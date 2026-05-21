import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteFolderSnapshot } from '../src/appHelpers.js'
import { createEnvelopeActions } from '../src/appEnvelopeActions.js'
import { createFileContentActions } from '../src/appFileContentActions.js'
import { mergeSnapshots, stampFilePatch, stampFolderPatch } from '../src/crdt.js'
import { createInitialSnapshot, makeFileFromDataUrl, makeFolder, stripFileContent, type FileRecord, type FolderRecord, type StorageSnapshot } from '../src/domain.js'

type StateUpdate<T> = T | ((current: T) => T)

test('child file lastCid with the same folder key skips shared-root content re-save', async () => {
  const { childFileWithCid, childFolder, sharedRoot, snapshot } = snapshotWithSharedChildFile()
  const actions = createContentActionsForSnapshot(snapshot, { [childFolder.id]: 'folder-secret' })

  const stored = await actions.ensureFolderFilesStored(sharedRoot, [childFileWithCid], 'folder-secret')

  assert.deepEqual(stored, [childFileWithCid])
})

test('child file lastCid is not reused only because the shared root has a cid', async () => {
  const { childFileWithCid, sharedRoot, snapshot } = snapshotWithSharedChildFile()
  const actions = createContentActionsForSnapshot(snapshot)

  await assert.rejects(
    () => actions.ensureFolderFilesStored(sharedRoot, [childFileWithCid], 'folder-secret'),
    /CIDまたは復号キーがありません/,
  )
})

test('child file lastCid is not reused for a shared root that has not been saved yet', async () => {
  const { childFileWithCid, sharedRoot, snapshot } = snapshotWithSharedChildFile({ rootLastCid: false })
  const actions = createContentActionsForSnapshot(snapshot)

  await assert.rejects(
    () => actions.ensureFolderFilesStored(sharedRoot, [childFileWithCid], 'folder-secret'),
    /CIDまたは復号キーがありません/,
  )
})

test('same-id file move upsert clears older move-out tombstone after merge', () => {
  const { file, sourceFolder, targetFolder } = snapshotWithTwoFoldersAndFile()
  const movedAt = '2026-05-21T00:00:01.000Z'
  const removedAt = '2026-05-21T00:00:00.999Z'
  const moved = stripFileContent(stampFilePatch(file, { folderId: targetFolder.id, lastCid: 'cid-after-move', deletedAt: undefined }, movedAt, 'node-a'))
  const sourceTombstone = stripFileContent(stampFilePatch(file, { deletedAt: removedAt }, removedAt, 'node-a'))

  const merged = mergeSnapshots(
    { ...createInitialSnapshot('node-a'), folders: [sourceFolder, targetFolder], files: [moved], activity: [] },
    { ...createInitialSnapshot('node-b'), folders: [sourceFolder, targetFolder], files: [sourceTombstone], activity: [] },
  )
  const mergedFile = merged.files.find((item) => item.id === file.id)

  assert.equal(mergedFile?.folderId, targetFolder.id)
  assert.equal(mergedFile?.deletedAt, undefined)
})

test('same-id folder move upsert clears older move-out tombstone after merge', () => {
  const { movingFolder, sourceFolder, targetFolder } = snapshotWithMovingFolder()
  const movedAt = '2026-05-21T00:00:01.000Z'
  const removedAt = '2026-05-21T00:00:00.999Z'
  const moved = stampFolderPatch(movingFolder, { parentId: targetFolder.id, deletedAt: undefined }, movedAt, 'node-a')
  const sourceTombstone = stampFolderPatch(movingFolder, { deletedAt: removedAt }, removedAt, 'node-a')

  const merged = mergeSnapshots(
    { ...createInitialSnapshot('node-a'), folders: [sourceFolder, targetFolder, moved], files: [], activity: [] },
    { ...createInitialSnapshot('node-b'), folders: [sourceFolder, targetFolder, sourceTombstone], files: [], activity: [] },
  )
  const mergedFolder = merged.folders.find((item) => item.id === movingFolder.id)

  assert.equal(mergedFolder?.parentId, targetFolder.id)
  assert.equal(mergedFolder?.deletedAt, undefined)
})

