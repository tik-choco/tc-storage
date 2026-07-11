import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  childFolders,
  compactSnapshotTombstones,
  createInitialSnapshot,
  filesInFolder,
  makeFileFromDataUrl,
  makeFolder,
  stripSnapshotFileContent,
  tombstoneRetentionDays,
} from '../src/storage/domain.js'

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

test('compactSnapshotTombstones drops only tombstones older than the retention window', () => {
  const now = '2026-05-17T00:00:00.000Z'
  const nowMs = Date.parse(now)
  const dayMs = 24 * 60 * 60 * 1000
  const staleAt = new Date(nowMs - (tombstoneRetentionDays + 1) * dayMs).toISOString()
  const freshAt = new Date(nowMs - (tombstoneRetentionDays - 1) * dayMs).toISOString()

  const liveFolder = makeFolder({ id: 'folder-live', name: 'Live', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-test' })
  const staleFolder = { ...makeFolder({ id: 'folder-stale', name: 'Stale', parentId: null, color: 'blue', roomId: 'tc-storage-main', now, nodeId: 'node-test' }), deletedAt: staleAt }
  const freshFolder = { ...makeFolder({ id: 'folder-fresh', name: 'Fresh', parentId: null, color: 'amber', roomId: 'tc-storage-main', now, nodeId: 'node-test' }), deletedAt: freshAt }

  const fileArgs = { folderId: 'folder-live', mimeType: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,YQ==', checksum: 'a', now, nodeId: 'node-test' }
  const liveFile = makeFileFromDataUrl({ id: 'file-live', name: 'live.txt', ...fileArgs })
  const staleFile = { ...makeFileFromDataUrl({ id: 'file-stale', name: 'stale.txt', ...fileArgs }), deletedAt: staleAt }
  const freshFile = { ...makeFileFromDataUrl({ id: 'file-fresh', name: 'fresh.txt', ...fileArgs }), deletedAt: freshAt }

  const snapshot = { ...createInitialSnapshot('node-test'), folders: [liveFolder, staleFolder, freshFolder], files: [liveFile, staleFile, freshFile] }

  const compacted = compactSnapshotTombstones(snapshot, nowMs)

  assert.deepEqual(compacted.folders.map((folder) => folder.id).sort(), ['folder-fresh', 'folder-live'])
  assert.deepEqual(compacted.files.map((file) => file.id).sort(), ['file-fresh', 'file-live'])
  assert.equal(snapshot.folders.length, 3, 'input snapshot must not be mutated')
  assert.equal(snapshot.files.length, 3, 'input snapshot must not be mutated')
})

test('compactSnapshotTombstones keeps records with an unparseable deletedAt', () => {
  const now = '2026-05-17T00:00:00.000Z'
  const nowMs = Date.parse(now)
  const folder = { ...makeFolder({ id: 'folder-bad', name: 'Bad', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-test' }), deletedAt: 'not-a-date' }
  const file = { ...makeFileFromDataUrl({ id: 'file-bad', folderId: 'folder-bad', name: 'bad.txt', mimeType: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,YQ==', checksum: 'a', now, nodeId: 'node-test' }), deletedAt: 'not-a-date' }
  const snapshot = { ...createInitialSnapshot('node-test'), folders: [folder], files: [file] }

  const compacted = compactSnapshotTombstones(snapshot, nowMs)

  assert.deepEqual(compacted.folders.map((record) => record.id), ['folder-bad'])
  assert.deepEqual(compacted.files.map((record) => record.id), ['file-bad'])
})
