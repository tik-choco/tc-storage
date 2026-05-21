import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FolderAccessRequest, PendingShare } from '../src/appTypes.js'
import { createAccessActions, type RequestKeyEntry } from '../src/appAccessActions.js'
import { createInitialSnapshot, makeFolder } from '../src/domain.js'
import { folderAccessGrantProof } from '../src/folderKeyProof.js'
import { applyStateUpdate, attackerDid, expectedFolderKeyHash, fixedFolderId, folderSecret, networkStub, otherDid, ownerDid, requesterDid, settingsStub } from './accessApprovalHelpers.js'

test('shared-approval grant proof clears the request on other approvers', async () => {
  const now = '2026-05-21T00:00:00.000Z'
  const folder = { ...makeFolder({ id: fixedFolderId, name: 'Fixed invite', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: ownerDid }), shareEnabled: true }
  let accessRequests: FolderAccessRequest[] = [{
    id: `${fixedFolderId}:${requesterDid}:request-a`,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    nodeId: requesterDid,
    publicKey: 'public-a',
    folderKeyHash: expectedFolderKeyHash,
    requestedAt: '2026-05-21T00:00:02.000Z',
    requestId: 'request-a',
  }]
  const actions = createAccessActions({
    accessRequestKeysRef: { current: {} },
    folderAccessModesRef: { current: { [folder.id]: 'shared-approval' } },
    folderKeysRef: { current: { [folder.id]: folderSecret } },
    networkRef: { current: networkStub() },
    openFolderAccessRequests: () => {},
    setFolderAccessRequests: (update) => {
      accessRequests = applyStateUpdate(accessRequests, update)
    },
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: () => {},
    setPendingShares: () => {},
    settingsRef: { current: settingsStub(ownerDid) },
    snapshotRef: { current: { ...createInitialSnapshot(ownerDid), folders: [folder], files: [], activity: [] } },
  })

  await actions.handleFolderAccessGrant({
    type: 'folder-access-grant',
    from: otherDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:03.000Z',
    clock: 3,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    targetNodeId: requesterDid,
    requestId: 'request-a',
    accessGrantProof: folderAccessGrantProof('different-secret', fixedFolderId, 'request-a', requesterDid),
    accessGrantPublicKey: 'grant-public',
    accessGrantIv: 'grant-iv',
    accessGrantCipherText: 'grant-cipher',
  })

  assert.equal(accessRequests.length, 1)

  await actions.handleFolderAccessGrant({
    type: 'folder-access-grant',
    from: otherDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:04.000Z',
    clock: 4,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    targetNodeId: requesterDid,
    requestId: 'request-a',
    accessGrantProof: folderAccessGrantProof(folderSecret, fixedFolderId, 'request-a', requesterDid),
    accessGrantPublicKey: 'grant-public',
    accessGrantIv: 'grant-iv',
    accessGrantCipherText: 'grant-cipher',
  })

  assert.deepEqual(accessRequests, [])
})

test('owner-only grant proof from another shared holder does not clear owner request', async () => {
  const now = '2026-05-21T00:00:00.000Z'
  const folder = { ...makeFolder({ id: fixedFolderId, name: 'Fixed invite', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: ownerDid }), shareEnabled: true }
  let accessRequests: FolderAccessRequest[] = [{
    id: `${fixedFolderId}:${requesterDid}:request-a`,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    nodeId: requesterDid,
    publicKey: 'public-a',
    folderKeyHash: expectedFolderKeyHash,
    requestedAt: '2026-05-21T00:00:02.000Z',
    requestId: 'request-a',
  }]
  const actions = createAccessActions({
    accessRequestKeysRef: { current: {} },
    folderAccessModesRef: { current: { [folder.id]: 'approval' } },
    folderKeysRef: { current: { [folder.id]: folderSecret } },
    networkRef: { current: networkStub() },
    openFolderAccessRequests: () => {},
    setFolderAccessRequests: (update) => {
      accessRequests = applyStateUpdate(accessRequests, update)
    },
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: () => {},
    setPendingShares: () => {},
    settingsRef: { current: settingsStub(ownerDid) },
    snapshotRef: { current: { ...createInitialSnapshot(ownerDid), folders: [folder], files: [], activity: [] } },
  })

  await actions.handleFolderAccessGrant({
    type: 'folder-access-grant',
    from: otherDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:04.000Z',
    clock: 4,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    targetNodeId: requesterDid,
    requestId: 'request-a',
    accessGrantProof: folderAccessGrantProof(folderSecret, fixedFolderId, 'request-a', requesterDid),
    accessGrantPublicKey: 'grant-public',
    accessGrantIv: 'grant-iv',
    accessGrantCipherText: 'grant-cipher',
  })

  assert.equal(accessRequests.length, 1)
})

