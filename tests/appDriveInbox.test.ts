import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createDriveInboxActions, type DriveInboxItem, type ResolveItemResult } from '../src/app/appDriveInbox.js'
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

function importedIds(): string[] {
  const raw = store['tc-storage-drive-inbox-imported-v1']
  return raw ? (JSON.parse(raw) as string[]) : []
}

function item(id: string, overrides: Partial<DriveInboxItem> = {}): DriveInboxItem {
  return {
    id,
    name: `${id}.txt`,
    mimeType: 'text/plain',
    size: 1,
    checksum: 'checksum',
    cid: `cid-${id}`,
    key: 'key',
    iv: 'iv',
    addedAt: '2026-05-20T00:00:00.000Z',
    ...overrides,
  }
}

function createHarness(resolveItemFile: (item: DriveInboxItem, nodeId: string) => Promise<ResolveItemResult>) {
  let snapshot: StorageSnapshot = createInitialSnapshot('node-test')
  const snapshotRef = { current: snapshot }
  const settingsRef = { current: { nodeId: 'node-test', roomId: 'tc-storage-main', identity: null, autoConnect: false, profileName: 'Test user', avatarUrl: '', avatarFileId: '' } as AppSettings }
  const uploadCalls: { fileList: FileList | null; folderId?: string | null }[] = []
  const uploadFilesRef = {
    current: async (fileList: FileList | null, folderId?: string | null) => {
      uploadCalls.push({ fileList, folderId })
    },
  }
  const actions = createDriveInboxActions({
    snapshotRef,
    setSnapshot: (update: StateUpdate<StorageSnapshot>) => {
      snapshot = typeof update === 'function' ? (update as (current: StorageSnapshot) => StorageSnapshot)(snapshot) : update
      snapshotRef.current = snapshot
    },
    settingsRef,
    uploadFilesRef,
    resolveItemFile,
  })
  return { actions, uploadCalls, snapshot: () => snapshot }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('a transient resolve failure is not recorded as imported, so it retries on the next event', async () => {
  let attempts = 0
  const harness = createHarness(async () => {
    attempts += 1
    return { kind: 'transient' }
  })

  harness.actions.importFromInbox({ cid: '', meta: { items: [item('a')] }, updatedAt: '2026-05-20T00:00:00.000Z', from: 'tc-note' })
  await settle()

  assert.equal(attempts, 1)
  assert.deepEqual(importedIds(), [])
  assert.equal(harness.uploadCalls.length, 0)

  // Republishing the same (still-unresolved) item retries it rather than
  // silently treating it as already handled.
  harness.actions.importFromInbox({ cid: '', meta: { items: [item('a')] }, updatedAt: '2026-05-20T00:00:01.000Z', from: 'tc-note' })
  await settle()

  assert.equal(attempts, 2)
  assert.deepEqual(importedIds(), [])
})

test('a permanent resolve failure (checksum mismatch / decrypt failure) is marked imported and never retried', async () => {
  let attempts = 0
  const harness = createHarness(async () => {
    attempts += 1
    return { kind: 'permanent' }
  })

  harness.actions.importFromInbox({ cid: '', meta: { items: [item('b')] }, updatedAt: '2026-05-20T00:00:00.000Z', from: 'tc-note' })
  await settle()

  assert.equal(attempts, 1)
  assert.deepEqual(importedIds(), ['b'])
  assert.equal(harness.uploadCalls.length, 0)

  harness.actions.importFromInbox({ cid: '', meta: { items: [item('b')] }, updatedAt: '2026-05-20T00:00:01.000Z', from: 'tc-note' })
  await settle()

  // Never re-attempted once marked as a permanent failure.
  assert.equal(attempts, 1)
})

test('a resolved item is uploaded into the tc-note inbox folder and recorded as imported', async () => {
  const file = new File(['hello'], 'c.txt', { type: 'text/plain' })
  const harness = createHarness(async () => ({ kind: 'resolved', file }))

  harness.actions.importFromInbox({ cid: '', meta: { items: [item('c')] }, updatedAt: '2026-05-20T00:00:00.000Z', from: 'tc-note' })
  await settle()

  assert.deepEqual(importedIds(), ['c'])
  assert.equal(harness.uploadCalls.length, 1)
  assert.equal(harness.snapshot().folders.some((folder) => folder.name === 'tc-noteから追加'), true)
})

test('a mix of transient, permanent, and resolved items in one republish is handled independently', async () => {
  const file = new File(['hello'], 'resolved.txt', { type: 'text/plain' })
  const harness = createHarness(async (current) => {
    if (current.id === 'transient-id') return { kind: 'transient' }
    if (current.id === 'permanent-id') return { kind: 'permanent' }
    return { kind: 'resolved', file }
  })

  harness.actions.importFromInbox({
    cid: '',
    meta: { items: [item('transient-id'), item('permanent-id'), item('resolved-id')] },
    updatedAt: '2026-05-20T00:00:00.000Z',
    from: 'tc-note',
  })
  await settle()

  assert.deepEqual(importedIds().toSorted(), ['permanent-id', 'resolved-id'])
  assert.equal(harness.uploadCalls.length, 1)
})
