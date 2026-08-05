import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  createVrsns2SpaceInboxActions,
  extensionForMime,
  loadImportedSpaceState,
  parseSpaceItems,
  saveImportedSpaceState,
  spaceFileName,
  type ResolveSpaceResult,
  type SpaceInboxItem,
} from '../src/app/appVrsns2SpaceInbox.js'
import { createInitialSnapshot, type StorageSnapshot } from '../src/storage/domain.js'
import type { AppSettings } from '../src/storage/localSettings.js'

type StateUpdate<T> = T | ((current: T) => T)

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

function importedState(): Record<string, { cid: string; fileId: string }> {
  const raw = store['tc-storage-vrsns2-space-imported-v1']
  return raw ? (JSON.parse(raw) as { entries: Record<string, { cid: string; fileId: string }> }).entries : {}
}

function item(overrides: Partial<SpaceInboxItem> = {}): SpaceInboxItem {
  return {
    id: 'cid-avatar',
    name: 'My Avatar',
    category: 'avatar',
    cid: 'cid-avatar',
    mimeType: 'model/vrm',
    updatedAt: '2026-08-05T00:00:00.000Z',
    ...overrides,
  }
}

function createHarness(resolveItem: (cid: string, nodeId: string) => Promise<ResolveSpaceResult>) {
  let snapshot: StorageSnapshot = createInitialSnapshot('node-test')
  const snapshotRef = { current: snapshot }
  let folderKeys: Record<string, string> = {}
  const folderKeysRef = { current: folderKeys }
  let fileContentCache: Record<string, string> = {}
  const settingsRef = { current: { nodeId: 'node-test', roomId: 'tc-storage-main', identity: null, autoConnect: false, profileName: 'Test user', avatarUrl: '', avatarFileId: '' } as AppSettings }
  const setSnapshot = (update: StateUpdate<StorageSnapshot>) => {
    snapshot = typeof update === 'function' ? (update as (current: StorageSnapshot) => StorageSnapshot)(snapshot) : update
    snapshotRef.current = snapshot
  }
  const actions = createVrsns2SpaceInboxActions({
    snapshotRef,
    setSnapshot,
    settingsRef,
    folderKeysRef,
    setFolderKeys: (update: StateUpdate<Record<string, string>>) => {
      folderKeys = typeof update === 'function' ? (update as (current: Record<string, string>) => Record<string, string>)(folderKeys) : update
      folderKeysRef.current = folderKeys
    },
    setFileContentCache: (update: StateUpdate<Record<string, string>>) => {
      fileContentCache = typeof update === 'function' ? (update as (current: Record<string, string>) => Record<string, string>)(fileContentCache) : update
    },
    resolveItem,
  })
  return { actions, snapshot: () => snapshot, setSnapshot, fileContentCache: () => fileContentCache }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function record(items: SpaceInboxItem[]): { cid: string; meta: { v: number; items: SpaceInboxItem[] }; updatedAt: string; from: 'tc-vrsns2' } {
  return { cid: '', meta: { v: 1, items }, updatedAt: '2026-08-05T00:00:00.000Z', from: 'tc-vrsns2' }
}

test('parseSpaceItems accepts valid items and rejects malformed ones', () => {
  const items = parseSpaceItems({
    items: [
      item(),
      { id: 'c2', name: 'A World', category: 'world', cid: 'c2', mimeType: 'model/gltf-binary', updatedAt: '2026-08-05T00:00:00.000Z' },
      { id: '', name: 'no id', category: 'avatar', cid: 'c3', mimeType: 'model/vrm', updatedAt: '2026-08-05T00:00:00.000Z' }, // missing id
      { id: 'c4', name: 'no cid', category: 'avatar', cid: '', mimeType: 'model/vrm', updatedAt: '2026-08-05T00:00:00.000Z' }, // missing cid
      { id: 'c5', name: 'bad category', category: 'prop', cid: 'c5', mimeType: 'model/vrm', updatedAt: '2026-08-05T00:00:00.000Z' }, // unknown category
      { id: 'c6', name: 123, category: 'object', cid: 'c6', mimeType: 'image/png', updatedAt: '2026-08-05T00:00:00.000Z' }, // name not a string
      { id: 'c7', name: 'ok', category: 'object', cid: 'c7', mimeType: 'image/webp', updatedAt: '2026-08-05T00:00:00.000Z' },
      null,
      'not an object',
    ],
  })

  assert.deepEqual(items, [item(), { id: 'c2', name: 'A World', category: 'world', cid: 'c2', mimeType: 'model/gltf-binary', updatedAt: '2026-08-05T00:00:00.000Z' }, { id: 'c7', name: 'ok', category: 'object', cid: 'c7', mimeType: 'image/webp', updatedAt: '2026-08-05T00:00:00.000Z' }])
})

test('parseSpaceItems returns an empty array when items is missing or not an array', () => {
  assert.deepEqual(parseSpaceItems({}), [])
  assert.deepEqual(parseSpaceItems({ items: 'nope' }), [])
  assert.deepEqual(parseSpaceItems({ items: null }), [])
})

test('parseSpaceItems caps at 300 entries even if the publisher sends more', () => {
  const items = Array.from({ length: 400 }, (_, index) => item({ id: `cid-${index}`, cid: `cid-${index}`, name: `Item ${index}` }))
  const parsed = parseSpaceItems({ items })
  assert.equal(parsed.length, 300)
  assert.equal(parsed[0]!.id, 'cid-0')
  assert.equal(parsed[299]!.id, 'cid-299')
})

test('extensionForMime maps known mimes to their extensions', () => {
  assert.equal(extensionForMime('model/vrm'), 'vrm')
  assert.equal(extensionForMime('model/gltf-binary'), 'glb')
  assert.equal(extensionForMime('model/gltf+json'), 'gltf')
  assert.equal(extensionForMime('image/webp'), 'webp')
  assert.equal(extensionForMime('audio/mpeg'), 'mp3')
  assert.equal(extensionForMime('video/mp4'), 'mp4')
  assert.equal(extensionForMime('application/json'), 'json')
})

test('extensionForMime falls back to the subtype for any image/video/audio mime', () => {
  assert.equal(extensionForMime('image/avif'), 'avif')
  assert.equal(extensionForMime('audio/flac'), 'flac')
  assert.equal(extensionForMime('video/x-matroska'), '', 'subtypes with dashes/over 8 chars are not guessed')
})

test('extensionForMime sniffs ply/ksplat magic bytes for octet-stream worlds', () => {
  const ply = new TextEncoder().encode('ply\nformat ascii 1.0\n')
  const ksplat = new TextEncoder().encode('ksplat\x00\x01')
  const other = new TextEncoder().encode('garbage')
  assert.equal(extensionForMime('application/octet-stream', ply), 'ply')
  assert.equal(extensionForMime('application/octet-stream', ksplat), 'ksplat')
  assert.equal(extensionForMime('application/octet-stream', other), '')
  assert.equal(extensionForMime('application/octet-stream'), '', 'no bytes, no sniff')
})

test('spaceFileName sanitizes the base and appends the derived extension', () => {
  assert.equal(spaceFileName(item()), 'My Avatar.vrm')
  assert.equal(spaceFileName(item({ name: 'A:World/Here', mimeType: 'model/gltf-binary' })), 'AWorldHere.glb')
  assert.equal(spaceFileName(item({ name: '', mimeType: 'image/webp' })), '無題.webp')
})

test('spaceFileName never doubles an extension the name already carries', () => {
  assert.equal(spaceFileName(item({ name: 'My Avatar.vrm' })), 'My Avatar.vrm')
  assert.equal(spaceFileName(item({ name: 'world.GLB', mimeType: 'model/gltf-binary' })), 'world.GLB')
})

test('spaceFileName leaves a name without a mime extension as-is', () => {
  assert.equal(spaceFileName(item({ mimeType: 'application/octet-stream' })), 'My Avatar')
})

test('imported space state round-trips through localStorage', () => {
  const state = new Map([
    ['cid-1', { cid: 'cid-1', fileId: 'file-1' }],
    ['cid-2', { cid: 'cid-2', fileId: 'file-2' }],
  ])
  saveImportedSpaceState(state)

  const loaded = loadImportedSpaceState()
  assert.deepEqual([...loaded.entries()], [...state.entries()])
})

test('loadImportedSpaceState tolerates missing, corrupt, or malformed JSON', () => {
  assert.deepEqual(loadImportedSpaceState(), new Map())

  store['tc-storage-vrsns2-space-imported-v1'] = 'not json'
  assert.deepEqual(loadImportedSpaceState(), new Map())

  store['tc-storage-vrsns2-space-imported-v1'] = JSON.stringify([1, 2, 3])
  assert.deepEqual(loadImportedSpaceState(), new Map())

  store['tc-storage-vrsns2-space-imported-v1'] = JSON.stringify({ v: 2, entries: {} })
  assert.deepEqual(loadImportedSpaceState(), new Map())

  store['tc-storage-vrsns2-space-imported-v1'] = JSON.stringify({ v: 1, entries: { 'cid-1': { cid: 'cid-1' } } })
  assert.deepEqual(loadImportedSpaceState(), new Map()) // missing fileId is dropped

  store['tc-storage-vrsns2-space-imported-v1'] = JSON.stringify({ v: 1, entries: { 'cid-1': { cid: 'cid-1', fileId: 'file-1' }, 'cid-2': 'not-an-object' } })
  assert.deepEqual([...loadImportedSpaceState().entries()], [['cid-1', { cid: 'cid-1', fileId: 'file-1' }]])
})

test('saveImportedSpaceState caps to the 1000 most recently touched entries', () => {
  const state = new Map<string, { cid: string; fileId: string }>()
  for (let index = 0; index < 1200; index += 1) {
    state.set(`cid-${index}`, { cid: `cid-${index}`, fileId: `file-${index}` })
  }
  saveImportedSpaceState(state)

  const loaded = loadImportedSpaceState()
  assert.equal(loaded.size, 1000)
  assert.equal(loaded.has('cid-199'), false) // oldest 200 dropped
  assert.equal(loaded.has('cid-200'), true)
})

test('first import creates the TC Space folder and file', async () => {
  const bytes = new TextEncoder().encode('vrm-bytes')
  const harness = createHarness(async () => ({ kind: 'resolved', bytes }))

  harness.actions.importFromSpaceInbox(record([item()]))
  await settle()

  const snapshot = harness.snapshot()
  const folder = snapshot.folders.find((entry) => entry.name === 'TC Space')
  assert.ok(folder)
  const file = snapshot.files.find((entry) => entry.folderId === folder!.id)
  assert.ok(file)
  assert.equal(file!.name, 'My Avatar.vrm')
  assert.equal(file!.mimeType, 'model/vrm')
  assert.equal(file!.size, bytes.byteLength)
  const state = importedState()
  assert.equal(state['cid-avatar']?.cid, 'cid-avatar')
  assert.equal(state['cid-avatar']?.fileId, file!.id)
  assert.ok(harness.fileContentCache()[file!.id], 'file content is cached for preview')
})

test('same id as last import is skipped (no resolve attempt)', async () => {
  let attempts = 0
  const bytes = new TextEncoder().encode('vrm-bytes')
  const harness = createHarness(async () => {
    attempts += 1
    return { kind: 'resolved', bytes }
  })

  const recordValue = record([item()])
  harness.actions.importFromSpaceInbox(recordValue)
  await settle()
  assert.equal(attempts, 1)

  harness.actions.importFromSpaceInbox(recordValue)
  await settle()
  assert.equal(attempts, 1, 're-publishing the same id should not re-resolve')
})

test('a file deleted by the user stays deleted while the cid is unchanged', async () => {
  const bytes = new TextEncoder().encode('vrm-bytes')
  const harness = createHarness(async () => ({ kind: 'resolved', bytes }))

  const recordValue = record([item()])
  harness.actions.importFromSpaceInbox(recordValue)
  await settle()

  // Simulate the user deleting the imported file.
  harness.setSnapshot((current) => ({
    ...current,
    files: current.files.map((file) => (file.name === 'My Avatar.vrm' ? { ...file, deletedAt: '2026-08-05T00:05:00.000Z' } : file)),
  }))

  // Re-publishing the same id is skipped, so the deletion is respected
  // (no file is resurrected).
  harness.actions.importFromSpaceInbox(recordValue)
  await settle()
  assert.equal(harness.snapshot().files.filter((file) => file.name === 'My Avatar.vrm' && !file.deletedAt).length, 0)
  assert.equal(harness.snapshot().files.filter((file) => file.name === 'My Avatar.vrm').length, 1)
})

test('a content change (new cid) imports as a new file, leaving the old one', async () => {
  const firstBytes = new TextEncoder().encode('vrm-v1')
  const secondBytes = new TextEncoder().encode('vrm-v2')
  let call = 0
  const harness = createHarness(async () => {
    call += 1
    return { kind: 'resolved', bytes: call === 1 ? firstBytes : secondBytes }
  })

  harness.actions.importFromSpaceInbox(record([item()]))
  await settle()
  assert.equal(call, 1)

  // The user edits the avatar: new cid = new id on this wire.
  harness.actions.importFromSpaceInbox(record([item({ id: 'cid-avatar-v2', cid: 'cid-avatar-v2', name: 'My Avatar' })]))
  await settle()

  const snapshot = harness.snapshot()
  const files = snapshot.files.filter((entry) => entry.name === 'My Avatar.vrm' && !entry.deletedAt)
  assert.equal(files.length, 2, 'an edited item arrives as a new file; the old copy is left alone')
  assert.equal(files[1]!.size, secondBytes.byteLength)
  const state = importedState()
  assert.equal(state['cid-avatar']?.fileId, files[0]!.id)
  assert.equal(state['cid-avatar-v2']?.fileId, files[1]!.id)
})

test('a transient storage_get failure is not recorded, so it retries on the next event', async () => {
  let attempts = 0
  const bytes = new TextEncoder().encode('vrm-bytes')
  const harness = createHarness(async () => {
    attempts += 1
    return attempts === 1 ? { kind: 'transient' } : { kind: 'resolved', bytes }
  })

  harness.actions.importFromSpaceInbox(record([item()]))
  await settle()
  assert.equal(attempts, 1)
  assert.deepEqual(importedState(), {}, 'transient failures are not recorded')

  harness.actions.importFromSpaceInbox(record([item()]))
  await settle()
  assert.equal(attempts, 2, 'the same id is retried after a transient failure')
  assert.equal(harness.snapshot().files.some((file) => file.name === 'My Avatar.vrm'), true)
})

test('empty or malformed items are a no-op', async () => {
  const harness = createHarness(async () => ({ kind: 'resolved', bytes: new TextEncoder().encode('x') }))
  harness.actions.importFromSpaceInbox({ cid: '', meta: { v: 1, items: [] }, updatedAt: '2026-08-05T00:00:00.000Z', from: 'tc-vrsns2' })
  await settle()
  assert.equal(harness.snapshot().folders.length, 0)
  assert.deepEqual(importedState(), {})
})
