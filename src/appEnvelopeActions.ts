import { pendingShareKey, type Notice, type PendingShare } from './appTypes.js'
import type { MutableRef, SetState } from './appControllerTypes.js'
import { descendantFolderIds } from './appHelpers.js'
import { envelopeLogDetails, folderLogDetails, shortLogValue, syncLog } from './appUtils.js'
import { mergeSnapshots, stampFilePatch, stampFolderPatch } from './crdt.js'
import { addActivity, stripFileContent, type FileRecord, type StorageSnapshot } from './domain.js'
import { canAutoImportFolderState, sharedFolderSignature, shouldDeferRemoteFolderStateImport } from './folderSync.js'
import type { ShareEnvelope } from './p2p.js'

interface EnvelopeOptions {
  autoImportCidsRef: MutableRef<Set<string>>
  autoImportFolderShare: (share: PendingShare, passphrase: string) => Promise<void>
  autoImportInFlightRef: MutableRef<Set<string>>
  autoImportLinkedShare: (share: PendingShare, passphrase: string) => Promise<void>
  announceSharedFolders: () => void
  folderKeysRef: MutableRef<Record<string, string>>
  folderPanelFolderId: string | null
  helloResponseAtRef: MutableRef<Record<string, number>>
  importKeysRef: MutableRef<Record<string, string>>
  pendingSharesRef: MutableRef<PendingShare[]>
  rememberFolderPeer: (envelope: Pick<ShareEnvelope, 'folderId' | 'from' | 'senderProfile' | 'sentAt'>) => void
  scheduleFolderSync: (folderId: string, reason: string) => void
  handleFileContentRepairRequest: (envelope: ShareEnvelope) => void
  handleFolderAccessDenied: (envelope: ShareEnvelope) => void
  handleFolderAccessGrant: (envelope: ShareEnvelope) => Promise<void>
  handleFolderAccessRequest: (envelope: ShareEnvelope) => void
  setCurrentFolderId: SetState<string | null>
  setDetailFileId: SetState<string | null>
  setExpandedPreviewOpen: SetState<boolean>
  setFolderKeys: SetState<Record<string, string>>
  setFolderPanelFolderId: SetState<string | null>
  setFolderPanelOpen: SetState<boolean>
  setNotice: SetState<Notice>
  setPendingShares: SetState<PendingShare[]>
  setSelectedFileId: SetState<string | null>
  setSnapshot: SetState<StorageSnapshot>
  snapshotRef: MutableRef<StorageSnapshot>
  currentFolderId: string | null
  detailFileId: string | null
  selectedFileId: string | null
}

