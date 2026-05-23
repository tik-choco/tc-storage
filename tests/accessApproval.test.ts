import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PendingShare } from '../src/appTypes.js'
import { createEnvelopeActions } from '../src/appEnvelopeActions.js'
import { createInitialSnapshot } from '../src/domain.js'
import { applyStateUpdate, fixedFolderId, folderSecret } from './accessApprovalHelpers.js'

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
