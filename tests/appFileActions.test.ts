import assert from 'node:assert/strict'
import { test } from 'node:test'
import { optimisticUploadedFiles } from '../src/appFileActions.js'
import { mergeUploadedFiles } from '../src/appHelpers.js'
import { makeFileFromDataUrl } from '../src/domain.js'

test('optimisticUploadedFiles keeps same-name uploads as separate rows while content stores in background', () => {
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
  const merged = mergeUploadedFiles([storedPrevious], [optimistic!], '2026-05-23T00:00:02.000Z', 'node-a')

  assert.equal(optimistic?.id, 'file-new')
  assert.equal(optimistic?.lastCid, undefined)
  assert.equal(optimistic?.checksum, 'checksum-new')
  assert.equal(optimistic?.dataUrl, incoming.dataUrl)
  assert.equal(optimistic?.version, incoming.version)
  assert.deepEqual(merged.map((file) => file.id), ['file-existing', 'file-new'])
  assert.deepEqual(merged.map((file) => file.name), ['clip.mp4', 'clip.mp4'])
})

test('optimisticUploadedFiles preserves duplicate upload names with distinct identities', () => {
  const firstIncoming = makeTestFile({
    id: 'file-first',
    name: 'report.txt',
    checksum: 'checksum-first',
    dataUrl: 'data:text/plain;base64,Zmlyc3Q=',
    size: 5,
  })
  const secondIncoming = makeTestFile({
    id: 'file-second',
    name: 'REPORT.txt',
    checksum: 'checksum-second',
    dataUrl: 'data:text/plain;base64,c2Vjb25k',
    size: 6,
  })

  const optimistic = optimisticUploadedFiles([], [firstIncoming, secondIncoming], '2026-05-23T00:00:03.000Z', 'node-a')

  assert.deepEqual(optimistic.map((file) => file.id), ['file-first', 'file-second'])
  assert.deepEqual(optimistic.map((file) => file.name), ['report.txt', 'REPORT.txt'])
})

test('mergeUploadedFiles replaces by cid instead of file name', () => {
  const previous = makeTestFile({
    id: 'file-existing',
    name: 'Report.txt',
    checksum: 'checksum-old',
    dataUrl: undefined,
    lastCid: 'cid-shared',
    version: 3,
  })
  const sameNameNewCid = makeTestFile({
    id: 'file-new',
    name: 'report.txt',
    checksum: 'checksum-new',
    dataUrl: undefined,
    lastCid: 'cid-new',
    size: 5,
  })
  const sameCidDifferentName = makeTestFile({
    id: 'file-replacement',
    name: 'renamed.txt',
    checksum: 'checksum-replacement',
    dataUrl: undefined,
    lastCid: 'cid-shared',
    size: 4,
  })

  const mergedWithSameName = mergeUploadedFiles([previous], [sameNameNewCid], '2026-05-23T00:00:03.000Z', 'node-a')
  const mergedWithSameCid = mergeUploadedFiles([previous], [sameCidDifferentName], '2026-05-23T00:00:04.000Z', 'node-a')

  assert.deepEqual(mergedWithSameName.map((file) => file.id), ['file-existing', 'file-new'])
  assert.deepEqual(mergedWithSameName.map((file) => file.name), ['Report.txt', 'report.txt'])
  assert.equal(mergedWithSameCid.length, 1)
  assert.equal(mergedWithSameCid[0]?.id, previous.id)
  assert.equal(mergedWithSameCid[0]?.name, sameCidDifferentName.name)
  assert.equal(mergedWithSameCid[0]?.checksum, sameCidDifferentName.checksum)
  assert.equal(mergedWithSameCid[0]?.lastCid, sameCidDifferentName.lastCid)
  assert.equal(mergedWithSameCid[0]?.version, previous.version + 1)
})

function makeTestFile(options: {
  id: string
  name: string
  checksum: string
  dataUrl?: string
  lastCid?: string
  size?: number
  version?: number
}) {
  const file = makeFileFromDataUrl({
    id: options.id,
    folderId: 'folder-a',
    name: options.name,
    mimeType: 'text/plain',
    size: options.size ?? 10,
    dataUrl: options.dataUrl ?? 'data:text/plain;base64,dGVzdA==',
    checksum: options.checksum,
    now: '2026-05-23T00:00:01.000Z',
    nodeId: 'node-a',
  })
  return {
    ...file,
    dataUrl: options.dataUrl,
    lastCid: options.lastCid,
    version: options.version ?? file.version,
  }
}
