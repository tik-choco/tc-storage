import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sortBrowserFiles, sortBrowserFolders } from '../src/app/appHelpers.js'
import { makeFileFromDataUrl, makeFolder } from '../src/storage/domain.js'

const now = '2026-06-04T00:00:00.000Z'

test('browser file sort supports manual, name, updated, and size order', () => {
  const files = [
    makeTestFile('file-c', 'clip10.mp4', 10, '2026-06-01T00:00:00.000Z', 1000),
    makeTestFile('file-a', 'clip2.mp4', 30, '2026-06-03T00:00:00.000Z', 3000),
    makeTestFile('file-b', 'notes.txt', 20, '2026-06-02T00:00:00.000Z', 2000),
  ]

  assert.deepEqual(sortBrowserFiles(files, 'manual').map((file) => file.id), ['file-c', 'file-a', 'file-b'])
  assert.deepEqual(sortBrowserFiles(files, 'name-asc').map((file) => file.id), ['file-a', 'file-c', 'file-b'])
  assert.deepEqual(sortBrowserFiles(files, 'updated-desc').map((file) => file.id), ['file-a', 'file-b', 'file-c'])
  assert.deepEqual(sortBrowserFiles(files, 'size-asc').map((file) => file.id), ['file-c', 'file-b', 'file-a'])
})

test('browser folder sort supports manual, name, and updated order', () => {
  const folders = [
    makeTestFolder('folder-b', 'Beta', '2026-06-02T00:00:00.000Z', 2000),
    makeTestFolder('folder-a', 'Alpha', '2026-06-03T00:00:00.000Z', 1000),
  ]

  assert.deepEqual(sortBrowserFolders(folders, 'manual').map((folder) => folder.id), ['folder-b', 'folder-a'])
  assert.deepEqual(sortBrowserFolders(folders, 'name-asc').map((folder) => folder.id), ['folder-a', 'folder-b'])
  assert.deepEqual(sortBrowserFolders(folders, 'updated-desc').map((folder) => folder.id), ['folder-a', 'folder-b'])
})

function makeTestFile(id: string, name: string, size: number, updatedAt: string, sortOrder: number) {
  return { ...makeFileFromDataUrl({ id, folderId: 'folder-root', name, mimeType: 'text/plain', size, dataUrl: 'data:text/plain;base64,YQ==', checksum: id, now, nodeId: 'node-test' }), sortOrder, updatedAt }
}

function makeTestFolder(id: string, name: string, updatedAt: string, sortOrder: number) {
  return { ...makeFolder({ id, name, parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-test' }), sortOrder, updatedAt }
}
