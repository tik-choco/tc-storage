import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP,
  CHECKPOINT_SCHEMA,
  PACK_APP,
  PACK_BYTES,
  MANIFEST_BYTES,
  MAX_PACKS,
  checkpointFingerprint,
  encodeCheckpoint,
  folderInput,
  mergeFolderCheckpoint,
  projectFolder,
  validateCheckpoint,
} from '../folder/folderCheckpoint'
import type { FolderCheckpoint } from '../folder/folderCheckpoint'
import { buildContentPacks, readPinnedPack, reconstructContent } from '../folder/folderEscrowContent'
import { makeFileFromDataUrl, makeFolder, stripFileContent } from '../storage/domain'
import type { StorageSnapshot } from '../storage/domain'
import { normalizeSnapshot, stampFilePatch, stampFolderPatch } from '../storage/crdt'
import { FolderEscrowController } from '../app/folderEscrowController'
import type { EscrowLocal } from '../storage/folderEscrow'
import { EscrowClient } from './client'
import { deriveAutoRoom, deriveEscrowKeys, encryptBlob, sha256, utf8 } from './crypto'
import { buildHead } from './head'
import { EscrowTestServer } from './storageTestTransport'

const time = '2026-10-12T00:00:00.000Z',
  later = '2026-10-12T00:00:01.000Z'
const folder = () => ({
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
})
const snapshot = (): StorageSnapshot => ({
  folders: [folder()],
  files: [],
  activity: [],
  clock: 1,
  originNode: 'node-a',
})
const file = async (id: string, bytes: Uint8Array) =>
  makeFileFromDataUrl({
    id,
    folderId: 'root',
    name: id,
    mimeType: 'application/octet-stream',
    size: bytes.length,
    dataUrl: 'data:application/octet-stream;base64,',
    checksum: await sha256(bytes),
    now: time,
    nodeId: 'node-a',
  })
const checkpoint = (s = snapshot()): FolderCheckpoint => ({
  v: 1,
  rootFolderId: 'root',
  appRoomId: 'app-room',
  snapshot: projectFolder(s, 'root'),
  contents: [],
  packs: [],
})
const controllers: FolderEscrowController[] = []
const clients: EscrowClient[] = []
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose()
  for (const c of clients.splice(0)) c.dispose()
  vi.useRealTimers()
})
async function session(server: EscrowTestServer) {
  const transport = server.transport('provider-a'),
    client = new EscrowClient(transport, 'escrow-room', { getTimeoutMs: 100, putTimeoutMs: 200 })
  clients.push(client)
  await client.waitForProvider(200)
  return { client, transport, assertProvider: transport.assertProvider }
}
async function controller(
  server: EscrowTestServer,
  s = snapshot(),
  readFile = async () => new Uint8Array(),
  local?: EscrowLocal,
) {
  let current = s,
    stored: EscrowLocal | undefined = local
  const c = new FolderEscrowController({
    folderId: 'root',
    key: 'secret',
    appRoom: 'app-room',
    nodeId: 'node-a',
    setting: { mode: 'custom', room: 'escrow-room' },
    snapshot: () => current,
    merge: (remote) => {
      current = mergeFolderCheckpoint(current, remote)
    },
    readFile,
    createClient: (transport, room) =>
      new EscrowClient(transport, room, { maxPlaintext: MANIFEST_BYTES, getTimeoutMs: 100, putTimeoutMs: 200 }),
    changed: () => {},
    transport: (p) => server.transport(p),
    loadLocal: () => stored ?? { lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0 },
    persist: (_room, v) => {
      stored = structuredClone(v)
    },
  })
  controllers.push(c)
  await c.start()
  await vi.waitUntil(() => ['ready', 'error'].includes(c.view.status), { timeout: 3000, interval: 5 })
  return {
    c,
    get current() {
      return current
    },
    set current(v: StorageSnapshot) {
      current = v
    },
    get stored() {
      return stored
    },
  }
}

