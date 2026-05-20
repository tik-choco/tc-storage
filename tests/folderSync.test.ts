import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteFolderSnapshot } from '../src/appHelpers.js'
import { stampFilePatch, stampFolderPatch } from '../src/crdt.js'
import { createInitialSnapshot, makeFileFromDataUrl, makeFolder } from '../src/domain.js'
import { canAutoImportFolderShare, canAutoImportFolderState, folderFilesForSync, foldersForSync, hasSharedFolderChangesSinceLastShare, sharedFolderSignature, shouldDeferRemoteFolderStateImport } from '../src/folderSync.js'

test('sharedFolderSignature tracks content changes but ignores saved CIDs', () => {
  const { file, folder, snapshot } = snapshotWithFolderAndFile()

  const shared = {
    ...snapshot,
    folders: [stampFolderPatch(folder, { shareEnabled: true, lastCid: 'cid-one' }, '2026-05-17T00:00:00.000Z', 'node-a')],
  }
  const withNewCid = {
    ...shared,
    folders: [stampFolderPatch(shared.folders[0]!, { lastCid: 'cid-two' }, '2026-05-17T00:00:01.000Z', 'node-a')],
  }
  const withDeletedFile = {
    ...shared,
    files: snapshot.files.map((item) => (item.id === file.id ? stampFilePatch(item, { deletedAt: '2026-05-17T00:00:02.000Z' }, '2026-05-17T00:00:02.000Z', 'node-a') : item)),
  }

  assert.equal(sharedFolderSignature(shared, folder.id), sharedFolderSignature(withNewCid, folder.id))
  assert.notEqual(sharedFolderSignature(shared, folder.id), sharedFolderSignature(withDeletedFile, folder.id))
})

test('folderFilesForSync includes tombstones for deletion sync', () => {
  const { file, folder, snapshot } = snapshotWithFolderAndFile()

  const withDeletedFile = {
    ...snapshot,
    files: snapshot.files.map((item) => (item.id === file.id ? stampFilePatch(item, { deletedAt: '2026-05-17T00:00:00.000Z' }, '2026-05-17T00:00:00.000Z', 'node-a') : item)),
  }

  assert.ok(folderFilesForSync(withDeletedFile, folder.id).some((item) => item.id === file.id && item.deletedAt))
})

test('shared folder sync includes descendant folders and files', () => {
  const { folder, snapshot } = snapshotWithFolderAndFile()
  const now = '2026-05-17T00:00:01.000Z'
  const childFolder = makeFolder({
    id: 'folder-child',
    name: 'Assets',
    parentId: folder.id,
    color: 'blue',
    roomId: 'tc-storage-main',
    now,
    nodeId: 'node-a',
  })
  const childFile = makeFileFromDataUrl({
    id: 'file-logo',
    folderId: childFolder.id,
    name: 'logo.png',
    mimeType: 'image/png',
    size: 10,
    dataUrl: 'data:image/png;base64,bG9nbw==',
    checksum: 'checksum-logo',
    now,
    nodeId: 'node-a',
  })
  const withChild = { ...snapshot, folders: [...snapshot.folders, childFolder], files: [...snapshot.files, childFile] }

  assert.deepEqual(foldersForSync(withChild, folder.id).map((item) => item.id), [folder.id, childFolder.id])
  assert.ok(folderFilesForSync(withChild, folder.id).some((item) => item.id === childFile.id))
  assert.notEqual(sharedFolderSignature(snapshot, folder.id), sharedFolderSignature(withChild, folder.id))
})

test('sharedFolderSignature stays lightweight and tracks file identity by metadata', () => {
  const { file, folder, snapshot } = snapshotWithFolderAndFile()
  const changedDataUrl = {
    ...snapshot,
    files: [stampFilePatch(file, { dataUrl: 'data:text/markdown;base64,' + 'x'.repeat(2048) }, '2026-05-17T00:00:01.000Z', 'node-a')],
  }
  const changedChecksum = {
    ...snapshot,
    files: [stampFilePatch(file, { checksum: 'checksum-two' }, '2026-05-17T00:00:02.000Z', 'node-a')],
  }

  const signature = sharedFolderSignature(snapshot, folder.id)

  assert.equal(signature.includes(file.dataUrl ?? ''), false)
  assert.equal(sharedFolderSignature(snapshot, folder.id), sharedFolderSignature(changedDataUrl, folder.id))
  assert.notEqual(sharedFolderSignature(snapshot, folder.id), sharedFolderSignature(changedChecksum, folder.id))
})

