/**
 * Permanent regressions for the W7b adversarial review (rv-w7b): pending uploads bypassing the
 * deletion fence (blocker), slots leaking between a pack ACK and the manifest, and a full slot
 * budget that GC could not unblock. They drive only controllers and the provider double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContentPacks, PACK_GC_GRACE_MS, PACK_GC_MIN_GENERATIONS } from '../folder/folderEscrowContent'
import {
  APP,
  CHECKPOINT_SCHEMA,
  MAX_LIVE_PACKS,
  MAX_PACKS,
  MAX_PENDING_UPLOADS,
  PACK_APP,
  PACK_BYTES,
  PENDING_UPLOAD_PRESSURE,
  encodeCheckpoint,
  folderInput,
  manifestSlots,
  packInput,
  validateCheckpoint,
} from '../folder/folderCheckpoint'
import type { FolderCheckpoint, PackEntry, RetiredPack } from '../folder/folderCheckpoint'
import { deriveEscrowKeys, sha256, utf8 } from './crypto'
import { buildHead } from './head'
import { GcServer, controller, craftProtected, empty, file, manifest, resetHarness, session, sources, time } from './contentPackGcHarness'
import { stampFilePatch } from '../storage/crdt'

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
async function otherMember() {
  vi.resetModules()
  return (await import('../app/folderEscrowController')).FolderEscrowController
}
async function latestManifest(server: GcServer): Promise<FolderCheckpoint> {
  const tx = await session(server)
  const latest = await tx.client.fetchLatest(APP, folderInput('root', 'secret'))
  return validateCheckpoint(latest!.plaintext, 'root', 'secret', 'app-room')
}
const missing = (server: GcServer, packs: PackEntry[]) =>
  packs.filter((p) => server.slots.get(p.head.slot)?.cid !== p.head.cid || !server.blobs.has(p.head.cid)).map((p) => p.digest)
/** Slots on the provider that neither the manifest slot nor any manifest list accounts for. */
async function untracked(server: GcServer, cp: FolderCheckpoint): Promise<string[]> {
  const manifestSlot = (await deriveEscrowKeys(APP, folderInput('root', 'secret'))).slot
  const known = manifestSlots(cp)
  return [...server.slots.keys()].filter((s) => s !== manifestSlot && !known.has(s))
}

