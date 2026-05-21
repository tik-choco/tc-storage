import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { didKeyFromEd25519PublicKey } from '../src/didIdentity.js'
import { makeFolder } from '../src/domain.js'
import { folderKeyHash } from '../src/folderKeyProof.js'
import { makeFileShareUrl, makeFolderShareUrl, readShareLink } from '../src/shareLinks.js'

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
const ownerDid = didFromSeed(1)
const folderSecret = 'folder-secret'

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

  const url = makeFolderShareUrl(folder, 'room-a', { name: 'Owner' }, ownerDid, folderSecret)
  const linked = readShareLink(new URL(url).hash)

  assert.equal(new URL(url).searchParams.has('folder'), false)
  assert.equal(linked?.key, '')
  assert.equal(linked?.share.type, 'folder-share')
  assert.equal(linked?.share.folderId, 'folder-fixed')
  assert.equal(linked?.share.cid, undefined)
  assert.equal(linked?.share.ownerNodeId, ownerDid)
  assert.equal(linked?.share.folderKeyHash, folderKeyHash(folder.id, folderSecret))
})

test('folder share URL requires a did:key owner', () => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'http://localhost/app/' },
  })
  const folder = makeFolder({ id: 'folder-fixed', name: 'Shared docs', parentId: null, color: 'teal', roomId: 'room-a', now: '2026-05-21T00:00:00.000Z', nodeId: 'node-a' })

  assert.throws(() => makeFolderShareUrl(folder, 'room-a', { name: 'Owner' }, 'node-owner', folderSecret), /署名用DID/)
  assert.throws(() => makeFolderShareUrl(folder, 'room-a', { name: 'Owner' }, ownerDid, ''), /検証情報/)
})

test('folder share URL parser rejects cid or decryption key in approval invites', () => {
  const payload = {
    v: 1,
    type: 'folder-share',
    roomId: 'room-a',
    folderId: 'folder-fixed',
    folderName: 'Shared docs',
    ownerNodeId: ownerDid,
    folderKeyHash: folderKeyHash('folder-fixed', folderSecret),
    cid: 'cid-should-not-be-here',
    key: 'folder-secret-should-not-be-here',
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')

  assert.equal(readShareLink(`#tc-share=${encoded}`), undefined)
})

test('folder share URL parser rejects approval invites without a did:key owner', () => {
  const missingOwner = Buffer.from(JSON.stringify({
    v: 1,
    type: 'folder-share',
    roomId: 'room-a',
    folderId: 'folder-fixed',
    folderKeyHash: folderKeyHash('folder-fixed', folderSecret),
  }), 'utf8').toString('base64url')
  const legacyOwner = Buffer.from(JSON.stringify({
    v: 1,
    type: 'folder-share',
    roomId: 'room-a',
    folderId: 'folder-fixed',
    ownerNodeId: 'node-owner',
    folderKeyHash: folderKeyHash('folder-fixed', folderSecret),
  }), 'utf8').toString('base64url')
  const missingHash = Buffer.from(JSON.stringify({
    v: 1,
    type: 'folder-share',
    roomId: 'room-a',
    folderId: 'folder-fixed',
    ownerNodeId: ownerDid,
  }), 'utf8').toString('base64url')

  assert.equal(readShareLink(`#tc-share=${missingOwner}`), undefined)
  assert.equal(readShareLink(`#tc-share=${legacyOwner}`), undefined)
  assert.equal(readShareLink(`#tc-share=${missingHash}`), undefined)
})

test('folder share URL can request shared approver grants', () => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: 'http://localhost/app/' },
  })
  const folder = makeFolder({ id: 'folder-fixed', name: 'Shared docs', parentId: null, color: 'teal', roomId: 'room-a', now: '2026-05-21T00:00:00.000Z', nodeId: ownerDid })

  const linked = readShareLink(new URL(makeFolderShareUrl(folder, 'room-a', { name: 'Owner' }, ownerDid, folderSecret, 'shared-approval')).hash)

  assert.equal(linked?.share.ownerNodeId, ownerDid)
  assert.equal(linked?.share.accessGrantMode, 'shared')
  assert.equal(linked?.share.folderKeyHash, folderKeyHash(folder.id, folderSecret))
})

test('file share URL parser requires cid and decryption key', () => {
  const missingKey = Buffer.from(JSON.stringify({
    v: 1,
    type: 'file-share',
    roomId: 'room-a',
    folderId: 'folder-a',
    fileId: 'file-a',
    cid: 'cid-file',
  }), 'utf8').toString('base64url')
  const missingCid = Buffer.from(JSON.stringify({
    v: 1,
    type: 'file-share',
    roomId: 'room-a',
    folderId: 'folder-a',
    fileId: 'file-a',
    key: 'file-secret',
  }), 'utf8').toString('base64url')

  assert.equal(readShareLink(`#tc-share=${missingKey}`), undefined)
  assert.equal(readShareLink(`#tc-share=${missingCid}`), undefined)
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

function didFromSeed(seed: number): string {
  const bytes = new Uint8Array(32)
  bytes.fill(seed)
  return didKeyFromEd25519PublicKey(bytes)
}
