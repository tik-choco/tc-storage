/**
 * Permanent regressions for the W7 adversarial review (rv-w7): a blocker and three should-fix findings.
 * They drive only controller / buildContentPacks / verifyReferencedPacks, so they also run against the
 * pre-W7b implementation, where each one fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContentPacks, PACK_GC_GRACE_MS, verifyReferencedPacks } from '../folder/folderEscrowContent'
import {
  APP,
  CHECKPOINT_SCHEMA,
  encodeCheckpoint,
  folderInput,
  validateCheckpoint,
} from '../folder/folderCheckpoint'
import type { FolderCheckpoint, PackEntry } from '../folder/folderCheckpoint'
import type { FileRecord } from '../storage/domain'
import { stampFilePatch } from '../storage/crdt'
import { sha256, utf8 } from './crypto'
import { headHash } from './head'
import { GcServer, controller, empty, file, manifest, resetHarness, session, sources, time } from './contentPackGcHarness'

beforeEach(() => resetHarness())
afterEach(() => {
  resetHarness()
  vi.restoreAllMocks()
})
const missing = (server: GcServer, packs: PackEntry[]) =>
  packs.filter((p) => !server.slots.has(p.head.slot) || !server.blobs.has(p.head.cid)).map((p) => p.digest)

describe('rv-w7 regressions', () => {
  it('BLOCKER: GC must not delete a pack after another member publishes it', async () => {
    let now = Date.parse(time)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const server = new GcServer(),
      a = await controller(server)
    const first = await a.edit('a')
    await a.edit('b')
    await a.edit('c')
    now += PACK_GC_GRACE_MS + 1
    // An independent member, outside the controllers' queue: it publishes a manifest holding 'a' again.
    const b = await session(server),
      source = utf8('a'),
      snapshot = structuredClone(a.snapshot)
    sources.set(await sha256(source), source)
    snapshot.files[0] = stampFilePatch(
      snapshot.files[0],
      { checksum: await sha256(source), size: source.length, version: 1000 },
      '2026-10-12T01:00:00.000Z',
      'b',
    )
    let committed: Awaited<ReturnType<typeof b.client.saveCheckpoint>> | undefined
    let next: FolderCheckpoint | undefined
    const broken: string[] = []
    server.onDeleted = () => {
      if (next && committed?.type === 'ack') broken.push(...missing(server, next.packs))
    }
    let armed = true
    server.beforeDelete = async (slot) => {
      if (!armed || slot !== first.packs[0].head.slot) return
      armed = false
      const latest = await b.client.fetchLatest(APP, folderInput('root', 'secret'))
      const content = await buildContentPacks(b, 'root', 'secret', snapshot.files, null, async () => source)
      next = { ...manifest(snapshot), ...content, retained: latest ? (await validateCheckpoint(latest.plaintext, 'root', 'secret', 'app-room')).packs : [] }
      await validateCheckpoint(encodeCheckpoint(next), 'root', 'secret', 'app-room')
      committed = await b.client.saveCheckpoint(APP, folderInput('root', 'secret'), encodeCheckpoint(next), {
        schema: CHECKPOINT_SCHEMA,
        parent: await headHash(latest!.head),
        seq: latest!.head.seq + 1,
      })
      expect(committed.type).toBe('ack')
    }
    for (let i = 0; i < 8 && armed; i++) await a.rename()
    // The delete was issued while the other member's manifest was being published.
    expect(armed).toBe(false)
    for (let i = 0; i < 3; i++) await a.rename({ allowError: true })
    expect(server.hookErrors).toEqual([])
    expect(committed?.type).toBe('ack')
    expect({ atDelete: broken, afterRetry: missing(server, next!.packs) }).toEqual({ atDelete: [], afterRetry: [] })
  })

  it('SHOULD-FIX: restart after pack deletion before the manifest drops it must clear the absent entry', async () => {
    let now = Date.parse(time)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const server = new GcServer(),
      a = await controller(server)
    const first = await a.edit('a')
    await a.edit('b')
    await a.edit('c')
    now += PACK_GC_GRACE_MS + 1
    const slot = first.packs[0].head.slot
    // Once the pack DELETE is issued, the next manifest PUT is lost (process dies).
    server.beforeDelete = async (deleted) => {
      if (deleted === slot) server.dropCheckpointPut = true
    }
    for (let i = 0; i < 8 && !server.droppedPuts; i++) await a.rename({ allowError: true })
    expect(server.droppedPuts).toBeGreaterThan(0)
    await vi.waitUntil(() => !server.slots.has(slot), { timeout: 3000, interval: 5 })
    const stored = structuredClone(a.stored),
      snapshot = structuredClone(a.snapshot)
    a.c.dispose()
    server.dropCheckpointPut = false
    server.beforeDelete = undefined
    const restart = await controller(server, snapshot, stored)
    for (let i = 0; i < 3; i++) await restart.rename()
    expect(server.slots.has(slot)).toBe(false)
    const lists = [...(restart.stored.checkpoint!.retired ?? []), ...((restart.stored.checkpoint as { deleting?: PackEntry[] }).deleting ?? [])]
    expect(lists.some((p) => p.head.slot === slot), 'absent pack must leave the retirement lists').toBe(false)
  })

  it('SHOULD-FIX: a fast member clock must not expire another member retirement immediately', async () => {
    let writerNow = Date.parse(time)
    vi.spyOn(Date, 'now').mockImplementation(() => writerNow)
    const server = new GcServer(),
      a = await controller(server)
    const first = await a.edit('a')
    await a.edit('b')
    await a.edit('c')
    const snapshot = structuredClone(a.snapshot)
    a.c.dispose()
    // No real time elapsed; another member's clock is two days ahead.
    writerNow += 2 * PACK_GC_GRACE_MS
    const b = await controller(server, snapshot, undefined, undefined, 'b')
    await b.rename()
    expect(server.deleteLog, 'zero elapsed hours must not satisfy a 24h grace period').not.toContain(first.packs[0].head.slot)
    expect(server.slots.has(first.packs[0].head.slot)).toBe(true)
  })

  it('SHOULD-FIX: re-upload of a reused pack must work from all remaining file sources', async () => {
    const server = new GcServer(),
      tx = await session(server)
    const bytesA = utf8('A'),
      bytesB = utf8('B')
    const fileA = { ...(await file(bytesA)), id: 'a' },
      fileB = { ...(await file(bytesB)), id: 'b' }
    const all = [fileA, fileB],
      read = async (f: FileRecord) => (f.id === 'a' ? bytesA : bytesB)
    const packed = await buildContentPacks(tx, 'root', 'secret', all, null, read)
    expect(packed.packs).toHaveLength(1)
    const s = empty()
    s.files = all
    const old = { ...manifest(s), ...packed }
    // The new manifest drops B but keeps A's segment and the old combined AB pack.
    const reused = await buildContentPacks(tx, 'root', 'secret', [fileA], old, async () => bytesA)
    const head = reused.packs[0].head
    server.slots.delete(head.slot)
    server.blobs.delete(head.cid)
    // Another member collected AB after the builder looked. All remaining file bytes exist locally.
    await expect(
      verifyReferencedPacks(tx, 'root', 'secret', reused.packs, reused.contents, [fileA], async () => bytesA),
    ).resolves.toBeUndefined()
    expect(missing(server, reused.packs)).toEqual([])
  })
})