describe('rv-w7b regressions', () => {
  it('BLOCKER: an upload pending after a lost manifest ACK is not reused once the parent deletes it', async () => {
    const server = new GcServer(),
      a = await controller(server)
    await a.edit('base')
    // A's manifest is stored but its ACK is lost: the pack stays pending in A.
    server.dropRootAck = true
    await a.edit('x', { allowError: true })
    server.dropRootAck = false
    expect(a.c.view.status).toBe('error')
    const pending = (await latestManifest(server)).packs[0]
    // Another member moves on, retires the pack and commits (but delays) its deletion.
    const b = await controller(server, structuredClone(a.snapshot), undefined, await otherMember(), 'b')
    await b.edit('y1')
    await b.edit('y2')
    now += PACK_GC_GRACE_MS + 1
    await b.rename()
    await b.rename()
    let entered = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    server.beforeDelete = async (slot) => {
      if (slot !== pending.head.slot) return
      if (!entered) {
        entered = true
        await gate
        server.deleteResult = undefined
      } else server.deleteResult = 'busy' // A's own sweep of the same entry
    }
    const committed = b.rename()
    await vi.waitUntil(() => entered, { timeout: 5000, interval: 5 })
    // A needs 'x' again and still holds the pending pack; its own delete attempt is refused.
    await a.set('x')
    await a.c.flush()
    expect(a.c.view.reason).toBeUndefined()
    release()
    await committed
    expect(server.hookErrors).toEqual([])
    expect(server.slots.has(pending.head.slot)).toBe(false)
    const current = await latestManifest(server)
    expect(current.packs.some((p) => p.head.slot === pending.head.slot)).toBe(false)
    expect(missing(server, [...current.packs, ...(current.retained ?? [])])).toEqual([])
    expect(await a.c.loadContent(a.snapshot.files[0])).toContain('eA==')
  })

  it('SHOULD-FIX: a restart between the pack ACK and the manifest PUT does not leak the slot', async () => {
    const server = new GcServer(),
      a = await controller(server)
    await a.edit('base')
    const before = new Set(server.slots.keys())
    server.dropCheckpointPut = true
    await a.edit('x', { allowError: true })
    expect(a.c.view.status).toBe('error')
    const orphan = [...server.slots.keys()].filter((s) => !before.has(s))
    expect(orphan).toHaveLength(1)
    // The intent was durable before the pack PUT.
    expect(a.stored.pendingUploads).toHaveLength(1)
    const stored = structuredClone(a.stored),
      snapshot = structuredClone(a.snapshot)
    a.c.dispose()
    server.dropCheckpointPut = false
    const b = await controller(server, snapshot, stored)
    const saved = await b.rename()
    expect(saved.retired?.map((p) => p.head.slot)).toContain(orphan[0])
    expect(await untracked(server, saved)).toEqual([])
    // Normal two-phase GC reclaims it.
    now += PACK_GC_GRACE_MS + 1
    for (let i = 0; i < 4; i++) await b.rename()
    expect(server.slots.has(orphan[0])).toBe(false)
    expect(await untracked(server, b.stored.checkpoint!)).toEqual([])
    expect(b.stored.pendingUploads ?? []).toEqual([])
  })

  it('SHOULD-FIX: a lost pack ACK does not leak the slot either', async () => {
    const server = new GcServer(),
      a = await controller(server)
    await a.edit('base')
    const before = new Set(server.slots.keys())
    server.dropPackAck = true
    await a.edit('x', { allowError: true })
    server.dropPackAck = false
    expect(a.c.view.status).toBe('error')
    const orphan = [...server.slots.keys()].filter((s) => !before.has(s))
    expect(orphan).toHaveLength(1)
    await a.c.flush()
    expect(a.c.view.status).toBe('saved')
    const saved = a.stored.checkpoint!
    expect(saved.retired?.map((p) => p.head.slot)).toContain(orphan[0])
    expect(await untracked(server, saved)).toEqual([])
  })

  it('keeps an intent whose head is not visible, whatever the clock says, and forgets it two manifests later', async () => {
    const server = new GcServer(),
      a = await controller(server)
    await a.edit('base')
    server.failPack = true
    await a.edit('x', { allowError: true })
    server.failPack = false
    expect(a.stored.pendingUploads).toHaveLength(1)
    await a.c.flush()
    // Invisible at the first miss: remembered, stamped with the manifest sequence.
    expect(a.stored.pendingUploads).toHaveLength(1)
    expect(a.stored.pendingUploads![0].absentSeq).toBe(a.stored.lastSeq)
    // A day on the clock changes nothing; the next manifest is only one generation later.
    now += 24 * 60 * 60 * 1000
    await a.rename()
    expect(a.stored.pendingUploads).toHaveLength(1)
    await a.rename()
    expect(a.stored.pendingUploads ?? []).toEqual([])
  })

  it('SHOULD-FIX: a PUT that commits after a clock step is still reclaimed (forward clock)', async () => {
    const server = new GcServer(),
      a = await controller(server)
    await a.edit('base')
    const before = new Set(server.slots.keys())
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    server.holdPackPut = () => gate
    await a.edit('x', { allowError: true })
    expect(a.c.view.status).toBe('error')
    expect([...server.slots.keys()].filter((k) => !before.has(k))).toEqual([])
    // The writer clock jumps an hour, then the stuck PUT lands.
    now += 60 * 60 * 1000
    await a.rename()
    release()
    await vi.waitUntil(() => [...server.slots.keys()].some((k) => !before.has(k)), { timeout: 3000, interval: 5 })
    const late = [...server.slots.keys()].filter((k) => !before.has(k))
    expect(late.length).toBeGreaterThan(0)
    await a.rename()
    await a.rename()
    const cp = a.stored.checkpoint!
    expect(await untracked(server, cp)).toEqual([])
    expect(late.filter((k) => !cp.retired?.some((p) => p.head.slot === k) && !cp.packs.some((p) => p.head.slot === k))).toEqual([])
  })

  it('SHOULD-FIX: repeated restarts and clock steps with in-flight PUTs leave no untracked slot after GC', async () => {
    const server = new GcServer()
    let a = await controller(server)
    await a.edit('base')
    for (let cycle = 0; cycle < 3; cycle++) {
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      server.holdPackPut = () => gate
      await a.edit('x' + cycle, { allowError: true })
      const stored = structuredClone(a.stored),
        snapshot = structuredClone(a.snapshot)
      a.c.dispose()
      now += 2 * 60 * 60 * 1000
      a = await controller(server, snapshot, stored)
      await a.rename()
      release()
      await new Promise((resolve) => setTimeout(resolve, 30))
      await a.rename()
      await a.rename()
    }
    now += PACK_GC_GRACE_MS + 1
    for (let i = 0; i < 8; i++) await a.rename()
    expect(await untracked(server, a.stored.checkpoint!)).toEqual([])
    expect(a.stored.pendingUploads ?? []).toEqual([])
  })

  it('SHOULD-FIX: restarts never truncate unresolved upload intents', async () => {
    const server = new GcServer()
    let a = await controller(server)
    await a.edit('base')
    server.rejectCheckpointPut = true
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let i = 0; i < 20; i++) await a.edit('c' + cycle + '-' + i, { allowError: true })
      const stored = structuredClone(a.stored),
        snapshot = structuredClone(a.snapshot)
      a.c.dispose()
      expect(stored.pendingUploads).toHaveLength(20 * (cycle + 1))
      a = await controller(server, snapshot, stored)
    }
    server.rejectCheckpointPut = false
    await a.rename()
    expect(await untracked(server, a.stored.checkpoint!)).toEqual([])
    now += PACK_GC_GRACE_MS + 1
    for (let i = 0; i < 8; i++) await a.rename()
    expect(await untracked(server, a.stored.checkpoint!)).toEqual([])
    expect(server.slots.size).toBeLessThanOrEqual(8)
  }, 120000)

  it('SHOULD-FIX: unresolved intents under pressure are folded into retired, then reclaimed', async () => {
    const server = new GcServer()
    let a = await controller(server)
    await a.edit('base')
    server.rejectCheckpointPut = true
    for (let i = 0; i < PENDING_UPLOAD_PRESSURE + 2; i++) await a.edit('p' + i, { allowError: true })
    expect(a.stored.pendingUploads).toHaveLength(PENDING_UPLOAD_PRESSURE)
    const stored = structuredClone(a.stored),
      snapshot = structuredClone(a.snapshot)
    a.c.dispose()
    server.rejectCheckpointPut = false
    a = await controller(server, snapshot, stored)
    const saved = await a.rename()
    expect(saved.retired?.length).toBeGreaterThanOrEqual(PENDING_UPLOAD_PRESSURE)
    expect(a.stored.pendingUploads ?? []).toEqual([])
    expect(await untracked(server, saved)).toEqual([])
    now += PACK_GC_GRACE_MS + 1
    for (let i = 0; i < 8; i++) await a.rename()
    expect(server.slots.size).toBeLessThanOrEqual(8)
  }, 120000)

  it('SHOULD-FIX: no upload starts at the intent cap; the save fails and recovers once intents resolve', { timeout: 60000 }, async () => {
    const server = new GcServer()
    const a = await controller(server)
    await a.edit('base')
    const fake = Array.from({ length: MAX_PENDING_UPLOADS }, (_, i) => ({
      digest: i.toString(16).padStart(64, '0'), length: 10, nonce: i.toString(16).padStart(32, 'a'), at: 1,
    }))
    const stored = { ...structuredClone(a.stored), pendingUploads: fake }
    const snapshot = structuredClone(a.snapshot)
    a.c.dispose()
    const uploadsBefore = server.packSlots.size
    // The pressure passes stamp the absent intents and then let them expire; nothing is dropped early.
    const r = await controller(server, snapshot, stored)
    await r.set('after the cap')
    await r.c.flush()
    for (let i = 0; i < 4 && r.c.view.status !== 'saved'; i++) await r.c.flush()
    expect(r.c.view.status).toBe('saved')
    expect(r.stored.pendingUploads ?? []).toEqual([])
    expect(r.stored.lastSeq).toBeGreaterThanOrEqual(4)
    expect(server.packSlots.size).toBe(uploadsBefore + 1)
  })

  it('SHOULD-FIX: a full slot budget is relieved by a GC-only manifest before the content save uploads', async () => {
    const server = new GcServer()
    const { snapshot } = await fullBudget(server, { since: 0, retiredSeq: 1 })
    const r = await controller(server, snapshot)
    const saved = await r.edit('needs another slot')
    expect(r.c.view.status).toBe('saved')
    expect(server.deleteLog.length).toBeGreaterThanOrEqual(MAX_PACKS - 1)
    expect(saved.retired?.length ?? 0).toBeLessThan(10)
    expect(missing(server, saved.packs)).toEqual([])
    expect(await untracked(server, saved)).toEqual([])
  }, 120000)

  it('SHOULD-FIX: a full budget advances the generation grace with GC-only manifests', async () => {
    const server = new GcServer()
    // Every retired pack is old enough by the clock but stamped at the current manifest sequence.
    const { snapshot } = await fullBudget(server, { since: 0, retiredSeq: 10 })
    const r = await controller(server, snapshot)
    const saved = await r.edit('needs another slot')
    expect(r.c.view.status).toBe('saved')
    expect(server.deleteLog.length).toBeGreaterThanOrEqual(MAX_PACKS - 1)
    // At most PACK_GC_MIN_GENERATIONS manifests to qualify plus the content manifest.
    expect(r.stored.lastSeq).toBeLessThanOrEqual(10 + PACK_GC_MIN_GENERATIONS + 2)
    expect(missing(server, saved.packs)).toEqual([])
    expect(await untracked(server, saved)).toEqual([])
  }, 120000)

  it('SHOULD-FIX: a full budget that only waits for the 24 h grace reports it and recovers by itself', async () => {
    const server = new GcServer()
    const { snapshot } = await fullBudget(server, { since: now, retiredSeq: 10 })
    const r = await controller(server, snapshot)
    await r.edit('needs another slot', { allowError: true })
    expect(r.c.view.status).toBe('error')
    expect(r.c.view.reason).toContain('waiting for GC grace')
    expect(server.deleteLog).toEqual([])
    now += PACK_GC_GRACE_MS + 1
    await r.c.flush()
    expect(r.c.view.status).toBe('saved')
    expect(server.deleteLog.length).toBeGreaterThanOrEqual(MAX_PACKS - 1)
    expect(await untracked(server, r.stored.checkpoint!)).toEqual([])
  }, 120000)

  it('BLOCKER: with no manifest yet, 256 unresolved intents are folded by an initial metadata-only manifest', async () => {
    const server = new GcServer()
    const fake = Array.from({ length: MAX_PENDING_UPLOADS }, (_, i) => ({
      digest: i.toString(16).padStart(64, '0'), length: 10, nonce: i.toString(16).padStart(32, 'c'), at: 1,
    }))
    const bytes = utf8('first save'),
      f = await file(bytes)
    sources.set(f.checksum, bytes)
    const s = empty()
    s.files = [f]
    const r = await controller(server, s, {
      lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0, pendingUploads: fake,
    })
    for (let day = 0; day < 4 && r.c.view.status !== 'saved'; day++) {
      await r.c.flush()
      now += 24 * 60 * 60 * 1000
    }
    expect(r.c.view.status).toBe('saved')
    expect(r.stored.lastSeq).toBeGreaterThanOrEqual(3)
    expect(r.stored.pendingUploads ?? []).toEqual([])
    expect(r.stored.checkpoint!.contents).toHaveLength(1)
    expect(missing(server, r.stored.checkpoint!.packs)).toEqual([])
  }, 60000)

  it('with no manifest yet, orphans of rejected first saves are reclaimed after the provider recovers', async () => {
    const server = new GcServer()
    let a = await controller(server)
    server.rejectCheckpointPut = true
    for (let i = 0; i < PENDING_UPLOAD_PRESSURE + 2; i++) await a.edit('first-' + i, { allowError: true })
    expect(a.stored.pendingUploads).toHaveLength(PENDING_UPLOAD_PRESSURE)
    const stored = structuredClone(a.stored),
      snapshot = structuredClone(a.snapshot)
    a.c.dispose()
    server.rejectCheckpointPut = false
    a = await controller(server, snapshot, stored)
    await a.rename()
    expect(a.c.view.status).toBe('saved')
    expect(await untracked(server, a.stored.checkpoint!)).toEqual([])
    now += PACK_GC_GRACE_MS + 1
    for (let i = 0; i < 8; i++) await a.rename()
    expect(server.slots.size).toBeLessThanOrEqual(8)
  }, 120000)

  it('BLOCKER: previous-generation packs that fill the budget are rotated to retired, then reclaimed', async () => {
    const server = new GcServer()
    const { snapshot } = await fullBudget(server, { since: 0, retiredSeq: 1 }, 'retained')
    const r = await controller(server, snapshot)
    await r.edit('needs another slot', { allowError: true })
    // Rotation is immediate; only the 24 h grace still blocks the upload.
    expect(r.c.view.status).toBe('error')
    expect(r.c.view.reason).toContain('waiting for GC grace')
    expect(r.stored.checkpoint?.retired?.length ?? 0).toBeGreaterThanOrEqual(MAX_PACKS - 1)
    expect(server.deleteLog).toEqual([])
    for (let day = 0; day < 4 && r.c.view.status !== 'saved'; day++) {
      now += PACK_GC_GRACE_MS + 1
      await r.c.flush()
    }
    expect(r.c.view.status).toBe('saved')
    expect(server.deleteLog.length).toBeGreaterThanOrEqual(MAX_PACKS - 1)
    expect(missing(server, r.stored.checkpoint!.packs)).toEqual([])
    expect(await untracked(server, r.stored.checkpoint!)).toEqual([])
  }, 120000)

  it('LEGACY: a pre-cap manifest with 1023 live packs is trimmed to the cap, then edits succeed', async () => {
    const server = new GcServer()
    const { snapshot } = await craftProtected(server, MAX_PACKS)
    let r = await controller(server, structuredClone(snapshot))
    await r.edit('changed', { allowError: true })
    // The omission transition is committed first; the upload then waits for the 24 h grace.
    expect(r.c.view.status).toBe('error')
    expect(r.c.view.reason).toContain('waiting for GC grace')
    const trimmed = r.stored.checkpoint!
    expect(r.stored.lastSeq).toBeGreaterThan(10)
    expect(trimmed.packs.length).toBeLessThanOrEqual(MAX_LIVE_PACKS)
    expect(trimmed.omitted?.length ?? 0).toBeGreaterThanOrEqual(MAX_PACKS - MAX_LIVE_PACKS)
    for (let round = 0; round < 4 && !['saved', 'saved-with-omissions'].includes(r.c.view.status); round++) {
      const stored = structuredClone(r.stored),
        saved = structuredClone(r.snapshot)
      r.c.dispose()
      now += PACK_GC_GRACE_MS + 1
      r = await controller(server, saved, stored)
      await r.c.flush()
    }
    expect(['saved', 'saved-with-omissions']).toContain(r.c.view.status)
    const cp = r.stored.checkpoint!
    expect(cp.packs.length).toBeLessThanOrEqual(MAX_LIVE_PACKS + 1)
    expect(server.deleteLog.length).toBeGreaterThanOrEqual(MAX_PACKS - MAX_LIVE_PACKS - 1)
    expect(missing(server, [...cp.packs, ...(cp.retained ?? [])])).toEqual([])
    for (let i = 0; i < 4; i++) await r.rename()
    expect(await untracked(server, r.stored.checkpoint!)).toEqual([])
  }, 300000)

  it('LEGACY: replacing every file of a pre-cap 1023-pack manifest recovers without a permanent deadlock', async () => {
    const server = new GcServer()
    const { snapshot } = await craftProtected(server, MAX_PACKS)
    let r = await controller(server, structuredClone(snapshot))
    const replaced = async () => {
      const files = await Promise.all(
        Array.from({ length: MAX_PACKS }, async (_, i) => {
          const bytes = utf8('replacement-' + i),
            f = await file(bytes, 'f' + i)
          sources.set(f.checksum, bytes)
          return f
        }),
      )
      await r.mutate((snap, stamp, node) => {
        snap.files = snap.files.map((old, i) =>
          stampFilePatch(old, { checksum: files[i].checksum, size: files[i].size, version: 50 }, stamp(), node),
        )
      }, { allowError: true })
    }
    await replaced()
    expect(r.c.view.status).toBe('error')
    expect(r.stored.checkpoint!.packs.length).toBeLessThanOrEqual(MAX_LIVE_PACKS)
    for (let round = 0; round < 5 && !['saved', 'saved-with-omissions'].includes(r.c.view.status); round++) {
      const stored = structuredClone(r.stored),
        saved = structuredClone(r.snapshot)
      r.c.dispose()
      now += PACK_GC_GRACE_MS + 1
      r = await controller(server, saved, stored)
      await r.c.flush()
    }
    expect(['saved', 'saved-with-omissions']).toContain(r.c.view.status)
    expect(r.stored.checkpoint!.contents.length).toBe(MAX_PACKS)
    expect(server.deleteLog.length).toBeGreaterThanOrEqual(MAX_PACKS - MAX_LIVE_PACKS - 1)
    expect(missing(server, r.stored.checkpoint!.packs)).toEqual([])
  }, 300000)

  it('BLOCKER: omitted content without local bytes does not block saves when capacity frees', async () => {
    const server = new GcServer()
    const { snapshot } = await craftProtected(server, MAX_LIVE_PACKS)
    const bytes = utf8('only the first member has these bytes'),
      extra = await file(bytes, 'extra')
    sources.set(extra.checksum, bytes)
    snapshot.files.push(extra)
    const first = await controller(server, structuredClone(snapshot))
    const omitted = await first.mutate(() => {})
    expect(omitted.omitted?.map((o) => [o.fileId, o.reason])).toEqual([['extra', 'capacity']])
    // A restored member (or another writer) does not have the bytes.
    sources.delete(extra.checksum)
    const stored = structuredClone(first.stored),
      saved = structuredClone(first.snapshot)
    first.c.dispose()
    let r = await controller(server, saved, stored)
    for (let day = 0; day < 3; day++) {
      const cp = await r.mutate((snap, stamp, node) => {
        const i = snap.files.findIndex((x) => x.id === 'f' + day)
        snap.files[i] = stampFilePatch(snap.files[i], { deletedAt: stamp() }, stamp(), node)
      })
      // Capacity is free, the bytes are not: the save proceeds with the file still omitted.
      expect(r.c.view.status).toBe('saved-with-omissions')
      expect(cp.omitted?.map((o) => [o.fileId, o.reason])).toEqual([['extra', 'unavailable']])
      expect(cp.contents.some((c) => c.fileId === 'extra')).toBe(false)
      now += PACK_GC_GRACE_MS + 1
      const keep = structuredClone(r.stored),
        snap = structuredClone(r.snapshot)
      r.c.dispose()
      r = await controller(server, snap, keep)
    }
    expect(r.stored.lastSeq).toBeGreaterThanOrEqual(13)
    // Once the bytes are available again the next save protects the file.
    sources.set(extra.checksum, bytes)
    const done = await r.rename()
    expect(done.contents.some((c) => c.fileId === 'extra')).toBe(true)
    expect(done.omitted ?? []).toEqual([])
    expect(r.c.view.status).toBe('saved')
  }, 180000)

  it('capacity policy: protected files stay protected, new content beyond the cap is omitted and admitted when room appears', async () => {
    const server = new GcServer()
    const { snapshot } = await craftProtected(server, MAX_LIVE_PACKS)
    const big = async (n: number) => {
      const bytes = new Uint8Array(PACK_BYTES)
      bytes.fill(n + 1)
      bytes[0] = n
      const f = await file(bytes, 'big' + n)
      sources.set(f.checksum, bytes)
      return f
    }
    snapshot.files.push(await big(0), await big(1), await big(2))
    const r = await controller(server, structuredClone(snapshot))
    const first = await r.mutate(() => {})
    expect(r.c.view.status).toBe('saved-with-omissions')
    expect(r.c.view.omittedFiles).toBe(3)
    expect(r.c.view.protectedFiles).toBe(MAX_LIVE_PACKS)
    expect(first.omitted?.map((o) => o.fileId).sort()).toEqual(['big0', 'big1', 'big2'])
    expect(first.packs).toHaveLength(MAX_LIVE_PACKS)
    expect(server.packSlots.size).toBe(0)
    // Stable: saving again changes nothing about who is protected.
    const again = await r.rename()
    expect(again.omitted).toEqual(first.omitted)
    expect(again.contents.map((c) => c.fileId)).toEqual(first.contents.map((c) => c.fileId))
    // An edit of a protected file frees its own pack first, so it stays protected (small first).
    const f5bytes = utf8('f5 edited'),
      f5 = await file(f5bytes, 'f5')
    sources.set(f5.checksum, f5bytes)
    const edited = await r.mutate((snap, stamp, node) => {
      const i = snap.files.findIndex((x) => x.id === 'f5')
      snap.files[i] = stampFilePatch(snap.files[i], { checksum: f5.checksum, size: f5.size, version: 99 }, stamp(), node)
    })
    expect(edited.contents).toHaveLength(MAX_LIVE_PACKS)
    // Deleting two protected files frees two packs: the next two omitted files are admitted.
    const freed = await r.mutate((snap, stamp, node) => {
      for (const id of ['f0', 'f1']) {
        const i = snap.files.findIndex((x) => x.id === id)
        snap.files[i] = stampFilePatch(snap.files[i], { deletedAt: stamp() }, stamp(), node)
      }
    })
    expect(r.c.view.status).toBe('saved-with-omissions')
    expect(freed.omitted?.map((o) => o.fileId)).toEqual(['big2'])
    expect(r.c.view.omittedFiles).toBe(1)
    expect(freed.contents.map((c) => c.fileId)).toEqual(expect.arrayContaining(['big0', 'big1']))
    expect(freed.packs.length).toBeLessThanOrEqual(MAX_LIVE_PACKS)
    expect(server.packSlots.size).toBe(3) // the edited f5 plus the two admitted files
    const last = await r.mutate((snap, stamp, node) => {
      const i = snap.files.findIndex((x) => x.id === 'f2')
      snap.files[i] = stampFilePatch(snap.files[i], { deletedAt: stamp() }, stamp(), node)
    })
    expect(r.c.view.status).toBe('saved')
    expect(last.omitted ?? []).toEqual([])
    expect(r.c.view.omittedFiles).toBe(0)
    expect(r.c.hasContent(r.snapshot.files.find((x) => x.id === 'big2')!)).toBe(true)
  }, 180000)
})

