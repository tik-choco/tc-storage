import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFileContentActions } from '../src/app/appFileContentActions.js'
import { createShareImportActions } from '../src/app/appShareImportActions.js'
import type { FileContentFailure } from '../src/app/appControllerTypes.js'
import type { Notice, PendingShare } from '../src/app/appTypes.js'
import { stampFilePatch } from '../src/storage/crdt.js'
import { createInitialSnapshot, makeFileFromDataUrl, makeFolder, stripFileContent } from '../src/storage/domain.js'

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
  const failuresRef: { current: Record<string, FileContentFailure> } = { current: {} }
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

test('thumbnail preload does not start duplicate progress while content is already loading', () => {
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
  }), { lastCid: 'cid-loading' }, now, 'node-a'))
  const snapshot = { ...createInitialSnapshot('node-a'), folders: [folder], files: [file], activity: [] }
  let loadStarts = 0
  const actions = createFileContentActions({
    failDownloadProgress: () => {},
    failFileLoadProgress: () => {},
    fileContentCacheRef: { current: {} },
    fileContentFailuresRef: { current: {} },
    fileContentLoadsRef: { current: { [file.id]: new Promise<string>(() => {}) } },
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

  assert.equal(loadStarts, 0)
})

test('parent folder fallback does not retry an already failed file CID with the same key', async () => {
  const now = '2026-05-21T00:00:00.000Z'
  const folder = makeFolder({ id: 'folder-a', name: 'Folder A', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const sharedFolder = { ...folder, shareEnabled: true, lastCid: 'cid-folder' }
  const file = stripFileContent(stampFilePatch(makeFileFromDataUrl({
    id: 'file-a',
    folderId: folder.id,
    name: 'video.mp4',
    mimeType: 'video/mp4',
    size: 5,
    dataUrl: 'data:video/mp4;base64,aGVsbG8=',
    checksum: 'checksum-a',
    now,
    nodeId: 'node-a',
  }), { lastCid: 'cid-file' }, now, 'node-a'))
  const snapshot = { ...createInitialSnapshot('node-a'), folders: [sharedFolder], files: [file], activity: [] }
  let fileLoads = 0
  let folderLoads = 0
  const actions = createFileContentActions({
    failDownloadProgress: () => {},
    failFileLoadProgress: () => {},
    fileContentCacheRef: { current: {} },
    fileContentFailuresRef: { current: {} },
    fileContentLoadsRef: { current: {} },
    fileShareKeysRef: { current: {} },
    finishDownloadProgress: () => {},
    finishFileLoadProgress: () => {},
    folderKeysRef: { current: { [folder.id]: 'secret' } },
    loadEncryptedFile: async () => {
      fileLoads += 1
      throw new Error('保存データを復号できませんでした')
    },
    loadEncryptedFolder: async () => {
      folderLoads += 1
      return { version: 1, exportedAt: now, originNode: 'node-a', folder: sharedFolder, files: [file] }
    },
    setFileContentCache: () => {},
    setNotice: () => {},
    setSnapshot: () => {},
    settingsRef: { current: testSettings() },
    snapshotRef: { current: snapshot },
    startDownloadProgress: () => 0,
    startFileLoadProgress: () => file.id,
    updateDownloadProgress: () => {},
  })

  await assert.rejects(() => actions.ensureFileContent(file), /試行済み/)
  assert.equal(fileLoads, 1)
  assert.equal(folderLoads, 1)
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

test('linked share import can force retry after peer connection despite cooldown', async () => {
  const share: PendingShare = {
    type: 'file-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 2,
    cid: 'cid-missing-file',
    folderId: 'folder-shared',
    fileId: 'file-shared',
    fileName: 'Shared file',
    autoImport: true,
  }
  const failuresRef: { current: Record<string, { retryAfter: number; signature: string }> } = { current: {} }
  let noticeCount = 0
  const pendingSharesRef = { current: [share] }
  const actions = createShareImportActions({
    autoImportCidsRef: { current: new Set() },
    autoImportFailuresRef: failuresRef,
    autoImportInFlightRef: { current: new Set() },
    clearFolderSyncTimer: () => {},
    importKeys: { 'cid-missing-file': 'secret' },
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
    setNotice: () => { noticeCount += 1 },
    setPendingShares: (update) => { pendingSharesRef.current = applyStateUpdate(pendingSharesRef.current, update) },
    setSnapshot: () => {},
    settingsRef: { current: testSettings() },
    snapshotRef: { current: createInitialSnapshot('node-a') },
    syncSignaturesRef: { current: {} },
  })

  await actions.autoImportLinkedShare(share, 'secret')
  await actions.autoImportLinkedShare(share, 'secret')
  await actions.autoImportLinkedShare(share, 'secret', { force: true })

  assert.equal(noticeCount, 2)
  assert.deepEqual(Object.keys(failuresRef.current), [share.cid])
})

test('markPendingShareImported keeps same-folder pending shares from other rooms', () => {
  const roomAShare: PendingShare = {
    type: 'folder-share',
    from: 'node-b',
    roomId: 'room-a',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 2,
    cid: 'cid-a',
    folderId: 'folder-fixed',
    folderName: 'Shared folder A',
    autoImport: true,
  }
  const roomBShare: PendingShare = { ...roomAShare, roomId: 'room-b', cid: 'cid-b', folderName: 'Shared folder B' }
  const pendingSharesRef = { current: [roomAShare, roomBShare] }
  let importKeys: Record<string, string> = { 'cid-a': 'key-a', 'cid-b': 'key-b' }
  const autoImportCidsRef = { current: new Set<string>() }
  const actions = createShareImportActions({
    autoImportCidsRef,
    autoImportFailuresRef: { current: {} },
    autoImportInFlightRef: { current: new Set() },
    clearFolderSyncTimer: () => {},
    importKeys,
    materializeFolderBundleFiles: async (bundle) => bundle,
    pendingSharesRef,
    rememberFolderPeer: () => {},
    setBusy: () => {},
    setCurrentFolderId: () => {},
    setDetailFileId: () => {},
    setFileContentCache: () => {},
    setFileShareKeys: () => {},
    setFolderKeys: () => {},
    setImportKeys: (update) => { importKeys = applyStateUpdate(importKeys, update) },
    setNotice: () => {},
    setPendingShares: (update) => { pendingSharesRef.current = applyStateUpdate(pendingSharesRef.current, update) },
    setSnapshot: () => {},
    settingsRef: { current: testSettings() },
    snapshotRef: { current: createInitialSnapshot('node-a') },
    syncSignaturesRef: { current: {} },
  })

  actions.markPendingShareImported(roomAShare)

  assert.deepEqual([...autoImportCidsRef.current], ['cid-a'])
  assert.deepEqual(pendingSharesRef.current, [roomBShare])
  assert.deepEqual(importKeys, { 'cid-b': 'key-b' })
})

test('canceling a pending folder invite clears stored access request keys', () => {
  const share: PendingShare = {
    type: 'folder-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 0,
    folderId: 'folder-fixed',
    folderName: 'Fixed invite',
    autoImport: true,
  }
  const entry = { folderId: 'folder-fixed', roomId: 'tc-storage-main' }
  const accessRequestKeysRef = { current: { 'request-a': entry, 'tc-storage-main:folder:folder-fixed': entry, 'request-other': { folderId: 'folder-other', roomId: 'tc-storage-main' } } }
  const pendingSharesRef = { current: [share] }
  const actions = createShareImportActions({
    accessRequestKeysRef,
    autoImportCidsRef: { current: new Set() },
    autoImportFailuresRef: { current: {} },
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
    setNotice: () => {},
    setPendingShares: (update) => { pendingSharesRef.current = applyStateUpdate(pendingSharesRef.current, update) },
    setSnapshot: () => {},
    settingsRef: { current: testSettings() },
    snapshotRef: { current: createInitialSnapshot('node-a') },
    syncSignaturesRef: { current: {} },
  })

  actions.cancelPendingShare(share)

  assert.deepEqual(pendingSharesRef.current, [])
  assert.deepEqual(Object.keys(accessRequestKeysRef.current), ['request-other'])
})

function testSettings() {
  return { roomId: 'tc-storage-main', nodeId: 'node-a', identity: null, autoConnect: false, profileName: 'Test user', avatarUrl: '', avatarFileId: '' }
}

function applyStateUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
