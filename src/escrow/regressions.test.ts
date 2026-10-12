import { afterEach, expect, it, vi } from 'vitest'
import { FolderEscrowController } from '../app/folderEscrowController'
import { EscrowClient } from './client'
import { EscrowTestServer } from './storageTestTransport'
import { deriveEscrowKeys, encryptBlob, sha256 } from './crypto'
import { buildHead, headHash } from './head'
import {
  APP,
  CHECKPOINT_SCHEMA,
  MANIFEST_BYTES,
  encodeCheckpoint,
  folderInput,
  mergeFolderCheckpoint,
  projectFolder,
} from '../folder/folderCheckpoint'
import { readBrowserFile } from '../storage/fileIO'
import { optimisticUploadedFiles } from '../app/appFileActions'
import { mergeUploadedFiles } from '../app/appHelpers'
import { buildContentPacks } from '../folder/folderEscrowContent'
import { mergeSnapshots, normalizeFileVersions, normalizeFolderVersions } from '../storage/crdt'
import { validateCheckpoint } from '../folder/folderCheckpoint'
import { makeFolder, stripFileContent } from '../storage/domain'
import type { StorageSnapshot } from '../storage/domain'
import type { EscrowLocal } from '../storage/folderEscrow'
import { stampFolderPatch } from '../storage/crdt'
import { createMistEscrowTransport } from './mistTransport'
import { MistRuntimeBroker } from '../p2p/mistRuntime'
import type { MistModule } from '../p2p/p2pTypes'

const time = '2026-10-12T00:00:00.000Z'
const later = '2026-10-12T00:00:01.000Z'
const blank = (): StorageSnapshot => ({
  folders: [
    {
      ...makeFolder({
        id: 'root',
        name: 'Root',
        parentId: null,
        color: 'teal',
        roomId: 'app-room',
        now: time,
        nodeId: 'node-a',
      }),
      shareEnabled: true,
    },
  ],
  files: [],
  activity: [],
  clock: 1,
  originNode: 'node-a',
})
const live: FolderEscrowController[] = []
afterEach(() => {
  for (const c of live.splice(0)) c.dispose()
})

async function reader(server: EscrowTestServer, readFile = async () => new Uint8Array(), local?: EscrowLocal) {
  let snapshot = blank(),
    stored: EscrowLocal | undefined
  const c = new FolderEscrowController({
    folderId: 'root',
    key: 'secret',
    appRoom: 'app-room',
    nodeId: 'node-a',
    setting: { mode: 'custom', room: 'escrow-room' },
    snapshot: () => snapshot,
    merge: (cp) => {
      snapshot = mergeFolderCheckpoint(snapshot, cp)
    },
    readFile,
    changed: () => {},
    transport: (p) => server.transport(p),
    createClient: (t, r) =>
      new EscrowClient(t, r, {
        maxPlaintext: MANIFEST_BYTES,
        getTimeoutMs: 100,
        putTimeoutMs: 1000,
      }),
    loadLocal: () =>
      local ?? {
        lastSeq: 0,
        lastHash: null,
        providerSeen: false,
        savedAt: 0,
      },
    persist: (_r, v) => {
      stored = structuredClone(v)
    },
  })
  live.push(c)
  await c.start()
  await vi.waitUntil(() => ['ready', 'error'].includes(c.view.status), { timeout: 3000, interval: 5 })
  return {
    c,
    get snapshot() {
      return snapshot
    },
    set snapshot(v: StorageSnapshot) {
      snapshot = v
    },
    get stored() {
      return stored
    },
  }
}

async function signedCheckpoint(server: EscrowTestServer, seq: number, parent: string | null) {
  const snapshot = blank()
  snapshot.folders[0] = stampFolderPatch(snapshot.folders[0], { name: 'Version ' + seq }, later, 'node-b')
  const checkpoint = {
    v: 1 as const,
    rootFolderId: 'root',
    appRoomId: 'app-room',
    snapshot: projectFolder(snapshot, 'root'),
    contents: [],
    packs: [],
  }
  const keys = await deriveEscrowKeys(APP, folderInput('root', 'secret'))
  const blob = await encryptBlob(keys.encKey, keys.slot, seq, encodeCheckpoint(checkpoint))
  const cid = await sha256(blob)
  server.blobs.set(cid, blob)
  return buildHead(keys, {
    seq,
    parent,
    cid,
    size: blob.length,
    sha256: cid,
    schema: CHECKPOINT_SCHEMA,
    comp: 'none',
  })
}