test('remoteFolderSnapshot marks imported folder shares as shared', () => {
  const { folder } = snapshotWithFolderAndFile()

  const remote = remoteFolderSnapshot(
    {
      version: 1,
      exportedAt: '2026-05-17T00:00:00.000Z',
      originNode: 'node-a',
      folder,
      folders: [folder],
      files: [],
    },
    {
      type: 'folder-share',
      from: 'node-a',
      roomId: 'tc-storage-main',
      sentAt: '2026-05-17T00:00:01.000Z',
      receivedAt: '2026-05-17T00:00:02.000Z',
      clock: 2,
      folderId: folder.id,
      folderName: folder.name,
      cid: 'cid-folder',
    },
  )

  assert.equal(remote.folders[0]?.shareEnabled, true)
  assert.equal(remote.folders[0]?.lastCid, 'cid-folder')
})

test('remoteFolderSnapshot imports descendant folders from folder bundle', () => {
  const { folder } = snapshotWithFolderAndFile()
  const childFolder = makeFolder({
    id: 'folder-child',
    name: 'Assets',
    parentId: folder.id,
    color: 'blue',
    roomId: 'tc-storage-main',
    now: '2026-05-17T00:00:00.000Z',
    nodeId: 'node-a',
  })

  const remote = remoteFolderSnapshot(
    {
      version: 1,
      exportedAt: '2026-05-17T00:00:00.000Z',
      originNode: 'node-a',
      folder,
      folders: [folder, childFolder],
      files: [],
    },
    {
      type: 'folder-share',
      from: 'node-a',
      roomId: 'tc-storage-main',
      sentAt: '2026-05-17T00:00:01.000Z',
      receivedAt: '2026-05-17T00:00:02.000Z',
      clock: 2,
      folderId: folder.id,
      folderName: folder.name,
      cid: 'cid-folder',
    },
  )

  assert.ok(remote.folders.some((item) => item.id === childFolder.id && item.parentId === folder.id))
})

test('remoteFolderSnapshot detaches a shared nested folder from its original parent', () => {
  const { folder: parent } = snapshotWithFolderAndFile()
  const childFolder = makeFolder({
    id: 'folder-child',
    name: 'Assets',
    parentId: parent.id,
    color: 'blue',
    roomId: 'tc-storage-main',
    now: '2026-05-17T00:00:00.000Z',
    nodeId: 'node-a',
  })

  const remote = remoteFolderSnapshot(
    {
      version: 1,
      exportedAt: '2026-05-17T00:00:00.000Z',
      originNode: 'node-a',
      folder: childFolder,
      folders: [childFolder],
      files: [],
    },
    {
      type: 'folder-share',
      from: 'node-a',
      roomId: 'tc-storage-main',
      sentAt: '2026-05-17T00:00:01.000Z',
      receivedAt: '2026-05-17T00:00:02.000Z',
      clock: 2,
      folderId: childFolder.id,
      folderName: childFolder.name,
      cid: 'cid-folder-child',
    },
  )

  assert.deepEqual(remote.folders.map((item) => item.id), [childFolder.id])
  assert.equal(remote.folders[0]?.parentId, null)
})

test('canAutoImportFolderShare accepts same folder with key even before local sharing is enabled', () => {
  const { folder } = snapshotWithFolderAndFile()

  assert.equal(canAutoImportFolderShare({ folder, incomingCid: 'cid-folder', passphrase: 'secret' }), true)
  assert.equal(canAutoImportFolderShare({ folder: { ...folder, lastCid: 'cid-folder' }, incomingCid: 'cid-folder', passphrase: 'secret' }), false)
  assert.equal(canAutoImportFolderShare({ folder, incomingCid: 'cid-folder', passphrase: '' }), false)
})

