import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import type { PendingShare } from '../src/appTypes.js'
import { createAccessActions, type RequestKeyEntry } from '../src/appAccessActions.js'
import { createEnvelopeActions } from '../src/appEnvelopeActions.js'
import { createAccessRequestKey, encryptFolderKeyForRequest } from '../src/accessGrantCrypto.js'
import { createInitialSnapshot, makeFolder } from '../src/domain.js'
import type { NetworkState } from '../src/p2p.js'

type StateUpdate<T> = T | ((current: T) => T)

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

test('folder-share cid after fixed invite uses the granted folder key for immediate import', () => {
  let pendingShares: PendingShare[] = [{
    type: 'folder-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 0,
    folderId: 'folder-fixed',
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
    folderKeysRef: { current: { 'folder-fixed': 'folder-secret' } },
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
    folderId: 'folder-fixed',
    folderName: 'Fixed invite',
    cid: 'cid-folder',
  })

  assert.equal(imported?.passphrase, 'folder-secret')
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
    settingsRef: { current: settingsStub('node-b') },
    snapshotRef: { current: createInitialSnapshot('node-b') },
  })

  await actions.requestFolderAccess({
    type: 'folder-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 0,
    folderId: 'folder-fixed',
    folderName: 'Fixed invite',
    ownerNodeId: 'node-owner',
    autoImport: true,
  })

  assert.equal((broadcasts[0] as { type?: string }).type, 'folder-access-request')
  assert.equal((broadcasts[0] as { targetNodeId?: string }).targetNodeId, 'node-owner')
  assert.equal(Object.values(accessRequestKeysRef.current)[0]?.ownerNodeId, 'node-owner')
})

test('folder owner ignores access requests targeted at another owner', () => {
  const now = '2026-05-21T00:00:00.000Z'
  const folder = {
    ...makeFolder({ id: 'folder-fixed', name: 'Fixed invite', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-owner' }),
    shareEnabled: true,
  }
  const snapshot = { ...createInitialSnapshot('node-owner'), folders: [folder], files: [], activity: [] }
  let requests = 0
  let opened = 0
  const actions = createAccessActions({
    accessRequestKeysRef: { current: {} },
    folderAccessModesRef: { current: {} },
    folderKeysRef: { current: { [folder.id]: 'folder-secret' } },
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
    settingsRef: { current: settingsStub('node-owner') },
    snapshotRef: { current: snapshot },
  })

  actions.handleFolderAccessRequest({
    type: 'folder-access-request',
    from: 'node-b',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: folder.id,
    folderName: folder.name,
    targetNodeId: 'node-other',
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
    folderId: 'folder-fixed',
    folderName: 'Fixed invite',
    ownerNodeId: 'node-owner',
    autoImport: true,
  }]
  let folderKeys: Record<string, string> = {}
  let importKeys: Record<string, string> = {}
  const requestKey = await createAccessRequestKey()
  const entry = {
    ...requestKey,
    folderId: 'folder-fixed',
    ownerNodeId: 'node-owner',
    roomId: 'tc-storage-main',
    requestId: 'request-a',
  } satisfies RequestKeyEntry
  const accessRequestKeysRef = {
    current: {
      'request-a': entry,
      'tc-storage-main:folder:folder-fixed': entry,
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
    settingsRef: { current: settingsStub('node-b') },
    snapshotRef: { current: createInitialSnapshot('node-b') },
  })
  const attackerGrant = await encryptFolderKeyForRequest('attacker-secret', requestKey.publicKey)

  await actions.handleFolderAccessGrant({
    type: 'folder-access-grant',
    from: 'node-attacker',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: 'folder-fixed',
    folderName: 'Fixed invite',
    targetNodeId: 'node-b',
    requestId: 'request-a',
    cid: 'cid-attacker',
    accessGrantPublicKey: attackerGrant.publicKey,
    accessGrantIv: attackerGrant.iv,
    accessGrantCipherText: attackerGrant.cipherText,
  })

  assert.deepEqual(folderKeys, {})
  assert.equal(pendingShares[0]?.cid, undefined)
  assert.deepEqual(Object.keys(accessRequestKeysRef.current).sort(), ['request-a', 'tc-storage-main:folder:folder-fixed'])

  const ownerGrant = await encryptFolderKeyForRequest('folder-secret', requestKey.publicKey)
  await actions.handleFolderAccessGrant({
    type: 'folder-access-grant',
    from: 'node-owner',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:03.000Z',
    clock: 3,
    folderId: 'folder-fixed',
    folderName: 'Fixed invite',
    targetNodeId: 'node-b',
    requestId: 'request-a',
    cid: 'cid-owner',
    accessGrantPublicKey: ownerGrant.publicKey,
    accessGrantIv: ownerGrant.iv,
    accessGrantCipherText: ownerGrant.cipherText,
  })

  assert.equal(folderKeys['folder-fixed'], 'folder-secret')
  assert.equal(importKeys['cid-owner'], 'folder-secret')
  assert.equal(pendingShares[0]?.cid, 'cid-owner')
  assert.deepEqual(accessRequestKeysRef.current, {})
})

test('folder access denied clears the waiting fixed invite on the requester', () => {
  let pendingShares: PendingShare[] = [{
    type: 'folder-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 0,
    folderId: 'folder-fixed',
    folderName: 'Fixed invite',
    ownerNodeId: 'node-owner',
    autoImport: true,
  }]
  const pendingSharesRef = { current: pendingShares }
  const accessRequestKeysRef = {
    current: {
      'request-a': {
        privateKey: {} as CryptoKey,
        publicKey: 'public-a',
        folderId: 'folder-fixed',
        ownerNodeId: 'node-owner',
        roomId: 'tc-storage-main',
        requestId: 'request-a',
      },
      'tc-storage-main:folder:folder-fixed': {
        privateKey: {} as CryptoKey,
        publicKey: 'public-a',
        folderId: 'folder-fixed',
        ownerNodeId: 'node-owner',
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
    settingsRef: { current: settingsStub('node-b') },
    snapshotRef: { current: createInitialSnapshot('node-b') },
  })

  actions.handleFolderAccessDenied({
    type: 'folder-access-denied',
    from: 'node-attacker',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: 'folder-fixed',
    folderName: 'Fixed invite',
    targetNodeId: 'node-b',
    requestId: 'request-a',
  })

  assert.equal(pendingShares.length, 1)
  assert.deepEqual(Object.keys(accessRequestKeysRef.current).sort(), ['request-a', 'tc-storage-main:folder:folder-fixed'])

  actions.handleFolderAccessDenied({
    type: 'folder-access-denied',
    from: 'node-owner',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:03.000Z',
    clock: 3,
    folderId: 'folder-fixed',
    folderName: 'Fixed invite',
    targetNodeId: 'node-b',
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
