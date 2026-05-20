import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInitialSnapshot, makeFileFromDataUrl, stripSnapshotFileContent } from '../src/domain.js'

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