export function createEnvelopeActions(options: EnvelopeOptions) {
  const {
    announceSharedFolders, autoImportCidsRef, autoImportFolderShare, autoImportInFlightRef, autoImportLinkedShare,
    currentFolderId, detailFileId, folderKeysRef, folderPanelFolderId, helloResponseAtRef,
    importKeysRef, pendingSharesRef, rememberFolderPeer, scheduleFolderSync,
    handleFileContentRepairRequest, handleFolderAccessDenied, handleFolderAccessGrant, handleFolderAccessRequest,
    selectedFileId, setCurrentFolderId, setDetailFileId, setExpandedPreviewOpen, setFolderKeys,
    setFolderPanelFolderId, setFolderPanelOpen, setNotice, setPendingShares, setSelectedFileId,
    setSnapshot, snapshotRef,
  } = options

  function handleEnvelope(envelope: ShareEnvelope) {
    syncLog('handle envelope', envelopeLogDetails(envelope))
    if (envelope.type === 'hello') {
      const now = Date.now()
      if ((helloResponseAtRef.current[envelope.from] ?? 0) + 2000 > now) {
        syncLog('hello ignored: response throttled', envelopeLogDetails(envelope))
        return
      }
      helloResponseAtRef.current[envelope.from] = now
      syncLog('hello accepted: announcing shared folders', envelopeLogDetails(envelope))
      announceSharedFolders()
      return
    }
    if (envelope.type === 'folder-state') {
      void receiveFolderState(envelope)
      return
    }
    if (envelope.type === 'folder-change') {
      receiveFolderChange(envelope)
      return
    }
    if (envelope.type === 'file-content-repair-request') {
      syncLog('received file content repair request', envelopeLogDetails(envelope))
      handleFileContentRepairRequest(envelope)
      return
    }
    if (envelope.type === 'folder-access-request') {
      handleFolderAccessRequest(envelope)
      return
    }
    if (envelope.type === 'folder-access-grant') {
      void handleFolderAccessGrant(envelope)
      return
    }
    if (envelope.type === 'folder-access-denied') {
      handleFolderAccessDenied(envelope)
      return
    }
    if ((envelope.type !== 'folder-share' && envelope.type !== 'file-share') || !envelope.cid) return
    const receivedAt = new Date().toISOString()
    const incomingShare: PendingShare = { ...envelope, receivedAt }
    const incomingKey = pendingShareKey(incomingShare)
    const matchesIncomingShare = (share: PendingShare) => (
      share.cid === envelope.cid ||
      pendingShareKey(share) === incomingKey ||
      (envelope.type === 'folder-share' && share.type === 'folder-share' && Boolean(envelope.folderId && share.folderId === envelope.folderId && share.roomId === envelope.roomId))
    )
    const existingShare = pendingSharesRef.current.find(matchesIncomingShare)
    if (
      envelope.type === 'folder-share' &&
      envelope.folderId &&
      existingShare?.autoImport &&
      folderKeysRef.current[envelope.folderId] &&
      !snapshotRef.current.folders.some((folder) => folder.id === envelope.folderId && !folder.deletedAt) &&
      !autoImportCidsRef.current.has(envelope.cid) &&
      !autoImportInFlightRef.current.has(envelope.cid)
    ) {
      void autoImportLinkedShare({ ...incomingShare, autoImport: true }, folderKeysRef.current[envelope.folderId])
    }
    setPendingShares((current) => {
      const existing = current.find(matchesIncomingShare)
      return [{ ...incomingShare, autoImport: existing?.autoImport }, ...current.filter((share) => !matchesIncomingShare(share))].slice(0, 12)
    })
  }

  async function receiveFolderState(envelope: ShareEnvelope) {
    syncLog('received folder-state', envelopeLogDetails(envelope))
    if (!envelope.folderId || !envelope.cid) {
      syncLog('folder-state skipped: missing folderId or cid', envelopeLogDetails(envelope))
      return
    }
    const snapshotValue = snapshotRef.current
    const folder = snapshotValue.folders.find((item) => item.id === envelope.folderId)
    const linkedShare = pendingSharesRef.current.find((share) => (
      share.autoImport &&
      (share.cid === envelope.cid || Boolean(envelope.folderId && share.folderId === envelope.folderId))
    ))
    const linkedPassphrase = linkedShare?.cid ? importKeysRef.current[linkedShare.cid]?.trim() ?? '' : ''
    const passphrase = folderKeysRef.current[envelope.folderId] || (linkedShare ? linkedPassphrase : '')
    const localSignature = sharedFolderSignature(snapshotValue, envelope.folderId)
    if (!folder) {
      if (passphrase && linkedShare && !autoImportCidsRef.current.has(envelope.cid) && !autoImportInFlightRef.current.has(envelope.cid)) {
        syncLog('folder-state accepted for linked share without local folder: storage_get will start', envelopeLogDetails(envelope))
        await autoImportLinkedShare({ ...linkedShare, ...envelope, autoImport: true, type: 'folder-share', receivedAt: new Date().toISOString() }, passphrase)
        return
      }
      syncLog('folder-state skipped: local folder not found and no linked key is available', envelopeLogDetails(envelope))
      return
    }
    if (!passphrase) return syncLog('folder-state skipped: folder key missing', envelopeLogDetails(envelope))
    rememberFolderPeer(envelope)
    if (shouldDeferRemoteFolderStateImport({ folder, snapshot: snapshotValue })) {
      const reason = envelope.cid === folder.lastCid
        ? 'remote has current cid but local changes exist'
        : 'local changes pending before remote folder-state import'
      syncLog('folder-state deferred: scheduling local storage_add before import', { ...folderLogDetails(folder), incomingCid: shortLogValue(envelope.cid), reason })
      scheduleFolderSync(folder.id, reason)
      return
    }
    if (folder.lastCid === envelope.cid) return syncLog('folder-state skipped: cid already current', { ...envelopeLogDetails(envelope), localCid: shortLogValue(folder.lastCid) })
    if (!envelope.folderSignature) return syncLog('folder-state skipped: remote signature missing', envelopeLogDetails(envelope))
    if (envelope.folderSignature === localSignature) return syncLog('folder-state skipped: signatures match', { ...envelopeLogDetails(envelope), signatureLength: localSignature.length })
    if (!canAutoImportFolderState({ folder, incomingCid: envelope.cid, incomingSignature: envelope.folderSignature, localSignature, passphrase })) return syncLog('folder-state skipped: auto-import guard rejected', envelopeLogDetails(envelope))
    if (autoImportCidsRef.current.has(envelope.cid)) return syncLog('folder-state skipped: cid already imported', envelopeLogDetails(envelope))
    if (autoImportInFlightRef.current.has(envelope.cid)) return syncLog('folder-state skipped: storage_get already in flight', envelopeLogDetails(envelope))
    syncLog('folder-state accepted: storage_get will start', { ...envelopeLogDetails(envelope), localCid: shortLogValue(folder.lastCid), localSignatureLength: localSignature.length, remoteSignatureLength: envelope.folderSignature.length })
    await autoImportFolderShare({ ...envelope, type: 'folder-share', receivedAt: new Date().toISOString() }, passphrase)
  }

  function receiveFolderChange(envelope: ShareEnvelope) {
    syncLog('received folder-change', envelopeLogDetails(envelope))
    if (!envelope.folderId || !envelope.changeType) return syncLog('folder-change skipped: missing folderId or changeType', envelopeLogDetails(envelope))
    const folder = snapshotRef.current.folders.find((item) => item.id === envelope.folderId)
    const folderName = envelope.folderName || folder?.name || '共有フォルダー'
    const changedFolderName = envelope.folder?.name || folderName
    const fileName = envelope.fileName || envelope.file?.name || 'ファイル'
    if (folder) rememberFolderPeer(envelope)
    if (envelope.changeType === 'file-upserted') {
      applyRemoteFileUpsert(envelope)
      setNotice({ tone: 'info', text: `${folderName}: ${fileName} が追加/更新されました。同期中...` })
      return
    }
    if (envelope.changeType === 'file-deleted') {
      applyRemoteFileDelete(envelope)
      setNotice({ tone: 'info', text: `${folderName}: ${fileName} が削除されました。同期中...` })
      return
    }
    if (envelope.changeType === 'folder-upserted') {
      applyRemoteFolderUpsert(envelope)
      setNotice({ tone: 'info', text: `${folderName}: ${changedFolderName} が追加/更新されました。同期中...` })
      return
    }
    if (envelope.changeType === 'folder-deleted') {
      applyRemoteFolderDelete(envelope)
      setNotice({ tone: 'info', text: `${folderName}: ${changedFolderName} が削除されました。同期中...` })
    }
  }

  function applyRemoteFileUpsert(envelope: ShareEnvelope) {
    if (!envelope.folderId || !envelope.file) return syncLog('folder-change upsert skipped: missing file metadata', envelopeLogDetails(envelope))
    const snapshotValue = snapshotRef.current
    if (!snapshotValue.folders.some((item) => item.id === envelope.folderId && !item.deletedAt)) return syncLog('folder-change upsert skipped: local folder not found', envelopeLogDetails(envelope))
    const file = stripFileContent({ ...envelope.file, folderId: envelope.file.folderId || envelope.folderId })
    setSnapshot((current) => addActivity(mergeSnapshots(current, remoteSnapshot(envelope, [file], [])), { actorNodeId: envelope.from, folderId: envelope.folderId, fileId: file.id, action: 'file.remote-upsert', detail: `${file.name} がリモートで追加/更新` }, envelope.sentAt))
  }

  function applyRemoteFileDelete(envelope: ShareEnvelope) {
    if (!envelope.folderId) return
    const snapshotValue = snapshotRef.current
    const existing = envelope.fileId ? snapshotValue.files.find((item) => item.id === envelope.fileId) : undefined
    const file = envelope.file
      ? stripFileContent({ ...envelope.file, folderId: envelope.file.folderId || envelope.folderId, deletedAt: envelope.file.deletedAt ?? envelope.sentAt })
      : existing
        ? stripFileContent(stampFilePatch(existing, { deletedAt: envelope.sentAt }, envelope.sentAt, envelope.from))
        : undefined
    if (!file) return syncLog('folder-change delete skipped: local file not found', envelopeLogDetails(envelope))
    setSnapshot((current) => addActivity(mergeSnapshots(current, remoteSnapshot(envelope, [file], [])), { actorNodeId: envelope.from, folderId: envelope.folderId, fileId: file.id, action: 'file.remote-delete', detail: `${file.name} がリモートで削除` }, envelope.sentAt))
    if (selectedFileId === file.id) {
      setSelectedFileId(null)
      setExpandedPreviewOpen(false)
    }
    if (detailFileId === file.id) setDetailFileId(null)
  }

  function applyRemoteFolderUpsert(envelope: ShareEnvelope) {
    if (!envelope.folderId || !envelope.folder) return syncLog('folder-change folder upsert skipped: missing folder metadata', envelopeLogDetails(envelope))
    const snapshotValue = snapshotRef.current
    if (!snapshotValue.folders.some((item) => item.id === envelope.folderId && !item.deletedAt)) return syncLog('folder-change folder upsert skipped: local shared root not found', envelopeLogDetails(envelope))
    const folder = envelope.folder
    setSnapshot((current) => addActivity(mergeSnapshots(current, remoteSnapshot(envelope, [], [folder])), { actorNodeId: envelope.from, folderId: folder.id, action: 'folder.remote-upsert', detail: `${folder.name} がリモートで追加/更新` }, envelope.sentAt))
    setFolderKeys((current) => {
      if (current[folder.id] || !current[envelope.folderId ?? '']) return current
      return { ...current, [folder.id]: current[envelope.folderId ?? ''] }
    })
  }

  function applyRemoteFolderDelete(envelope: ShareEnvelope) {
    if (!envelope.folderId) return
    const snapshotValue = snapshotRef.current
    const targetFolderId = envelope.folder?.id ?? envelope.folderId
    const folder = snapshotValue.folders.find((item) => item.id === targetFolderId)
    if (!folder) return syncLog('folder-change folder delete skipped: local folder not found', envelopeLogDetails(envelope))
    const deletedIds = descendantFolderIds(snapshotValue.folders, folder.id)
    const deletedAt = envelope.folder?.deletedAt ?? envelope.sentAt
    setSnapshot((current) => {
      const currentDeletedIds = descendantFolderIds(current.folders, folder.id)
      const foldersNext = current.folders.map((item) => (currentDeletedIds.has(item.id) ? stampFolderPatch(item, { deletedAt }, deletedAt, envelope.from) : item))
      const filesNext = current.files.map((item) => (currentDeletedIds.has(item.folderId) ? stampFilePatch(item, { deletedAt }, deletedAt, envelope.from) : item))
      return addActivity({ ...current, folders: foldersNext, files: filesNext, clock: Math.max(current.clock, envelope.clock) + 1, originNode: current.originNode }, { actorNodeId: envelope.from, folderId: folder.id, action: 'folder.remote-delete', detail: `${folder.name} がリモートで削除` }, envelope.sentAt)
    })
    if (currentFolderId && deletedIds.has(currentFolderId)) setCurrentFolderId(folder.parentId)
    if (selectedFileId && snapshotValue.files.some((item) => item.id === selectedFileId && deletedIds.has(item.folderId))) {
      setSelectedFileId(null)
      setExpandedPreviewOpen(false)
    }
    if (detailFileId && snapshotValue.files.some((item) => item.id === detailFileId && deletedIds.has(item.folderId))) setDetailFileId(null)
    if (folderPanelFolderId && deletedIds.has(folderPanelFolderId)) setFolderPanelFolderId(null)
    setFolderPanelOpen(false)
  }

  function remoteSnapshot(envelope: ShareEnvelope, files: FileRecord[], folders: StorageSnapshot['folders']): StorageSnapshot {
    return { folders, files, activity: [], clock: envelope.clock, originNode: envelope.from }
  }

  return { handleEnvelope }
}
