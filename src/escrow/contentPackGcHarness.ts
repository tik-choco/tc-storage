/** Shared fixtures for the content-pack GC tests: a delete-capable mistl double and controller driver. */
import { vi } from 'vitest'
import { FolderEscrowController } from '../app/folderEscrowController'
import {
  APP,
  CHECKPOINT_SCHEMA,
  MANIFEST_BYTES,
  PACK_APP,
  encodeCheckpoint,
  folderInput,
  mergeFolderCheckpoint,
  packInput,
  projectFolder,
} from '../folder/folderCheckpoint'
import type { FolderCheckpoint } from '../folder/folderCheckpoint'
import { makeFileFromDataUrl, makeFolder } from '../storage/domain'
import type { FileRecord, StorageSnapshot } from '../storage/domain'
import { stampFilePatch, stampFolderPatch } from '../storage/crdt'
import type { EscrowLocal } from '../storage/folderEscrow'
import { EscrowClient } from './client'
import { deriveEscrowKeys, sha256, utf8 } from './crypto'
import { buildHead, headHash } from './head'
import type { EscrowHead } from './head'
import { encodeEscrowMessage, parseEscrowMessage } from './protocol'
import { EscrowTestServer } from './storageTestTransport'

export const time = '2026-10-12T00:00:00.000Z'
export const active: { dispose(): void }[] = []
/** Monotonic edit stamp shared by all controllers of one test. */
export const clock = { tick: 0 }
export const sources = new Map<string, Uint8Array>()
export const resetHarness = () => {
  clock.tick = 0
  sources.clear()
  for (const c of active.splice(0)) c.dispose()
}
export const empty = (): StorageSnapshot => ({
  clock: 1,
  originNode: 'a',
  activity: [],
  files: [],
  folders: [
    {
      ...makeFolder({ id: 'root', name: 'Root', parentId: null, color: 'teal', roomId: 'app-room', now: time, nodeId: 'a' }),
      shareEnabled: true,
    },
  ],
})
export const manifest = (s = empty()): FolderCheckpoint => ({
  v: 1, rootFolderId: 'root', appRoomId: 'app-room', snapshot: projectFolder(s, 'root'), contents: [], packs: [],
})
export async function file(bytes: Uint8Array, id = 'file'): Promise<FileRecord> {
  return makeFileFromDataUrl({
    id, folderId: 'root', name: id, mimeType: 'text/plain', size: bytes.length,
    checksum: await sha256(bytes), dataUrl: 'data:text/plain;base64,', now: time, nodeId: 'a',
  })
}