test('canAutoImportFolderState requires a different signature and newer CID', () => {
  const { folder, snapshot } = snapshotWithFolderAndFile()
  const localSignature = sharedFolderSignature(snapshot, folder.id)
  const sharedFolder = { ...folder, lastCid: 'cid-old' }

  assert.equal(canAutoImportFolderState({ folder: sharedFolder, incomingCid: 'cid-new', incomingSignature: 'remote-signature', localSignature, passphrase: 'secret' }), true)
  assert.equal(canAutoImportFolderState({ folder: sharedFolder, incomingCid: 'cid-new', incomingSignature: localSignature, localSignature, passphrase: 'secret' }), false)
  assert.equal(canAutoImportFolderState({ folder: sharedFolder, incomingCid: 'cid-old', incomingSignature: 'remote-signature', localSignature, passphrase: 'secret' }), false)
  assert.equal(canAutoImportFolderState({ folder: sharedFolder, incomingCid: 'cid-new', incomingSignature: 'remote-signature', localSignature, passphrase: '' }), false)
})

test('hasSharedFolderChangesSinceLastShare detects local edits after the last shared CID', () => {
  const { file, folder, snapshot } = snapshotWithFolderAndFile()
  const sharedAt = '2026-05-17T00:00:05.000Z'
  const sharedFolder = stampFolderPatch(folder, { shareEnabled: true, lastCid: 'cid-folder', lastSharedAt: sharedAt }, sharedAt, 'node-a')
  const sharedSnapshot = { ...snapshot, folders: [sharedFolder] }
  const editedSnapshot = {
    ...sharedSnapshot,
    files: [stampFilePatch(file, { starred: true }, '2026-05-17T00:00:06.000Z', 'node-a')],
  }

  assert.equal(hasSharedFolderChangesSinceLastShare(sharedSnapshot, sharedFolder), false)
  assert.equal(hasSharedFolderChangesSinceLastShare(editedSnapshot, sharedFolder), true)
  assert.equal(hasSharedFolderChangesSinceLastShare(snapshot, { ...folder, shareEnabled: true }), true)
})

test('remote folder-state import is deferred while local shared changes are unpublished', () => {
  const { file, folder, snapshot } = snapshotWithFolderAndFile()
  const sharedAt = '2026-05-17T00:00:05.000Z'
  const sharedFolder = stampFolderPatch(folder, { shareEnabled: true, lastCid: 'cid-folder', lastSharedAt: sharedAt }, sharedAt, 'node-a')
  const sharedSnapshot = { ...snapshot, folders: [sharedFolder] }
  const reorderedSnapshot = {
    ...sharedSnapshot,
    files: [stampFilePatch(file, { sortOrder: 2000 }, '2026-05-17T00:00:06.000Z', 'node-a')],
  }

  assert.equal(shouldDeferRemoteFolderStateImport({ folder: sharedFolder, snapshot: sharedSnapshot }), false)
  assert.equal(shouldDeferRemoteFolderStateImport({ folder: sharedFolder, snapshot: reorderedSnapshot }), true)
})

function snapshotWithFolderAndFile() {
  const now = '2026-05-17T00:00:00.000Z'
  const folder = makeFolder({
    id: 'folder-product',
    name: 'Product',
    parentId: null,
    color: 'teal',
    roomId: 'tc-storage-main',
    now,
    nodeId: 'node-a',
  })
  const file = makeFileFromDataUrl({
    id: 'file-roadmap',
    folderId: folder.id,
    name: 'roadmap.md',
    mimeType: 'text/markdown',
    size: 4,
    dataUrl: 'data:text/markdown;base64,dGVzdA==',
    checksum: 'checksum',
    now,
    nodeId: 'node-a',
  })
  const snapshot = { ...createInitialSnapshot('node-a'), folders: [folder], files: [file] }
  return { file, folder, snapshot }
}
