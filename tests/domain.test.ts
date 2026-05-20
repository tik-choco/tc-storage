import assert from 'node:assert/strict'
import { test } from 'node:test'
import { childFolders, createInitialSnapshot, filesInFolder, makeFileFromDataUrl, makeFolder, stripSnapshotFileContent } from '../src/domain.js'

test('stripSnapshotFileContent removes file bodies but keeps content CIDs', () => {
  const now = '2026-05-17T00:00:00.000Z'
  const file = {
    ...makeFileFromDataUrl({
      id: 'file-test',
      folderId: 'folder-test',
      name: 'large.bin',
      mimeType: 'application/octet-stream',
      size: 1024,
      dataUrl: 'data:application/octet-stream;base64,' + 'a'.repeat(1024),
      checksum: 'checksum',
      now,
      nodeId: 'node-test',
    }),
    lastCid: 'bafy-file-content',
  }
  const stripped = stripSnapshotFileContent({ ...createInitialSnapshot('node-test'), files: [file] })
  const strippedFile = stripped.files[0]!

  assert.equal(strippedFile.dataUrl, undefined)
  assert.equal(strippedFile.lastCid, 'bafy-file-content')
  assert.equal(strippedFile.fieldVersions?.dataUrl, undefined)
})

test('folders and files use saved sort order before falling back to names', () => {
  const now = '2026-05-17T00:00:00.000Z'
  const root = makeFolder({
    id: 'folder-root',
    name: 'Root',
    parentId: null,
    color: 'teal',
    roomId: 'tc-storage-main',
    now,
    nodeId: 'node-test',
  })
  const zeta = { ...makeFolder({ id: 'folder-zeta', name: 'Zeta', parentId: root.id, color: 'blue', roomId: 'tc-storage-main', now, nodeId: 'node-test' }), sortOrder: 2000 }
  const alpha = { ...makeFolder({ id: 'folder-alpha', name: 'Alpha', parentId: root.id, color: 'amber', roomId: 'tc-storage-main', now, nodeId: 'node-test' }), sortOrder: 1000 }
  const laterFile = { ...makeFileFromDataUrl({ id: 'file-later', folderId: root.id, name: 'b.txt', mimeType: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,Yg==', checksum: 'b', now, nodeId: 'node-test' }), sortOrder: 2000 }
  const earlierFile = { ...makeFileFromDataUrl({ id: 'file-earlier', folderId: root.id, name: 'a.txt', mimeType: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,YQ==', checksum: 'a', now, nodeId: 'node-test' }), sortOrder: 1000 }
  const snapshot = { ...createInitialSnapshot('node-test'), folders: [root, zeta, alpha], files: [laterFile, earlierFile] }

  assert.deepEqual(childFolders(snapshot, root.id).map((folder) => folder.id), ['folder-alpha', 'folder-zeta'])
  assert.deepEqual(filesInFolder(snapshot, root.id).map((file) => file.id), ['file-earlier', 'file-later'])
})