it('disconnect flush must include edits made during an in-flight save', async () => {
  const server = new EscrowTestServer(),
    r = await reader(server)
  let release!: () => void,
    entered = false
  server.beforePut = async (h) => {
    if (h.schema !== CHECKPOINT_SCHEMA) return
    server.beforePut = undefined
    entered = true
    await new Promise<void>((resolve) => {
      release = resolve
    })
  }
  const first = r.c.flush()
  await vi.waitUntil(() => entered, { timeout: 3000, interval: 5 })
  r.snapshot = {
    ...r.snapshot,
    folders: [stampFolderPatch(r.snapshot.folders[0], { name: 'Edited before disconnect' }, later, 'node-a')],
  }
  r.c.observe()
  const beforeDisconnect = r.c.flush()
  release()
  await Promise.all([first, beforeDisconnect])
  r.c.dispose() // useMistShare tears down after awaiting this flush.
  expect(r.stored?.checkpoint?.snapshot.folders[0].name).toBe('Edited before disconnect')
})

it('a reader must reject rollback after restoring a newer signed head', async () => {
  const server = new EscrowTestServer()
  const old = await signedCheckpoint(server, 4, 'a'.repeat(64))
  const newer = await signedCheckpoint(server, 5, await headHash(old))
  server.heads.set('provider-a', new Map([[newer.slot, newer]]))
  const r = await reader(server)
  expect(r.snapshot.folders[0].name).toBe('Version 5')
  expect(server.putLog).toHaveLength(0)
  server.depart('provider-a')
  server.heads.get('provider-a')!.set(old.slot, old)
  server.arrive('provider-a')
  await vi.waitUntil(() => ['ready', 'error'].includes(r.c.view.status), { timeout: 3000, interval: 5 })
  expect(r.c.view.status).toBe('error')
  expect(r.c.view.reason).toContain('rollback')
})

it('leave and reacquire during a pending transport join must preserve the new lease', async () => {
  let finish!: () => void
  const joined: string[] = [],
    left: string[] = []
  const api = {
    init_with_config: () => true,
    register_event_callback: () => {},
    join_room_async: async (id: string) => {
      joined.push(id)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    },
    leave_room_id: (id: string) => {
      left.push(id)
    },
    get_neighbors_in_room: () => '[]',
    send_message_in_room: () => {},
  } as unknown as MistModule
  const t = createMistEscrowTransport('review-node', undefined, async () => api)
  const first = t.join('escrow-room')
  await vi.waitUntil(() => joined.length === 1, { timeout: 1000, interval: 5 })
  t.leave('escrow-room')
  const second = t.join('escrow-room')
  await new Promise((resolve) => setTimeout(resolve, 0))
  finish()
  await Promise.all([first, second])
  try {
    expect(left).toEqual([])
  } finally {
    t.leave('escrow-room')
  }
})

it('released room leases must not retain every historical peer', async () => {
  let emit!: (...e: unknown[]) => void
  const api = {
    register_event_callback: (cb: typeof emit) => {
      emit = cb
    },
    join_room_async: async () => {},
    leave_room_id: () => {},
  }
  const broker = new MistRuntimeBroker(api as unknown as MistModule)
  const owner = Symbol('review')
  for (let i = 0; i < 128; i++) {
    const room = 'escrow-' + i
    await broker.acquire(room, owner)
    emit(5, 'provider-' + i, new Uint8Array(), room)
    broker.release(room, owner)
  }
  expect((broker as unknown as { peers: Map<string, Set<string>> }).peers.size).toBe(0)
})

it('projects freshly uploaded metadata without stamps and round-trips content and merge winners', async () => {
  const server = new EscrowTestServer()
  const s = blank()
  const browserFile = new File(['fresh upload'], 'fresh.txt', { type: 'text/plain' })
  const uploaded = await readBrowserFile(browserFile, 'root', time, 'node-a')
  const optimistic = optimisticUploadedFiles(s.files, [uploaded], time, 'node-a')
  s.files = mergeUploadedFiles(s.files, optimistic.map(stripFileContent), time, 'node-a').map(stripFileContent)
  // Simulate metadata persisted by older clients that dropped stamps on a second content strip.
  s.files[0] = { ...s.files[0], fieldVersions: undefined }
  expect(s.files[0].fieldVersions).toBeUndefined()
  const original = structuredClone(s)
  const projected = projectFolder(s, 'root')
  expect(projected.files[0].fieldVersions).toEqual(normalizeFileVersions(s.files[0], s.originNode).fieldVersions)
  const transport = server.transport('provider-a')
  const client = new EscrowClient(transport, 'escrow-room', { getTimeoutMs: 100, putTimeoutMs: 1000 })
  try {
    await client.waitForProvider(1000)
    const content = await buildContentPacks(
      { client, transport, assertProvider: transport.assertProvider },
      'root',
      'secret',
      projected.files,
      null,
      async () => new Uint8Array(await browserFile.arrayBuffer()),
    )
    const decoded = await validateCheckpoint(
      encodeCheckpoint({ v: 1, rootFolderId: 'root', appRoomId: 'app-room', snapshot: projected, ...content }),
      'root',
      'secret',
      'app-room',
    )
    const local = blank()
    local.files = [
      {
        ...uploaded,
        name: 'Same time, intermediate node',
        dataUrl: undefined,
        fieldVersions: { name: { updatedAt: time, nodeId: 'node-0' } },
      },
    ]
    expect(mergeFolderCheckpoint(local, decoded).files).toEqual(mergeSnapshots(local, s).files)
    expect(mergeFolderCheckpoint(local, decoded).files[0].name).toBe('fresh.txt')
    const owner = await reader(server, async () => new Uint8Array(await browserFile.arrayBuffer()))
    owner.snapshot = s
    owner.c.observe()
    await owner.c.flush()
    expect(owner.c.view.status).toBe('saved')
    expect(owner.stored?.checkpoint?.snapshot.files[0].fieldVersions).toEqual(projected.files[0].fieldVersions)
    expect(s).toEqual(original)
  } finally {
    client.dispose()
  }
})

