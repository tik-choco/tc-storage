import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  createVrsns2CatalogOutboxActions,
  loadPublishedCatalogState,
  maxItemBytes,
  maxOutboxItems,
  savePublishedCatalogState,
  selectOutboxCandidates,
  vrsns2CatalogOutboxTopic,
  type CatalogOutboxItem,
} from '../src/app/appVrsns2CatalogOutbox.js'
import { saveImportedSpaceState } from '../src/app/appVrsns2SpaceInbox.js'
import { sha256Hex } from '../src/crypto/crypto.js'
import { base64ToBytes, bytesToBase64 } from '../src/crypto/cryptoEncoding.js'
import { createInitialSnapshot, makeFileFromDataUrl, makeFolder, type FileRecord, type StorageSnapshot } from '../src/storage/domain.js'
import type { AppSettings } from '../src/storage/localSettings.js'

let originalLocalStorage: Storage | undefined
let store: Record<string, string>

beforeEach(() => {
  originalLocalStorage = globalThis.localStorage
  store = {}
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value
      },
    },
  })
})

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

function publishedRecord(): { cid: string; meta: { v: number; items: CatalogOutboxItem[] } } | undefined {
  const raw = store['tc-shared-vrsns2-catalog-inbox-v1']
  return raw ? (JSON.parse(raw) as { cid: string; meta: { v: number; items: CatalogOutboxItem[] } }) : undefined
}

async function dataUrlFor(bytes: Uint8Array): Promise<string> {
  return `data:image/png;base64,${bytesToBase64(bytes)}`
}

