import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContentPacks, mergeRetirementLists, PACK_GC_GRACE_MS, planPackGc, sweepDeleting, verifyReferencedPacks } from '../folder/folderEscrowContent'
import {
  APP,
  MAX_PACKS,
  PACK_APP,
  encodeCheckpoint,
  folderInput,
  packInput,
  sanitizePendingUploads,
  validateCheckpoint,
  CHECKPOINT_SCHEMA,
} from '../folder/folderCheckpoint'
import type { FolderCheckpoint, PackEntry, RetiredPack } from '../folder/folderCheckpoint'
import type { DeleteResult } from './client'
import { sha256, utf8 } from './crypto'
import type { EscrowHead } from './head'
import { escrowMessages } from './i18n'
import { GcServer, controller, empty, file, manifest, resetHarness, session, sources, time } from './contentPackGcHarness'

let now = 0
beforeEach(() => {
  resetHarness()
  now = Date.parse(time)
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => {
  resetHarness()
  vi.restoreAllMocks()
})
/** A second module instance has its own upload queue: it models another member's browser. */
async function otherMember() {
  vi.resetModules()
  return (await import('../app/folderEscrowController')).FolderEscrowController
}
const missing = (server: GcServer, packs: PackEntry[]) =>
  packs.filter((p) => server.slots.get(p.head.slot)?.cid !== p.head.cid || !server.blobs.has(p.head.cid)).map((p) => p.digest)
async function latestManifest(server: GcServer): Promise<FolderCheckpoint> {
  const tx = await session(server)
  const latest = await tx.client.fetchLatest(APP, folderInput('root', 'secret'))
  return validateCheckpoint(latest!.plaintext, 'root', 'secret', 'app-room')
}
const slotOf = (p: { head: EscrowHead }) => p.head.slot
const listed = (c: FolderCheckpoint, slot: string) =>
  [...(c.retired ?? []), ...(c.deleting ?? [])].some((p) => p.head.slot === slot)
const fake = (i: number): PackEntry => ({
  digest: i.toString(16).padStart(64, '0'),
  length: 1,
  head: { slot: 'slot-' + i } as EscrowHead,
})
const fakeRetired = (i: number, since: number, seq?: number): RetiredPack => ({
  digest: fake(i).digest, since, head: fake(i).head, ...(seq !== undefined && { seq }),
})
const checkpointOf = (over: Partial<FolderCheckpoint> = {}): FolderCheckpoint => ({ ...manifest(), ...over })

describe('format', () => {
  it.each(['en', 'ja', 'zh-CN', 'zh-TW'])('localizes slot counts in %s', (locale) => {
    expect(escrowMessages(locale).slotsInUse).toBeTruthy()
    expect(escrowMessages(locale).retiredCount).toBeTruthy()
  })
  it('accepts legacy manifests without retired/deleting/retained/nonce', async () => {
    const old = manifest()
    expect(await validateCheckpoint(encodeCheckpoint(old), 'root', 'secret', 'app-room')).toEqual(old)
  })
  it('validates nonce packs and retirement entries, keyed by slot rather than digest', async () => {
    const server = new GcServer(),
      tx = await session(server),
      bytes = utf8('pack'),
      s = empty()
    s.files = [await file(bytes)]
    const one = await buildContentPacks(tx, 'root', 'secret', s.files, null, async () => bytes)
    const two = await buildContentPacks(tx, 'root', 'secret', s.files, null, async () => bytes)
    const live = one.packs[0],
      twin = two.packs[0]
    expect(live.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(twin.digest).toBe(live.digest)
    expect(twin.head.slot).not.toBe(live.head.slot)
    const base = { ...manifest(s), ...one }
    expect(await validateCheckpoint(encodeCheckpoint(base), 'root', 'secret', 'app-room')).toEqual(base)
    const entry = { digest: twin.digest, since: 1, seq: 3, head: twin.head, nonce: twin.nonce }
    // The same bytes may be live in one slot and retired or deleting in another.
    for (const list of ['retired', 'deleting'] as const) {
      const ok = { ...base, [list]: [entry] }
      expect((await validateCheckpoint(encodeCheckpoint(ok), 'root', 'secret', 'app-room'))[list]).toEqual([entry])
    }
    const nonce = (v: string) => ({ ...base, packs: [{ ...live, nonce: v }] })
    const bad: [string, FolderCheckpoint][] = [
      ['tampered nonce', nonce('f'.repeat(32)) as FolderCheckpoint],
      ['malformed nonce', nonce('!') as FolderCheckpoint],
      ['same slot as live pack', { ...base, retired: [{ ...entry, nonce: live.nonce, head: live.head }] }],
      ['seq zero', { ...base, retired: [{ ...entry, seq: 0 }] }],
      ['unknown key', { ...base, retired: [{ ...entry, extra: 1 } as RetiredPack] }],
      ['missing since', { ...base, deleting: [{ digest: entry.digest, head: entry.head, nonce: entry.nonce } as RetiredPack] }],
      ['slot in both lists', { ...base, retired: [entry], deleting: [entry] }],
      ['retired without nonce where the slot needs one', { ...base, retired: [{ ...entry, nonce: undefined }] }],
    ]
    for (const [name, checkpoint] of bad)
      await expect(validateCheckpoint(encodeCheckpoint(checkpoint), 'root', 'secret', 'app-room'), name).rejects.toThrow()
  })
  it('accepts W7-format retirement entries without seq and nonce', async () => {
    // A pack uploaded by the legacy (nonce-less) scheme.
    const server = new GcServer(),
      tx = await session(server),
      bytes = utf8('legacy'),
      digest = await sha256(bytes)
    const ack = await tx.client.saveCheckpoint(PACK_APP, packInput('root', 'secret', digest), bytes, {
      schema: PACK_APP, parent: null, seq: 1, comp: 'none',
    })
    if (ack.type !== 'ack') throw new Error('upload failed')
    const old = { ...manifest(), retired: [{ digest, since: 1, head: ack.head }] }
    expect((await validateCheckpoint(encodeCheckpoint(old), 'root', 'secret', 'app-room')).retired).toEqual(old.retired)
  })
  it('bounds the total slots a manifest keeps alive', () => {
    const packs = Array.from({ length: 600 }, (_, i) => fake(i))
    const retired = Array.from({ length: 500 }, (_, i) => fakeRetired(1000 + i, 1, 1))
    expect(() => encodeCheckpoint(checkpointOf({ packs, retired }))).toThrow('slots')
    expect(() => encodeCheckpoint(checkpointOf({ packs, retired: retired.slice(0, 400) }))).not.toThrow()
  })
})

describe('planPackGc', () => {
  const plan = (over: Partial<Parameters<typeof planPackGc>[0]> = {}) =>
    planPackGc({
      packs: [], previous: null, retired: [], deleting: [], pending: [], now: 1_000_000_000, seq: 10, canDelete: true, ...over,
    })
  it('moves to deleting only after 24 hours by the writer clock AND three manifests', () => {
    const since = 1_000_000_000 - PACK_GC_GRACE_MS
    expect(plan({ retired: [fakeRetired(1, since, 7)] }).deleting.map(slotOf)).toEqual(['slot-1'])
    expect(plan({ retired: [fakeRetired(1, since + 1, 7)] }).deleting).toEqual([])
    expect(plan({ retired: [fakeRetired(1, since, 8)] }).deleting).toEqual([])
    expect(plan({ retired: [fakeRetired(1, since, 8)] }).retired.map(slotOf)).toEqual(['slot-1'])
    // A far-future `since` (retired by a fast clock) never expires early.
    expect(plan({ retired: [fakeRetired(1, since + 5 * PACK_GC_GRACE_MS, 1)] }).deleting).toEqual([])
    // Ancient wall clock but too few manifests: skew alone cannot bypass the grace period.
    expect(plan({ retired: [fakeRetired(1, 0, 9)] }).deleting).toEqual([])
  })
  it('reports exactly the newly committed entries and keeps older deleting entries', () => {
    const result = plan({ retired: [fakeRetired(1, 0, 1), fakeRetired(2, 0, 9)], deleting: [fakeRetired(3, 0, 1)] })
    expect(result.moved.map(slotOf)).toEqual(['slot-1'])
    expect(result.deleting.map(slotOf)).toEqual(['slot-1', 'slot-3'])
    expect(result.retired.map(slotOf)).toEqual(['slot-2'])
  })
  it('never deletes on a provider without the delete feature', () => {
    const result = plan({ canDelete: false, retired: [fakeRetired(1, 0, 1)] })
    expect(result.deleting).toEqual([])
    expect(result.moved).toEqual([])
    expect(result.retired.map(slotOf)).toEqual(['slot-1'])
  })
  it('stamps entries that carry no seq (W7 manifests) instead of trusting them', () => {
    const result = plan({ retired: [fakeRetired(1, 0)] })
    expect(result.deleting).toEqual([])
    expect(result.retired[0].seq).toBe(10)
  })
  it('never lists or deletes a pack the new or the previous manifest references', () => {
    const previous = checkpointOf({ packs: [fake(1)] })
    const result = plan({
      packs: [fake(2)], previous, retired: [fakeRetired(1, 0, 1), fakeRetired(2, 0, 1)], deleting: [fakeRetired(1, 0, 1)],
    })
    expect(result.deleting).toEqual([])
    expect(result.retired).toEqual([])
    expect(result.moved).toEqual([])
  })
  it('retires packs leaving the two-manifest window and uploads nobody references', () => {
    const previous = checkpointOf({ packs: [fake(2)], retained: [fake(1), fake(2), fake(3)] })
    const result = plan({ packs: [fake(3)], previous, pending: [fake(4), fake(3)] })
    // 1 left the window; 2 is still the previous manifest's; 3 is live; 4 was uploaded but never used.
    expect(result.retired.map(slotOf)).toEqual(['slot-1', 'slot-4'])
    expect(result.retired.every((p) => p.since === 1_000_000_000 && p.seq === 10)).toBe(true)
  })
  it('refuses to exceed the slot budget instead of leaking slots', () => {
    const live = Array.from({ length: 10 }, (_, i) => fake(i))
    const full = Array.from({ length: MAX_PACKS - 10 }, (_, i) => fakeRetired(100 + i, 1_000_000_000, 9))
    expect(plan({ packs: live, retired: full }).retired).toHaveLength(MAX_PACKS - 10)
    expect(() => plan({ packs: live, retired: [...full, fakeRetired(5000, 1_000_000_000, 9)] })).toThrow('budget')
    // Sweeping deleted slots out of the lists beforehand is what makes room for new candidates.
    const result = plan({ packs: live, retired: full.slice(1), pending: [fake(6000)] })
    expect(result.retired).toHaveLength(MAX_PACKS - 10)
  })
})

describe('mergeRetirementLists', () => {
  it('unites by slot, lets deleting win and drops anything the parent still references', () => {
    const latest = checkpointOf({ packs: [fake(9)], retained: [fake(8)], retired: [fakeRetired(1, 5, 2)] })
    const older = checkpointOf({
      retired: [fakeRetired(1, 1, 1), fakeRetired(2, 1, 1), fakeRetired(8, 1, 1)],
      deleting: [fakeRetired(3, 1, 1), fakeRetired(9, 1, 1)],
    })
    const older2 = checkpointOf({ retired: [fakeRetired(3, 1, 1)], deleting: [fakeRetired(2, 1, 1)] })
    const merged = mergeRetirementLists(latest, [older2, older])
    expect(merged.retired.map(slotOf)).toEqual(['slot-1'])
    expect(merged.retired[0].since).toBe(5)
    expect(merged.deleting.map(slotOf)).toEqual(['slot-2', 'slot-3'])
    expect(mergeRetirementLists(null, [])).toEqual({ retired: [], deleting: [] })
  })
})

describe('sweepDeleting', () => {
  async function realPack() {
    const server = new GcServer(),
      tx = await session(server),
      bytes = utf8('victim')
    const s = empty()
    s.files = [await file(bytes)]
    const { packs } = await buildContentPacks(tx, 'root', 'secret', s.files, null, async () => bytes)
    const pack = packs[0]
    const entry: RetiredPack = { digest: pack.digest, nonce: pack.nonce, since: 1, seq: 1, head: pack.head }
    return { pack, entry }
  }
  const make = (head: EscrowHead | null, deleteSlot: () => Promise<DeleteResult>, features: string[] = ['delete']) => {
    const client = {
      providers: new Map([['p', { maxBlob: 1, features }]]),
      getHead: vi.fn(async () => head),
      deleteSlot: vi.fn(deleteSlot),
    }
    return { client, assertProvider: () => {} }
  }
  it('drops entries whose slot is gone without sending a delete', async () => {
    const { entry } = await realPack()
    const s = make(null, async () => ({ type: 'deleted' }))
    expect(await sweepDeleting(s, 'root', 'secret', [entry])).toEqual([])
    expect(s.client.deleteSlot).not.toHaveBeenCalled()
  })
  it('drops an entry only on a deleted result, using the exact pinned head and input', async () => {
    const { pack, entry } = await realPack()
    const s = make(pack.head, async () => ({ type: 'deleted' }))
    expect(await sweepDeleting(s, 'root', 'secret', [entry])).toEqual([])
    expect(s.client.deleteSlot).toHaveBeenCalledWith(PACK_APP, packInput('root', 'secret', pack.digest, pack.nonce), pack.head)
  })
  it.each([
    ['conflict', { type: 'conflict', head: null }],
    ['busy', { type: 'error', code: 'busy', message: 'busy' }],
    ['unsupported', { type: 'unsupported', message: 'no' }],
  ] as const)('keeps the entry after %s', async (_name, result) => {
    const { pack, entry } = await realPack()
    const s = make(pack.head, async () => result as DeleteResult)
    expect(await sweepDeleting(s, 'root', 'secret', [entry])).toEqual([entry])
  })
  it('keeps the entry when the provider cannot be asked, lacks delete support, or holds another head', async () => {
    const { pack, entry } = await realPack()
    const throwing = make(pack.head, async () => ({ type: 'deleted' }))
    throwing.client.getHead.mockRejectedValue(new Error('timeout'))
    expect(await sweepDeleting(throwing, 'root', 'secret', [entry])).toEqual([entry])
    const legacy = make(pack.head, async () => ({ type: 'deleted' }), [])
    expect(await sweepDeleting(legacy, 'root', 'secret', [entry])).toEqual([entry])
    expect(legacy.client.deleteSlot).not.toHaveBeenCalled()
    const other = make({ ...pack.head, sha256: 'f'.repeat(64) }, async () => ({ type: 'deleted' }))
    expect(await sweepDeleting(other, 'root', 'secret', [entry])).toEqual([entry])
    expect(other.client.deleteSlot).not.toHaveBeenCalled()
    // A legacy provider that no longer holds the slot still lets the entry go.
    const gone = make(null, async () => ({ type: 'deleted' }), [])
    expect(await sweepDeleting(gone, 'root', 'secret', [entry])).toEqual([])
  })
  it('lets a lost provider abort the transaction instead of being swallowed', async () => {
    const { pack, entry } = await realPack()
    const s = make(pack.head, async () => ({ type: 'deleted' }))
    s.assertProvider = () => {
      throw new Error('Escrow provider disconnected')
    }
    await expect(sweepDeleting(s, 'root', 'secret', [entry])).rejects.toThrow('disconnected')
  })
})

describe('pack lifecycle through the manifest CAS', () => {
  async function three() {
    const server = new GcServer(),
      r = await controller(server)
    const m1 = await r.edit('a'),
      m2 = await r.edit('b'),
      m3 = await r.edit('c')
    return { server, r, m1, m2, m3, a: m1.packs[0] }
  }
  it('retires a pack once it leaves the two-manifest window and keeps its exact head', async () => {
    const { r, m1, m2, m3, a } = await three()
    expect(m1.retired).toEqual([])
    expect(m2.retired).toEqual([])
    expect(m2.retained).toEqual(m1.packs)
    expect(m3.retired).toEqual([{ digest: a.digest, nonce: a.nonce, since: now, seq: 3, head: a.head }])
    expect(m3.retained).toEqual(m2.packs)
    expect(m3.deleting).toEqual([])
    expect(r.c.view.slotsInUse).toBe(4)
    expect(r.c.view.retiredCount).toBe(1)
  })
  it('waits 24 hours, then commits the deletion in a manifest, deletes after the ACK and drops the entry later', async () => {
    const { server, r, a } = await three()
    for (let i = 0; i < 3; i++) await r.rename()
    now += PACK_GC_GRACE_MS - 1
    expect((await r.rename()).retired?.some((p) => p.head.slot === a.head.slot)).toBe(true)
    expect(server.deleteLog).toEqual([])
    now += 1
    const committed = await r.rename()
    expect(committed.deleting?.map(slotOf)).toContain(a.head.slot)
    expect(committed.retired?.some((p) => p.head.slot === a.head.slot)).toBe(false)
    expect(server.deleteLog).toContain(a.head.slot)
    expect(server.slots.has(a.head.slot)).toBe(false)
    const dropped = await r.rename()
    expect(listed(dropped, a.head.slot)).toBe(false)
    expect(server.deleteLog.filter((s) => s === a.head.slot)).toHaveLength(1)
  })
  it('needs three manifests even when the grace period is long over', async () => {
    const { server, r, a } = await three()
    now += PACK_GC_GRACE_MS + 1
    await r.rename()
    await r.rename()
    expect(server.deleteLog).toEqual([])
    expect(server.slots.has(a.head.slot)).toBe(true)
    await r.rename()
    expect(server.deleteLog).toEqual([a.head.slot])
  })
  it('only deletes slots that the current manifest already lists as deleting', async () => {
    const violations: string[] = []
    const server = new GcServer(),
      observer = await session(server)
    server.beforeDelete = async (slot) => {
      const latest = await observer.client.fetchLatest(APP, folderInput('root', 'secret'))
      const current = await validateCheckpoint(latest!.plaintext, 'root', 'secret', 'app-room')
      if (!current.deleting?.some((p) => p.head.slot === slot)) violations.push(slot)
    }
    const r = await controller(server)
    for (let i = 0; i < 12; i++) {
      await r.edit('g' + i)
      now += PACK_GC_GRACE_MS + 1
    }
    expect(server.deleteLog.length).toBeGreaterThan(5)
    expect(violations).toEqual([])
    expect(server.hookErrors).toEqual([])
  })
  it.each(['conflict', 'busy', 'quota'] as const)('keeps the entry after a %s answer and finishes it on the next save', async (failure) => {
    const { server, r, a } = await three()
    now += PACK_GC_GRACE_MS + 1
    await r.rename()
    await r.rename()
    server.deleteResult = failure
    const kept = await r.rename()
    expect(kept.deleting?.map(slotOf)).toContain(a.head.slot)
    expect(server.slots.has(a.head.slot)).toBe(true)
    server.deleteResult = undefined
    const done = await r.rename()
    expect(listed(done, a.head.slot)).toBe(false)
    expect(server.slots.has(a.head.slot)).toBe(false)
  })
  it('never retires into deleting nor sends a delete when the provider lacks the feature', async () => {
    const { server, r, a } = await three()
    server.supportsDelete = false
    now += PACK_GC_GRACE_MS + 1
    let last
    for (let i = 0; i < 5; i++) last = await r.rename()
    expect(last!.retired?.some((p) => p.head.slot === a.head.slot)).toBe(true)
    expect(last!.deleting).toEqual([])
    expect(server.requests).not.toContain('escrow_delete')
    server.supportsDelete = true
    await r.rename()
    expect(server.slots.has(a.head.slot)).toBe(false)
  })
  it('never rescues a retired pack: content needed again is uploaded again under a new nonce', async () => {
    const { server, r, a } = await three()
    const again = await r.edit('a')
    expect(again.packs[0].digest).toBe(a.digest)
    expect(again.packs[0].head.slot).not.toBe(a.head.slot)
    expect(again.packs[0].nonce).not.toBe(a.nonce)
    expect(again.retired?.some((p) => p.head.slot === a.head.slot)).toBe(true)
    for (let i = 0; i < 6; i++) {
      now += PACK_GC_GRACE_MS + 1
      await r.rename()
    }
    expect(server.slots.has(a.head.slot)).toBe(false)
    const current = await latestManifest(server)
    expect(missing(server, current.packs)).toEqual([])
    expect(await r.c.loadContent(r.snapshot.files[0])).toContain('YQ==')
  })
  it('re-referencing content while its pack is still inside the window reuses the same slot', async () => {
    const server = new GcServer(),
      r = await controller(server)
    const a = (await r.edit('a')).packs[0]
    await r.edit('b')
    const again = await r.edit('a')
    expect(again.packs[0].head.slot).toBe(a.head.slot)
    expect(again.retired).toEqual([])
  })
  it('reuses uploads of a failed save on retry and retires uploads that end up unused', async () => {
    const server = new GcServer(),
      r = await controller(server)
    await r.edit('base')
    server.dropCheckpointPut = true
    await r.edit('x', { allowError: true })
    expect(r.c.view.status).toBe('error')
    const uploads = () => server.putLog.filter((p) => p.head.schema === PACK_APP).map((p) => p.head)
    const orphan = uploads().at(-1)!
    server.dropCheckpointPut = false
    const retried = await r.c.flush().then(() => r.stored.checkpoint!)
    expect(retried.packs.map(slotOf)).toContain(orphan.slot)
    expect(uploads().filter((h) => h.slot === orphan.slot)).toHaveLength(1)
    // An upload that no manifest ends up using is retired by the next ACK.
    server.dropCheckpointPut = true
    await r.edit('y', { allowError: true })
    const unused = uploads().at(-1)!
    server.dropCheckpointPut = false
    const saved = await r.edit('z')
    expect(saved.retired?.map(slotOf)).toContain(unused.slot)
    expect(saved.packs.map(slotOf)).not.toContain(unused.slot)
  })
  it('reports retired and deleting slots in the status', async () => {
    const { r } = await three()
    expect(r.c.view.slotsInUse).toBe(4)
    now += PACK_GC_GRACE_MS + 1
    await r.rename()
    await r.rename()
    await r.rename()
    const cp = r.stored.checkpoint!
    expect(r.c.view.retiredCount).toBe((cp.retired?.length ?? 0) + (cp.deleting?.length ?? 0))
    expect(r.c.view.slotsInUse).toBe(1 + new Set([...cp.packs, ...(cp.retained ?? []), ...(cp.retired ?? []), ...(cp.deleting ?? [])].map(slotOf)).size)
  })
})

describe('writers racing the collector', () => {
  /** B still caches the pack X (from M1) while A, in parallel, builds the manifest that retires X. */
  async function racers() {
    const server = new GcServer(),
      a = await controller(server)
    const x = (await a.edit('a')).packs[0]
    const b = await controller(server, structuredClone(a.snapshot), undefined, await otherMember(), 'b')
    await a.edit('b')
    return { server, a, b, x }
  }
  it('B publishes first with X: the collector sees X referenced and does not retire it', async () => {
    const { server, a, b, x } = await racers()
    server.beforeCheckpointPut = async () => {
      await b.edit('a')
    }
    const final = await a.rename()
    expect(server.hookErrors).toEqual([])
    expect(final.packs.map(slotOf)).toContain(x.head.slot)
    expect(listed(final, x.head.slot)).toBe(false)
    expect(missing(server, [...final.packs, ...(final.retained ?? [])])).toEqual([])
  })
  it('A publishes first and retires X: B drops its cached X and uploads the content again', async () => {
    const { server, a, b, x } = await racers()
    server.beforeCheckpointPut = async () => {
      const m = await a.rename()
      expect(m.retired?.map(slotOf)).toContain(x.head.slot)
    }
    const final = await b.edit('a')
    expect(server.hookErrors).toEqual([])
    expect(final.packs).toHaveLength(1)
    expect(final.packs[0].digest).toBe(x.digest)
    expect(final.packs[0].head.slot).not.toBe(x.head.slot)
    expect(final.retired?.map(slotOf)).toContain(x.head.slot)
    expect(missing(server, [...final.packs, ...(final.retained ?? [])])).toEqual([])
  })
  it('B holds X in its cache while X is committed for deletion: B uploads again and nothing breaks', async () => {
    const { server, a, b, x } = await racers()
    await a.edit('c')
    now += PACK_GC_GRACE_MS + 1
    await a.rename()
    await a.rename()
    // A's third manifest commits the deletion; its DELETE is held until B has published 'a' again.
    let held = false
    server.beforeDelete = async (slot) => {
      if (slot !== x.head.slot || held) return
      held = true
      const m = await b.edit('a')
      expect(m.packs[0].head.slot).not.toBe(x.head.slot)
    }
    const committed = await a.rename()
    expect(server.hookErrors).toEqual([])
    expect(held).toBe(true)
    expect(committed.deleting?.map(slotOf)).toContain(x.head.slot)
    const current = await latestManifest(server)
    expect(current.packs[0].digest).toBe(x.digest)
    expect(server.slots.has(x.head.slot)).toBe(false)
    expect(missing(server, [...current.packs, ...(current.retained ?? [])])).toEqual([])
    expect(await b.c.loadContent(b.snapshot.files[0])).toContain('YQ==')
  })
  it('B never references X while it is listed as deleting, even when X still exists on the provider', async () => {
    const { server, a, b, x } = await racers()
    await a.edit('c')
    now += PACK_GC_GRACE_MS + 1
    await a.rename()
    await a.rename()
    server.deleteResult = 'busy'
    const committed = await a.rename()
    expect(committed.deleting?.map(slotOf)).toContain(x.head.slot)
    expect(server.slots.has(x.head.slot)).toBe(true)
    // B's cache still holds X (stored, identical head), but the parent manifest retired it.
    const mine = await b.edit('a')
    expect(mine.packs[0].digest).toBe(x.digest)
    expect(mine.packs[0].head.slot).not.toBe(x.head.slot)
    expect(listed(mine, x.head.slot)).toBe(true)
    server.deleteResult = undefined
    const done = await b.rename()
    expect(server.slots.has(x.head.slot)).toBe(false)
    expect(listed(done, x.head.slot)).toBe(false)
    expect(missing(server, [...done.packs, ...(done.retained ?? [])])).toEqual([])
  })
  it('a pack another member lost is uploaded again before the manifest is published', async () => {
    const server = new GcServer(),
      r = await controller(server)
    const old = (await r.edit('body')).packs[0]
    server.slots.delete(old.head.slot)
    server.blobs.delete(old.head.cid)
    const restored = await r.rename()
    expect(restored.packs[0].digest).toBe(old.digest)
    expect(restored.packs[0].head.slot).not.toBe(old.head.slot)
    expect(missing(server, restored.packs)).toEqual([])
  })
  it('re-uploads a pack removed during the final verification fence', async () => {
    const server = new GcServer(),
      tx = await session(server),
      bytes = utf8('body'),
      s = empty()
    s.files = [await file(bytes)]
    const content = await buildContentPacks(tx, 'root', 'secret', s.files, null, async () => bytes)
    const old = { ...content.packs[0].head }
    server.beforeGet = (slot) => {
      if (slot === old.slot) {
        server.beforeGet = undefined
        server.slots.delete(slot)
        server.blobs.delete(old.cid)
      }
    }
    await verifyReferencedPacks(tx, 'root', 'secret', content.packs, content.contents, s.files, async () => bytes)
    expect(content.packs[0].head.slot).not.toBe(old.slot)
    expect(server.slots.get(content.packs[0].head.slot)).toEqual(content.packs[0].head)
    const checkpoint = { ...manifest(s), ...content }
    await validateCheckpoint(encodeCheckpoint(checkpoint), 'root', 'secret', 'app-room')
    expect(
      (await tx.client.saveCheckpoint(APP, folderInput('root', 'secret'), encodeCheckpoint(checkpoint), {
        schema: CHECKPOINT_SCHEMA, seq: 1, parent: null,
      })).type,
    ).toBe('ack')
  })
  it('repacking a partly reused pack keeps every remaining file readable and does not touch cached descriptors', async () => {
    const server = new GcServer(),
      tx = await session(server)
    const bytesA = utf8('AAAA'),
      bytesB = utf8('BBBB')
    const fileA = { ...(await file(bytesA)), id: 'a' },
      fileB = { ...(await file(bytesB)), id: 'b' }
    const read = async (f: { id: string }) => (f.id === 'a' ? bytesA : bytesB)
    const packed = await buildContentPacks(tx, 'root', 'secret', [fileA, fileB], null, read)
    const old = { ...manifest(), ...packed }
    const snapshot = structuredClone(old.contents)
    const reused = await buildContentPacks(tx, 'root', 'secret', [fileA], old, read)
    server.slots.delete(reused.packs[0].head.slot)
    await verifyReferencedPacks(tx, 'root', 'secret', reused.packs, reused.contents, [fileA], read)
    expect(old.contents).toEqual(snapshot)
    const s = empty()
    s.files = [fileA]
    const checkpoint = { ...manifest(s), ...reused }
    await validateCheckpoint(encodeCheckpoint(checkpoint), 'root', 'secret', 'app-room')
    expect(missing(server, reused.packs)).toEqual([])
  })
})

describe('restarts, skewed clocks and legacy manifests', () => {
  async function ready() {
    const server = new GcServer(),
      r = await controller(server)
    const a = (await r.edit('a')).packs[0]
    await r.edit('b')
    await r.edit('c')
    now += PACK_GC_GRACE_MS + 1
    await r.rename()
    await r.rename()
    return { server, r, a }
  }
  const restart = async (server: GcServer, r: Awaited<ReturnType<typeof controller>>) => {
    const stored = structuredClone(r.stored),
      snapshot = structuredClone(r.snapshot)
    r.c.dispose()
    return controller(server, snapshot, stored)
  }
  it('restart after the manifest committed the deletion but before the DELETE ran finishes the job', async () => {
    const { server, r, a } = await ready()
    server.deleteResult = 'busy'
    const committed = await r.rename()
    expect(committed.deleting?.map(slotOf)).toContain(a.head.slot)
    expect(server.slots.has(a.head.slot)).toBe(true)
    server.deleteResult = undefined
    const again = await restart(server, r)
    const done = await again.rename()
    expect(server.slots.has(a.head.slot)).toBe(false)
    expect(listed(done, a.head.slot)).toBe(false)
  })
  it('restart after the DELETE but before the manifest dropped the entry needs no second DELETE', async () => {
    const { server, r, a } = await ready()
    const committed = await r.rename()
    expect(committed.deleting?.map(slotOf)).toContain(a.head.slot)
    expect(server.slots.has(a.head.slot)).toBe(false)
    const deletes = server.deleteLog.length
    const again = await restart(server, r)
    const done = await again.rename()
    expect(listed(done, a.head.slot)).toBe(false)
    expect(server.deleteLog).toHaveLength(deletes)
  })
  it('a fast clock needs three manifests, a slow retirer clock never expires early', async () => {
    const server = new GcServer(),
      r = await controller(server)
    const a = (await r.edit('a')).packs[0]
    await r.edit('b')
    await r.edit('c')
    const snapshot = structuredClone(r.snapshot)
    r.c.dispose()
    now += 2 * PACK_GC_GRACE_MS
    const b = await controller(server, snapshot, undefined, undefined, 'b')
    await b.rename()
    await b.rename()
    expect(server.deleteLog).toEqual([])
    await b.rename()
    expect(server.deleteLog).toContain(a.head.slot)
    // The collector's clock is two days behind the retirer: nothing is due however many manifests pass.
    const slow = new GcServer(),
      s = await controller(slow)
    now += 10 * PACK_GC_GRACE_MS
    const a2 = (await s.edit('a')).packs[0]
    await s.edit('b')
    await s.edit('c')
    now -= 8 * PACK_GC_GRACE_MS
    for (let i = 0; i < 5; i++) await s.rename()
    expect(slow.deleteLog).not.toContain(a2.head.slot)
  })
  async function legacyChain() {
    const server = new GcServer(),
      tx = await session(server),
      bytes = utf8('legacy'),
      digest = await sha256(bytes)
    // Written by the nonce-less scheme: the slot derives from the digest alone.
    const ack = await tx.client.saveCheckpoint(PACK_APP, packInput('root', 'secret', digest), bytes, {
      schema: PACK_APP, parent: null, seq: 1, comp: 'none',
    })
    if (ack.type !== 'ack') throw new Error('upload failed')
    const f = await file(bytes)
    sources.set(f.checksum, bytes)
    const s = empty()
    s.files = [f]
    const legacy: FolderCheckpoint = {
      ...manifest(s),
      contents: [{ fileId: f.id, checksum: f.checksum, size: f.size, segments: [{ packDigest: digest, offset: 0, length: bytes.length }] }],
      packs: [{ digest, length: bytes.length, head: ack.head }],
    }
    await tx.client.saveCheckpoint(APP, folderInput('root', 'secret'), encodeCheckpoint(legacy), {
      schema: CHECKPOINT_SCHEMA, parent: null, seq: 1,
    })
    return { server, snapshot: s, legacyHead: ack.head, digest }
  }
  it('restores content from a legacy manifest and garbage-collects its nonce-less pack', async () => {
    const { server, snapshot, legacyHead } = await legacyChain()
    const r = await controller(server, structuredClone(snapshot))
    expect(await r.c.loadContent(r.snapshot.files[0])).toContain('bGVnYWN5')
    const first = await r.edit('new-1')
    expect(first.retained?.map(slotOf)).toEqual([legacyHead.slot])
    await r.edit('new-2')
    now += PACK_GC_GRACE_MS + 1
    for (let i = 0; i < 3; i++) await r.rename()
    expect(server.deleteLog).toContain(legacyHead.slot)
    expect(server.slots.has(legacyHead.slot)).toBe(false)
    await r.rename()
    const current = await latestManifest(server)
    expect(missing(server, current.packs)).toEqual([])
    // The legacy manifest had no retired/deleting/retained and no nonce on its pack.
    expect(listed(current, legacyHead.slot)).toBe(false)
  })
  it('keeps a legacy pack alive while it is still referenced', async () => {
    const { server, snapshot, legacyHead } = await legacyChain()
    const r = await controller(server, structuredClone(snapshot))
    for (let i = 0; i < 5; i++) {
      now += PACK_GC_GRACE_MS + 1
      await r.rename()
    }
    expect(server.deleteLog).toEqual([])
    expect(server.slots.has(legacyHead.slot)).toBe(true)
  })
})

describe('slot usage', () => {
  it('50 changing generations, writer restarts and expired graces never exceed live + retired + 2 slots', async () => {
    const server = new GcServer(),
      observer = await session(server)
    const violations: string[] = []
    server.beforeDelete = async (slot) => {
      const latest = await observer.client.fetchLatest(APP, folderInput('root', 'secret'))
      const current = await validateCheckpoint(latest!.plaintext, 'root', 'secret', 'app-room')
      if (!current.deleting?.some((p) => p.head.slot === slot)) violations.push(slot)
    }
    let r = await controller(server)
    for (let i = 0; i < 50; i++) {
      const cp = await r.edit('generation-' + i)
      const slots = server.slots.size
      const retired = (cp.retired?.length ?? 0) + (cp.deleting?.length ?? 0)
      expect(slots).toBeLessThanOrEqual(cp.packs.length + retired + 2)
      expect(slots).toBeLessThanOrEqual(7)
      expect(missing(server, [...cp.packs, ...(cp.retained ?? [])])).toEqual([])
      expect(r.c.view.slotsInUse).toBeGreaterThanOrEqual(slots)
      expect([...server.slots.values()].reduce((n, h) => n + h.size, 0)).toBeLessThan(20000)
      now += PACK_GC_GRACE_MS + 1
      if (i === 24) {
        const stored = structuredClone(r.stored),
          snapshot = structuredClone(r.snapshot)
        r.c.dispose()
        r = await controller(server, snapshot, stored)
      }
    }
    expect(server.peakSlots).toBeLessThanOrEqual(8)
    expect(server.deleteLog.length).toBeGreaterThanOrEqual(44)
    expect(violations).toEqual([])
    expect(server.hookErrors).toEqual([])
  }, 60000)
  it('without elapsed time nothing is deleted and the lists, not the provider, hold the slots', async () => {
    const server = new GcServer(),
      r = await controller(server)
    let cp
    for (let i = 0; i < 30; i++) cp = await r.edit('generation-' + i)
    expect(server.deleteLog).toEqual([])
    expect(server.slots.size).toBe(1 + 1 + 1 + cp!.retired!.length)
    expect(cp!.retired).toHaveLength(28)
  }, 60000)
})

describe('pending upload intents', () => {
  it('are never truncated on load and ignore malformed or duplicate entries', () => {
    const intent = (i: number) => ({
      digest: i.toString(16).padStart(64, '0'), length: 10, nonce: i.toString(16).padStart(32, '0'), at: 1,
    })
    const many = Array.from({ length: 300 }, (_, i) => intent(i))
    expect(sanitizePendingUploads(many)).toEqual(many)
    expect(sanitizePendingUploads([...many.slice(0, 3), many[0], { ...intent(9), nonce: '!' }, 'x', null, { ...intent(8), absentSeq: 0 }]))
      .toEqual(many.slice(0, 3))
    expect(sanitizePendingUploads([{ ...intent(1), absentSeq: 7 }])).toEqual([{ ...intent(1), absentSeq: 7 }])
    expect(sanitizePendingUploads('nope')).toEqual([])
  })
})
