import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PendingShare } from '../src/appTypes.js'
import { createAccessActions, type RequestKeyEntry } from '../src/appAccessActions.js'
import { createEnvelopeActions } from '../src/appEnvelopeActions.js'
import { createInitialSnapshot } from '../src/domain.js'
import type { NetworkState } from '../src/p2p.js'

type StateUpdate<T> = T | ((current: T) => T)

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
    autoImport: true,
  }]
  const pendingSharesRef = { current: pendingShares }
  const accessRequestKeysRef = {
    current: {
      'request-a': {
        privateKey: {} as CryptoKey,
        publicKey: 'public-a',
        folderId: 'folder-fixed',
        roomId: 'tc-storage-main',
        requestId: 'request-a',
      },
      'tc-storage-main:folder:folder-fixed': {
        privateKey: {} as CryptoKey,
        publicKey: 'public-a',
        folderId: 'folder-fixed',
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
    from: 'node-a',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
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

function networkStub() {
  const state: NetworkState = {
    mode: 'mistlib',
    peers: [],
    stablePeers: [],
    lastEvent: '',
    messagesSent: 0,
    messagesReceived: 0,
  }
  return { state, connect: async () => {}, disconnect: () => {}, broadcastShare: () => {} }
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
