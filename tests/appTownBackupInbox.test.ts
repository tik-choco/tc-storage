import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  createTownBackupInboxActions,
  parseTownBackupItem,
  type ResolveTownBackupResult,
  type TownBackupItem,
} from '../src/app/appTownBackupInbox.js'
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

function importedState(): Record<string, { checksum: string; fileId: string }> {
  const raw = store['tc-storage-town-backup-imported-v1']
  return raw ? (JSON.parse(raw) as { entries: Record<string, { checksum: string; fileId: string }> }).entries : {}
}

function item(overrides: Partial<TownBackupItem> = {}): TownBackupItem {
  return {
    id: 'tc-town-backup',
    name: 'tc-town-backup.json',
    mimeType: 'application/json',
    size: 5,
    checksum: 'checksum-a',
    cid: 'cid-a',
    key: 'key',
    iv: 'iv',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  }
}

function createHarness(resolveItem: (item: TownBackupItem, nodeId: string) => Promise<ResolveTownBackupResult>) {
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
  const actions = createTownBackupInboxActions({
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

test('parseTownBackupItem accepts valid meta and rejects malformed meta', () => {
  const valid = parseTownBackupItem({ v: 1, updatedAt: '2026-07-10T00:00:00.000Z', item: item() })
  assert.deepEqual(valid, item())

  assert.equal(parseTownBackupItem({}), undefined)
  assert.equal(parseTownBackupItem({ v: 2, item: item() }), undefined)
  assert.equal(parseTownBackupItem({ v: 1, item: null }), undefined)
  assert.equal(parseTownBackupItem({ v: 1, item: { ...item(), id: '' } }), undefined)
  assert.equal(parseTownBackupItem({ v: 1, item: { ...item(), size: -1 } }), undefined)
  assert.equal(parseTownBackupItem({ v: 1, item: { ...item(), checksum: undefined } }), undefined)
})

test('first import creates the TC Town folder and file', async () => {
  const bytes = new TextEncoder().encode('{"characters":[]}')
  const harness = createHarness(async () => ({ kind: 'resolved', bytes }))

  harness.actions.importFromBackup({ cid: '', meta: { v: 1, updatedAt: '2026-07-10T00:00:00.000Z', item: item() }, updatedAt: '2026-07-10T00:00:00.000Z', from: 'tc-town' })
  await settle()

  const snapshot = harness.snapshot()
  const folder = snapshot.folders.find((entry) => entry.name === 'TC Town')
  assert.ok(folder)
  const file = snapshot.files.find((entry) => entry.folderId === folder!.id)
  assert.ok(file)
  assert.equal(file!.name, 'tc-town-backup.json')
  assert.equal(file!.mimeType, 'application/json')
  assert.equal(file!.checksum, 'checksum-a')
  const state = importedState()
  assert.equal(state['tc-town-backup']?.checksum, 'checksum-a')
  assert.equal(state['tc-town-backup']?.fileId, file!.id)
})

test('same checksum as last import is skipped (no resolve attempt)', async () => {
  let attempts = 0
  const bytes = new TextEncoder().encode('{}')
  const harness = createHarness(async () => {
    attempts += 1
    return { kind: 'resolved', bytes }
  })

  const record = { cid: '', meta: { v: 1, updatedAt: '2026-07-10T00:00:00.000Z', item: item() }, updatedAt: '2026-07-10T00:00:00.000Z', from: 'tc-town' as const }
  harness.actions.importFromBackup(record)
  await settle()
  assert.equal(attempts, 1)

  harness.actions.importFromBackup(record)
  await settle()
  assert.equal(attempts, 1, 're-publishing the same checksum should not re-resolve')
})

test('changed checksum patches the existing file in place (same fileId)', async () => {
  const firstBytes = new TextEncoder().encode('{"v":1}')
  const secondBytes = new TextEncoder().encode('{"v":2,"more":"data"}')
  let call = 0
  const harness = createHarness(async () => {
    call += 1
    return { kind: 'resolved', bytes: call === 1 ? firstBytes : secondBytes }
  })

  harness.actions.importFromBackup({ cid: '', meta: { v: 1, updatedAt: '2026-07-10T00:00:00.000Z', item: item({ checksum: 'checksum-a', cid: 'cid-a' }) }, updatedAt: '2026-07-10T00:00:00.000Z', from: 'tc-town' })
  await settle()
  const firstFileId = harness.snapshot().files.find((entry) => entry.name === 'tc-town-backup.json')!.id

  harness.actions.importFromBackup({ cid: '', meta: { v: 1, updatedAt: '2026-07-10T00:00:01.000Z', item: item({ checksum: 'checksum-b', cid: 'cid-b' }) }, updatedAt: '2026-07-10T00:00:01.000Z', from: 'tc-town' })
  await settle()

  const snapshot = harness.snapshot()
  const files = snapshot.files.filter((entry) => entry.name === 'tc-town-backup.json' && !entry.deletedAt)
  assert.equal(files.length, 1, 'exactly one live file should exist after an in-place update')
  assert.equal(files[0]!.id, firstFileId, 'the same fileId should be reused')
  assert.equal(files[0]!.checksum, 'checksum-b')
  assert.equal(files[0]!.size, secondBytes.byteLength)
  assert.equal(files[0]!.version, 2)
})

test('a file deleted by the user stays deleted while the checksum is unchanged', async () => {
  const bytes = new TextEncoder().encode('{}')
  const harness = createHarness(async () => ({ kind: 'resolved', bytes }))

  const record = { cid: '', meta: { v: 1, updatedAt: '2026-07-10T00:00:00.000Z', item: item() }, updatedAt: '2026-07-10T00:00:00.000Z', from: 'tc-town' as const }
  harness.actions.importFromBackup(record)
  await settle()

  // Simulate the user deleting the imported file.
  harness.setSnapshot((current) => ({
    ...current,
    files: current.files.map((file) => (file.name === 'tc-town-backup.json' ? { ...file, deletedAt: '2026-07-10T00:05:00.000Z' } : file)),
  }))

  // Re-publishing the same checksum is skipped, so the deletion is respected
  // (no file is resurrected).
  harness.actions.importFromBackup(record)
  await settle()
  assert.equal(harness.snapshot().files.filter((file) => file.name === 'tc-town-backup.json' && !file.deletedAt).length, 0)
  assert.equal(harness.snapshot().files.filter((file) => file.name === 'tc-town-backup.json').length, 1)
})

test('fresh re-import when the previous file was deleted and the checksum changed', async () => {
  const firstBytes = new TextEncoder().encode('{"v":1}')
  const secondBytes = new TextEncoder().encode('{"v":2}')
  let call = 0
  const harness = createHarness(async () => {
    call += 1
    return { kind: 'resolved', bytes: call === 1 ? firstBytes : secondBytes }
  })

  harness.actions.importFromBackup({ cid: '', meta: { v: 1, updatedAt: '2026-07-10T00:00:00.000Z', item: item({ checksum: 'checksum-a' }) }, updatedAt: '2026-07-10T00:00:00.000Z', from: 'tc-town' })
  await settle()
  const originalFileId = harness.snapshot().files.find((entry) => entry.name === 'tc-town-backup.json')!.id

  // The user deletes the imported file, then tc-town's data changes again.
  harness.setSnapshot((current) => ({
    ...current,
    files: current.files.map((file) => (file.id === originalFileId ? { ...file, deletedAt: '2026-07-10T00:05:00.000Z' } : file)),
  }))

  harness.actions.importFromBackup({ cid: '', meta: { v: 1, updatedAt: '2026-07-10T00:10:00.000Z', item: item({ checksum: 'checksum-b', cid: 'cid-b' }) }, updatedAt: '2026-07-10T00:10:00.000Z', from: 'tc-town' })
  await settle()

  const state = importedState()
  assert.equal(state['tc-town-backup']?.checksum, 'checksum-b')
  // A fresh import should not reuse the deleted file's id.
  assert.notEqual(state['tc-town-backup']?.fileId, originalFileId)
  const liveFiles = harness.snapshot().files.filter((file) => file.name === 'tc-town-backup.json' && !file.deletedAt)
  assert.equal(liveFiles.length, 1)
  assert.equal(liveFiles[0]!.checksum, 'checksum-b')
})

test('checksum mismatch is marked as a permanent failure and never retried', async () => {
  let attempts = 0
  const harness = createHarness(async () => {
    attempts += 1
    return { kind: 'permanent' }
  })

  const record = { cid: '', meta: { v: 1, updatedAt: '2026-07-10T00:00:00.000Z', item: item() }, updatedAt: '2026-07-10T00:00:00.000Z', from: 'tc-town' as const }
  harness.actions.importFromBackup(record)
  await settle()

  assert.equal(attempts, 1)
  const state = importedState()
  assert.equal(state['tc-town-backup']?.checksum, 'checksum-a')
  assert.equal(state['tc-town-backup']?.fileId, '')
  assert.equal(harness.snapshot().files.some((file) => file.name === 'tc-town-backup.json'), false)

  harness.actions.importFromBackup(record)
  await settle()
  assert.equal(attempts, 1, 'a permanently-failed checksum should never be retried')
})

test('a transient storage_get failure is not recorded, so it retries on the next event', async () => {
  let attempts = 0
  const harness = createHarness(async () => {
    attempts += 1
    return { kind: 'transient' }
  })

  const record = { cid: '', meta: { v: 1, updatedAt: '2026-07-10T00:00:00.000Z', item: item() }, updatedAt: '2026-07-10T00:00:00.000Z', from: 'tc-town' as const }
  harness.actions.importFromBackup(record)
  await settle()

  assert.equal(attempts, 1)
  assert.deepEqual(importedState(), {})

  harness.actions.importFromBackup(record)
  await settle()
  assert.equal(attempts, 2, 'a transient failure should be retried on the next event')
})