it('materializes partial and absent stamps using snapshot origin without changing existing stamps', () => {
  const s = blank()
  s.folders[0] = { ...s.folders[0], updatedAt: later, fieldVersions: { name: { updatedAt: later, nodeId: 'node-b' } } }
  s.files = [
    {
      id: 'partial',
      folderId: 'root',
      name: 'partial',
      mimeType: 'text/plain',
      size: 0,
      checksum: 'a'.repeat(64),
      version: 1,
      starred: false,
      createdAt: time,
      updatedAt: later,
      fieldVersions: { name: { updatedAt: time, nodeId: 'node-b' } },
    },
  ]
  const p = projectFolder(s, 'root')
  expect(p.files[0].fieldVersions).toEqual(normalizeFileVersions(s.files[0], s.originNode).fieldVersions)
  const expected = normalizeFolderVersions(s.folders[0], s.originNode).fieldVersions!
  for (const field of ['lastCid', 'lastSavedAt', 'lastSharedAt']) delete expected[field]
  expect(p.folders[0].fieldVersions).toEqual(expected)
  expect(p.files[0].fieldVersions?.folderId).toEqual({ updatedAt: '1970-01-01T00:00:00.000Z', nodeId: 'node-a' })
  s.folders[0] = { ...s.folders[0], fieldVersions: undefined }
  expect(projectFolder(s, 'root').folders[0].fieldVersions?.name).toEqual({ updatedAt: later, nodeId: 'node-a' })
})