describe('folder checkpoint validation and projection', () => {
  it('uses the specified secret input and custom only changes routing', async () => {
    expect(folderInput('Root', ' secret ')).toBe('["folder","Root","secret"]')
    expect(await deriveAutoRoom(APP, folderInput('root', 'secret'))).not.toBe(await deriveAutoRoom(APP, 'root'))
    expect((await deriveEscrowKeys(APP, folderInput('root', 'secret'))).slot).not.toBe(
      (await deriveEscrowKeys(APP, folderInput('root', 'other'))).slot,
    )
  })
  it('projects only the subtree, strips content/activity/publication fields and ignores publication dirtiness', async () => {
    // Keep all non-publication stamps identical across the publication-only patch.
    const s = normalizeSnapshot(snapshot())
    s.folders.push({ ...folder(), id: 'unrelated' })
    s.files.push(await file('file-a', utf8('a')))
    const before = checkpointFingerprint(s, 'root')
    s.folders[0] = stampFolderPatch(
      s.folders[0],
      { lastCid: 'cid', lastSavedAt: later, lastSharedAt: later },
      later,
      'node-a',
    )
    s.clock++
    expect(checkpointFingerprint(s, 'root')).toBe(before)
    const p = projectFolder(s, 'root')
    expect(p.folders).toHaveLength(1)
    expect(p.files[0].dataUrl).toBeUndefined()
    expect(p.folders[0].lastCid).toBeUndefined()
    expect(p.activity).toEqual([])
  })
  it('preserves root placement, unrelated records, tombstones and original remote stamps', async () => {
    const s = snapshot()
    s.folders.unshift({ ...folder(), id: 'local-parent', shareEnabled: false })
    s.folders[1] = { ...s.folders[1], parentId: 'local-parent' }
    const remote = checkpoint()
    remote.snapshot.folders[0] = stampFolderPatch(remote.snapshot.folders[0], { name: 'Remote' }, later, 'node-b')
    remote.snapshot.files = [
      stripFileContent(stampFilePatch(await file('dead', new Uint8Array()), { deletedAt: later }, later, 'node-b')),
    ]
    const merged = mergeFolderCheckpoint(s, remote)
    expect(merged.folders.find((f) => f.id === 'root')?.parentId).toBe('local-parent')
    expect(merged.folders.find((f) => f.id === 'root')?.fieldVersions?.name).toEqual({
      updatedAt: later,
      nodeId: 'node-b',
    })
    expect(merged.files[0].deletedAt).toBe(later)
    expect(merged.folders).toHaveLength(2)
    expect(await validateCheckpoint(encodeCheckpoint(remote), 'root', 'secret', 'app-room')).toEqual(remote)
  })
  it.each(['wrong-root', 'wrong-room', 'bad-date', 'duplicate', 'cycle', 'secret', 'no-content', 'bad-setting'])(
    'rejects %s before merge',
    async (kind) => {
      const c = checkpoint()
      if (kind === 'wrong-root') c.rootFolderId = 'other'
      if (kind === 'wrong-room') c.appRoomId = 'other'
      if (kind === 'bad-date') c.snapshot.folders[0].updatedAt = 'today'
      if (kind === 'duplicate') c.snapshot.folders.push(c.snapshot.folders[0])
      if (kind === 'cycle') c.snapshot.folders[0].parentId = 'root'
      if (kind === 'secret') (c.snapshot.folders[0] as unknown as Record<string, unknown>).folderKey = 'secret'
      if (kind === 'no-content') c.snapshot.files.push(await file('missing', utf8('a')))
      if (kind === 'bad-setting') c.snapshot.folders[0].escrow = { mode: 'custom', room: 'bad room' }
      await expect(validateCheckpoint(encodeCheckpoint(c), 'root', 'secret', 'app-room')).rejects.toThrow()
    },
  )
  it('rejects nested independently shared roots and both manifest bounds', () => {
    const s = snapshot()
    s.folders.push({ ...folder(), id: 'nested', parentId: 'root' })
    expect(() => projectFolder(s, 'root')).toThrow('Nested')
    const c = checkpoint()
    c.snapshot.folders[0].name = 'x'.repeat(MANIFEST_BYTES)
    expect(() => encodeCheckpoint(c)).toThrow('16 MiB')
    c.snapshot.folders[0].name = 'Root'
    c.packs = Array(MAX_PACKS + 1).fill({})
    expect(() => encodeCheckpoint(c)).toThrow('1023')
  })
  it('preserves unrelated records and drops a stale inline body when metadata content changes', async () => {
    const s = snapshot(),
      oldBytes = utf8('old'),
      newBytes = utf8('new')
    s.files = [await file('a', oldBytes)]
    s.folders.push({ ...folder(), id: 'outside', name: 'Local outside', shareEnabled: false })
    const remote = checkpoint(s)
    remote.snapshot.folders.push({
      ...folder(),
      id: 'outside',
      parentId: 'root',
      name: 'Remote collision',
      shareEnabled: false,
      updatedAt: later,
    })
    remote.snapshot.files = [
      stripFileContent(
        stampFilePatch(s.files[0], { checksum: await sha256(newBytes), size: newBytes.length }, later, 'node-b'),
      ),
    ]
    const merged = mergeFolderCheckpoint(s, remote)
    expect(merged.files[0].dataUrl).toBeUndefined()
    expect(merged.folders.find((f) => f.id === 'outside')?.name).toBe('Local outside')
  })
  it('converges stamped escrow settings atomically', () => {
    const a = snapshot(),
      b = snapshot()
    a.folders[0] = stampFolderPatch(a.folders[0], { escrow: { mode: 'off', room: '' } }, later, 'node-a')
    b.folders[0] = stampFolderPatch(b.folders[0], { escrow: { mode: 'custom', room: 'custom-room' } }, later, 'node-b')
    expect(mergeFolderCheckpoint(a, checkpoint(b)).folders[0].escrow).toEqual({ mode: 'custom', room: 'custom-room' })
    expect(mergeFolderCheckpoint(b, checkpoint(a)).folders[0].escrow).toEqual({ mode: 'custom', room: 'custom-room' })
  })
})

