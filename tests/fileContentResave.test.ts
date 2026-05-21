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

function createContentActionsForSnapshot(
  snapshot: StorageSnapshot,
  folderKeys: Record<string, string>,
  initialCache: Record<string, string>,
  saveEncryptedFile: Parameters<typeof createFileContentActions>[0]['saveEncryptedFile'],
) {
  let cache = initialCache
  let snapshotValue = snapshot
  const fileContentCacheRef = { current: cache }
  const snapshotRef = { current: snapshotValue }
  return createFileContentActions({
    failDownloadProgress: () => {},
    failFileLoadProgress: () => {},
    fileContentCacheRef,
    fileContentLoadsRef: { current: {} },
    fileContentStorageRef: { current: {} },
    fileShareKeysRef: { current: {} },
    finishDownloadProgress: () => {},
    finishFileLoadProgress: () => {},
    folderKeysRef: { current: folderKeys },
    saveEncryptedFile,
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