it('flush during initial restore saves its requested revision before disconnect', async () => {
  const server = new EscrowTestServer()
  const head = await signedCheckpoint(server, 1, null)
  server.heads.set('provider-a', new Map([[head.slot, head]]))
  let snapshot = blank(),
    stored: EscrowLocal | undefined
  let entered = false,
    release!: () => void
  const c = new FolderEscrowController({
    folderId: 'root',
    key: 'secret',
    appRoom: 'app-room',
    nodeId: 'node-a',
    setting: { mode: 'custom', room: 'escrow-room' },
    snapshot: () => snapshot,
    merge: (cp) => {
      snapshot = mergeFolderCheckpoint(snapshot, cp)
    },
    readFile: async () => new Uint8Array(),
    changed: () => {},
    transport: (provider) => {
      const transport = server.transport(provider)
      if (provider) {
        const get = transport.storageGet
        transport.storageGet = async (cid) => {
          if (!entered) {
            entered = true
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
          return get(cid)
        }
      }
      return transport
    },
    createClient: (t, r) => new EscrowClient(t, r, { getTimeoutMs: 100, putTimeoutMs: 1000 }),
    loadLocal: () => ({ lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0 }),
    persist: (_room, value) => {
      stored = structuredClone(value)
    },
  })
  live.push(c)
  await c.start()
  await vi.waitUntil(() => entered, { timeout: 3000, interval: 5 })
  snapshot.folders[0] = stampFolderPatch(
    snapshot.folders[0],
    { name: 'Edited during restore' },
    '2026-10-12T00:00:02.000Z',
    'node-a',
  )
  c.observe()
  const flush = c.flush()
  release()
  await flush
  c.dispose()
  expect(stored?.checkpoint?.snapshot.folders[0].name).toBe('Edited during restore')
  expect(stored?.lastSeq).toBe(2)
})

it('disconnect flush stops on a failed follow-up save and keeps that revision dirty', async () => {
  const server = new EscrowTestServer(),
    r = await reader(server)
  let entered = false,
    release!: () => void
  server.beforePut = async (head) => {
    if (head.schema !== CHECKPOINT_SCHEMA) return
    server.beforePut = undefined
    entered = true
    await new Promise<void>((resolve) => {
      release = resolve
    })
  }
  const first = r.c.flush()
  await vi.waitUntil(() => entered, { timeout: 3000, interval: 5 })
  r.snapshot.folders[0] = stampFolderPatch(r.snapshot.folders[0], { name: 'Needs retry' }, later, 'node-a')
  r.c.observe()
  const flush = r.c.flush()
  server.beforePut = async () => {
    server.dropRootAck = true
  }
  release()
  await Promise.all([first, flush])
  expect(r.c.view.status).toBe('error')
  expect(r.stored?.lastSeq).toBe(1)
  expect(r.stored?.checkpoint?.snapshot.folders[0].name).toBe('Root')
  server.dropRootAck = false
  server.beforePut = undefined
  await r.c.flush()
  expect(r.c.view.status).toBe('saved')
  expect(r.stored?.checkpoint?.snapshot.folders[0].name).toBe('Needs retry')
})

it.each(['fork', 'missing', 'restart'])(
  'retains reader rollback protection for %s without marking a local save',
  async (kind) => {
    const server = new EscrowTestServer()
    const newer = await signedCheckpoint(server, 5, 'a'.repeat(64))
    server.heads.set('provider-a', new Map([[newer.slot, newer]]))
    const r = await reader(server)
    const stored = r.stored!
    expect(stored.verifiedSeq).toBe(5)
    expect(stored.verifiedHash).toBe(await headHash(newer))
    expect(stored.lastSeq).toBe(0)
    expect(stored.lastHash).toBeNull()
    expect(stored.savedAt).toBe(0)
    expect(r.c.view.savedAt).toBe(0)
    expect(server.putLog).toHaveLength(0)
    server.depart('provider-a')
    if (kind === 'missing') server.heads.get('provider-a')!.delete(newer.slot)
    else
      server.heads
        .get('provider-a')!
        .set(newer.slot, await signedCheckpoint(server, kind === 'fork' ? 5 : 4, 'b'.repeat(64)))
    if (kind === 'restart') {
      r.c.dispose()
      server.arrive('provider-a')
      const returning = await reader(server, async () => new Uint8Array(), stored)
      expect(returning.c.view.status).toBe('error')
      expect(returning.c.view.reason).toContain('rollback')
    } else {
      server.arrive('provider-a')
      await vi.waitUntil(() => ['ready', 'error'].includes(r.c.view.status), { timeout: 3000, interval: 5 })
      expect(r.c.view.status).toBe('error')
      expect(r.c.view.reason).toContain(kind === 'fork' ? 'rollback' : 'missing')
    }
    expect(server.putLog).toHaveLength(0)
  },
)

it('a stale failed transport load must not delete a replacement room', async () => {
  let reject!: (error: Error) => void
  let calls = 0
  const left: string[] = []
  const api = {
    init_with_config: () => true,
    register_event_callback: () => {},
    join_room_async: async () => {},
    leave_room_id: (id: string) => {
      left.push(id)
    },
    get_neighbors_in_room: () => '[]',
    send_message_in_room: () => {},
  } as unknown as MistModule
  const t = createMistEscrowTransport('review-node', undefined, () => {
    if (++calls === 1)
      return new Promise<MistModule>((_resolve, fail) => {
        reject = fail
      })
    return Promise.resolve(api)
  })
  const first = t.join('room')
  const failed = expect(first).rejects.toThrow('obsolete load')
  t.leave('room')
  await t.join('room')
  reject(new Error('obsolete load'))
  await failed
  try {
    expect(() => t.send('room', null, new Uint8Array())).not.toThrow()
    expect(left).toEqual([])
  } finally {
    t.leave('room')
  }
  expect(left).toEqual(['room'])
})

it.each([false, true])('cleans peer state after an unowned pending join completes (failure: %s)', async (fail) => {
  let emit!: (...events: unknown[]) => void
  let finish!: () => void
  const api = {
    register_event_callback: (cb: typeof emit) => {
      emit = cb
    },
    join_room_async: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      if (fail) throw new Error('join failed')
    },
    leave_room_id: () => {},
  }
  const broker = new MistRuntimeBroker(api as unknown as MistModule)
  const owner = Symbol('pending owner')
  const pending = broker.acquire('room', owner).catch(() => {})
  emit(5, 'provider', new Uint8Array(), 'room')
  broker.release('room', owner)
  emit(5, 'late-before-completion', new Uint8Array(), 'room')
  finish()
  await pending
  emit(5, 'late-after-completion', new Uint8Array(), 'room')
  emit(0, 'late-message', new Uint8Array(), 'never-owned')
  const state = broker as unknown as {
    peers: Map<string, Set<string>>
    rooms: Map<string, unknown>
  }
  expect(state.peers.size).toBe(0)
  expect(state.rooms.size).toBe(0)
})