describe('immutable packs', () => {
  it('packs thousands of small files with zero-byte files without a pack', async () => {
    const server = new EscrowTestServer(),
      tx = await session(server),
      s = snapshot()
    const data = new Map<string, Uint8Array>()
    for (let i = 0; i < 1200; i++) {
      const bytes = utf8('file-' + i)
      const f = await file('file-' + i, bytes)
      s.files.push(f)
      data.set(f.id, bytes)
    }
    s.files.push(await file('empty', new Uint8Array()))
    data.set('empty', new Uint8Array())
    const content = await buildContentPacks(tx, 'root', 'secret', s.files, null, async (f) => data.get(f.id)!)
    expect(content.packs).toHaveLength(1)
    expect(content.contents.find((e) => e.fileId === 'empty')?.segments).toEqual([])
    const c = { ...checkpoint(s), ...content }
    await validateCheckpoint(encodeCheckpoint(c), 'root', 'secret', 'app-room')
    const entry = content.contents.find((e) => e.fileId === 'file-700')!
    expect(
      await reconstructContent(entry, content.packs, (p) => readPinnedPack(tx.transport, p, 'root', 'secret')),
    ).toEqual(data.get('file-700'))
    const reused = await buildContentPacks(tx, 'root', 'secret', s.files, c, async () => {
      throw new Error('unchanged content reread')
    })
    expect(reused.packs).toEqual(content.packs)
    expect(server.putLog.every((p) => p.provider === 'provider-a')).toBe(true)
  }, 20000)
  it('splits incompressible files larger than 32 MiB at exact pack boundaries', async () => {
    const server = new EscrowTestServer(),
      tx = await session(server),
      bytes = new Uint8Array(32 * 1024 * 1024 + 113)
    for (let i = 0; i < bytes.length; i += 65536)
      crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)))
    const f = await file('large', bytes),
      s = snapshot()
    s.files = [f]
    const content = await buildContentPacks(tx, 'root', 'secret', s.files, null, async () => bytes)
    expect(content.packs).toHaveLength(5)
    expect(content.packs.every((p) => p.length <= PACK_BYTES)).toBe(true)
    expect(content.contents[0].segments.map((s) => s.length)).toEqual([
      PACK_BYTES,
      PACK_BYTES,
      PACK_BYTES,
      PACK_BYTES,
      113,
    ])
    await validateCheckpoint(encodeCheckpoint({ ...checkpoint(s), ...content }), 'root', 'secret', 'app-room')
    expect(
      await sha256(
        await reconstructContent(content.contents[0], content.packs, (p) =>
          readPinnedPack(tx.transport, p, 'root', 'secret'),
        ),
      ),
    ).toBe(f.checksum)
  }, 20000)
  it('validates source checksums and malformed segment sums, bounds and encrypted heads', async () => {
    const server = new EscrowTestServer(),
      tx = await session(server),
      bytes = utf8('actual'),
      f = await file('a', bytes),
      s = snapshot()
    s.files = [f]
    // Mismatching or missing source bytes never become pack content: the file is reported as omitted.
    for (const read of [async () => utf8('wrong'), async () => Promise.reject(new Error('missing'))]) {
      const none = await buildContentPacks(tx, 'root', 'secret', [f], null, read)
      expect(none.packs).toEqual([])
      expect(none.contents).toEqual([])
      expect(none.omitted).toEqual([{ fileId: f.id, checksum: f.checksum, size: f.size, reason: 'unavailable' }])
    }
    const content = await buildContentPacks(tx, 'root', 'secret', [f], null, async () => bytes),
      c = { ...checkpoint(s), ...content }
    const bad = structuredClone(c)
    bad.contents[0].segments[0].offset = 100
    await expect(validateCheckpoint(encodeCheckpoint(bad), 'root', 'secret', 'app-room')).rejects.toThrow('bounds')
    const size = structuredClone(c)
    size.contents[0].segments[0].length--
    await expect(validateCheckpoint(encodeCheckpoint(size), 'root', 'secret', 'app-room')).rejects.toThrow('size')
    const schema = structuredClone(c)
    schema.packs[0].head.schema = 'wrong'
    await expect(validateCheckpoint(encodeCheckpoint(schema), 'root', 'secret', 'app-room')).rejects.toThrow('head')
    server.blobs.set(c.packs[0].head.cid, utf8('corrupt'))
    await expect(readPinnedPack(tx.transport, c.packs[0], 'root', 'secret')).rejects.toThrow('ciphertext')
  })
  it('uploads identical bytes from concurrent builders into separate slots, each at sequence 1', async () => {
    const server = new EscrowTestServer(),
      a = await session(server),
      b = await session(server),
      bytes = utf8('same'),
      f = await file('a', bytes)
    const [one, two] = await Promise.all([
      buildContentPacks(a, 'root', 'secret', [f], null, async () => bytes),
      buildContentPacks(b, 'root', 'secret', [f], null, async () => bytes),
    ])
    // A fresh nonce per upload keeps a later delete of one slot from ever hitting another upload.
    expect(one.packs[0].digest).toBe(two.packs[0].digest)
    expect(one.packs[0].nonce).not.toBe(two.packs[0].nonce)
    expect(one.packs[0].head.slot).not.toBe(two.packs[0].head.slot)
    expect(one.packs[0].head.seq).toBe(1)
    expect(two.packs[0].head.seq).toBe(1)
  })
})