type Hook = () => Promise<void>
/** Delete-capable provider double; DELETE semantics follow mistl/docs/escrow.md. */
export class GcServer extends EscrowTestServer {
  supportsDelete = true
  deleteResult?: 'conflict' | 'busy' | 'quota'
  deleteLog: string[] = []
  requests: string[] = []
  hookErrors: unknown[] = []
  beforeGet?: (slot: string) => void
  /** Runs before every DELETE is processed; the DELETE waits for it. */
  beforeDelete?: (slot: string) => Promise<void>
  /** Runs once before the next manifest PUT is forwarded; the PUT waits for it. */
  beforeCheckpointPut?: Hook
  dropCheckpointPut = false
  droppedPuts = 0
  /** Swallow the ACK of pack PUTs (the slot is stored; the writer never learns). */
  dropPackAck = false
  /** Answer manifest PUTs at once with a quota error (a fast failing save). */
  rejectCheckpointPut = false
  /** Runs once before the next pack PUT is forwarded; the PUT waits for it (a PUT that lands late). */
  holdPackPut?: Hook
  packSlots = new Set<string>()
  onDeleted?: (slot: string) => void
  peakSlots = 0
  constructor() {
    super()
    this.beforePut = async (head) => {
      const heads = this.heads.get('provider-a')!
      this.peakSlots = Math.max(this.peakSlots, heads.size + Number(!heads.has(head.slot)))
    }
  }
  get slots(): Map<string, EscrowHead> {
    let slots = this.heads.get('provider-a')
    if (!slots) {
      slots = new Map()
      this.heads.set('provider-a', slots)
    }
    return slots
  }
  override transport(provider?: string) {
    const t = super.transport(provider)
    const listeners = new Map<string, Set<(from: string, bytes: Uint8Array) => void>>()
    const originalOn = t.onMessage,
      originalSend = t.send
    t.onMessage = (room, cb) => {
      const callbacks = listeners.get(room) ?? new Set()
      listeners.set(room, callbacks)
      callbacks.add(cb)
      const off = originalOn(room, (id, bytes) => {
        const m = parseEscrowMessage(bytes)
        if (this.dropPackAck && m?.type === 'escrow_ack' && this.packSlots.has(m.slot)) return
        cb(id, m?.type === 'escrow_provider' && this.supportsDelete
          ? encodeEscrowMessage({ ...m, features: ['delete'] }) : bytes)
      })
      return () => {
        callbacks.delete(cb)
        off()
      }
    }
    t.send = (room, to, bytes) => {
      const m = parseEscrowMessage(bytes)
      if (!m) return
      this.requests.push(m.type)
      if (m.type === 'escrow_get') this.beforeGet?.(m.slot)
      if (m.type === 'escrow_put' && m.head.schema === PACK_APP) this.packSlots.add(m.head.slot)
      if (m.type === 'escrow_put' && m.head.schema === PACK_APP && this.holdPackPut) {
        const hook = this.holdPackPut
        this.holdPackPut = undefined
        void hook().catch((e) => this.hookErrors.push(e)).then(() => originalSend(room, to, bytes))
        return
      }
      if (m.type === 'escrow_put' && m.head.schema === CHECKPOINT_SCHEMA) {
        if (this.rejectCheckpointPut) {
          const reply = encodeEscrowMessage({ v: 1, type: 'escrow_error', id: m.id, code: 'quota', message: 'quota' })
          for (const cb of listeners.get(room) ?? []) cb(to ?? 'provider-a', reply)
          return
        }
        if (this.dropCheckpointPut) {
          this.droppedPuts++
          return
        }
        const hook = this.beforeCheckpointPut
        if (hook) {
          this.beforeCheckpointPut = undefined
          void hook().catch((e) => this.hookErrors.push(e)).then(() => originalSend(room, to, bytes))
          return
        }
      }
      if (m.type !== 'escrow_delete') {
        originalSend(room, to, bytes)
        return
      }
      void (async () => {
        try {
          await this.beforeDelete?.(m.slot)
        } catch (e) {
          this.hookErrors.push(e)
        }
        const heads = this.heads.get(to!)!
        const current = heads.get(m.slot)
        this.deleteLog.push(m.slot)
        const code =
          this.deleteResult ??
          (current && (current.seq !== m.seq || (await headHash(current)) !== m.head) ? 'conflict' : undefined)
        const reply =
          code === 'conflict'
            ? encodeEscrowMessage({ v: 1, type: 'escrow_error', id: m.id, code, message: code, head: current ?? null })
            : code
              ? encodeEscrowMessage({ v: 1, type: 'escrow_error', id: m.id, code, message: code })
              : encodeEscrowMessage({ v: 1, type: 'escrow_deleted', id: m.id, slot: m.slot })
        if (!code) {
          heads.delete(m.slot)
          if (current) this.blobs.delete(current.cid)
        }
        for (const cb of listeners.get(room) ?? []) cb(to!, reply)
        if (!code) this.onDeleted?.(m.slot)
      })()
    }
    return t
  }
}
/**
 * A published manifest (sequence 10) protecting `count` small files, each in its own pack with a
 * valid signed head on the provider. Tiny stand-ins for packs of up to 8 MiB each: they let a test
 * reach the live-pack cap without moving gigabytes.
 */
