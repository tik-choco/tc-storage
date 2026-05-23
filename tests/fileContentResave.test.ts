import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFileContentActions } from '../src/appFileContentActions.js'
import { createInitialSnapshot, makeFileFromDataUrl, makeFolder, stripFileContent, type StorageSnapshot } from '../src/domain.js'
import { stampFilePatch, stampFolderPatch } from '../src/crdt.js'

type StateUpdate<T> = T | ((current: T) => T)

test('cached child file with lastCid is re-saved under the shared-root key once', async () => {
  const { childFileWithCid, childFolder, sharedRoot, snapshot } = snapshotWithSharedChildFile()
  const dataUrl = 'data:text/plain;base64,aGVsbG8='
  let saveCount = 0
  const actions = createContentActionsForSnapshot(
    snapshot,
    { [childFolder.id]: 'folder-secret' },
    { [childFileWithCid.id]: dataUrl },
    async ({ file }) => {
      saveCount += 1
      assert.equal(file.dataUrl, dataUrl)
      return `cid-refreshed-${saveCount}`
    },
  )

  const first = await actions.ensureFolderFilesStored(sharedRoot, [childFileWithCid], 'folder-secret')
  const second = await actions.ensureFolderFilesStored(sharedRoot, first, 'folder-secret')

  assert.equal(saveCount, 1)
  assert.equal(first[0]?.lastCid, 'cid-refreshed-1')
  assert.deepEqual(second, first)
})

test('folder bundle fallback does not persist a bundled file cid until content loads', async () => {
  const { childFileWithCid, childFolder, sharedRoot, snapshot } = snapshotWithSharedChildFile()
  const bundledFile = stampFilePatch(childFileWithCid, { lastCid: 'cid-from-folder-bundle' }, childFileWithCid.updatedAt, 'node-b')
  const harness = createContentActionsHarness({
    snapshot,
    folderKeys: { [sharedRoot.id]: 'folder-secret', [childFolder.id]: 'folder-secret' },
    loadEncryptedFolder: async () => ({
      version: 1,
      exportedAt: childFileWithCid.updatedAt,
      originNode: 'node-b',
      folder: sharedRoot,
      files: [bundledFile],
    }),
    loadEncryptedFile: async (cid) => {
      throw new Error(`missing ${cid}`)
    },
  })

  await assert.rejects(() => harness.actions.ensureFileContent(childFileWithCid), /missing cid-from-folder-bundle/)

  assert.equal(harness.snapshot().files.find((file) => file.id === childFileWithCid.id)?.lastCid, childFileWithCid.lastCid)
})

test('folder bundle fallback persists a bundled file cid after content loads', async () => {
  const { childFileWithCid, childFolder, sharedRoot, snapshot } = snapshotWithSharedChildFile()
  const dataUrl = 'data:text/plain;base64,aGVsbG8='
  const bundledFile = stampFilePatch(childFileWithCid, { lastCid: 'cid-from-folder-bundle' }, childFileWithCid.updatedAt, 'node-b')
  const harness = createContentActionsHarness({
    snapshot,
    folderKeys: { [sharedRoot.id]: 'folder-secret', [childFolder.id]: 'folder-secret' },
    loadEncryptedFolder: async () => ({
      version: 1,
      exportedAt: childFileWithCid.updatedAt,
      originNode: 'node-b',
      folder: sharedRoot,
      files: [bundledFile],
    }),
    loadEncryptedFile: async (cid) => {
      if (cid !== bundledFile.lastCid) throw new Error(`missing ${cid}`)
      return {
        version: 1,
        exportedAt: childFileWithCid.updatedAt,
        originNode: 'node-b',
        folder: sharedRoot,
        file: { ...bundledFile, dataUrl },
      }
    },
  })

  const loaded = await harness.actions.ensureFileContent(childFileWithCid)

  assert.equal(loaded.dataUrl, dataUrl)
  assert.equal(harness.snapshot().files.find((file) => file.id === childFileWithCid.id)?.lastCid, bundledFile.lastCid)
})

test('content loaded from storage_get is not immediately re-saved as untrusted cache', async () => {
  const { childFileWithCid, sharedRoot, snapshot } = snapshotWithSharedChildFile()
  const dataUrl = 'data:text/plain;base64,aGVsbG8='
  let saveCount = 0
  const harness = createContentActionsHarness({
    snapshot,
    folderKeys: { [sharedRoot.id]: 'folder-secret' },
    loadEncryptedFile: async (cid) => ({
      version: 1,
      exportedAt: childFileWithCid.updatedAt,
      originNode: 'node-b',
      folder: sharedRoot,
      file: { ...childFileWithCid, lastCid: cid, dataUrl },
    }),
    saveEncryptedFile: async () => {
      saveCount += 1
      return `cid-refreshed-${saveCount}`
    },
  })

  await harness.actions.ensureFileContent(childFileWithCid)
  const stored = await harness.actions.ensureFolderFilesStored(sharedRoot, [childFileWithCid], 'folder-secret')

  assert.equal(saveCount, 0)
  assert.equal(stored[0]?.lastCid, childFileWithCid.lastCid)
})

