import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFileContentActions } from '../src/appFileContentActions.js'
import { createShareImportActions } from '../src/appShareImportActions.js'
import type { Notice, PendingShare } from '../src/appTypes.js'
import { stampFilePatch } from '../src/crdt.js'
import { createInitialSnapshot, makeFileFromDataUrl, makeFolder, stripFileContent } from '../src/domain.js'

type StateUpdate<T> = T | ((current: T) => T)

test('thumbnail preload backs off after a storage_get failure for the same content', async () => {
  const now = '2026-05-21T00:00:00.000Z'
  const folder = makeFolder({ id: 'folder-a', name: 'Folder A', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const file = stripFileContent(stampFilePatch(makeFileFromDataUrl({
    id: 'file-a',
    folderId: folder.id,
    name: 'image.png',
    mimeType: 'image/png',
    size: 5,
    dataUrl: 'data:image/png;base64,aGVsbG8=',
    checksum: 'checksum-a',
    now,
    nodeId: 'node-a',
  }), { lastCid: 'cid-missing' }, now, 'node-a'))
  const snapshot = { ...createInitialSnapshot('node-a'), folders: [folder], files: [file], activity: [] }
  const failuresRef: { current: Record<string, { retryAfter: number; signature: string }> } = { current: {} }
  let loadStarts = 0
  let loadFailures = 0
  const actions = createFileContentActions({
    failDownloadProgress: () => {},
    failFileLoadProgress: () => { loadFailures += 1 },
    fileContentCacheRef: { current: {} },
    fileContentFailuresRef: failuresRef,
    fileContentLoadsRef: { current: {} },
    fileShareKeysRef: { current: {} },
    finishDownloadProgress: () => {},
    finishFileLoadProgress: () => {},
    folderKeysRef: { current: { [folder.id]: 'secret' } },
    setFileContentCache: () => {},
    setNotice: () => {},
    setSnapshot: () => {},
    settingsRef: { current: testSettings() },
    snapshotRef: { current: snapshot },
    startDownloadProgress: () => 0,
    startFileLoadProgress: () => {
      loadStarts += 1
      return file.id
    },
    updateDownloadProgress: () => {},
  })

  actions.preloadFileContent(file)
  await settle()
  actions.preloadFileContent(file)
  await settle()

  assert.equal(loadStarts, 1)
  assert.equal(loadFailures, 1)
  assert.deepEqual(Object.keys(failuresRef.current), [file.id])
})

test('auto folder import backs off after a storage_get failure for the same share', async () => {
  const share: PendingShare = {
    type: 'folder-share',
    from: 'node-b',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 2,
    cid: 'cid-missing',
    folderId: 'folder-shared',
    folderName: 'Shared folder',
    autoImport: true,
  }
  const failuresRef: { current: Record<string, { retryAfter: number; signature: string }> } = { current: {} }
  let noticeCount = 0
  let notice: Notice = { tone: 'info', text: '' }
  const pendingSharesRef = { current: [share] }
  let snapshot = createInitialSnapshot('node-a')
  const snapshotRef = { current: snapshot }
  const actions = createShareImportActions({
    autoImportCidsRef: { current: new Set() },
    autoImportFailuresRef: failuresRef,
    autoImportInFlightRef: { current: new Set() },
    clearFolderSyncTimer: () => {},
    importKeys: {},
    materializeFolderBundleFiles: async (bundle) => bundle,
    pendingSharesRef,
    rememberFolderPeer: () => {},
    setBusy: () => {},
    setCurrentFolderId: () => {},
    setDetailFileId: () => {},
    setFileContentCache: () => {},
    setFileShareKeys: () => {},
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: (update) => {
      notice = applyStateUpdate(notice, update)
      noticeCount += 1
    },
    setPendingShares: (update) => { pendingSharesRef.current = applyStateUpdate(pendingSharesRef.current, update) },
    setSnapshot: (update) => {
      snapshot = applyStateUpdate(snapshot, update)
      snapshotRef.current = snapshot
    },
    settingsRef: { current: testSettings() },
    snapshotRef,
    syncSignaturesRef: { current: {} },
  })

  await actions.autoImportFolderShare(share, 'secret')
  await actions.autoImportFolderShare(share, 'secret')

  assert.equal(noticeCount, 1)
  assert.equal(notice.tone, 'error')
  assert.deepEqual(Object.keys(failuresRef.current), [share.cid])
})

function testSettings() {
  return { roomId: 'tc-storage-main', signalingUrl: '', nodeId: 'node-a', identity: null, autoConnect: false, profileName: 'Test user', avatarUrl: '', avatarFileId: '' }
}

function applyStateUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