/** One live pack plus 1022 retired packs fill all 1023 slots of a manifest published at sequence 10. */
async function fullBudget(
  server: GcServer,
  retiredAt: { since: number; retiredSeq: number },
  as: 'retired' | 'retained' = 'retired',
) {
  const tx = await session(server),
    bytes = utf8('live'),
    f = await file(bytes)
  sources.set(f.checksum, bytes)
  const s = empty()
  s.files = [f]
  const content = await buildContentPacks(tx, 'root', 'secret', s.files, null, async () => bytes)
  const retired: RetiredPack[] = [],
    retained: PackEntry[] = []
  for (let i = 0; i < MAX_PACKS - 1; i++) {
    const digest = await sha256(utf8('dead-' + i)),
      nonce = i.toString(16).padStart(32, '0')
    const keys = await deriveEscrowKeys(PACK_APP, packInput('root', 'secret', digest, nonce))
    const head = await buildHead(keys, {
      seq: 1, parent: null, schema: PACK_APP, comp: 'none', size: 64, sha256: digest, cid: digest, at: 1,
    })
    server.slots.set(head.slot, head)
    if (as === 'retired') retired.push({ digest, nonce, since: retiredAt.since, seq: retiredAt.retiredSeq, head })
    else retained.push({ digest, length: 36, head, nonce })
  }
  const full = { ...manifest(s), ...content, retained, retired, deleting: [] }
  expect((await tx.client.saveCheckpoint(APP, folderInput('root', 'secret'), encodeCheckpoint(full), {
    schema: CHECKPOINT_SCHEMA, parent: null, seq: 10,
  })).type).toBe('ack')
  return { snapshot: structuredClone(s) }
}
