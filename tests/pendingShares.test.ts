import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import type { PendingShare } from '../src/appTypes.js'
import { loadFolderAccessModes, saveFolderAccessModes } from '../src/folderAccess.js'
import { loadImportKeys, loadPendingShares, saveImportKeys, savePendingShares } from '../src/pendingShares.js'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

let originalLocalStorage: Storage | undefined

beforeEach(() => {
  originalLocalStorage = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: originalLocalStorage,
    configurable: true,
  })
})

test('pending shares and import keys survive a reload', () => {
  const share: PendingShare = {
    type: 'folder-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-20T00:00:00.000Z',
    receivedAt: '2026-05-20T00:00:01.000Z',
    clock: 2,
    cid: 'cid-folder',
    folderId: 'folder-a',
    folderName: 'Shared docs',
    autoImport: true,
    senderProfile: { name: 'Sender' },
  }

  savePendingShares([share])
  saveImportKeys({ 'cid-folder': 'secret-key' })

  assert.deepEqual(loadPendingShares(), [share])
  assert.deepEqual(loadImportKeys(), { 'cid-folder': 'secret-key' })
})

test('fixed folder invite pending shares survive without a cid', () => {
  const share: PendingShare = {
    type: 'folder-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 0,
    folderId: 'folder-fixed',
    folderName: 'Fixed invite',
    ownerNodeId: 'node-owner',
    autoImport: true,
    senderProfile: { name: 'Owner' },
  }

  savePendingShares([share])

  assert.deepEqual(loadPendingShares(), [share])
})

test('pending share storage ignores malformed records', () => {
  localStorage.setItem('tc-storage-pending-shares-v1', JSON.stringify([
    { type: 'hello', cid: 'cid-hello' },
    {
      type: 'file-share',
      from: 'node-a',
      roomId: 'tc-storage-main',
      sentAt: '2026-05-20T00:00:00.000Z',
      receivedAt: '2026-05-20T00:00:01.000Z',
      clock: 3,
      cid: 'cid-file',
      fileName: 'memo.txt',
      autoImport: true,
    },
  ]))

  assert.deepEqual(loadPendingShares().map((share) => share.cid), ['cid-file'])
})

test('folder access modes survive a reload and normalize invalid modes', () => {
  saveFolderAccessModes({ 'folder-approval': 'approval', 'folder-open': 'open' })
  localStorage.setItem('tc-storage-folder-access-modes-v1', JSON.stringify({
    ...loadFolderAccessModes(),
    'folder-invalid': 'anything',
  }))

  assert.deepEqual(loadFolderAccessModes(), {
    'folder-approval': 'approval',
    'folder-open': 'open',
    'folder-invalid': 'approval',
  })
})