function tcSpaceFolder(now = '2026-08-05T00:00:00.000Z') {
  return makeFolder({ id: 'folder-tc-space', name: 'TC Space', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-test' })
}

/** Builds a FileRecord the way it actually lives in the snapshot -- content stripped, only the checksum survives (see storage/domain.ts's stripFileContent). */
function fileRecord(options: { id: string; folderId: string; checksum: string; size?: number; updatedAt: string; name?: string }): FileRecord {
  const record = makeFileFromDataUrl({
    id: options.id,
    folderId: options.folderId,
    name: options.name ?? `${options.id}.png`,
    mimeType: 'image/png',
    size: options.size ?? 10,
    dataUrl: 'data:image/png;base64,unused',
    checksum: options.checksum,
    now: options.updatedAt,
    nodeId: 'node-test',
  })
  return { ...record, dataUrl: undefined, updatedAt: options.updatedAt }
}

async function decryptItem(item: CatalogOutboxItem, ciphertext: Uint8Array): Promise<Uint8Array> {
  const keyBytes = base64ToBytes(item.key)
  const iv = base64ToBytes(item.iv)
  assert.equal(keyBytes.byteLength, 32, 'key must be a 256-bit AES-GCM key')
  assert.equal(iv.byteLength, 12, 'iv must be a 96-bit AES-GCM iv')
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, cryptoKey, ciphertext as BufferSource)
  return new Uint8Array(plain)
}

function makeHarness(overrides: {
  uploadCiphertext?: (name: string, ciphertext: Uint8Array, nodeId: string) => Promise<string>
  unpinCid?: (cid: string, nodeId: string) => Promise<void>
} = {}) {
  let snapshot: StorageSnapshot = createInitialSnapshot('node-test')
  const snapshotRef = { current: snapshot }
  const settingsRef = { current: { nodeId: 'node-test', roomId: 'tc-storage-main', identity: null, autoConnect: false, profileName: 'Test user', avatarUrl: '', avatarFileId: '' } as AppSettings }
  const fileContentCacheRef = { current: {} as Record<string, string> }

  function setSnapshot(next: StorageSnapshot | ((current: StorageSnapshot) => StorageSnapshot)): void {
    snapshot = typeof next === 'function' ? next(snapshot) : next
    snapshotRef.current = snapshot
  }
  function setDataUrl(fileId: string, dataUrl: string): void {
    fileContentCacheRef.current = { ...fileContentCacheRef.current, [fileId]: dataUrl }
  }
  function clearDataUrl(fileId: string): void {
    const { [fileId]: _removed, ...rest } = fileContentCacheRef.current
    fileContentCacheRef.current = rest
  }

  const uploadCalls: { name: string; ciphertext: Uint8Array }[] = []
  const unpinCalls: string[] = []
  const uploadCiphertext = overrides.uploadCiphertext ?? (async (name: string, ciphertext: Uint8Array) => {
    uploadCalls.push({ name, ciphertext })
    return `cid-${uploadCalls.length}`
  })
  const unpinCid = overrides.unpinCid ?? (async (cid: string) => {
    unpinCalls.push(cid)
  })

  const actions = createVrsns2CatalogOutboxActions({ snapshotRef, settingsRef, fileContentCacheRef, uploadCiphertext, unpinCid })
  return { actions, setSnapshot, setDataUrl, clearDataUrl, uploadCalls, unpinCalls, settingsRef }
}

// ---- selectOutboxCandidates (pure) ----

test('selectOutboxCandidates excludes given ids and oversized files, then sorts newest-first', () => {
  const files: FileRecord[] = [
    fileRecord({ id: 'a', folderId: 'f', checksum: 'ca', updatedAt: '2026-08-01T00:00:00.000Z' }),
    fileRecord({ id: 'b', folderId: 'f', checksum: 'cb', updatedAt: '2026-08-03T00:00:00.000Z' }),
    fileRecord({ id: 'c', folderId: 'f', checksum: 'cc', updatedAt: '2026-08-02T00:00:00.000Z' }),
    fileRecord({ id: 'excluded', folderId: 'f', checksum: 'cx', updatedAt: '2026-08-04T00:00:00.000Z' }),
    fileRecord({ id: 'huge', folderId: 'f', checksum: 'ch', size: maxItemBytes + 1, updatedAt: '2026-08-05T00:00:00.000Z' }),
  ]
  const result = selectOutboxCandidates(files, new Set(['excluded']))
  assert.deepEqual(result.map((file) => file.id), ['b', 'c', 'a'])
})

test('selectOutboxCandidates caps at maxOutboxItems, keeping the most recently updated', () => {
  const files: FileRecord[] = Array.from({ length: maxOutboxItems + 10 }, (_, index) =>
    fileRecord({ id: `file-${index}`, folderId: 'f', checksum: `c${index}`, updatedAt: `2026-08-01T00:${String(index).padStart(2, '0')}:00.000Z` }))
  const result = selectOutboxCandidates(files, new Set())
  assert.equal(result.length, maxOutboxItems)
  // The newest maxOutboxItems entries are files (10..maxOutboxItems+9), i.e. index maxOutboxItems+9 down to 10.
  assert.equal(result[0]!.id, `file-${maxOutboxItems + 9}`)
  assert.equal(result[result.length - 1]!.id, 'file-10')
})

// ---- published-state cache round trip ----

test('published catalog state round-trips through localStorage', () => {
  const state = new Map([
    ['file-1', { checksum: 'c1', cid: 'cid-1', key: 'key-1', iv: 'iv-1' }],
    ['file-2', { checksum: 'c2', cid: 'cid-2', key: 'key-2', iv: 'iv-2' }],
  ])
  savePublishedCatalogState(state)
  assert.deepEqual([...loadPublishedCatalogState().entries()], [...state.entries()])
})

test('loadPublishedCatalogState tolerates missing, corrupt, or malformed JSON', () => {
  assert.deepEqual(loadPublishedCatalogState(), new Map())

  store['tc-storage-vrsns2-catalog-published-v1'] = 'not json'
  assert.deepEqual(loadPublishedCatalogState(), new Map())

  store['tc-storage-vrsns2-catalog-published-v1'] = JSON.stringify([1, 2, 3])
  assert.deepEqual(loadPublishedCatalogState(), new Map())

  store['tc-storage-vrsns2-catalog-published-v1'] = JSON.stringify({ v: 2, entries: {} })
  assert.deepEqual(loadPublishedCatalogState(), new Map())

  store['tc-storage-vrsns2-catalog-published-v1'] = JSON.stringify({ v: 1, entries: { 'file-1': { checksum: 'c1', cid: 'cid-1' } } })
  assert.deepEqual(loadPublishedCatalogState(), new Map()) // missing key/iv is dropped

  store['tc-storage-vrsns2-catalog-published-v1'] = JSON.stringify({
    v: 1,
    entries: { 'file-1': { checksum: 'c1', cid: 'cid-1', key: 'k', iv: 'i' }, 'file-2': 'not-an-object' },
  })
  assert.deepEqual([...loadPublishedCatalogState().entries()], [['file-1', { checksum: 'c1', cid: 'cid-1', key: 'k', iv: 'i' }]])
})

test('savePublishedCatalogState caps to the 1000 most recently touched entries', () => {
  const state = new Map<string, { checksum: string; cid: string; key: string; iv: string }>()
  for (let index = 0; index < 1200; index += 1) {
    state.set(`file-${index}`, { checksum: `c${index}`, cid: `cid-${index}`, key: 'k', iv: 'i' })
  }
  savePublishedCatalogState(state)
  const loaded = loadPublishedCatalogState()
  assert.equal(loaded.size, 1000)
  assert.equal(loaded.has('file-199'), false)
  assert.equal(loaded.has('file-200'), true)
})

// ---- end-to-end publish behavior ----

test('no "TC Space" folder publishes an empty item list', async () => {
  const harness = makeHarness()
  await harness.actions.publishCatalogOutbox()
  assert.deepEqual(publishedRecord()?.meta, { v: 1, items: [] })
  assert.equal(harness.uploadCalls.length, 0)
})

test('a new file with cached plaintext is encrypted, uploaded, and published with a decryptable key/iv', async () => {
  const harness = makeHarness()
  const folder = tcSpaceFolder()
  const bytes = new TextEncoder().encode('hello tc-vrsns2')
  const checksum = await sha256Hex(bytes)
  const file = fileRecord({ id: 'file-1', folderId: folder.id, checksum, updatedAt: '2026-08-05T00:00:00.000Z' })
  harness.setSnapshot((current) => ({ ...current, folders: [...current.folders, folder], files: [...current.files, file] }))
  harness.setDataUrl('file-1', await dataUrlFor(bytes))

  await harness.actions.publishCatalogOutbox()

  assert.equal(harness.uploadCalls.length, 1)
  const record = publishedRecord()
  assert.equal(record?.cid, '')
  const items = record?.meta.items ?? []
  assert.equal(items.length, 1)
  const item = items[0]!
  assert.equal(item.id, 'file-1')
  assert.equal(item.mimeType, 'image/png')
  assert.equal(item.checksum, checksum)
  assert.equal(item.cid, 'cid-1')

  const decrypted = await decryptItem(item, harness.uploadCalls[0]!.ciphertext)
  assert.deepEqual(decrypted, bytes)
})

test('an unchanged file is reused from cache on the next publish, without re-encrypting', async () => {
  const harness = makeHarness()
  const folder = tcSpaceFolder()
  const bytes = new TextEncoder().encode('stable content')
  const checksum = await sha256Hex(bytes)
  const file = fileRecord({ id: 'file-1', folderId: folder.id, checksum, updatedAt: '2026-08-05T00:00:00.000Z' })
  harness.setSnapshot((current) => ({ ...current, folders: [...current.folders, folder], files: [...current.files, file] }))
  harness.setDataUrl('file-1', await dataUrlFor(bytes))

  await harness.actions.publishCatalogOutbox()
  assert.equal(harness.uploadCalls.length, 1)
  const firstCid = publishedRecord()?.meta.items[0]?.cid

  // Even if the cached dataUrl disappears (as it would after the app evicts
  // preview content), the cache hit path never needs it: the file's
  // checksum field alone tells us nothing changed.
  harness.clearDataUrl('file-1')
  await harness.actions.publishCatalogOutbox()

  assert.equal(harness.uploadCalls.length, 1, 're-publishing an unchanged file must not re-encrypt')
  assert.equal(publishedRecord()?.meta.items[0]?.cid, firstCid, 'the cid is reused verbatim')
})

test('a changed checksum re-encrypts, mints a new cid, and unpins the superseded one', async () => {
  const harness = makeHarness()
  const folder = tcSpaceFolder()
  const bytesV1 = new TextEncoder().encode('version one')
  const checksumV1 = await sha256Hex(bytesV1)
  const file = fileRecord({ id: 'file-1', folderId: folder.id, checksum: checksumV1, updatedAt: '2026-08-05T00:00:00.000Z' })
  harness.setSnapshot((current) => ({ ...current, folders: [...current.folders, folder], files: [...current.files, file] }))
  harness.setDataUrl('file-1', await dataUrlFor(bytesV1))
  await harness.actions.publishCatalogOutbox()
  const firstCid = publishedRecord()?.meta.items[0]?.cid
  assert.ok(firstCid)

  const bytesV2 = new TextEncoder().encode('version two, edited')
  const checksumV2 = await sha256Hex(bytesV2)
  harness.setSnapshot((current) => ({
    ...current,
    files: current.files.map((entry) => (entry.id === 'file-1' ? { ...entry, checksum: checksumV2, updatedAt: '2026-08-05T00:05:00.000Z' } : entry)),
  }))
  harness.setDataUrl('file-1', await dataUrlFor(bytesV2))
  await harness.actions.publishCatalogOutbox()

  assert.equal(harness.uploadCalls.length, 2, 'a changed checksum re-encrypts')
  const record = publishedRecord()
  const item = record?.meta.items[0]!
  assert.equal(item.checksum, checksumV2)
  assert.notEqual(item.cid, firstCid, 'the cid changes when the content changes')
  assert.deepEqual(harness.unpinCalls, [firstCid], 'the superseded cid is unpinned')

  const decrypted = await decryptItem(item, harness.uploadCalls[1]!.ciphertext)
  assert.deepEqual(decrypted, bytesV2)
})

test('a file that was itself imported from tc-vrsns2 is excluded (echo-loop guard)', async () => {
  saveImportedSpaceState(new Map([['vrsns2-item-1', { cid: 'vrsns2-item-1', fileId: 'file-from-vrsns2' }]]))
  const harness = makeHarness()
  const folder = tcSpaceFolder()
  const bytes = new TextEncoder().encode('came from tc-vrsns2')
  const checksum = await sha256Hex(bytes)
  const file = fileRecord({ id: 'file-from-vrsns2', folderId: folder.id, checksum, updatedAt: '2026-08-05T00:00:00.000Z' })
  harness.setSnapshot((current) => ({ ...current, folders: [...current.folders, folder], files: [...current.files, file] }))
  harness.setDataUrl('file-from-vrsns2', await dataUrlFor(bytes))

  await harness.actions.publishCatalogOutbox()

  assert.deepEqual(publishedRecord()?.meta.items, [])
  assert.equal(harness.uploadCalls.length, 0, 'a file that came from tc-vrsns2 is never re-encrypted or published back to it')
})

test('a file with no cached plaintext is skipped this round and retried later, never fetched', async () => {
  const harness = makeHarness()
  const folder = tcSpaceFolder()
  const file = fileRecord({ id: 'file-1', folderId: folder.id, checksum: 'checksum-without-bytes', updatedAt: '2026-08-05T00:00:00.000Z' })
  harness.setSnapshot((current) => ({ ...current, folders: [...current.folders, folder], files: [...current.files, file] }))
  // Deliberately never call setDataUrl.

  await harness.actions.publishCatalogOutbox()

  assert.deepEqual(publishedRecord()?.meta.items, [])
  assert.equal(harness.uploadCalls.length, 0)

  // Once the content becomes available, the very next publish picks it up.
  const bytes = new TextEncoder().encode('now available')
  const checksum = await sha256Hex(bytes)
  harness.setSnapshot((current) => ({ ...current, files: current.files.map((entry) => (entry.id === 'file-1' ? { ...entry, checksum } : entry)) }))
  harness.setDataUrl('file-1', await dataUrlFor(bytes))
  await harness.actions.publishCatalogOutbox()
  assert.equal(publishedRecord()?.meta.items.length, 1)
})

test('a file over the tc-vrsns2 size cap is excluded even with cached plaintext', async () => {
  const harness = makeHarness()
  const folder = tcSpaceFolder()
  const bytes = new TextEncoder().encode('irrelevant, excluded by size before content is read')
  const checksum = await sha256Hex(bytes)
  const file = fileRecord({ id: 'file-1', folderId: folder.id, checksum, size: maxItemBytes + 1, updatedAt: '2026-08-05T00:00:00.000Z' })
  harness.setSnapshot((current) => ({ ...current, folders: [...current.folders, folder], files: [...current.files, file] }))
  harness.setDataUrl('file-1', await dataUrlFor(bytes))

  await harness.actions.publishCatalogOutbox()

  assert.deepEqual(publishedRecord()?.meta.items, [])
  assert.equal(harness.uploadCalls.length, 0)
})

test('an upload failure for one item never throws and does not block the others', async () => {
  const harness = makeHarness({
    uploadCiphertext: async (name: string) => {
      if (name.startsWith('file-fails')) throw new Error('storage_add quota exceeded')
      return `cid-${name}`
    },
  })
  const folder = tcSpaceFolder()
  const bytesOk = new TextEncoder().encode('this one works')
  const checksumOk = await sha256Hex(bytesOk)
  const bytesFail = new TextEncoder().encode('this one fails to upload')
  const checksumFail = await sha256Hex(bytesFail)
  const fileOk = fileRecord({ id: 'file-ok', folderId: folder.id, checksum: checksumOk, updatedAt: '2026-08-05T00:00:01.000Z' })
  const fileFails = fileRecord({ id: 'file-fails', folderId: folder.id, checksum: checksumFail, updatedAt: '2026-08-05T00:00:00.000Z' })
  harness.setSnapshot((current) => ({ ...current, folders: [...current.folders, folder], files: [...current.files, fileOk, fileFails] }))
  harness.setDataUrl('file-ok', await dataUrlFor(bytesOk))
  harness.setDataUrl('file-fails', await dataUrlFor(bytesFail))

  await assert.doesNotReject(() => harness.actions.publishCatalogOutbox())

  const items = publishedRecord()?.meta.items ?? []
  assert.deepEqual(items.map((item) => item.id), ['file-ok'], 'the failing item is left out; the rest still publish')
  assert.equal(loadPublishedCatalogState().has('file-fails'), false, 'no bogus cache entry is recorded for the failed item')
})

test('the topic constant matches the shared-bus contract name', () => {
  assert.equal(vrsns2CatalogOutboxTopic, 'vrsns2-catalog-inbox')
})