test('remote folder delete uses envelope folder deletedAt so a newer move upsert can revive it', () => {
  const { movingFolder, sourceFolder, targetFolder } = snapshotWithMovingFolder()
  const movedAt = '2026-05-21T00:00:01.000Z'
  const removedAt = '2026-05-21T00:00:00.999Z'
  const initial = { ...createInitialSnapshot('node-b'), folders: [sourceFolder, targetFolder, movingFolder], files: [], activity: [] }
  const harness = createEnvelopeHarness(initial)
  const sourceTombstone = stampFolderPatch(movingFolder, { deletedAt: removedAt }, removedAt, 'node-a')

  harness.actions.handleEnvelope({
    type: 'folder-change',
    from: 'node-a',
    roomId: 'tc-storage-main',
    sentAt: movedAt,
    clock: 2,
    changeType: 'folder-deleted',
    folderId: sourceFolder.id,
    folderName: sourceFolder.name,
    folder: sourceTombstone,
  })
  const deletedFolder = harness.snapshot().folders.find((item) => item.id === movingFolder.id)

  assert.equal(deletedFolder?.deletedAt, removedAt)

  const moved = stampFolderPatch(movingFolder, { parentId: targetFolder.id, deletedAt: undefined }, movedAt, 'node-a')
  const merged = mergeSnapshots(
    harness.snapshot(),
    { ...createInitialSnapshot('node-a'), folders: [sourceFolder, targetFolder, moved], files: [], activity: [] },
  )
  const mergedFolder = merged.folders.find((item) => item.id === movingFolder.id)

  assert.equal(mergedFolder?.parentId, targetFolder.id)
  assert.equal(mergedFolder?.deletedAt, undefined)
})

