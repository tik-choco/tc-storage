import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  folderAccessGrantLimit,
  hasFolderAccessGrant,
  loadFolderAccessGrants,
  saveFolderAccessGrants,
  withFolderAccessGrant,
} from '../src/folder/folderAccessGrants.js'

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

test('folder access grants survive a reload', () => {
  const grants = withFolderAccessGrant(withFolderAccessGrant({}, 'folder-a', 'node-1'), 'folder-a', 'node-2')

  saveFolderAccessGrants(grants)

  assert.deepEqual(loadFolderAccessGrants(), { 'folder-a': ['node-1', 'node-2'] })
})

test('withFolderAccessGrant does not duplicate an existing node and keeps folders separate', () => {
  let grants = withFolderAccessGrant({}, 'folder-a', 'node-1')
  grants = withFolderAccessGrant(grants, 'folder-b', 'node-1')
  grants = withFolderAccessGrant(grants, 'folder-a', 'node-1')

  assert.deepEqual(grants, { 'folder-a': ['node-1'], 'folder-b': ['node-1'] })
})

test('hasFolderAccessGrant reports membership per folder and rejects empty ids', () => {
  const grants = withFolderAccessGrant({}, 'folder-a', 'node-1')

  assert.equal(hasFolderAccessGrant(grants, 'folder-a', 'node-1'), true)
  assert.equal(hasFolderAccessGrant(grants, 'folder-a', 'node-unknown'), false)
  assert.equal(hasFolderAccessGrant(grants, 'folder-unknown', 'node-1'), false)
  assert.equal(hasFolderAccessGrant(grants, '', 'node-1'), false)
  assert.equal(hasFolderAccessGrant(grants, 'folder-a', ''), false)
})

test('loading malformed stored grants ignores bad shapes without throwing', () => {
  localStorage.setItem('tc-storage-folder-access-grants-v1', JSON.stringify({
    'folder-array': ['node-1', 123, null, '', 'node-2'],
    'folder-not-array': 'node-1',
    'folder-null': null,
  }))

  assert.deepEqual(loadFolderAccessGrants(), { 'folder-array': ['node-1', 'node-2'] })
})

test('loading a stored value that is not an object returns no grants', () => {
  localStorage.setItem('tc-storage-folder-access-grants-v1', JSON.stringify(['node-1', 'node-2']))
  assert.deepEqual(loadFolderAccessGrants(), {})

  localStorage.setItem('tc-storage-folder-access-grants-v1', JSON.stringify(null))
  assert.deepEqual(loadFolderAccessGrants(), {})

  localStorage.setItem('tc-storage-folder-access-grants-v1', 'not json')
  assert.deepEqual(loadFolderAccessGrants(), {})
})

test('withFolderAccessGrant drops the oldest node once the per-folder limit is exceeded', () => {
  let grants: Record<string, string[]> = {}
  for (let i = 0; i < folderAccessGrantLimit + 5; i++) {
    grants = withFolderAccessGrant(grants, 'folder-a', `node-${i}`)
  }

  const nodeIds = grants['folder-a']
  assert.equal(nodeIds.length, folderAccessGrantLimit)
  // The oldest entries (node-0..node-4) must have fallen off.
  assert.equal(nodeIds.includes('node-0'), false)
  assert.equal(nodeIds.includes('node-4'), false)
  // The newest entry must be the last one added.
  assert.equal(nodeIds[nodeIds.length - 1], `node-${folderAccessGrantLimit + 4}`)
  assert.equal(nodeIds[0], 'node-5')
})

test('saveFolderAccessGrants does not throw when the storage write fails', () => {
  const throwingStorage = new MemoryStorage()
  throwingStorage.setItem = () => {
    throw new Error('QuotaExceededError')
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: throwingStorage,
    configurable: true,
  })

  assert.doesNotThrow(() => saveFolderAccessGrants({ 'folder-a': ['node-1'] }))
})
