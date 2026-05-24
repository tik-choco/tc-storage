import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PendingShare } from '../src/appTypes.js'
import { createAccessActions, type RequestKeyEntry } from '../src/appAccessActions.js'
import { createAccessRequestKey, encryptFolderKeyForRequest } from '../src/accessGrantCrypto.js'
import { createInitialSnapshot } from '../src/domain.js'
import { applyStateUpdate, attackerDid, expectedFolderKeyHash, fixedFolderId, folderSecret, networkStub, otherDid, ownerDid, requesterDid, settingsStub } from './accessApprovalHelpers.js'

test('folder access grant is accepted only from the owner pinned in the invite', async () => {
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
  let folderKeys: Record<string, string> = {}
  let importKeys: Record<string, string> = {}
  const requestKey = await createAccessRequestKey()
  const entry = { ...requestKey, folderId: fixedFolderId, folderKeyHash: expectedFolderKeyHash, ownerNodeId: ownerDid, roomId: 'tc-storage-main', requestId: 'request-a' } satisfies RequestKeyEntry
  const accessRequestKeysRef = { current: { 'request-a': entry, [`tc-storage-main:folder:${fixedFolderId}`]: entry } }
  const actions = createAccessActions({
    accessRequestKeysRef,
    folderAccessModesRef: { current: {} },
    folderKeysRef: { current: folderKeys },
    networkRef: { current: networkStub() },
    openFolderAccessRequests: () => {},
    setFolderAccessRequests: () => {},
    setFolderKeys: (update) => {
      folderKeys = applyStateUpdate(folderKeys, update)
    },
    setImportKeys: (update) => {
      importKeys = applyStateUpdate(importKeys, update)
    },
    setNotice: () => {},
    setPendingShares: (update) => {
      pendingShares = applyStateUpdate(pendingShares, update)
    },
    settingsRef: { current: settingsStub(requesterDid) },
    snapshotRef: { current: createInitialSnapshot(requesterDid) },
  })
  const attackerGrant = await encryptFolderKeyForRequest('attacker-secret', requestKey.publicKey)

  await actions.handleFolderAccessGrant({
    type: 'folder-access-grant',
    from: attackerDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    targetNodeId: requesterDid,
    requestId: 'request-a',
    cid: 'cid-attacker',
    accessGrantPublicKey: attackerGrant.publicKey,
    accessGrantIv: attackerGrant.iv,
    accessGrantCipherText: attackerGrant.cipherText,
  })

  assert.deepEqual(folderKeys, {})
  assert.equal(pendingShares[0]?.cid, undefined)
  assert.deepEqual(Object.keys(accessRequestKeysRef.current).sort(), ['request-a', `tc-storage-main:folder:${fixedFolderId}`])

  const ownerGrant = await encryptFolderKeyForRequest(folderSecret, requestKey.publicKey)
  await actions.handleFolderAccessGrant({
    type: 'folder-access-grant',
    from: ownerDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:03.000Z',
    clock: 3,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    targetNodeId: requesterDid,
    requestId: 'request-a',
    cid: 'cid-owner',
    accessGrantPublicKey: ownerGrant.publicKey,
    accessGrantIv: ownerGrant.iv,
    accessGrantCipherText: ownerGrant.cipherText,
  })

  assert.equal(folderKeys[fixedFolderId], folderSecret)
  assert.equal(importKeys['cid-owner'], folderSecret)
  assert.equal(pendingShares[0]?.cid, 'cid-owner')
  assert.deepEqual(accessRequestKeysRef.current, {})
})

