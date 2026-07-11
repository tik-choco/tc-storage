import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEnvelopeActions } from '../src/app/appEnvelopeActions.js'
import { createMoveActions } from '../src/app/appMoveActions.js'
import type { Notice } from '../src/app/appTypes.js'
import type { ShareEnvelope } from '../src/p2p/p2p.js'
import { createInitialSnapshot, makeFolder, type FolderRecord, type StorageSnapshot } from '../src/storage/domain.js'

type StateUpdate<T> = T | ((current: T) => T)

test('moving an already-shared folder into another shared folder is rejected', async () => {
  const sourceSharedFolder = makeSharedFolder('folder-source-share', 'Source share', null, 'room-source')
  const targetSharedFolder = makeSharedFolder('folder-target-share', 'Target share', null, 'room-target')
  const childFolder = makeTestFolder('folder-child', 'Child', sourceSharedFolder.id)
  const snapshot = {
    ...createInitialSnapshot('node-a'),
    folders: [sourceSharedFolder, targetSharedFolder, childFolder],
    files: [],
    activity: [],
  }
  const harness = createMoveHarness(snapshot, {
    [sourceSharedFolder.id]: 'source-secret',
    [targetSharedFolder.id]: 'target-secret',
    [childFolder.id]: 'source-secret',
  })

  assert.equal(harness.actions.canMoveItemToFolder({ type: 'folder', id: sourceSharedFolder.id }, targetSharedFolder.id), false)

  await harness.actions.moveDraggedItem({ type: 'folder', id: sourceSharedFolder.id }, targetSharedFolder.id)

  const movedFolder = harness.snapshot().folders.find((folder) => folder.id === sourceSharedFolder.id)
  assert.equal(movedFolder?.parentId, null)
  assert.equal(movedFolder?.shareEnabled, true)
  assert.equal(movedFolder?.sharedRoomId, 'room-source')
  assert.deepEqual(harness.announcements, [])
  assert.deepEqual(harness.scheduled, [])
  assert.deepEqual(harness.notice, { tone: 'error', text: 'その場所には移動できません' })
})

test('a remote peer ignores an already-shared folder move into another shared folder', () => {
  const sourceSharedFolder = makeSharedFolder('folder-source-share', 'Source share', null, 'room-source')
  const targetSharedFolder = makeSharedFolder('folder-target-share', 'Target share', null, 'room-target')
  const childFolder = makeTestFolder('folder-child', 'Child', sourceSharedFolder.id)
  const remoteSnapshot = {
    ...createInitialSnapshot('node-b'),
    folders: [sourceSharedFolder, targetSharedFolder, childFolder],
    files: [],
    activity: [],
  }
  const remote = createRemoteHarness(remoteSnapshot, {
    [sourceSharedFolder.id]: 'source-secret',
    [targetSharedFolder.id]: 'target-secret',
    [childFolder.id]: 'source-secret',
  })
  const remoteMovedFolder = { ...sourceSharedFolder, parentId: targetSharedFolder.id, updatedAt: '2026-05-21T00:00:01.000Z' }
  const envelope: ShareEnvelope = {
    type: 'folder-change',
    from: 'node-a',
    roomId: targetSharedFolder.sharedRoomId,
    sentAt: remoteMovedFolder.updatedAt,
    clock: 2,
    changeType: 'folder-upserted',
    folderId: targetSharedFolder.id,
    folderName: targetSharedFolder.name,
    folder: remoteMovedFolder,
  }

  remote.actions.handleEnvelope(envelope)

  const folder = remote.snapshot().folders.find((item) => item.id === sourceSharedFolder.id)
  assert.equal(folder?.parentId, null)
  assert.equal(folder?.shareEnabled, true)
  assert.equal(folder?.sharedRoomId, 'room-source')
  assert.equal(remote.folderKeys()[sourceSharedFolder.id], 'source-secret')
  assert.deepEqual(remote.peers, [{ folderId: targetSharedFolder.id, from: 'node-a' }])
  assert.equal(remote.notice, null)
})

