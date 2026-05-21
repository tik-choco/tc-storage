import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createAccessActions, type RequestKeyEntry } from '../src/appAccessActions.js'
import { createInitialSnapshot, makeFolder } from '../src/domain.js'
import { applyStateUpdate, expectedFolderKeyHash, fixedFolderId, folderSecret, networkStub, otherDid, ownerDid, requesterDid, settingsStub } from './accessApprovalHelpers.js'

test('folder access request targets the owner pinned in the fixed invite', async () => {
  const broadcasts: unknown[] = []
  const accessRequestKeysRef = { current: {} as Record<string, RequestKeyEntry> }
  const actions = createAccessActions({
    accessRequestKeysRef,
    folderAccessModesRef: { current: {} },
    folderKeysRef: { current: {} },
    networkRef: { current: networkStub(broadcasts) },
    openFolderAccessRequests: () => {},
    setFolderAccessRequests: () => {},
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: () => {},
    setPendingShares: () => {},
    settingsRef: { current: settingsStub(requesterDid) },
    snapshotRef: { current: createInitialSnapshot(requesterDid) },
  })

  await actions.requestFolderAccess({
    type: 'folder-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 0,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    ownerNodeId: ownerDid,
    folderKeyHash: expectedFolderKeyHash,
    autoImport: true,
  })

  assert.equal((broadcasts[0] as { type?: string }).type, 'folder-access-request')
  assert.equal((broadcasts[0] as { targetNodeId?: string }).targetNodeId, ownerDid)
  assert.equal((broadcasts[0] as { folderKeyHash?: string }).folderKeyHash, expectedFolderKeyHash)
  assert.equal(Object.values(accessRequestKeysRef.current)[0]?.ownerNodeId, ownerDid)
  assert.equal(Object.values(accessRequestKeysRef.current)[0]?.folderKeyHash, expectedFolderKeyHash)
})

test('shared-approval access request broadcasts to connected shared peers', async () => {
  const broadcasts: unknown[] = []
  const accessRequestKeysRef = { current: {} as Record<string, RequestKeyEntry> }
  const actions = createAccessActions({
    accessRequestKeysRef,
    folderAccessModesRef: { current: {} },
    folderKeysRef: { current: {} },
    networkRef: { current: networkStub(broadcasts) },
    openFolderAccessRequests: () => {},
    setFolderAccessRequests: () => {},
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: () => {},
    setPendingShares: () => {},
    settingsRef: { current: settingsStub(requesterDid) },
    snapshotRef: { current: createInitialSnapshot(requesterDid) },
  })

  await actions.requestFolderAccess({
    type: 'folder-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 0,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    ownerNodeId: ownerDid,
    accessGrantMode: 'shared',
    folderKeyHash: expectedFolderKeyHash,
    autoImport: true,
  })

  assert.equal((broadcasts[0] as { type?: string }).type, 'folder-access-request')
  assert.equal((broadcasts[0] as { targetNodeId?: string }).targetNodeId, undefined)
  assert.equal((broadcasts[0] as { accessGrantMode?: string }).accessGrantMode, 'shared')
  assert.equal((broadcasts[0] as { folderKeyHash?: string }).folderKeyHash, expectedFolderKeyHash)
  assert.equal(Object.values(accessRequestKeysRef.current)[0]?.accessGrantMode, 'shared')
})

test('shared-approval access request is shown to a connected holder with the folder key', () => {
  const now = '2026-05-21T00:00:00.000Z'
  const folder = { ...makeFolder({ id: fixedFolderId, name: 'Fixed invite', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: otherDid }), shareEnabled: true }
  const snapshot = { ...createInitialSnapshot(otherDid), folders: [folder], files: [], activity: [] }
  let requests = 0
  let opened = 0
  const actions = createAccessActions({
    accessRequestKeysRef: { current: {} },
    folderAccessModesRef: { current: { [folder.id]: 'shared-approval' } },
    folderKeysRef: { current: { [folder.id]: folderSecret } },
    networkRef: { current: networkStub() },
    openFolderAccessRequests: () => {
      opened += 1
    },
    setFolderAccessRequests: (update) => {
      requests = applyStateUpdate([], update).length
    },
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: () => {},
    setPendingShares: () => {},
    settingsRef: { current: settingsStub(otherDid) },
    snapshotRef: { current: snapshot },
  })

  actions.handleFolderAccessRequest({
    type: 'folder-access-request',
    from: requesterDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: folder.id,
    folderName: folder.name,
    accessGrantMode: 'shared',
    folderKeyHash: expectedFolderKeyHash,
    requestId: 'request-a',
    accessPublicKey: 'public-a',
  })

  assert.equal(requests, 1)
  assert.equal(opened, 1)
})

test('shared-approval access request is ignored when the holder key does not match the invite', () => {
  const now = '2026-05-21T00:00:00.000Z'
  const folder = { ...makeFolder({ id: fixedFolderId, name: 'Fixed invite', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: otherDid }), shareEnabled: true }
  const snapshot = { ...createInitialSnapshot(otherDid), folders: [folder], files: [], activity: [] }
  let requests = 0
  let opened = 0
  const actions = createAccessActions({
    accessRequestKeysRef: { current: {} },
    folderAccessModesRef: { current: { [folder.id]: 'shared-approval' } },
    folderKeysRef: { current: { [folder.id]: 'different-secret' } },
    networkRef: { current: networkStub() },
    openFolderAccessRequests: () => {
      opened += 1
    },
    setFolderAccessRequests: (update) => {
      requests = applyStateUpdate([], update).length
    },
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: () => {},
    setPendingShares: () => {},
    settingsRef: { current: settingsStub(otherDid) },
    snapshotRef: { current: snapshot },
  })

  actions.handleFolderAccessRequest({
    type: 'folder-access-request',
    from: requesterDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: folder.id,
    folderName: folder.name,
    accessGrantMode: 'shared',
    folderKeyHash: expectedFolderKeyHash,
    requestId: 'request-a',
    accessPublicKey: 'public-a',
  })

  assert.equal(requests, 0)
  assert.equal(opened, 0)
})

test('folder owner ignores access requests targeted at another owner', () => {
  const now = '2026-05-21T00:00:00.000Z'
  const folder = { ...makeFolder({ id: fixedFolderId, name: 'Fixed invite', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: ownerDid }), shareEnabled: true }
  const snapshot = { ...createInitialSnapshot(ownerDid), folders: [folder], files: [], activity: [] }
  let requests = 0
  let opened = 0
  const actions = createAccessActions({
    accessRequestKeysRef: { current: {} },
    folderAccessModesRef: { current: {} },
    folderKeysRef: { current: { [folder.id]: folderSecret } },
    networkRef: { current: networkStub() },
    openFolderAccessRequests: () => {
      opened += 1
    },
    setFolderAccessRequests: (update) => {
      requests = applyStateUpdate([], update).length
    },
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: () => {},
    setPendingShares: () => {},
    settingsRef: { current: settingsStub(ownerDid) },
    snapshotRef: { current: snapshot },
  })

  actions.handleFolderAccessRequest({
    type: 'folder-access-request',
    from: requesterDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: folder.id,
    folderName: folder.name,
    folderKeyHash: expectedFolderKeyHash,
    targetNodeId: otherDid,
    requestId: 'request-a',
    accessPublicKey: 'public-a',
  })

  assert.equal(requests, 0)
  assert.equal(opened, 0)
})
