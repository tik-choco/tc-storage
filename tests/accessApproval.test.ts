import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import type { FolderAccessRequest, PendingShare } from '../src/appTypes.js'
import { createAccessActions, type RequestKeyEntry } from '../src/appAccessActions.js'
import { createEnvelopeActions } from '../src/appEnvelopeActions.js'
import { createAccessRequestKey, encryptFolderKeyForRequest } from '../src/accessGrantCrypto.js'
import { didKeyFromEd25519PublicKey } from '../src/didIdentity.js'
import { createInitialSnapshot, makeFolder } from '../src/domain.js'
import { folderAccessGrantProof, folderKeyHash } from '../src/folderKeyProof.js'
import type { NetworkState } from '../src/p2p.js'

type StateUpdate<T> = T | ((current: T) => T)

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

const ownerDid = didFromSeed(1)
const requesterDid = didFromSeed(2)
const attackerDid = didFromSeed(3)
const otherDid = didFromSeed(4)
const fixedFolderId = 'folder-fixed'
const folderSecret = 'folder-secret'
const expectedFolderKeyHash = folderKeyHash(fixedFolderId, folderSecret)

test('folder-share cid after fixed invite uses the granted folder key for immediate import', () => {
  let pendingShares: PendingShare[] = [{
    type: 'folder-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 0,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    autoImport: true,
  }]
  const pendingSharesRef = { current: pendingShares }
  const snapshotRef = { current: createInitialSnapshot('node-b') }
  let imported: { passphrase: string; share: PendingShare } | undefined

  const actions = createEnvelopeActions({
    announceSharedFolders: () => {},
    autoImportCidsRef: { current: new Set<string>() },
    autoImportFolderShare: async () => {},
    autoImportInFlightRef: { current: new Set<string>() },
    autoImportLinkedShare: async (share, passphrase) => {
      imported = { passphrase, share }
    },
    currentFolderId: null,
    detailFileId: null,
    folderKeysRef: { current: { [fixedFolderId]: folderSecret } },
    folderPanelFolderId: null,
    handleFolderAccessDenied: () => {},
    handleFolderAccessGrant: async () => {},
    handleFolderAccessRequest: () => {},
    helloResponseAtRef: { current: {} },
    importKeysRef: { current: {} },
    pendingSharesRef,
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
    setPendingShares: (update) => {
      pendingShares = applyStateUpdate(pendingShares, update)
      pendingSharesRef.current = pendingShares
    },
    setSelectedFileId: () => {},
    setSnapshot: () => {},
    snapshotRef,
  })

  actions.handleEnvelope({
    type: 'folder-share',
    from: 'node-a',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    cid: 'cid-folder',
  })

  assert.equal(imported?.passphrase, folderSecret)
  assert.equal(imported?.share.cid, 'cid-folder')
  assert.equal(pendingShares.length, 1)
  assert.equal(pendingShares[0]?.autoImport, true)
})

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
  const folder = {
    ...makeFolder({ id: fixedFolderId, name: 'Fixed invite', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: otherDid }),
    shareEnabled: true,
  }
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
  const folder = {
    ...makeFolder({ id: fixedFolderId, name: 'Fixed invite', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: otherDid }),
    shareEnabled: true,
  }
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
  const folder = {
    ...makeFolder({ id: fixedFolderId, name: 'Fixed invite', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: ownerDid }),
    shareEnabled: true,
  }
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
  const entry = {
    ...requestKey,
    folderId: fixedFolderId,
    folderKeyHash: expectedFolderKeyHash,
    ownerNodeId: ownerDid,
    roomId: 'tc-storage-main',
    requestId: 'request-a',
  } satisfies RequestKeyEntry
  const accessRequestKeysRef = {
    current: {
      'request-a': entry,
      [`tc-storage-main:folder:${fixedFolderId}`]: entry,
    },
  }
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
  const entry = {
    ...requestKey,
    accessGrantMode: 'shared' as const,
    folderId: fixedFolderId,
    folderKeyHash: expectedFolderKeyHash,
    ownerNodeId: ownerDid,
    roomId: 'tc-storage-main',
    requestId: 'request-a',
  } satisfies RequestKeyEntry
  const accessRequestKeysRef = {
    current: {
      'request-a': entry,
      [`tc-storage-main:folder:${fixedFolderId}`]: entry,
    },
  }
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

test('shared-approval grant proof clears the request on other approvers', async () => {
  const now = '2026-05-21T00:00:00.000Z'
  const folder = {
    ...makeFolder({ id: fixedFolderId, name: 'Fixed invite', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: ownerDid }),
    shareEnabled: true,
  }
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
  const accessRequestKeysRef = {
    current: {
      'request-a': entry,
      [`tc-storage-main:folder:${fixedFolderId}`]: entry,
    },
  }
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
  const accessRequestKeysRef = {
    current: {
      'request-a': {
        privateKey: {} as CryptoKey,
        publicKey: 'public-a',
        folderId: fixedFolderId,
        folderKeyHash: expectedFolderKeyHash,
        ownerNodeId: ownerDid,
        roomId: 'tc-storage-main',
        requestId: 'request-a',
      },
      [`tc-storage-main:folder:${fixedFolderId}`]: {
        privateKey: {} as CryptoKey,
        publicKey: 'public-a',
        folderId: fixedFolderId,
        folderKeyHash: expectedFolderKeyHash,
        ownerNodeId: ownerDid,
        roomId: 'tc-storage-main',
        requestId: 'request-a',
      },
    } satisfies Record<string, RequestKeyEntry>,
  }
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

function applyStateUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update
}

function networkStub(broadcasts: unknown[] = []) {
  const state: NetworkState = {
    mode: 'mistlib',
    peers: [],
    stablePeers: [],
    lastEvent: '',
    messagesSent: 0,
    messagesReceived: 0,
  }
  return { state, connect: async () => {}, disconnect: () => {}, broadcastShare: (payload: unknown) => broadcasts.push(payload) }
}

function settingsStub(nodeId: string) {
  return {
    roomId: 'tc-storage-main',
    signalingUrl: 'https://rtc.example.test/signaling',
    nodeId,
    identity: null,
    autoConnect: false,
    profileName: 'Test user',
    avatarUrl: '',
    avatarFileId: '',
  }
}

function didFromSeed(seed: number): string {
  const bytes = new Uint8Array(32)
  bytes.fill(seed)
  return didKeyFromEd25519PublicKey(bytes)
}
