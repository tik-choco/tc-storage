import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PendingShare } from '../src/app/appTypes.js'
import { createEnvelopeActions } from '../src/app/appEnvelopeActions.js'
import { createInitialSnapshot } from '../src/storage/domain.js'
import { applyStateUpdate, fixedFolderId, folderSecret } from './accessApprovalHelpers.js'

test('folder-state does not use a linked invite from another room with the same folder id', async () => {
  const pendingShares: PendingShare[] = [{
    type: 'folder-share',
    from: 'share-url',
    roomId: 'room-a',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 0,
    cid: 'cid-a',
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    autoImport: true,
  }]
  const snapshotRef = { current: createInitialSnapshot('node-b') }
  let imported = false
  const actions = createEnvelopeActions({
    announceSharedFolders: () => {},
    autoImportCidsRef: { current: new Set<string>() },
    autoImportFolderShare: async () => {},
    autoImportInFlightRef: { current: new Set<string>() },
    autoImportLinkedShare: async () => { imported = true },
    currentFolderId: null,
    detailFileId: null,
    folderKeysRef: { current: {} },
    folderPanelFolderId: null,
    handleFileContentRepairRequest: () => {},
    handleFolderAccessDenied: () => {},
    handleFolderAccessGrant: async () => {},
    handleFolderAccessRequest: () => {},
    helloResponseAtRef: { current: {} },
    importKeysRef: { current: { 'cid-a': folderSecret } },
    pendingSharesRef: { current: pendingShares },
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
    setSnapshot: () => {},
    snapshotRef,
  })

  actions.handleEnvelope({
    type: 'folder-state',
    from: 'node-a',
    roomId: 'room-b',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    cid: 'cid-b',
    folderSignature: 'signature-b',
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(imported, false)
})

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
    handleFileContentRepairRequest: () => {},
    handleFolderAccessDenied: () => {},
    handleFolderAccessGrant: async () => {},
    handleFolderAccessRequest: () => {},
    helloResponseAtRef: { current: {} },
    importKeysRef: { current: {} },
    pendingSharesRef,
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
