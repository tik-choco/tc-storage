/**
 * Seeded randomized liveness/safety test for content-pack GC. Two writers (second one in its own
 * module instance) edit, rename, restart and step the clock while the provider rejects manifests,
 * loses ACKs, delivers pack PUTs late and refuses DELETEs. After every step no current or previous
 * manifest may reference a missing pack. After a final error-free phase with time passing, both
 * writers must save again (liveness) and the provider must hold nothing but what the lists track.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP, MAX_LIVE_PACKS, PACK_BYTES, folderInput, manifestSlots, validateCheckpoint } from '../folder/folderCheckpoint'
import type { FolderCheckpoint } from '../folder/folderCheckpoint'
import { deriveEscrowKeys } from './crypto'
import { GcServer, controller, craftProtected, file, resetHarness, session, sources, time } from './contentPackGcHarness'
import { sha256 } from './crypto'

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

function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Writer = Awaited<ReturnType<typeof controller>>
async function run(seed: number, steps: number, nearCap = false) {
  const rand = random(seed)
  const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)]
  const server = new GcServer()
  const observer = await session(server)
  const second = await (async () => {
    vi.resetModules()
    return (await import('../app/folderEscrowController')).FolderEscrowController
  })()
  const manifestSlot = (await deriveEscrowKeys(APP, folderInput('root', 'secret'))).slot
  const writers: { name: 'a' | 'b'; w: Writer }[] = []
  // Near the cap: 250 protected files in 250 packs, so only six more packs fit under MAX_LIVE_PACKS.
  const crafted = nearCap ? await craftProtected(server, MAX_LIVE_PACKS - 6) : undefined
  const a = await controller(server, crafted ? structuredClone(crafted.snapshot) : undefined, undefined, undefined, 'a')
  if (!crafted) await a.edit('base')
  writers.push({ name: 'a', w: a })
  writers.push({ name: 'b', w: await controller(server, structuredClone(a.snapshot), undefined, second, 'b') })

  async function current(): Promise<FolderCheckpoint | null> {
    const latest = await observer.client.fetchLatest(APP, folderInput('root', 'secret'))
    return latest ? validateCheckpoint(latest.plaintext, 'root', 'secret', 'app-room') : null
  }
  /** Safety: nothing the current or the previous manifest references may be missing. */
  async function assertSafe(where: string) {
    const cp = await current()
    if (!cp) return cp
    const lost = [...cp.packs, ...(cp.retained ?? [])].filter(
      (p) => server.slots.get(p.head.slot)?.cid !== p.head.cid || !server.blobs.has(p.head.cid),
    )
    expect(lost.map((p) => p.head.slot), `seed ${seed} ${where}: referenced pack missing`).toEqual([])
    return cp
  }
  let release: (() => void) | undefined
  const clearFaults = async () => {
    server.rejectCheckpointPut = false
    server.dropRootAck = false
    server.dropPackAck = false
    server.dropCheckpointPut = false
    server.deleteResult = undefined
    server.holdPackPut = undefined
    if (release) {
      release()
      release = undefined
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
  let unique = 0
  for (let step = 0; step < steps; step++) {
    const writer = pick(writers)
    const roll = rand()
    if (roll < 0.1) server.rejectCheckpointPut = true
    else if (roll < 0.13) server.dropRootAck = true
    else if (roll < 0.16) server.dropPackAck = true
    else if (roll < 0.2) {
      const gate = new Promise<void>((resolve) => (release = resolve))
      server.holdPackPut = () => gate
    } else if (roll < 0.28) server.deleteResult = 'busy'
    const op = rand()
    if (nearCap && op < 0.2) {
      // A new file of one full pack of data: only some of them fit under the cap.
      const bytes = new Uint8Array(PACK_BYTES)
      bytes.fill(1 + (++unique % 250))
      bytes[0] = unique % 256
      bytes[1] = Math.floor(unique / 256)
      const added = await file(bytes, 'g' + unique + '-' + seed)
      sources.set(await sha256(bytes), bytes)
      await writer.w.mutate((s) => {
        s.files.push(added)
      }, { allowError: true })
    } else if (op < 0.4) await writer.w.edit(rand() < 0.5 ? 'v' + Math.floor(rand() * 6) : 'u' + ++unique + seed, { allowError: true })
    else if (op < 0.55) await writer.w.rename({ allowError: true })
    else if (op < 0.7) {
      await clearFaults()
      const stored = structuredClone(writer.w.stored),
        snapshot = structuredClone(writer.w.snapshot)
      writer.w.c.dispose()
      writer.w = await controller(server, snapshot, stored, writer.name === 'b' ? second : undefined, writer.name)
    } else if (op < 0.85) now += pick([60_000, 3_600_000, 26 * 3_600_000])
    else if (op < 0.92) {
      // A burst of rejected saves piles up unresolved uploads.
      server.rejectCheckpointPut = true
      for (let i = 0; i < 4; i++) await writer.w.edit('burst' + ++unique + seed, { allowError: true })
    } else {
      now += 26 * 3_600_000
      await writer.w.rename({ allowError: true })
    }
    await clearFaults()
    await assertSafe('step ' + step)
  }

  // Final error-free phase with time passing: liveness.
  const calm = (writer: { w: Writer }) => ['saved', 'saved-with-omissions'].includes(writer.w.c.view.status)
  await clearFaults()
  for (let round = 0; round < 14; round++) {
    now += 26 * 3_600_000
    for (const writer of writers) await writer.w.rename({ allowError: true })
    if (writers.every(calm)) break
  }
  for (const writer of writers)
    expect(calm(writer), `seed ${seed}: writer ${writer.name} must recover (${writer.w.c.view.reason})`).toBe(true)
  // Drain: after more manifests and days every retired pack is reclaimed.
  for (let round = 0; round < 8; round++) {
    now += 26 * 3_600_000
    for (const writer of writers) await writer.w.rename()
  }
  const cp = (await assertSafe('final'))!
  const intents = writers.reduce((n, writer) => n + (writer.w.stored.pendingUploads?.length ?? 0), 0)
  const known = manifestSlots(cp)
  const stray = [...server.slots.keys()].filter((slot) => slot !== manifestSlot && !known.has(slot))
  expect(stray.length, `seed ${seed}: slots outside every list`).toBeLessThanOrEqual(intents)
  expect((cp.retired?.length ?? 0) + (cp.deleting?.length ?? 0), `seed ${seed}: retirement lists drain`).toBeLessThanOrEqual(8)
  expect(server.slots.size).toBeLessThanOrEqual(1 + known.size + intents)
  if (!nearCap)
    for (const writer of writers) {
      const first = writer.w.snapshot.files[0]
      expect(await writer.w.c.loadContent(first), `seed ${seed}: content of ${writer.name} restorable`).toContain('data:')
    }
  // The live packs stay under the cap, and every file is either protected or reported as omitted.
  expect(cp.packs.length).toBeLessThanOrEqual(nearCap ? MAX_LIVE_PACKS : 4)
  const live = cp.snapshot.files.filter((f) => !f.deletedAt)
  expect(cp.contents.length + (cp.omitted?.length ?? 0)).toBe(live.length)
  expect(server.hookErrors).toEqual([])
  return { seed, steps, retired: cp.retired?.length ?? 0, slots: server.slots.size, deletes: server.deleteLog.length }
}

// VITE_GC_FUZZ_SEEDS=40 explores more seeds locally; the committed run is fixed and deterministic.
const extra = Number((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_GC_FUZZ_SEEDS ?? 0)
const seeds = Array.from({ length: 6 + (Number.isInteger(extra) && extra > 0 ? extra : 0) }, (_, i) => i + 1)
describe('content-pack GC fuzz (liveness and safety)', () => {
  it.each(seeds)('seed %i', async (seed) => {
    const result = await run(seed, 34)
    expect(result.slots).toBeLessThan(20)
  }, 60000)
  it.each([101, 102, 103])('near the live-pack cap, seed %i', async (seed) => {
    const result = await run(seed, 26, true)
    expect(result.slots).toBeLessThan(MAX_LIVE_PACKS + 40)
  }, 120000)
})
