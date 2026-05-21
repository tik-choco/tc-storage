import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { makeFolder } from '../src/domain.js'
import { makeFileShareUrl, makeFolderShareUrl, readShareLink } from '../src/shareLinks.js'

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')

afterEach(() => {
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation)
  else delete (globalThis as { location?: Location }).location
})

test('folder share URL is a stable approval invite without cid or decryption key', () => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'http://localhost/app/?folder=folder-old' },
  })
  const folder = {
    ...makeFolder({ id: 'folder-fixed', name: 'Shared docs', parentId: null, color: 'teal', roomId: 'room-a', now: '2026-05-21T00:00:00.000Z', nodeId: 'node-a' }),
    lastCid: 'cid-current',
    shareEnabled: true,
  }

  const url = makeFolderShareUrl(folder, 'room-a', { name: 'Owner' })
  const linked = readShareLink(new URL(url).hash)

  assert.equal(new URL(url).searchParams.has('folder'), false)
  assert.equal(linked?.key, '')
  assert.equal(linked?.share.type, 'folder-share')
  assert.equal(linked?.share.folderId, 'folder-fixed')
  assert.equal(linked?.share.cid, undefined)
})

test('file share URL keeps snapshot cid and key for direct import', () => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'http://localhost/app/' },
  })
  const folder = makeFolder({ id: 'folder-a', name: 'Folder A', parentId: null, color: 'blue', roomId: 'room-a', now: '2026-05-21T00:00:00.000Z', nodeId: 'node-a' })
  const file = {
    id: 'file-a',
    folderId: folder.id,
    name: 'memo.txt',
    mimeType: 'text/plain',
    size: 4,
    checksum: 'sum',
    version: 1,
    starred: false,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
  }

  const linked = readShareLink(new URL(makeFileShareUrl(file, folder, 'room-a', 5, 'cid-file', 'file-secret', { name: 'Owner' })).hash)

  assert.equal(linked?.key, 'file-secret')
  assert.equal(linked?.share.cid, 'cid-file')
  assert.equal(linked?.share.fileId, 'file-a')
})