test('folder access grant marks only the pending invite in the granted room', async () => {
  let pendingShares: PendingShare[] = [
    {
      type: 'folder-share',
      from: 'share-url',
      roomId: 'room-a',
      sentAt: '2026-05-21T00:00:00.000Z',
      receivedAt: '2026-05-21T00:00:01.000Z',
      clock: 0,
      folderId: fixedFolderId,
      folderName: 'Fixed invite A',
      ownerNodeId: ownerDid,
      folderKeyHash: expectedFolderKeyHash,
      autoImport: true,
    },
    {
      type: 'folder-share',
      from: 'share-url',
      roomId: 'room-b',
      sentAt: '2026-05-21T00:00:00.000Z',
      receivedAt: '2026-05-21T00:00:01.000Z',
      clock: 0,
      folderId: fixedFolderId,
      folderName: 'Fixed invite B',
      ownerNodeId: ownerDid,
      folderKeyHash: expectedFolderKeyHash,
      autoImport: true,
    },
  ]
  let folderKeys: Record<string, string> = {}
  let importKeys: Record<string, string> = {}
  const requestKey = await createAccessRequestKey()
  const entry = { ...requestKey, folderId: fixedFolderId, folderKeyHash: expectedFolderKeyHash, ownerNodeId: ownerDid, roomId: 'room-a', requestId: 'request-a' } satisfies RequestKeyEntry
  const accessRequestKeysRef = { current: { 'request-a': entry, [`room-a:folder:${fixedFolderId}`]: entry } }
  const actions = createAccessActions({
    accessRequestKeysRef,
    folderAccessModesRef: { current: {} },
    folderKeysRef: { current: folderKeys },
    networkRef: { current: networkStub() },
    openFolderAccessRequests: () => {},
    setFolderAccessRequests: () => {},
    setFolderKeys: (update) => { folderKeys = applyStateUpdate(folderKeys, update) },
    setImportKeys: (update) => { importKeys = applyStateUpdate(importKeys, update) },
    setNotice: () => {},
    setPendingShares: (update) => { pendingShares = applyStateUpdate(pendingShares, update) },
    settingsRef: { current: { ...settingsStub(requesterDid), roomId: 'room-a' } },
    snapshotRef: { current: createInitialSnapshot(requesterDid) },
  })
  const grant = await encryptFolderKeyForRequest(folderSecret, requestKey.publicKey)

  await actions.handleFolderAccessGrant({
    type: 'folder-access-grant',
    from: ownerDid,
    roomId: 'room-a',
    sentAt: '2026-05-21T00:00:03.000Z',
    clock: 3,
    folderId: fixedFolderId,
    folderName: 'Fixed invite A',
    targetNodeId: requesterDid,
    requestId: 'request-a',
    cid: 'cid-room-a',
    accessGrantPublicKey: grant.publicKey,
    accessGrantIv: grant.iv,
    accessGrantCipherText: grant.cipherText,
  })

  assert.equal(folderKeys[fixedFolderId], folderSecret)
  assert.equal(importKeys['cid-room-a'], folderSecret)
  assert.equal(pendingShares.find((share) => share.roomId === 'room-a')?.cid, 'cid-room-a')
  assert.equal(pendingShares.find((share) => share.roomId === 'room-b')?.cid, undefined)
})

test('shared-approval access grant can come from a non-owner shared holder', async () => {
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
  let folderKeys: Record<string, string> = {}
  let importKeys: Record<string, string> = {}
  const requestKey = await createAccessRequestKey()
  const entry = { ...requestKey, accessGrantMode: 'shared' as const, folderId: fixedFolderId, folderKeyHash: expectedFolderKeyHash, ownerNodeId: ownerDid, roomId: 'tc-storage-main', requestId: 'request-a' } satisfies RequestKeyEntry
  const accessRequestKeysRef = { current: { 'request-a': entry, [`tc-storage-main:folder:${fixedFolderId}`]: entry } }
  const actions = createAccessActions({
    accessRequestKeysRef,
    folderAccessModesRef: { current: {} },
    folderKeysRef: { current: folderKeys },
    networkRef: { current: networkStub() },
    openFolderAccessRequests: () => {},
    setFolderAccessRequests: () => {},
    setFolderKeys: (update) => {
      folderKeys = applyStateUpdate(folderKeys, update)
    },
    setImportKeys: (update) => {
      importKeys = applyStateUpdate(importKeys, update)
    },
    setNotice: () => {},
    setPendingShares: (update) => {
      pendingShares = applyStateUpdate(pendingShares, update)
    },
    settingsRef: { current: settingsStub(requesterDid) },
    snapshotRef: { current: createInitialSnapshot(requesterDid) },
  })
  const wrongGrant = await encryptFolderKeyForRequest('attacker-secret', requestKey.publicKey)

  await actions.handleFolderAccessGrant({
    type: 'folder-access-grant',
    from: attackerDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    targetNodeId: requesterDid,
    requestId: 'request-a',
    cid: 'cid-attacker',
    accessGrantPublicKey: wrongGrant.publicKey,
    accessGrantIv: wrongGrant.iv,
    accessGrantCipherText: wrongGrant.cipherText,
  })

  assert.deepEqual(folderKeys, {})
  assert.deepEqual(importKeys, {})
  assert.equal(pendingShares[0]?.cid, undefined)

  const grant = await encryptFolderKeyForRequest(folderSecret, requestKey.publicKey)
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
    cid: 'cid-holder',
    accessGrantPublicKey: grant.publicKey,
    accessGrantIv: grant.iv,
    accessGrantCipherText: grant.cipherText,
  })

  assert.equal(folderKeys[fixedFolderId], folderSecret)
  assert.equal(importKeys['cid-holder'], folderSecret)
  assert.equal(pendingShares[0]?.cid, 'cid-holder')
  assert.deepEqual(Object.keys(accessRequestKeysRef.current).sort(), ['request-a', `tc-storage-main:folder:${fixedFolderId}`])
})
