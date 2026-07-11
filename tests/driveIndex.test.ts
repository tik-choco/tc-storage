import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDriveIndex } from '../src/storage/driveIndex.js'
import { createInitialSnapshot, makeFileFromDataUrl, makeFolder } from '../src/storage/domain.js'

const now = '2026-05-17T00:00:00.000Z'

function folder(id: string, name: string, parentId: string | null, overrides: Partial<ReturnType<typeof makeFolder>> = {}) {
  return { ...makeFolder({ id, name, parentId, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-test' }), ...overrides }
}

function file(id: string, folderId: string, name: string, overrides: Partial<ReturnType<typeof makeFileFromDataUrl>> = {}) {
  return {
    ...makeFileFromDataUrl({ id, folderId, name, mimeType: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,YQ==', checksum: 'a', now, nodeId: 'node-test' }),
    ...overrides,
  }
}

test('buildDriveIndex includes files with an own-folder key and a lastCid', () => {
  const root = folder('folder-root', 'Root', null)
  const doc = file('file-doc', root.id, 'doc.txt', { lastCid: 'cid-doc' })
  const snapshot = { ...createInitialSnapshot('node-test'), folders: [root], files: [doc] }

  const index = buildDriveIndex(snapshot, { [root.id]: 'root-key' }, now)

  assert.deepEqual(index, {
    version: 1,
    updatedAt: now,
    files: [{ id: 'file-doc', name: 'doc.txt', mimeType: 'text/plain', size: 1, lastCid: 'cid-doc', path: 'Root', passphrase: 'root-key' }],
  })
})

test('buildDriveIndex falls back to the nearest ancestor folder key', () => {
  const root = folder('folder-root', 'Root', null)
  const child = folder('folder-child', 'Child', root.id)
  const doc = file('file-doc', child.id, 'doc.txt', { lastCid: 'cid-doc' })
  const snapshot = { ...createInitialSnapshot('node-test'), folders: [root, child], files: [doc] }

  const index = buildDriveIndex(snapshot, { [root.id]: 'root-key' }, now)

  assert.equal(index.files.length, 1)
  assert.equal(index.files[0]?.passphrase, 'root-key')
  assert.equal(index.files[0]?.path, 'Root/Child')
})

test('buildDriveIndex prefers a folder\'s own key over an ancestor\'s', () => {
  const root = folder('folder-root', 'Root', null)
  const child = folder('folder-child', 'Child', root.id)
  const doc = file('file-doc', child.id, 'doc.txt', { lastCid: 'cid-doc' })
  const snapshot = { ...createInitialSnapshot('node-test'), folders: [root, child], files: [doc] }

  const index = buildDriveIndex(snapshot, { [root.id]: 'root-key', [child.id]: 'child-key' }, now)

  assert.equal(index.files[0]?.passphrase, 'child-key')
})

test('buildDriveIndex skips deleted files, files without a lastCid, and files with no resolvable key', () => {
  const root = folder('folder-root', 'Root', null)
  const deleted = file('file-deleted', root.id, 'deleted.txt', { lastCid: 'cid-deleted', deletedAt: now })
  const noCid = file('file-no-cid', root.id, 'no-cid.txt')
  const noKey = file('file-no-key', root.id, 'no-key.txt', { lastCid: 'cid-no-key' })
  const snapshot = { ...createInitialSnapshot('node-test'), folders: [root], files: [deleted, noCid, noKey] }

  const index = buildDriveIndex(snapshot, {}, now)

  assert.deepEqual(index.files, [])
})

test('buildDriveIndex skips a deleted ancestor as a key source', () => {
  const root = folder('folder-root', 'Root', null, { deletedAt: now })
  const child = folder('folder-child', 'Child', root.id)
  const doc = file('file-doc', child.id, 'doc.txt', { lastCid: 'cid-doc' })
  const snapshot = { ...createInitialSnapshot('node-test'), folders: [root, child], files: [doc] }

  const index = buildDriveIndex(snapshot, { [root.id]: 'root-key' }, now)

  assert.deepEqual(index.files, [])
})