test('cached file storage proofs are isolated by shared folder key', async () => {
  const { childFileWithCid, childFolder, sharedRoot, snapshot } = snapshotWithSharedChildFile()
  const sharedChildFolder = stampFolderPatch(childFolder, { shareEnabled: true, lastCid: 'cid-child-folder' }, childFolder.updatedAt, 'node-a')
  const snapshotValue = { ...snapshot, folders: [sharedRoot, sharedChildFolder] }
  const dataUrl = 'data:text/plain;base64,aGVsbG8='
  let saveCount = 0
  const actions = createContentActionsForSnapshot(
    snapshotValue,
    { [sharedRoot.id]: 'root-secret', [sharedChildFolder.id]: 'child-secret' },
    { [childFileWithCid.id]: dataUrl },
    async ({ folder }) => {
      saveCount += 1
      return `${folder.id}-cid-${saveCount}`
    },
  )

  const rootStored = await actions.ensureFolderFilesStored(sharedRoot, [childFileWithCid], 'root-secret')
  const childStored = await actions.ensureFolderFilesStored(sharedChildFolder, [childFileWithCid], 'child-secret')
  const rootStoredAgain = await actions.ensureFolderFilesStored(sharedRoot, [childFileWithCid], 'root-secret')

  assert.equal(saveCount, 2)
  assert.equal(rootStored[0]?.lastCid, 'folder-root-cid-1')
  assert.equal(childStored[0]?.lastCid, 'folder-child-cid-2')
  assert.equal(rootStoredAgain[0]?.lastCid, 'folder-root-cid-1')
})

test('parent folder publish does not treat independently shared child cache as untrusted', () => {
  const { childFileWithCid, childFolder, sharedRoot, snapshot } = snapshotWithSharedChildFile()
  const sharedChildFolder = stampFolderPatch(childFolder, { shareEnabled: true, lastCid: 'cid-child-folder' }, childFolder.updatedAt, 'node-a')
  const snapshotValue = { ...snapshot, folders: [sharedRoot, sharedChildFolder] }
  const actions = createContentActionsForSnapshot(
    snapshotValue,
    { [sharedRoot.id]: 'root-secret', [sharedChildFolder.id]: 'child-secret' },
    { [childFileWithCid.id]: 'data:text/plain;base64,aGVsbG8=' },
    async () => 'cid-unused',
  )

  assert.equal(actions.hasUntrustedFolderContent(sharedRoot.id), false)
  assert.equal(actions.hasUntrustedFolderContent(sharedChildFolder.id), true)
})

function createContentActionsForSnapshot(
  snapshot: StorageSnapshot,
  folderKeys: Record<string, string>,
  initialCache: Record<string, string>,
  saveEncryptedFile: Parameters<typeof createFileContentActions>[0]['saveEncryptedFile'],
) {
  return createContentActionsHarness({ snapshot, folderKeys, initialCache, saveEncryptedFile }).actions
}

function createContentActionsHarness(options: {
  snapshot: StorageSnapshot
  folderKeys: Record<string, string>
  initialCache?: Record<string, string>
  loadEncryptedFile?: Parameters<typeof createFileContentActions>[0]['loadEncryptedFile']
  loadEncryptedFolder?: Parameters<typeof createFileContentActions>[0]['loadEncryptedFolder']
  saveEncryptedFile?: Parameters<typeof createFileContentActions>[0]['saveEncryptedFile']
}) {
  let cache = options.initialCache ?? {}
  let snapshotValue = options.snapshot
  const fileContentCacheRef = { current: cache }
  const snapshotRef = { current: snapshotValue }
  const actions = createFileContentActions({
    failDownloadProgress: () => {},
    failFileLoadProgress: () => {},
    fileContentCacheRef,
    fileContentLoadsRef: { current: {} },
    fileContentStorageRef: { current: {} },
    fileShareKeysRef: { current: {} },
    finishDownloadProgress: () => {},
    finishFileLoadProgress: () => {},
    folderKeysRef: { current: options.folderKeys },
    loadEncryptedFile: options.loadEncryptedFile,
    loadEncryptedFolder: options.loadEncryptedFolder,
    saveEncryptedFile: options.saveEncryptedFile,
    setFileContentCache: (update) => {
      cache = applyStateUpdate(cache, update)
      fileContentCacheRef.current = cache
    },
    setNotice: () => {},
    setSnapshot: (update) => {
      snapshotValue = applyStateUpdate(snapshotValue, update)
      snapshotRef.current = snapshotValue
    },
    settingsRef: { current: { roomId: 'tc-storage-main', signalingUrl: '', nodeId: 'node-a', identity: null, autoConnect: false, profileName: 'Test user', avatarUrl: '', avatarFileId: '' } },
    snapshotRef,
    startDownloadProgress: () => 0,
    startFileLoadProgress: () => '',
    updateDownloadProgress: () => {},
  })
  return { actions, snapshot: () => snapshotValue }
}

function snapshotWithSharedChildFile() {
  const now = '2026-05-21T00:00:00.000Z'
  const sharedRoot = stampFolderPatch(makeFolder({ id: 'folder-root', name: 'Root', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-a' }), { shareEnabled: true, lastCid: 'cid-root' }, now, 'node-a')
  const childFolder = makeFolder({ id: 'folder-child', name: 'Child', parentId: sharedRoot.id, color: 'blue', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const childFile = makeFileFromDataUrl({ id: 'file-child', folderId: childFolder.id, name: 'child.txt', mimeType: 'text/plain', size: 5, dataUrl: 'data:text/plain;base64,aGVsbG8=', checksum: 'checksum-child', now, nodeId: 'node-a' })
  const childFileWithCid = stripFileContent(stampFilePatch(childFile, { lastCid: 'cid-child' }, now, 'node-a'))
  return { childFileWithCid, childFolder, sharedRoot, snapshot: { ...createInitialSnapshot('node-a'), folders: [sharedRoot, childFolder], files: [childFileWithCid], activity: [] } }
}

function applyStateUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update
}