test('initial folder-share import snapshot normalizes the shared root parent to null', () => {
  const now = '2026-05-21T00:00:00.000Z'
  const parent = makeFolder({ id: 'folder-parent', name: 'Parent', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const sharedFolder = makeFolder({ id: 'folder-shared', name: 'Shared', parentId: parent.id, color: 'blue', roomId: 'tc-storage-main', now, nodeId: 'node-a' })

  const remote = remoteFolderSnapshot(
    {
      version: 1,
      exportedAt: now,
      originNode: 'node-a',
      folder: sharedFolder,
      folders: [sharedFolder],
      files: [],
    },
    {
      type: 'folder-share',
      from: 'node-a',
      roomId: 'tc-storage-main',
      sentAt: '2026-05-21T00:00:01.000Z',
      receivedAt: '2026-05-21T00:00:02.000Z',
      clock: 2,
      folderId: sharedFolder.id,
      folderName: sharedFolder.name,
      cid: 'cid-folder',
    },
  )

  assert.equal(remote.folders.find((item) => item.id === sharedFolder.id)?.parentId, null)
})

test('folder-share import preserves an existing local shared-root parent', () => {
  const now = '2026-05-21T00:00:00.000Z'
  const movedAt = '2026-05-21T00:00:01.000Z'
  const sharedAt = '2026-05-21T00:00:03.000Z'
  const parent = makeFolder({ id: 'folder-parent', name: 'Parent', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-b' })
  const bundleRoot = makeFolder({ id: 'folder-shared', name: 'Shared', parentId: null, color: 'blue', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const localSharedFolder = stampFolderPatch(bundleRoot, { parentId: parent.id, shareEnabled: true, lastCid: 'cid-before-move' }, movedAt, 'node-b')
  const local = { ...createInitialSnapshot('node-b'), folders: [parent, localSharedFolder], files: [], activity: [] }

  const remote = remoteFolderSnapshot(
    {
      version: 1,
      exportedAt: sharedAt,
      originNode: 'node-a',
      folder: bundleRoot,
      folders: [bundleRoot],
      files: [],
    },
    {
      type: 'folder-share',
      from: 'node-a',
      roomId: 'tc-storage-main',
      sentAt: sharedAt,
      receivedAt: '2026-05-21T00:00:04.000Z',
      clock: 3,
      folderId: bundleRoot.id,
      folderName: bundleRoot.name,
      cid: 'cid-after-sync',
    },
    { preserveRootFolder: localSharedFolder },
  )

  const merged = mergeSnapshots(local, remote)
  const mergedFolder = merged.folders.find((item) => item.id === bundleRoot.id)

  assert.equal(remote.folders.find((item) => item.id === bundleRoot.id)?.parentId, parent.id)
  assert.equal(mergedFolder?.parentId, parent.id)
  assert.equal(mergedFolder?.lastCid, 'cid-after-sync')
})

function createContentActionsForSnapshot(
  snapshot: StorageSnapshot,
  folderKeys: Record<string, string> = {},
) {
  let cache: Record<string, string> = {}
  let snapshotValue = snapshot
  const snapshotRef = { current: snapshotValue }
  return createFileContentActions({
    failDownloadProgress: () => {},
    failFileLoadProgress: () => {},
    fileContentCacheRef: { current: cache },
    fileContentLoadsRef: { current: {} },
    fileShareKeysRef: { current: {} },
    finishDownloadProgress: () => {},
    finishFileLoadProgress: () => {},
    folderKeysRef: { current: folderKeys },
    setFileContentCache: (update) => {
      cache = applyStateUpdate(cache, update)
    },
    setNotice: () => {},
    setSnapshot: (update) => {
      snapshotValue = applyStateUpdate(snapshotValue, update)
      snapshotRef.current = snapshotValue
    },
    settingsRef: { current: { roomId: 'tc-storage-main', signalingUrl: 'https://rtc.example.test/signaling', nodeId: 'node-a', identity: null, autoConnect: false, profileName: 'Test user', avatarUrl: '', avatarFileId: '' } },
    snapshotRef,
    startDownloadProgress: () => 0,
    startFileLoadProgress: () => '',
    updateDownloadProgress: () => {},
  })
}

function applyStateUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update
}

function createEnvelopeHarness(snapshot: StorageSnapshot) {
  let snapshotValue = snapshot
  const snapshotRef = { current: snapshotValue }
  const actions = createEnvelopeActions({
    announceSharedFolders: () => {},
    autoImportCidsRef: { current: new Set<string>() },
    autoImportFolderShare: async () => {},
    autoImportInFlightRef: { current: new Set<string>() },
    autoImportLinkedShare: async () => {},
    currentFolderId: null,
    detailFileId: null,
    folderKeysRef: { current: {} },
    folderPanelFolderId: null,
    handleFolderAccessDenied: () => {},
    handleFolderAccessGrant: async () => {},
    handleFolderAccessRequest: () => {},
    helloResponseAtRef: { current: {} },
    importKeysRef: { current: {} },
    pendingSharesRef: { current: [] },
    preloadFileContent: () => {},
    rememberFolderPeer: () => {},
    scheduleFolderSync: () => {},
    selectedFileId: null,
    setCurrentFolderId: () => {},
    setDetailFileId: () => {},
    setExpandedPreviewOpen: () => {},
    setFolderKeys: () => {},
    setFolderPanelFolderId: () => {},
    setFolderPanelOpen: () => {},
    setNotice: () => {},
    setPendingShares: () => {},
    setSelectedFileId: () => {},
    setSnapshot: (update) => {
      snapshotValue = applyStateUpdate(snapshotValue, update)
      snapshotRef.current = snapshotValue
    },
    snapshotRef,
  })
  return { actions, snapshot: () => snapshotValue }
}

function snapshotWithSharedChildFile(options: { rootLastCid?: boolean } = {}): { childFileWithCid: FileRecord; childFolder: FolderRecord; sharedRoot: FolderRecord; snapshot: StorageSnapshot } {
  const now = '2026-05-21T00:00:00.000Z'
  const sharedRoot = stampFolderPatch(
    makeFolder({ id: 'folder-root', name: 'Root', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-a' }),
    options.rootLastCid === false ? { shareEnabled: true } : { shareEnabled: true, lastCid: 'cid-root' },
    now,
    'node-a',
  )
  const childFolder = makeFolder({ id: 'folder-child', name: 'Child', parentId: sharedRoot.id, color: 'blue', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const childFile = makeFileFromDataUrl({ id: 'file-child', folderId: childFolder.id, name: 'child.txt', mimeType: 'text/plain', size: 5, dataUrl: 'data:text/plain;base64,aGVsbG8=', checksum: 'checksum-child', now, nodeId: 'node-a' })
  const childFileWithCid = stripFileContent(stampFilePatch(childFile, { lastCid: 'cid-child' }, now, 'node-a'))
  return {
    childFileWithCid,
    childFolder,
    sharedRoot,
    snapshot: { ...createInitialSnapshot('node-a'), folders: [sharedRoot, childFolder], files: [childFileWithCid], activity: [] },
  }
}

function snapshotWithTwoFoldersAndFile() {
  const now = '2026-05-21T00:00:00.000Z'
  const sourceFolder = makeFolder({ id: 'folder-source', name: 'Source', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const targetFolder = makeFolder({ id: 'folder-target', name: 'Target', parentId: null, color: 'blue', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const file = stripFileContent(stampFilePatch(
    makeFileFromDataUrl({ id: 'file-moving', folderId: sourceFolder.id, name: 'moving.txt', mimeType: 'text/plain', size: 4, dataUrl: 'data:text/plain;base64,dGVzdA==', checksum: 'checksum-file', now, nodeId: 'node-a' }),
    { lastCid: 'cid-before-move' },
    now,
    'node-a',
  ))
  return { file, sourceFolder, targetFolder }
}

function snapshotWithMovingFolder() {
  const now = '2026-05-21T00:00:00.000Z'
  const sourceFolder = makeFolder({ id: 'folder-source', name: 'Source', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const targetFolder = makeFolder({ id: 'folder-target', name: 'Target', parentId: null, color: 'blue', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const movingFolder = makeFolder({ id: 'folder-moving', name: 'Moving', parentId: sourceFolder.id, color: 'amber', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  return { movingFolder, sourceFolder, targetFolder }
}