test('shared-approval denial does not cancel the waiting invite', () => {
  let pendingShares: PendingShare[] = [{
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
  }]
  const entry = {
    privateKey: {} as CryptoKey,
    publicKey: 'public-a',
    accessGrantMode: 'shared' as const,
    folderId: fixedFolderId,
    folderKeyHash: expectedFolderKeyHash,
    ownerNodeId: ownerDid,
    roomId: 'tc-storage-main',
    requestId: 'request-a',
  } satisfies RequestKeyEntry
  const accessRequestKeysRef = { current: { 'request-a': entry, [`tc-storage-main:folder:${fixedFolderId}`]: entry } }
  const actions = createAccessActions({
    accessRequestKeysRef,
    folderAccessModesRef: { current: {} },
    folderKeysRef: { current: {} },
    networkRef: { current: networkStub() },
    openFolderAccessRequests: () => {},
    setFolderAccessRequests: () => {},
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: () => {},
    setPendingShares: (update) => {
      pendingShares = applyStateUpdate(pendingShares, update)
    },
    settingsRef: { current: settingsStub(requesterDid) },
    snapshotRef: { current: createInitialSnapshot(requesterDid) },
  })

  actions.handleFolderAccessDenied({
    type: 'folder-access-denied',
    from: otherDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:03.000Z',
    clock: 3,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    targetNodeId: requesterDid,
    requestId: 'request-a',
  })

  assert.equal(pendingShares.length, 1)
  assert.deepEqual(Object.keys(accessRequestKeysRef.current).sort(), ['request-a', `tc-storage-main:folder:${fixedFolderId}`])
})

test('folder access denied clears the waiting fixed invite on the requester', () => {
  let pendingShares: PendingShare[] = [{
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
  }]
  const pendingSharesRef = { current: pendingShares }
  const entry = {
    privateKey: {} as CryptoKey,
    publicKey: 'public-a',
    folderId: fixedFolderId,
    folderKeyHash: expectedFolderKeyHash,
    ownerNodeId: ownerDid,
    roomId: 'tc-storage-main',
    requestId: 'request-a',
  } satisfies RequestKeyEntry
  const accessRequestKeysRef = { current: { 'request-a': entry, [`tc-storage-main:folder:${fixedFolderId}`]: entry } }
  let noticeText = ''
  const actions = createAccessActions({
    accessRequestKeysRef,
    folderAccessModesRef: { current: {} },
    folderKeysRef: { current: {} },
    networkRef: { current: networkStub() },
    openFolderAccessRequests: () => {},
    setFolderAccessRequests: () => {},
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: (update) => {
      noticeText = applyStateUpdate({ tone: 'info' as const, text: noticeText }, update).text
    },
    setPendingShares: (update) => {
      pendingShares = applyStateUpdate(pendingShares, update)
      pendingSharesRef.current = pendingShares
    },
    settingsRef: { current: settingsStub(requesterDid) },
    snapshotRef: { current: createInitialSnapshot(requesterDid) },
  })

  actions.handleFolderAccessDenied({
    type: 'folder-access-denied',
    from: attackerDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    targetNodeId: requesterDid,
    requestId: 'request-a',
  })

  assert.equal(pendingShares.length, 1)
  assert.deepEqual(Object.keys(accessRequestKeysRef.current).sort(), ['request-a', `tc-storage-main:folder:${fixedFolderId}`])

  actions.handleFolderAccessDenied({
    type: 'folder-access-denied',
    from: ownerDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:03.000Z',
    clock: 3,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    targetNodeId: requesterDid,
    requestId: 'request-a',
  })

  assert.deepEqual(pendingShares, [])
  assert.deepEqual(Object.keys(accessRequestKeysRef.current), [])
  assert.match(noticeText, /却下/)
})