describe('folder controller durability', () => {
  it('ACKs every pack on the same provider before the manifest and restores lazily', async () => {
    const server = new EscrowTestServer()
    server.providers.add('provider-b')
    const bytes = utf8('protected'),
      s = snapshot()
    s.files = [await file('a', bytes)]
    const owner = await controller(server, s, async () => bytes)
    await owner.c.flush()
    expect(owner.c.view.status).toBe('saved')
    expect(owner.stored?.lastSeq).toBe(1)
    expect(server.putLog.map((p) => p.head.schema)).toEqual([PACK_APP, CHECKPOINT_SCHEMA])
    expect(server.putLog.every((p) => p.provider === 'provider-a')).toBe(true)
    const returning = await controller(server, snapshot())
    expect(returning.current.files[0].checksum).toBe(s.files[0].checksum)
    expect(returning.current.files[0].dataUrl).toBeUndefined()
    expect(returning.stored?.lastSeq).toBe(0)
    expect(await returning.c.loadContent(returning.current.files[0])).toContain('cHJvdGVjdGVk')
  })
  it('never publishes a manifest or advances watermarks after pack quota failure', async () => {
    const server = new EscrowTestServer()
    server.failPack = true
    const bytes = utf8('file'),
      s = snapshot()
    s.files = [await file('a', bytes)]
    const owner = await controller(server, s, async () => bytes)
    await owner.c.flush()
    expect(owner.c.view.status).toBe('error')
    expect(owner.c.view.reason).toContain('quota')
    expect(owner.stored?.lastSeq).toBe(0)
    expect(server.putLog.every((p) => p.head.schema === PACK_APP)).toBe(true)
    server.failPack = false
    await owner.c.flush()
    expect(owner.c.view.status).toBe('saved')
  })
  it('aborts a pinned transaction on provider loss without switching to another provider', async () => {
    const server = new EscrowTestServer()
    server.providers.add('provider-b')
    server.loseProviderOnPack = true
    const bytes = utf8('file'),
      s = snapshot()
    s.files = [await file('a', bytes)]
    const owner = await controller(server, s, async () => bytes)
    const flush = owner.c.flush()
    await vi.waitUntil(() => !server.providers.has('provider-a'), { timeout: 3000, interval: 5 })
    await flush
    expect(owner.c.view.status).toBe('error')
    expect(owner.stored?.lastSeq).toBe(0)
    expect(server.putLog.every((p) => p.provider === 'provider-a' && p.head.schema === PACK_APP)).toBe(true)
  })
  it('retains dirty state after edits arrive during a delayed upload and saves the newer revision next', async () => {
    const server = new EscrowTestServer(),
      owner = await controller(server)
    server.beforePut = async (head) => {
      if (head.schema === CHECKPOINT_SCHEMA) {
        server.beforePut = undefined
        owner.current = {
          ...owner.current,
          folders: [stampFolderPatch(owner.current.folders[0], { name: 'During upload' }, later, 'node-a')],
        }
        owner.c.observe()
      }
    }
    await owner.c.flush()
    expect(owner.c.view.status).toBe('ready')
    await owner.c.flush()
    expect(owner.c.view.status).toBe('saved')
    expect(owner.stored?.lastSeq).toBe(2)
    expect(owner.stored?.checkpoint?.snapshot.folders[0].name).toBe('During upload')
  })
  it('merges a root CAS conflict using the original CRDT stamps then retries', async () => {
    const server = new EscrowTestServer(),
      owner = await controller(server)
    server.conflictOnce = async () => {
      const c = checkpoint()
      c.snapshot.folders[0] = stampFolderPatch(c.snapshot.folders[0], { name: 'Concurrent' }, later, 'node-b')
      const keys = await deriveEscrowKeys(APP, folderInput('root', 'secret')),
        blob = await encryptBlob(keys.encKey, keys.slot, 1, encodeCheckpoint(c)),
        cid = await sha256(blob)
      server.blobs.set(cid, blob)
      return buildHead(keys, {
        seq: 1,
        parent: null,
        cid,
        size: blob.length,
        sha256: await sha256(blob),
        schema: CHECKPOINT_SCHEMA,
        comp: 'none',
      })
    }
    await owner.c.flush()
    expect(owner.stored?.lastSeq).toBe(2)
    expect(owner.current.folders[0].name).toBe('Concurrent')
    expect(owner.current.folders[0].fieldVersions?.name).toEqual({ updatedAt: later, nodeId: 'node-b' })
  })
  it('rejects rollback and leaves valid local state untouched', async () => {
    const server = new EscrowTestServer(),
      owner = await controller(server)
    await owner.c.flush()
    const seq = owner.stored!,
      known = { ...seq, lastSeq: 5 }
    const returning = await controller(server, snapshot(), async () => new Uint8Array(), known)
    expect(returning.c.view.status).toBe('error')
    expect(returning.c.view.reason).toContain('rollback')
    expect(returning.current).toEqual(snapshot())
    expect(returning.stored?.lastSeq).toBe(5)
  })
  it('does not delay startup without a provider and listens for late arrivals', async () => {
    const server = new EscrowTestServer()
    server.providers.clear()
    let s = snapshot()
    const c = new FolderEscrowController({
      folderId: 'root',
      key: 'secret',
      appRoom: 'app-room',
      nodeId: 'node-a',
      setting: { mode: 'custom', room: 'escrow-room' },
      snapshot: () => s,
      merge: (r) => {
        s = mergeFolderCheckpoint(s, r)
      },
      readFile: async () => new Uint8Array(),
      changed: () => {},
      transport: (p) => server.transport(p),
      loadLocal: () => ({ lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0 }),
      persist: () => {},
    })
    controllers.push(c)
    await c.start()
    expect(c.view.status).toBe('searching')
    expect(server.putLog).toEqual([])
    server.arrive('provider-a')
    await vi.waitUntil(() => c.view.status === 'ready', { timeout: 3000, interval: 5 })
    await c.flush()
    expect(c.view.status).toBe('saved')
  })
  it('retains dirty state on lost manifest ACK and retries using the accepted parent', async () => {
    const server = new EscrowTestServer(),
      owner = await controller(server)
    server.dropRootAck = true
    await owner.c.flush()
    expect(owner.c.view.status).toBe('error')
    expect(owner.c.view.savedAt).toBe(0)
    expect(owner.stored?.lastSeq).toBe(0)
    server.dropRootAck = false
    await owner.c.flush()
    expect(owner.c.view.status).toBe('saved')
    expect(owner.stored?.lastSeq).toBe(2)
  })
  it('Off never derives, joins or writes', async () => {
    const server = new EscrowTestServer(),
      c = new FolderEscrowController({
        folderId: 'root',
        key: 'secret',
        appRoom: 'app-room',
        nodeId: 'node-a',
        setting: { mode: 'off', room: '' },
        snapshot,
        merge: () => {},
        readFile: async () => new Uint8Array(),
        changed: () => {},
        transport: (p) => server.transport(p),
      })
    controllers.push(c)
    await c.start()
    await c.flush()
    expect(c.view.status).toBe('off')
    expect(server.pinned).toEqual([])
  })
})
