import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createTranslationsInboxActions } from '../src/app/appTranslationsInbox.js'
import { createInitialSnapshot, type StorageSnapshot } from '../src/storage/domain.js'
import type { AppSettings } from '../src/storage/localSettings.js'
import type { Notice } from '../src/app/appTypes.js'

type StateUpdate<T> = T | ((current: T) => T)

interface TranslationInboxItemLike {
  id: string
  fileName: string
  mimeType: string
  text?: string
  cid?: string
}

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
  const raw = store['tc-storage-translate-imported-v1']
  return raw ? (JSON.parse(raw) as string[]) : []
}

function item(id: string, overrides: Partial<TranslationInboxItemLike> = {}): TranslationInboxItemLike {
  return {
    id,
    fileName: `${id}.md`,
    mimeType: 'text/markdown',
    cid: `cid-${id}`,
    ...overrides,
  }
}

function createHarness(resolveText: (item: TranslationInboxItemLike, nodeId: string) => Promise<string | undefined>) {
  let snapshot: StorageSnapshot = createInitialSnapshot('node-test')
  const snapshotRef = { current: snapshot }
  const settingsRef = { current: { nodeId: 'node-test', roomId: 'tc-storage-main', identity: null, autoConnect: false, profileName: 'Test user', avatarUrl: '', avatarFileId: '' } as AppSettings }
  const uploadCalls: { fileList: FileList | null; folderId?: string | null }[] = []
  const uploadFilesRef = {
    current: async (fileList: FileList | null, folderId?: string | null) => {
      uploadCalls.push({ fileList, folderId })
    },
  }
  const notices: Notice[] = []
  const actions = createTranslationsInboxActions({
    snapshotRef,
    setSnapshot: (update: StateUpdate<StorageSnapshot>) => {
      snapshot = typeof update === 'function' ? (update as (current: StorageSnapshot) => StorageSnapshot)(snapshot) : update
      snapshotRef.current = snapshot
    },
    settingsRef,
    uploadFilesRef,
    setNotice: (update: StateUpdate<Notice>) => {
      // Notice state itself isn't under test, only that setNotice was invoked;
      // resolve a concrete value the same way the real setState would so
      // callers using an updater fn still work.
      const previous: Notice = { tone: 'info', text: '' }
      const next = typeof update === 'function' ? (update as (current: Notice) => Notice)(previous) : update
      notices.push(next)
    },
    resolveText,
  })
  return { actions, uploadCalls, notices, snapshot: () => snapshot }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('a failing item triggers exactly one notice', async () => {
  const harness = createHarness(async () => undefined)

  harness.actions.importFromInbox({ cid: '', meta: { items: [item('a')] }, updatedAt: '2026-05-20T00:00:00.000Z', from: 'tc-translate' })
  await settle()

  assert.equal(harness.notices.length, 1)
  assert.equal(harness.notices[0].tone, 'error')
  assert.match(harness.notices[0].text, /1件/)
  assert.deepEqual(importedIds(), [])
  assert.equal(harness.uploadCalls.length, 0)
})

test('the same still-failing item on a subsequent call does not trigger a duplicate notice', async () => {
  const harness = createHarness(async () => undefined)

  harness.actions.importFromInbox({ cid: '', meta: { items: [item('a')] }, updatedAt: '2026-05-20T00:00:00.000Z', from: 'tc-translate' })
  await settle()
  assert.equal(harness.notices.length, 1)

  harness.actions.importFromInbox({ cid: '', meta: { items: [item('a')] }, updatedAt: '2026-05-20T00:00:01.000Z', from: 'tc-translate' })
  await settle()

  // Still failing, but already notified: no new notice.
  assert.equal(harness.notices.length, 1)
})

test('a later successful resolve clears the notified set so a fresh failure afterward notifies again', async () => {
  let shouldFail = true
  const harness = createHarness(async (current) => (shouldFail ? undefined : `body for ${current.id}`))

  harness.actions.importFromInbox({ cid: '', meta: { items: [item('a')] }, updatedAt: '2026-05-20T00:00:00.000Z', from: 'tc-translate' })
  await settle()
  assert.equal(harness.notices.length, 1)

  // Now resolves successfully -- clears the notified-failure entry and marks
  // the item as imported.
  shouldFail = false
  harness.actions.importFromInbox({ cid: '', meta: { items: [item('a')] }, updatedAt: '2026-05-20T00:00:01.000Z', from: 'tc-translate' })
  await settle()
  assert.equal(harness.notices.length, 1)
  assert.deepEqual(importedIds(), ['a'])
  assert.equal(harness.uploadCalls.length, 1)

  // Simulate the file being deleted elsewhere so it's no longer in the
  // imported set (per the module's own dedupe contract: "user deletions are
  // respected"), then republish it and have it fail again (e.g. the CID was
  // evicted again). Since the notified-failure entry was cleared on the
  // earlier success, this fresh failure must notify again rather than
  // staying silent forever.
  store['tc-storage-translate-imported-v1'] = JSON.stringify([])
  shouldFail = true
  harness.actions.importFromInbox({ cid: '', meta: { items: [item('a')] }, updatedAt: '2026-05-20T00:00:02.000Z', from: 'tc-translate' })
  await settle()
  assert.equal(harness.notices.length, 2)
})
