import assert from 'node:assert/strict'
import { test } from 'node:test'
import { optimisticUploadedFiles } from '../src/appFileActions.js'
import { makeFileFromDataUrl } from '../src/domain.js'

test('optimisticUploadedFiles keeps existing rows visible while new content stores in background', () => {
  const previous = makeFileFromDataUrl({
    id: 'file-existing',
    folderId: 'folder-a',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    size: 10,
    dataUrl: 'data:video/mp4;base64,b2xk',
    checksum: 'checksum-old',
    now: '2026-05-23T00:00:00.000Z',
    nodeId: 'node-a',
  })
  const storedPrevious = { ...previous, dataUrl: undefined, lastCid: 'cid-old' }
  const incoming = makeFileFromDataUrl({
    id: 'file-new',
    folderId: 'folder-a',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    size: 20,
    dataUrl: 'data:video/mp4;base64,bmV3',
    checksum: 'checksum-new',
    now: '2026-05-23T00:00:01.000Z',
    nodeId: 'node-a',
  })

  const [optimistic] = optimisticUploadedFiles([storedPrevious], [incoming], '2026-05-23T00:00:02.000Z', 'node-a')

  assert.equal(optimistic?.id, 'file-existing')
  assert.equal(optimistic?.lastCid, undefined)
  assert.equal(optimistic?.checksum, 'checksum-new')
  assert.equal(optimistic?.dataUrl, incoming.dataUrl)
  assert.equal(optimistic?.version, previous.version + 1)
})
