import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInitialSnapshot, makeFileFromDataUrl, makeFolder, tombstoneRetentionDays } from '../src/storage/domain.js'
import { loadStoredSnapshot, persistSnapshot } from '../src/storage/localSnapshot.js'

type JsonStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

function makeQuotaLimitedStorage(maxLength: number): JsonStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      if (value.length > maxLength) throw new DOMException('exceeded the quota', 'QuotaExceededError')
      values.set(key, value)
    },
  }
}

function snapshotWithActivity(activityCount: number, filler = '') {
  const now = '2026-05-17T00:00:00.000Z'
  const snapshot = createInitialSnapshot('node-test')
  const activity = Array.from({ length: activityCount }, (_, index) => ({
    id: `activity-${index}`,
    actorNodeId: 'node-test',
    action: 'create',
    detail: filler || `entry ${index}`,
    at: now,
  }))
  return { ...snapshot, activity }
}

test('persistSnapshot succeeds and writes the stripped snapshot on the first attempt', () => {
  const storage = makeQuotaLimitedStorage(1_000_000)
  const snapshot = snapshotWithActivity(5)

  const result = persistSnapshot(snapshot, storage)

  assert.equal(result, true)
  const stored = JSON.parse(storage.values.get('tc-storage-snapshot-v1')!)
  assert.equal(stored.activity.length, 5)
})

test('persistSnapshot trims activity and retries after a quota failure, without mutating the in-memory snapshot', () => {
  const now = '2026-05-17T00:00:00.000Z'
  const snapshot = createInitialSnapshot('node-test')
  const file = makeFileFromDataUrl({
    id: 'file-test',
    folderId: 'folder-test',
    name: 'large.bin',
    mimeType: 'application/octet-stream',
    size: 1024,
    dataUrl: 'data:application/octet-stream;base64,' + 'a'.repeat(1024),
    checksum: 'checksum',
    now,
    nodeId: 'node-test',
  })
  // 40 activity entries (the normal cap) push the payload over the storage limit; 10 fits.
  const activity = Array.from({ length: 40 }, (_, index) => ({
    id: `activity-${index}`,
    actorNodeId: 'node-test',
    action: 'create',
    detail: `some fairly long activity detail text to inflate payload size ${index}`,
    at: now,
  }))
  const fullSnapshot = { ...snapshot, files: [file], activity }
  const fullSerializedLength = JSON.stringify(fullSnapshot).length
  const trimmedSerializedLength = JSON.stringify({ ...fullSnapshot, activity: activity.slice(0, 10) }).length
  const storage = makeQuotaLimitedStorage(Math.floor((fullSerializedLength + trimmedSerializedLength) / 2))

  const result = persistSnapshot(fullSnapshot, storage)

  assert.equal(result, true)
  assert.equal(fullSnapshot.activity.length, 40, 'in-memory snapshot activity must not be mutated')
  const stored = JSON.parse(storage.values.get('tc-storage-snapshot-v1')!)
  assert.equal(stored.activity.length, 10)
  assert.equal(stored.files[0].dataUrl, undefined, 'file content should still be stripped')
})

test('persistSnapshot gives up and returns false without throwing when even trimmed activity cannot fit', () => {
  const storage = makeQuotaLimitedStorage(10)
  const snapshot = snapshotWithActivity(20)

  const result = persistSnapshot(snapshot, storage)

  assert.equal(result, false)
  assert.equal(storage.values.has('tc-storage-snapshot-v1'), false)
})

test('persistSnapshot drops tombstoned records from local persistence as a last resort, leaving the in-memory snapshot intact', () => {
  const now = '2026-05-17T00:00:00.000Z'
  const liveFolder = makeFolder({ id: 'folder-live', name: 'Live', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-test' })
  const deletedFolder = { ...makeFolder({ id: 'folder-deleted', name: 'Deleted', parentId: null, color: 'blue', roomId: 'tc-storage-main', now, nodeId: 'node-test' }), deletedAt: now }
  const activity = Array.from({ length: 10 }, (_, index) => ({
    id: `activity-${index}`,
    actorNodeId: 'node-test',
    action: 'create',
    detail: `padding activity detail text to inflate payload size ${index}`,
    at: now,
  }))
  const fullSnapshot = { ...createInitialSnapshot('node-test'), folders: [liveFolder, deletedFolder], activity }
  const trimmedLength = JSON.stringify({ ...fullSnapshot, activity: activity.slice(0, 10) }).length
  const tombstoneFreeLength = JSON.stringify({ ...fullSnapshot, activity: activity.slice(0, 10), folders: [liveFolder] }).length
  const storage = makeQuotaLimitedStorage(Math.floor((trimmedLength + tombstoneFreeLength) / 2))

  const result = persistSnapshot(fullSnapshot, storage)

  assert.equal(result, true)
  const stored = JSON.parse(storage.values.get('tc-storage-snapshot-v1')!)
  assert.deepEqual(stored.folders.map((folder: { id: string }) => folder.id), ['folder-live'])
  assert.equal(fullSnapshot.folders.length, 2, 'in-memory snapshot must keep tombstoned records')
})

test('loadStoredSnapshot compacts stale tombstones out of the persisted snapshot', () => {
  const now = '2026-05-17T00:00:00.000Z'
  const nowMs = Date.parse(now)
  const dayMs = 24 * 60 * 60 * 1000
  const staleAt = new Date(nowMs - (tombstoneRetentionDays + 1) * dayMs).toISOString()
  const staleFolder = { ...makeFolder({ id: 'folder-stale', name: 'Stale', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-test' }), deletedAt: staleAt }
  const liveFolder = makeFolder({ id: 'folder-live', name: 'Live', parentId: null, color: 'blue', roomId: 'tc-storage-main', now, nodeId: 'node-test' })
  const stored = { ...createInitialSnapshot('node-test'), folders: [staleFolder, liveFolder], files: [] }
  const storage = makeQuotaLimitedStorage(1_000_000)
  storage.setItem('tc-storage-snapshot-v1', JSON.stringify(stored))

  const loaded = loadStoredSnapshot('node-test', storage, nowMs)

  assert.deepEqual(loaded.snapshot.folders.map((folder) => folder.id), ['folder-live'])
  assert.equal(loaded.loadedFromStorage, true)
})

test('loadStoredSnapshot reports loadedFromStorage as false when stored JSON is corrupt', () => {
  const storage = makeQuotaLimitedStorage(1_000_000)
  storage.setItem('tc-storage-snapshot-v1', 'not valid json {')

  const loaded = loadStoredSnapshot('node-test', storage)

  assert.equal(loaded.loadedFromStorage, false)
  assert.deepEqual(loaded.snapshot.folders, [])
  assert.deepEqual(loaded.snapshot.files, [])
})

test('loadStoredSnapshot reports loadedFromStorage as false when the stored shape is malformed', () => {
  const storage = makeQuotaLimitedStorage(1_000_000)
  storage.setItem('tc-storage-snapshot-v1', JSON.stringify({ ...createInitialSnapshot('node-test'), folders: 'not-an-array' }))

  const loaded = loadStoredSnapshot('node-test', storage)

  assert.equal(loaded.loadedFromStorage, false)
})

test('loadStoredSnapshot reports loadedFromStorage as false when there is no stored snapshot', () => {
  const storage = makeQuotaLimitedStorage(1_000_000)

  const loaded = loadStoredSnapshot('node-test', storage)

  assert.equal(loaded.loadedFromStorage, false)
  assert.deepEqual(loaded.snapshot.folders, [])
})