function createMoveHarness(snapshot: StorageSnapshot, initialFolderKeys: Record<string, string>) {
  let snapshotValue = snapshot
  let folderKeys = initialFolderKeys
  const snapshotRef = { current: snapshotValue }
  const folderKeysRef = { current: folderKeys }
  const announcements: Array<{ changeType: string; folderId: string; fileId?: string; changedFolderId?: string; changedFolder?: FolderRecord }> = []
  const scheduled: Array<{ folderId: string; reason: string }> = []
  let notice: Notice | null = null
  const actions = createMoveActions({
    announceFolderChange: (folder, changeType, file, changedFolder) => {
      announcements.push({ changeType, folderId: folder.id, fileId: file?.id, changedFolderId: changedFolder?.id, changedFolder })
    },
    ensureFileContent: async (file) => file,
    folderKeysRef,
    scheduleFolderSync: (folderId, reason) => {
      scheduled.push({ folderId, reason })
    },
    setBusy: () => {},
    setFileContentCache: () => {},
    setFolderKeys: (update) => {
      folderKeys = applyStateUpdate(folderKeys, update)
      folderKeysRef.current = folderKeys
    },
    setNotice: (update) => {
      notice = applyStateUpdate(notice ?? { tone: 'info', text: '' }, update)
    },
    setSnapshot: (update) => {
      snapshotValue = applyStateUpdate(snapshotValue, update)
      snapshotRef.current = snapshotValue
    },
    settings: {
      roomId: 'tc-storage-main',
      nodeId: 'node-a',
      identity: null,
      autoConnect: false,
      profileName: 'Test user',
      avatarUrl: '',
      avatarFileId: '',
    },
    snapshotRef,
  })
  return {
    actions,
    announcements,
    folderKeys: () => folderKeys,
    get notice() {
      return notice
    },
    scheduled,
    snapshot: () => snapshotValue,
  }
}

function createRemoteHarness(snapshot: StorageSnapshot, initialFolderKeys: Record<string, string>) {
  let snapshotValue = snapshot
  let folderKeys = initialFolderKeys
  const snapshotRef = { current: snapshotValue }
  const folderKeysRef = { current: folderKeys }
  const peers: Array<{ folderId: string | undefined; from: string }> = []
  let notice: Notice | null = null
  const actions = createEnvelopeActions({
    announceSharedFolders: () => {},
    autoImportCidsRef: { current: new Set<string>() },
    autoImportFolderShare: async () => {},
    autoImportInFlightRef: { current: new Set<string>() },
    autoImportLinkedShare: async () => {},
    currentFolderId: null,
    detailFileId: null,
    folderKeysRef,
    folderPanelFolderId: null,
    handleFileContentRepairRequest: () => {},
    handleFolderAccessDenied: () => {},
    handleFolderAccessGrant: async () => {},
    handleFolderAccessRequest: () => {},
    helloResponseAtRef: { current: {} },
    importKeysRef: { current: {} },
    pendingSharesRef: { current: [] },
    rememberFolderPeer: (envelope) => {
      peers.push({ folderId: envelope.folderId, from: envelope.from })
    },
    scheduleFolderSync: () => {},
    selectedFileId: null,
    setCurrentFolderId: () => {},
    setDetailFileId: () => {},
    setExpandedPreviewOpen: () => {},
    setFolderKeys: (update) => {
      folderKeys = applyStateUpdate(folderKeys, update)
      folderKeysRef.current = folderKeys
    },
    setFolderPanelFolderId: () => {},
    setFolderPanelOpen: () => {},
    setNotice: (update) => {
      notice = applyStateUpdate(notice ?? { tone: 'info', text: '' }, update)
    },
    setPendingShares: () => {},
    setSelectedFileId: () => {},
    setSnapshot: (update) => {
      snapshotValue = applyStateUpdate(snapshotValue, update)
      snapshotRef.current = snapshotValue
    },
    snapshotRef,
  })
  return {
    actions,
    folderKeys: () => folderKeys,
    get notice() {
      return notice
    },
    peers,
    snapshot: () => snapshotValue,
  }
}

function makeSharedFolder(id: string, name: string, parentId: string | null, sharedRoomId: string): FolderRecord {
  return { ...makeTestFolder(id, name, parentId), shareEnabled: true, sharedRoomId }
}

function makeTestFolder(id: string, name: string, parentId: string | null): FolderRecord {
  return makeFolder({ id, name, parentId, color: 'teal', roomId: 'tc-storage-main', now: '2026-05-21T00:00:00.000Z', nodeId: 'node-a' })
}

function applyStateUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update
}
