import assert from 'node:assert/strict'
import { test } from 'node:test'
import { folderContentProgress } from '../src/components/browserProgressUtils.js'
import { stampFilePatch } from '../src/storage/crdt.js'
import { makeFileFromDataUrl, type FileRecord } from '../src/storage/domain.js'

const now = '2026-06-04T00:00:00.000Z'

function file(id: string, folderId: string, overrides: Partial<FileRecord> = {}): FileRecord {
  const base = stampFilePatch(makeFileFromDataUrl({
    id,
    folderId,
    name: `${id}.txt`,
    mimeType: 'text/plain',
    size: 5,
    dataUrl: 'data:text/plain;base64,aGVsbG8=',
    checksum: `checksum-${id}`,
    now,
    nodeId: 'node-a',
  }), {}, now, 'node-a')
  // makeFileFromDataUrl always sets dataUrl; tests that want an unresolved file strip it back off.
  return { ...base, ...overrides }
}

test('folderContentProgress returns undefined for an empty folder', () => {
  assert.equal(folderContentProgress([], 'folder-a', {}), undefined)
})

test('folderContentProgress returns undefined once every file in the folder has content', () => {
  const files = [
    file('file-a', 'folder-a', { dataUrl: 'data:text/plain;base64,aGVsbG8=' }),
    file('file-b', 'folder-a', { dataUrl: undefined }),
  ]
  const fileDataUrls = { 'file-b': 'data:text/plain;base64,d29ybGQ=' }

  assert.equal(folderContentProgress(files, 'folder-a', fileDataUrls), undefined)
})

test('folderContentProgress counts both file.dataUrl and the fileDataUrls cache as ready', () => {
  const files = [
    file('file-a', 'folder-a', { dataUrl: 'data:text/plain;base64,aGVsbG8=' }), // ready via record
    file('file-b', 'folder-a', { dataUrl: undefined }), // ready via cache
    file('file-c', 'folder-a', { dataUrl: undefined }), // not ready
  ]
  const fileDataUrls = { 'file-b': 'data:text/plain;base64,d29ybGQ=' }

  const progress = folderContentProgress(files, 'folder-a', fileDataUrls)

  assert.deepEqual(progress, { ready: 2, total: 3, percent: 67 })
})

test('folderContentProgress excludes deleted files and files from other folders', () => {
  const files = [
    file('file-a', 'folder-a', { dataUrl: undefined }),
    file('file-b', 'folder-a', { dataUrl: undefined, deletedAt: now }),
    file('file-c', 'folder-other', { dataUrl: undefined }),
  ]
  const fileDataUrls = { 'file-c': 'data:text/plain;base64,d29ybGQ=' }

  const progress = folderContentProgress(files, 'folder-a', fileDataUrls)

  // Only file-a counts toward the folder-a total; file-b is deleted, file-c belongs elsewhere.
  assert.deepEqual(progress, { ready: 0, total: 1, percent: 0 })
})