export async function craftProtected(server: GcServer, count: number) {
  const tx = await session(server)
  const s = empty()
  const contents: FolderCheckpoint['contents'] = [],
    packs: FolderCheckpoint['packs'] = []
  for (let i = 0; i < count; i++) {
    const bytes = utf8('dead-' + i),
      f = await file(bytes, 'f' + i),
      nonce = i.toString(16).padStart(32, '0')
    sources.set(f.checksum, bytes)
    const keys = await deriveEscrowKeys(PACK_APP, packInput('root', 'secret', f.checksum, nonce))
    const head = await buildHead(keys, {
      seq: 1, parent: null, schema: PACK_APP, comp: 'none', size: bytes.length + 28, sha256: f.checksum, cid: f.checksum, at: 1,
    })
    server.slots.set(head.slot, head)
    server.blobs.set(head.cid, new Uint8Array(head.size))
    s.files.push(f)
    contents.push({ fileId: f.id, checksum: f.checksum, size: f.size, segments: [{ packDigest: f.checksum, offset: 0, length: f.size }] })
    packs.push({ digest: f.checksum, length: bytes.length, head, nonce })
  }
  packs.sort((a, b) => a.digest.localeCompare(b.digest))
  const published = { ...manifest(s), contents, packs, retained: [], retired: [], deleting: [] }
  const ack = await tx.client.saveCheckpoint(APP, folderInput('root', 'secret'), encodeCheckpoint(published), {
    schema: CHECKPOINT_SCHEMA, parent: null, seq: 10,
  })
  if (ack.type !== 'ack') throw new Error('crafted manifest rejected')
  return { snapshot: structuredClone(s), packs }
}
export async function session(server: EscrowTestServer) {
  const transport = server.transport('provider-a')
  const client = new EscrowClient(transport, 'escrow-room', { getTimeoutMs: 200, putTimeoutMs: 400 })
  active.push(client)
  await client.waitForProvider(500)
  return { client, transport, assertProvider: transport.assertProvider }
}
export async function controller(
  server: EscrowTestServer,
  initial = empty(),
  local?: EscrowLocal,
  Ctor: typeof FolderEscrowController = FolderEscrowController,
  nodeId = 'a',
) {
  let snapshot = initial,
    stored = local
  const c = new Ctor({
    folderId: 'root', key: 'secret', appRoom: 'app-room', nodeId, setting: { mode: 'custom', room: 'escrow-room' },
    snapshot: () => snapshot,
    merge: (checkpoint) => {
      snapshot = mergeFolderCheckpoint(snapshot, checkpoint)
    },
    readFile: async (f) => {
      const b = sources.get(f.checksum)
      if (!b) throw new Error('missing source')
      return b
    },
    changed: () => {},
    transport: (p) => server.transport(p),
    createClient: (t, r) => new EscrowClient(t, r, { maxPlaintext: MANIFEST_BYTES, getTimeoutMs: 200, putTimeoutMs: 500 }),
    loadLocal: () => stored ?? { lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0 },
    persist: (_room, value) => {
      stored = structuredClone(value)
    },
  })
  active.push(c)
  await c.start()
  await vi.waitUntil(() => !['searching', 'restoring'].includes(c.view.status), { timeout: 30000, interval: 5 })
  const stamp = () => new Date(Date.parse(time) + ++clock.tick * 1000).toISOString()
  return {
    c,
    data: sources,
    get stored() {
      return stored!
    },
    get snapshot() {
      return snapshot
    },
    /** Arbitrary snapshot change (several files), then a save. */
    async mutate(
      fn: (snapshot: StorageSnapshot, stamp: () => string, nodeId: string) => void,
      options: { allowError?: boolean } = {},
    ) {
      fn(snapshot, stamp, nodeId)
      c.observe()
      await c.flush()
      if (!options.allowError && c.view.reason !== undefined) throw new Error('mutate failed: ' + c.view.reason)
      return stored!.checkpoint!
    },
    /** Change the file content without saving. */
    async set(value: string) {
      const bytes = utf8(value),
        f = await file(bytes)
      sources.set(f.checksum, bytes)
      snapshot.files = [
        stampFilePatch(snapshot.files[0] ?? f, { checksum: f.checksum, size: f.size, version: clock.tick + 1 }, stamp(), nodeId),
      ]
      c.observe()
    },
    async edit(value: string, options: { allowError?: boolean } = {}) {
      const bytes = utf8(value),
        f = await file(bytes)
      sources.set(f.checksum, bytes)
      snapshot.files = [
        stampFilePatch(snapshot.files[0] ?? f, { checksum: f.checksum, size: f.size, version: clock.tick + 1 }, stamp(), nodeId),
      ]
      c.observe()
      await c.flush()
      if (!options.allowError && (c.view.reason !== undefined || !['saved', 'saved-with-omissions'].includes(c.view.status)))
        throw new Error('edit not saved: ' + c.view.status + ' ' + c.view.reason)
      return stored!.checkpoint!
    },
    async rename(options: { allowError?: boolean } = {}) {
      snapshot.folders[0] = stampFolderPatch(snapshot.folders[0], { name: 'Root ' + (clock.tick + 1) }, stamp(), nodeId)
      c.observe()
      await c.flush()
      if (!options.allowError && c.view.reason !== undefined) throw new Error('rename failed: ' + c.view.reason)
      return stored!.checkpoint!
    },
  }
}
