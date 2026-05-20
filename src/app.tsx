import { useCallback, useMemo, useRef, useState } from 'preact/hooks'
import { descendantFolderIds, filterByName, mergeUploadedFiles, nextFolderName, remoteFileSnapshot, remoteFolderSnapshot } from './appHelpers.js'
import type { BrowserDragItem, BrowserReorderTarget, BrowserViewMode, DeleteRequest, Notice, PendingShare } from './appTypes.js'
import { BrowserPanel } from './components/BrowserPanel.js'
import { DeleteConfirmPanel } from './components/DeleteConfirmPanel.js'
import { FolderPanel } from './components/DetailPanel.js'
import { DraggablePopover, initialPopoverPosition, popoverPositionFromAnchor, type PopoverKind, type PopoverPosition } from './components/FloatingPopover.js'
import { ExpandedPreview, FileDetailPanel } from './components/Preview.js'
import { ProfilePanel, SettingsPanel } from './components/SettingsPanels.js'
import { Sidebar } from './components/Sidebar.js'
import { TopSummary } from './components/TopSummary.js'
import { copyToClipboard, reserveClipboardWrite, writeReservedClipboard } from './clipboard.js'
import { mergeSnapshots, stampFilePatch, stampFolderPatch } from './crdt.js'
import { activeFiles, activeFolders, addActivity, childFolders, compareFilesForDisplay, compareFoldersForDisplay, filesInFolder, makeFolder, stripFileContent, touchSnapshot, type FileRecord, type FolderBundle, type FolderRecord, type StorageSnapshot } from './domain.js'
import { hasBrowserDragItem, hasExternalFiles, readBrowserDragItem, writeBrowserDragItem } from './dragDrop.js'
import { describeError } from './errors.js'
import { downloadFile, readBrowserFile } from './fileIO.js'
import { generateFileShareKey, loadFileShareKeys } from './fileShareKeys.js'
import { loadFolderSyncPeers, type FolderSyncPeers } from './folderPeers.js'
import { readFolderRoute } from './folderRoute.js'
import { canAutoImportFolderState, folderFilesForSync, foldersForSync, hasSharedFolderChangesSinceLastShare, sharedFolderSignature } from './folderSync.js'
import { generateFolderKey, loadFolderKeys } from './folderKeys.js'
import { loadSettings, type AppSettings } from './localSettings.js'
import { loadStoredSnapshot } from './localSnapshot.js'
import { loadEncryptedFileFromMist, loadEncryptedFolderFromMist, saveEncryptedFileToMist, saveEncryptedFolderToMist } from './mistStorage.js'
import { useMistShare, type ShareEnvelope, type ShareProfile } from './p2p.js'
import { loadImportKeys, loadPendingShares } from './pendingShares.js'
import { makeFileShareUrl, makeFolderShareUrl, type LinkedShare } from './shareLinks.js'
import { activeAncestorFolderId, browserViewModeKey, canPreloadThumbnail, envelopeLogDetails, folderColors, folderKeyUpdatesForBundle, folderLogDetails, loadBrowserViewMode, nearestSharedAncestorFolder, shareLogDetails, shortLogValue, syncLog, syncWarn, withoutRecordKey } from './appUtils.js'
import { useAppEffects } from './useAppEffects.js'
import { useProfileAvatarPicker } from './useProfileAvatarPicker.js'
import { useTransferProgress } from './useTransferProgress.js'

export function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings())
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(settings)
  const [snapshot, setSnapshot] = useState<StorageSnapshot>(() => loadStoredSnapshot(settings.nodeId))
  const [folderKeys, setFolderKeys] = useState<Record<string, string>>(() => loadFolderKeys())
  const [fileShareKeys, setFileShareKeys] = useState<Record<string, string>>(() => loadFileShareKeys())
  const [folderPeers, setFolderPeers] = useState<FolderSyncPeers>(() => loadFolderSyncPeers())
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(() => readFolderRoute())
  const [query, setQuery] = useState('')
  const [folderNameDraft, setFolderNameDraft] = useState<string | null>(null)
  const [importKeys, setImportKeys] = useState<Record<string, string>>(() => loadImportKeys())
  const [browserViewMode, setBrowserViewMode] = useState<BrowserViewMode>(() => loadBrowserViewMode())
  const [pendingShares, setPendingShares] = useState<PendingShare[]>(() => loadPendingShares())
  const [fileContentCache, setFileContentCache] = useState<Record<string, string>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [folderPanelOpen, setFolderPanelOpen] = useState(false)
  const [folderPanelFolderId, setFolderPanelFolderId] = useState<string | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [detailFileId, setDetailFileId] = useState<string | null>(null)
  const [expandedPreviewOpen, setExpandedPreviewOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [dragItem, setDragItem] = useState<BrowserDragItem | null>(null)
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null | undefined>(undefined)
  const [reorderTarget, setReorderTarget] = useState<BrowserReorderTarget | null>(null)
  const [notice, setNotice] = useState<Notice>({ tone: 'info', text: '' })
  const [busy, setBusy] = useState('')
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null)
  const [popoverPositions, setPopoverPositions] = useState<Record<PopoverKind, PopoverPosition>>(() => ({
    profile: initialPopoverPosition('profile'),
    settings: initialPopoverPosition('settings'),
    detail: initialPopoverPosition('detail'),
    folder: initialPopoverPosition('folder'),
    confirm: initialPopoverPosition('confirm'),
  }))
  const {
    downloadProgress,
    failDownloadProgress,
    failFileLoadProgress,
    fileLoadProgress,
    finishDownloadProgress,
    finishFileLoadProgress,
    startDownloadProgress,
    startFileLoadProgress,
    updateDownloadProgress,
  } = useTransferProgress()

  const folders = useMemo(() => activeFolders(snapshot), [snapshot])
  const files = useMemo(() => activeFiles(snapshot), [snapshot])
  const currentFolder = folders.find((folder) => folder.id === currentFolderId) ?? null
  const folderPanelFolder = (folderPanelFolderId ? folders.find((folder) => folder.id === folderPanelFolderId) : currentFolder) ?? null
  const selectedFile = files.find((file) => file.id === selectedFileId) ?? null, detailFile = files.find((file) => file.id === detailFileId) ?? null
  const detailFolder = detailFile ? folders.find((folder) => folder.id === detailFile.folderId) ?? null : null
  const fileDataUrls = useMemo(() => Object.fromEntries(files.flatMap((file) => {
    const dataUrl = file.dataUrl ?? fileContentCache[file.id]
    return dataUrl ? [[file.id, dataUrl]] : []
  })), [fileContentCache, files])
  const selectedPreviewFile = selectedFile ? { ...selectedFile, dataUrl: fileDataUrls[selectedFile.id] } : null
  const detailFileWithContent = detailFile ? { ...detailFile, dataUrl: fileDataUrls[detailFile.id] } : null
  const profileImageFiles = useMemo(() => files.filter((file) => file.mimeType.startsWith('image/')), [files])
  const folderRows = useMemo(() => filterByName(query.trim() ? folders : currentFolderId ? currentFolder ? childFolders(snapshot, currentFolder.id) : [] : childFolders(snapshot, null), query), [currentFolder, currentFolderId, folders, query, snapshot])
  const fileRows = useMemo(() => filterByName(query.trim() ? files : currentFolder ? filesInFolder(snapshot, currentFolder.id) : [], query), [currentFolder, files, query, snapshot])
  const pendingFolderShares = useMemo(() => {
    if (currentFolderId !== null) return []
    const folderShares = pendingShares.filter((share) => share.autoImport && share.type === 'folder-share')
    return query.trim() ? filterByName(folderShares.map((share) => ({ ...share, name: share.folderName ?? 'Shared folder' })), query) : folderShares
  }, [currentFolderId, pendingShares, query])
  const currentFolderKey = currentFolder ? folderKeys[currentFolder.id] ?? '' : ''
  const folderPanelKey = folderPanelFolder ? folderKeys[folderPanelFolder.id] ?? '' : ''
  const folderPanelPeers = folderPanelFolder ? folderPeers[folderPanelFolder.id] ?? [] : []
  const detailFolderPeers = detailFolder ? folderPeers[detailFolder.id] ?? [] : []
  const avatarUrl = settings.avatarFileId ? fileDataUrls[settings.avatarFileId] ?? '' : settings.avatarUrl
  const draftAvatarUrl = settingsDraft.avatarFileId ? fileDataUrls[settingsDraft.avatarFileId] ?? '' : settingsDraft.avatarUrl
  const shareProfile: ShareProfile = useMemo(() => ({ name: settings.profileName, avatarUrl: settings.avatarFileId ? undefined : settings.avatarUrl || undefined }), [settings.avatarFileId, settings.avatarUrl, settings.profileName])
  const folderShareUrl = folderPanelFolder?.lastCid && folderPanelKey ? makeFolderShareUrl(folderPanelFolder, settings.roomId, snapshot.clock, folderPanelFolder.lastCid, folderPanelKey, shareProfile) : ''
  const detailFileShareCid = detailFile?.lastShareCid ?? detailFile?.lastCid
  const fileShareUrl = detailFile && detailFileShareCid && detailFolder && fileShareKeys[detailFile.id] ? makeFileShareUrl(detailFile, detailFolder, settings.roomId, snapshot.clock, detailFileShareCid, fileShareKeys[detailFile.id], shareProfile) : ''
  const previewFiles = useMemo(() => (selectedFile ? filesInFolder(snapshot, selectedFile.folderId) : fileRows), [fileRows, selectedFile, snapshot])
  const selectedFileIndex = selectedFile ? previewFiles.findIndex((file) => file.id === selectedFile.id) : -1
  const network = useMistShare(settings, useCallback(handleEnvelope, []))
  const snapshotRef = useRef(snapshot)
  const folderKeysRef = useRef(folderKeys)
  const fileShareKeysRef = useRef(fileShareKeys)
  const fileContentCacheRef = useRef(fileContentCache)
  const importKeysRef = useRef(importKeys)
  const pendingSharesRef = useRef(pendingShares)
  const fileContentLoadsRef = useRef<Record<string, Promise<string>>>({})
  const settingsRef = useRef(settings)
  const networkRef = useRef(network)
  const syncSignaturesRef = useRef<Record<string, string>>({})
  const syncTimersRef = useRef<Record<string, number>>({})
  const syncInFlightRef = useRef<Set<string>>(new Set())
  const autoImportCidsRef = useRef<Set<string>>(new Set())
  const autoImportInFlightRef = useRef<Set<string>>(new Set())
  const helloResponseAtRef = useRef<Record<string, number>>({})
  const dragItemRef = useRef<BrowserDragItem | null>(null)
  const {
    openProfileAvatarImages,
    profileAvatarImages,
    selectProfileAvatarImage,
  } = useProfileAvatarPicker({
    canResolveFileContent,
    ensureFileContent,
    fileContentCacheRef,
    fileDataUrls,
    preloadFileContent,
    profileImageFiles,
    selectedAvatarFileId: settingsDraft.avatarFileId,
    setNotice,
    setSettingsDraft,
  })
  useAppEffects({
    acceptLinkedShare,
    announceSharedFolders,
    autoImportCidsRef,
    autoImportFolderShare,
    autoImportInFlightRef,
    autoImportLinkedShare,
    browserViewMode,
    browserViewModeKey,
    canResolveFileContent,
    clearFolderSyncTimer,
    currentFolder,
    currentFolderId,
    detailFileId,
    ensureFileContent,
    expandedPreviewOpen,
    fileContentCache,
    fileContentCacheRef,
    fileDataUrls,
    fileRows,
    fileShareKeys,
    fileShareKeysRef,
    files,
    folderKeys,
    folderKeysRef,
    folderPeers,
    folders,
    handlePreviewKey,
    importKeys,
    importKeysRef,
    isPendingShareAlreadyImported,
    markPendingShareImported,
    network,
    networkMode: network.state.mode,
    networkRef,
    peerCount: network.state.peers.length,
    pendingShares,
    pendingSharesRef,
    preloadFileContent,
    previewFiles,
    profileOpen,
    scheduleFolderSync,
    selectedFile,
    selectedFileId,
    selectedPreviewFile,
    selectFolder,
    setCurrentFolderId,
    setDetailFileId,
    setExpandedPreviewOpen,
    setFolderKeys,
    setFolderNameDraft,
    setNotice,
    setSelectedFileId,
    setSettings,
    setSettingsDraft,
    setSnapshot,
    settings,
    settingsOpen,
    settingsRef,
    snapshot,
    snapshotRef,
    syncSignaturesRef,
    syncTimersRef,
  })

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
    if ((envelope.type !== 'folder-share' && envelope.type !== 'file-share') || !envelope.cid) return
    setPendingShares((current) => {
      const existing = current.find((share) => share.cid === envelope.cid)
      return [{ ...envelope, autoImport: existing?.autoImport, receivedAt: new Date().toISOString() }, ...current.filter((share) => share.cid !== envelope.cid)].slice(0, 12)
    })
  }

  function rememberFolderPeer(envelope: Pick<ShareEnvelope, 'folderId' | 'from' | 'senderProfile' | 'sentAt'>) {
    if (!envelope.folderId || envelope.from === settingsRef.current.nodeId) return
    setFolderPeers((current) => {
      const peers = current[envelope.folderId ?? ''] ?? []
      const peer = {
        nodeId: envelope.from,
        profile: envelope.senderProfile,
        lastSeenAt: envelope.sentAt || new Date().toISOString(),
      }
      const nextPeers = [peer, ...peers.filter((item) => item.nodeId !== envelope.from)]
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
        .slice(0, 16)
      return { ...current, [envelope.folderId ?? '']: nextPeers }
    })
  }

  function announceSharedFolders() {
    const snapshotValue = snapshotRef.current
    const folderKeysValue = folderKeysRef.current
    syncLog('announce shared folders tick', {
      sharedFolderCount: snapshotValue.folders.filter((folder) => folder.shareEnabled && folderKeysValue[folder.id]).length,
      roomId: settingsRef.current.roomId,
    })
    for (const folder of snapshotValue.folders) {
      if (!folder.shareEnabled || !folderKeysValue[folder.id]) continue
      if (!folder.lastCid || hasSharedFolderChangesSinceLastShare(snapshotValue, folder)) {
        syncLog('announce found local changes: scheduling storage_add', folderLogDetails(folder))
        scheduleFolderSync(folder.id, 'announce found local changes')
        continue
      }
      syncLog('sending folder-state cid over send_message', { ...folderLogDetails(folder), signatureLength: sharedFolderSignature(snapshotValue, folder.id).length })
      networkRef.current.broadcastShare({ type: 'folder-state', clock: snapshotValue.clock, folderId: folder.id, folderName: folder.name, cid: folder.lastCid, folderSignature: sharedFolderSignature(snapshotValue, folder.id) })
    }
  }

  function announceFolderChange(folder: FolderRecord, changeType: NonNullable<ShareEnvelope['changeType']>, file?: FileRecord, changedFolder?: FolderRecord) {
    if (!folder.shareEnabled || !folderKeysRef.current[folder.id]) return
    syncLog('sending folder-change over send_message', { ...folderLogDetails(folder), changeType, changedFolderId: changedFolder?.id, changedFolderName: changedFolder?.name, fileId: file?.id, fileName: file?.name, fileCid: shortLogValue(file?.lastCid) })
    networkRef.current.broadcastShare({
      type: 'folder-change',
      clock: snapshotRef.current.clock + 1,
      changeType,
      folderId: folder.id,
      folderName: folder.name,
      folder: changedFolder,
      fileId: file?.id,
      fileName: file?.name,
      file: file ? stripFileContent(file) : undefined,
      cid: file?.lastCid,
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
    if (folder && envelope.cid === folder.lastCid && hasSharedFolderChangesSinceLastShare(snapshotValue, folder)) {
      syncLog('folder-state matches local cid but local changes exist: scheduling storage_add', folderLogDetails(folder))
      scheduleFolderSync(folder.id, 'remote has current cid but local changes exist')
      return
    }
    if (!folder) {
      if (passphrase && linkedShare && !autoImportCidsRef.current.has(envelope.cid) && !autoImportInFlightRef.current.has(envelope.cid)) {
        syncLog('folder-state accepted for linked share without local folder: storage_get will start', envelopeLogDetails(envelope))
        await autoImportLinkedShare({ ...linkedShare, ...envelope, autoImport: true, type: 'folder-share', receivedAt: new Date().toISOString() }, passphrase)
        return
      }
      syncLog('folder-state skipped: local folder not found and no linked key is available', envelopeLogDetails(envelope))
      return
    }
    if (!passphrase) {
      syncLog('folder-state skipped: folder key missing', envelopeLogDetails(envelope))
      return
    }
    rememberFolderPeer(envelope)
    if (folder.lastCid === envelope.cid) {
      syncLog('folder-state skipped: cid already current', { ...envelopeLogDetails(envelope), localCid: shortLogValue(folder.lastCid) })
      return
    }
    if (!envelope.folderSignature) {
      syncLog('folder-state skipped: remote signature missing', envelopeLogDetails(envelope))
      return
    }
    if (envelope.folderSignature === localSignature) {
      syncLog('folder-state skipped: signatures match', { ...envelopeLogDetails(envelope), signatureLength: localSignature.length })
      return
    }
    if (!canAutoImportFolderState({ folder, incomingCid: envelope.cid, incomingSignature: envelope.folderSignature, localSignature, passphrase })) {
      syncLog('folder-state skipped: auto-import guard rejected', envelopeLogDetails(envelope))
      return
    }
    if (autoImportCidsRef.current.has(envelope.cid)) {
      syncLog('folder-state skipped: cid already imported', envelopeLogDetails(envelope))
      return
    }
    if (autoImportInFlightRef.current.has(envelope.cid)) {
      syncLog('folder-state skipped: storage_get already in flight', envelopeLogDetails(envelope))
      return
    }
    syncLog('folder-state accepted: storage_get will start', { ...envelopeLogDetails(envelope), localCid: shortLogValue(folder.lastCid), localSignatureLength: localSignature.length, remoteSignatureLength: envelope.folderSignature.length })
    await autoImportFolderShare({ ...envelope, type: 'folder-share', receivedAt: new Date().toISOString() }, passphrase)
  }

  function receiveFolderChange(envelope: ShareEnvelope) {
    syncLog('received folder-change', envelopeLogDetails(envelope))
    if (!envelope.folderId || !envelope.changeType) {
      syncLog('folder-change skipped: missing folderId or changeType', envelopeLogDetails(envelope))
      return
    }
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
    if (!envelope.folderId || !envelope.file) {
      syncLog('folder-change upsert skipped: missing file metadata', envelopeLogDetails(envelope))
      return
    }
    const snapshotValue = snapshotRef.current
    if (!snapshotValue.folders.some((item) => item.id === envelope.folderId && !item.deletedAt)) {
      syncLog('folder-change upsert skipped: local folder not found', envelopeLogDetails(envelope))
      return
    }
    const file = stripFileContent({ ...envelope.file, folderId: envelope.file.folderId || envelope.folderId })
    setSnapshot((current) => {
      const remoteSnapshot: StorageSnapshot = {
        folders: [],
        files: [file],
        activity: [],
        clock: envelope.clock,
        originNode: envelope.from,
      }
      return addActivity(
        mergeSnapshots(current, remoteSnapshot),
        { actorNodeId: envelope.from, folderId: envelope.folderId, fileId: file.id, action: 'file.remote-upsert', detail: `${file.name} がリモートで追加/更新` },
        envelope.sentAt,
      )
    })
    if (canPreloadThumbnail(file)) preloadFileContent(file)
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
    if (!file) {
      syncLog('folder-change delete skipped: local file not found', envelopeLogDetails(envelope))
      return
    }
    setSnapshot((current) => {
      const remoteSnapshot: StorageSnapshot = {
        folders: [],
        files: [file],
        activity: [],
        clock: envelope.clock,
        originNode: envelope.from,
      }
      return addActivity(
        mergeSnapshots(current, remoteSnapshot),
        { actorNodeId: envelope.from, folderId: envelope.folderId, fileId: file.id, action: 'file.remote-delete', detail: `${file.name} がリモートで削除` },
        envelope.sentAt,
      )
    })
    if (selectedFileId === file.id) {
      setSelectedFileId(null)
      setExpandedPreviewOpen(false)
    }
    if (detailFileId === file.id) setDetailFileId(null)
  }

  function applyRemoteFolderUpsert(envelope: ShareEnvelope) {
    if (!envelope.folderId || !envelope.folder) {
      syncLog('folder-change folder upsert skipped: missing folder metadata', envelopeLogDetails(envelope))
      return
    }
    const snapshotValue = snapshotRef.current
    if (!snapshotValue.folders.some((item) => item.id === envelope.folderId && !item.deletedAt)) {
      syncLog('folder-change folder upsert skipped: local shared root not found', envelopeLogDetails(envelope))
      return
    }
    const folder = envelope.folder
    setSnapshot((current) => {
      const remoteSnapshot: StorageSnapshot = {
        folders: [folder],
        files: [],
        activity: [],
        clock: envelope.clock,
        originNode: envelope.from,
      }
      return addActivity(
        mergeSnapshots(current, remoteSnapshot),
        { actorNodeId: envelope.from, folderId: folder.id, action: 'folder.remote-upsert', detail: `${folder.name} がリモートで追加/更新` },
        envelope.sentAt,
      )
    })
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
    if (!folder) {
      syncLog('folder-change folder delete skipped: local folder not found', envelopeLogDetails(envelope))
      return
    }
    const deletedIds = descendantFolderIds(snapshotValue.folders, folder.id)
    setSnapshot((current) => {
      const currentDeletedIds = descendantFolderIds(current.folders, folder.id)
      const foldersNext = current.folders.map((item) => (currentDeletedIds.has(item.id) ? stampFolderPatch(item, { deletedAt: envelope.sentAt }, envelope.sentAt, envelope.from) : item))
      const filesNext = current.files.map((item) => (currentDeletedIds.has(item.folderId) ? stampFilePatch(item, { deletedAt: envelope.sentAt }, envelope.sentAt, envelope.from) : item))
      return addActivity(
        { ...current, folders: foldersNext, files: filesNext, clock: Math.max(current.clock, envelope.clock) + 1, originNode: current.originNode },
        { actorNodeId: envelope.from, folderId: folder.id, action: 'folder.remote-delete', detail: `${folder.name} がリモートで削除` },
        envelope.sentAt,
      )
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

  function clearFolderSyncTimer(folderId: string) {
    const timer = syncTimersRef.current[folderId]
    if (timer !== undefined) window.clearTimeout(timer)
    delete syncTimersRef.current[folderId]
  }

  function scheduleFolderSync(folderId: string, reason: string) {
    clearFolderSyncTimer(folderId)
    syncLog('scheduled folder storage_add', { folderId, reason, delayMs: 900 })
    syncTimersRef.current[folderId] = window.setTimeout(() => {
      delete syncTimersRef.current[folderId]
      void publishSharedFolder(folderId)
    }, 900)
  }

  async function publishSharedFolder(folderId: string) {
    if (syncInFlightRef.current.has(folderId)) {
      syncLog('storage_add skipped: publish already in flight', { folderId })
      return
    }
    const snapshotValue = snapshotRef.current
    const settingsValue = settingsRef.current
    const folder = snapshotValue.folders.find((item) => item.id === folderId)
    const passphrase = folderKeysRef.current[folderId]
    if (!folder?.shareEnabled || !passphrase) {
      syncLog('storage_add skipped: folder not shareable or key missing', { folderId, hasFolder: Boolean(folder), shareEnabled: folder?.shareEnabled, hasPassphrase: Boolean(passphrase) })
      return
    }
    syncInFlightRef.current.add(folderId)
    try {
      const foldersForSave = foldersForSync(snapshotValue, folderId)
      const filesForSync = await ensureFolderFilesStored(folder, folderFilesForSync(snapshotValue, folderId), passphrase)
      syncLog('storage_add start for shared folder', { ...folderLogDetails(folder), folderCount: foldersForSave.length, fileCount: filesForSync.length })
      const cid = await saveEncryptedFolderToMist({ folder, folders: foldersForSave, files: filesForSync, passphrase, originNode: settingsValue.nodeId })
      syncLog('storage_add complete for shared folder', { ...folderLogDetails(folder), cid: shortLogValue(cid), folderCount: foldersForSave.length, fileCount: filesForSync.length })
      const now = new Date().toISOString()
      setSnapshot((current) => {
        const currentFolder = current.folders.find((item) => item.id === folderId)
        if (!currentFolder) return current
        const storedFilesById = new Map(filesForSync.map((file) => [file.id, stripFileContent(file)]))
        const foldersNext = current.folders.map((item) => (
          item.id === folderId
            ? stampFolderPatch(item, { lastCid: cid, lastSavedAt: now, lastSharedAt: now, shareEnabled: true, sharedRoomId: settingsValue.roomId }, now, settingsValue.nodeId)
            : item
        ))
        const filesNext = current.files.map((item) => storedFilesById.get(item.id) ?? item)
        const next = touchSnapshot(addActivity({ ...current, folders: foldersNext, files: filesNext }, { actorNodeId: settingsValue.nodeId, folderId, action: 'folder.sync', detail: `${currentFolder.name} を自動同期` }, now), settingsValue.nodeId)
        syncSignaturesRef.current[folderId] = sharedFolderSignature(next, folderId)
        return next
      })
      syncLog('broadcasting new folder-share cid over send_message', { ...folderLogDetails(folder), cid: shortLogValue(cid), clock: snapshotValue.clock + 1 })
      networkRef.current.broadcastShare({ clock: snapshotValue.clock + 1, folderId, folderName: folder.name, cid })
      setNotice({ tone: 'success', text: `${folder.name} を自動同期しました` })
    } catch (error) {
      syncWarn('storage_add failed for shared folder', { folderId, error: describeError(error, 'unknown error') })
      setNotice({ tone: 'error', text: describeError(error, `${folder.name} の自動同期に失敗しました`) })
    } finally {
      syncInFlightRef.current.delete(folderId)
    }
  }

  async function autoImportFolderShare(share: PendingShare, passphrase: string) {
    const cid = share.cid
    if (!cid) return
    autoImportInFlightRef.current.add(cid)
    try {
      syncLog('storage_get start for folder-share', shareLogDetails(share))
      const bundle = await materializeFolderBundleFiles(await loadEncryptedFolderFromMist(cid, passphrase), passphrase)
      syncLog('storage_get complete for folder-share', { ...shareLogDetails(share), folderId: bundle.folder.id, folderName: bundle.folder.name, fileCount: bundle.files.length })
      const remoteSnapshot = remoteFolderSnapshot(bundle, share)
      const now = new Date().toISOString()
      clearFolderSyncTimer(bundle.folder.id)
      setSnapshot((current) => {
        const merged = mergeSnapshots(current, remoteSnapshot)
        const next = addActivity(merged, { actorNodeId: settings.nodeId, folderId: bundle.folder.id, action: 'folder.sync', detail: `${bundle.folder.name} を自動同期` }, now)
        rememberImportedFolderSignature(bundle.folder.id, next, remoteSnapshot)
        return next
      })
      setFolderKeys((current) => ({ ...current, ...folderKeyUpdatesForBundle(bundle, passphrase) }))
      rememberFolderPeer(share)
      markPendingShareImported(share)
      setNotice({ tone: 'success', text: `${bundle.folder.name} を自動同期しました` })
    } catch (error) {
      syncWarn('storage_get failed for folder-share', { ...shareLogDetails(share), error: describeError(error, 'unknown error') })
      setNotice({ tone: 'error', text: describeError(error, '共有フォルダーの自動同期に失敗しました') })
    } finally {
      autoImportInFlightRef.current.delete(cid)
    }
  }

  async function autoImportLinkedShare(share: PendingShare, passphrase: string) {
    if (!share.cid) return
    autoImportInFlightRef.current.add(share.cid)
    try {
      syncLog('storage_get start for linked share', shareLogDetails(share))
      if (share.type === 'file-share') await importFileShare(share, passphrase)
      else await importFolderShare(share, passphrase)
      markPendingShareImported(share)
      syncLog('storage_get complete for linked share', shareLogDetails(share))
    } catch (error) {
      syncWarn('storage_get failed for linked share; keeping pending for retry', { ...shareLogDetails(share), error: describeError(error, 'unknown error') })
      setNotice({ tone: 'info', text: '共有データを待機中です。送り主がオンラインになったら自動的に再試行します' })
    } finally {
      autoImportInFlightRef.current.delete(share.cid)
    }
  }

  function isPendingShareAlreadyImported(share: PendingShare): boolean {
    if (!share.cid) return true
    const snapshotValue = snapshotRef.current
    if (share.type === 'folder-share') {
      const folder = share.folderId ? snapshotValue.folders.find((item) => item.id === share.folderId && !item.deletedAt) : undefined
      return folder?.lastCid === share.cid
    }
    const file = share.fileId ? snapshotValue.files.find((item) => item.id === share.fileId && !item.deletedAt) : undefined
    return Boolean(file && (file.lastShareCid === share.cid || file.lastCid === share.cid))
  }

  function markPendingShareImported(share: PendingShare): void {
    const cid = share.cid
    if (!cid) return
    autoImportCidsRef.current.add(cid)
    const pendingMatches = pendingSharesRef.current.filter((item) => pendingShareMatchesImported(item, share))
    setPendingShares((current) => current.filter((item) => !pendingShareMatchesImported(item, share)))
    setImportKeys((current) => {
      let next = withoutRecordKey(current, cid)
      for (const pending of pendingMatches) {
        if (pending.cid) next = withoutRecordKey(next, pending.cid)
      }
      return next
    })
  }

  function cancelPendingShare(share: PendingShare): void {
    const cid = share.cid
    if (!cid) return
    setPendingShares((current) => current.filter((item) => item.cid !== cid))
    setImportKeys((current) => withoutRecordKey(current, cid))
    setNotice({ tone: 'info', text: '共有待ちをキャンセルしました' })
  }

  function pendingShareMatchesImported(pending: PendingShare, imported: PendingShare): boolean {
    if (pending.cid && pending.cid === imported.cid) return true
    if (imported.type === 'folder-share' && pending.type === 'folder-share' && imported.folderId && pending.folderId === imported.folderId) return true
    if (imported.type === 'file-share' && pending.type === 'file-share' && imported.fileId && pending.fileId === imported.fileId) return true
    return false
  }

  async function ensureFolderFilesStored(folder: FolderRecord, filesForSave: FileRecord[], passphrase: string): Promise<FileRecord[]> {
    const storedFiles: FileRecord[] = []
    for (const file of filesForSave) {
      if (file.deletedAt || (file.lastCid && file.folderId === folder.id)) {
        storedFiles.push(file)
        continue
      }
      const fileWithContent = await ensureFileContent(file)
      syncLog('storage_add start for file content', { folderId: folder.id, fileFolderId: file.folderId, fileId: file.id, fileName: file.name })
      const cid = await saveEncryptedFileToMist({ folder, file: fileWithContent, passphrase, originNode: settingsRef.current.nodeId })
      syncLog('storage_add complete for file content', { folderId: folder.id, fileFolderId: file.folderId, fileId: file.id, fileName: file.name, cid: shortLogValue(cid) })
      storedFiles.push(stampFilePatch(fileWithContent, { lastCid: cid }, new Date().toISOString(), settingsRef.current.nodeId))
    }
    return storedFiles
  }

  async function materializeFolderBundleFiles(bundle: FolderBundle, passphrase: string): Promise<FolderBundle> {
    const cacheNext: Record<string, string> = {}
    const files: FileRecord[] = []
    for (const file of bundle.files) {
      if (file.dataUrl) cacheNext[file.id] = file.dataUrl
      if (file.deletedAt || file.lastCid || !file.dataUrl) {
        files.push(file)
        continue
      }
      syncLog('storage_add start for legacy folder file content', { folderId: bundle.folder.id, fileId: file.id, fileName: file.name })
      const cid = await saveEncryptedFileToMist({ folder: bundle.folder, file, passphrase, originNode: bundle.originNode })
      syncLog('storage_add complete for legacy folder file content', { folderId: bundle.folder.id, fileId: file.id, fileName: file.name, cid: shortLogValue(cid) })
      files.push(stampFilePatch(file, { lastCid: cid }, bundle.exportedAt, bundle.originNode))
    }
    if (Object.keys(cacheNext).length > 0) setFileContentCache((current) => ({ ...current, ...cacheNext }))
    return { ...bundle, files }
  }

  async function ensureFileContent(file: FileRecord, options: { trackProgress?: boolean } = {}): Promise<FileRecord> {
    const cached = file.dataUrl ?? fileContentCacheRef.current[file.id]
    if (cached) return { ...file, dataUrl: cached }
    const progressFileId = options.trackProgress ? startFileLoadProgress(file) : ''
    const loading = fileContentLoadsRef.current[file.id]
    try {
      if (loading) {
        const dataUrl = await loading
        if (progressFileId) finishFileLoadProgress(progressFileId)
        return { ...file, dataUrl }
      }

      const candidates: Array<{ cid: string; passphrase: string; source: string }> = []
      const folderPassphrase = folderKeysRef.current[file.folderId]
      const sharedRoot = nearestSharedAncestorFolder(snapshotRef.current, file.folderId)
      const sharedRootPassphrase = sharedRoot ? folderKeysRef.current[sharedRoot.id] : undefined
      if (file.lastCid && sharedRoot && sharedRootPassphrase) candidates.push({ cid: file.lastCid, passphrase: sharedRootPassphrase, source: sharedRoot.id === file.folderId ? 'folder' : 'shared-root' })
      if (file.lastCid && folderPassphrase && folderPassphrase !== sharedRootPassphrase) candidates.push({ cid: file.lastCid, passphrase: folderPassphrase, source: 'folder' })
      const filePassphrase = fileShareKeysRef.current[file.id]
      const shareCid = file.lastShareCid ?? file.lastCid
      if (shareCid && filePassphrase) candidates.push({ cid: shareCid, passphrase: filePassphrase, source: 'file-share' })
      const folder = snapshotRef.current.folders.find((item) => item.id === file.folderId)
      const folderBundleCandidate = sharedRoot?.lastCid && sharedRootPassphrase
        ? { cid: sharedRoot.lastCid, passphrase: sharedRootPassphrase }
        : folder?.lastCid && folderPassphrase
          ? { cid: folder.lastCid, passphrase: folderPassphrase }
          : undefined
      if (candidates.length === 0 && !folderBundleCandidate) throw new Error(`${file.name} のCIDまたは復号キーがありません`)

      const promise = candidates.length > 0
        ? loadFileContentFromCandidates(file, candidates).catch(async (error) => {
          if (!folderBundleCandidate) throw error
          syncWarn('file content candidates failed; trying parent folder bundle', { fileId: file.id, fileName: file.name, folderCid: shortLogValue(folderBundleCandidate.cid), error: describeError(error, 'unknown error') })
          return loadFileContentFromFolderBundle(file, folderBundleCandidate.cid, folderBundleCandidate.passphrase)
        })
        : loadFileContentFromFolderBundle(file, folderBundleCandidate!.cid, folderBundleCandidate!.passphrase)
      fileContentLoadsRef.current[file.id] = promise
      try {
        const dataUrl = await promise
        setFileContentCache((current) => ({ ...current, [file.id]: dataUrl }))
        if (progressFileId) finishFileLoadProgress(progressFileId)
        return { ...file, dataUrl }
      } finally {
        delete fileContentLoadsRef.current[file.id]
      }
    } catch (error) {
      if (progressFileId) failFileLoadProgress(progressFileId)
      throw error
    }
  }

  function preloadFileContent(file: FileRecord): void {
    if (file.dataUrl || fileContentCacheRef.current[file.id]) return
    if (!canResolveFileContent(file)) return
    syncLog('thumbnail preload requested', { fileId: file.id, fileName: file.name, cid: shortLogValue(file.lastCid), shareCid: shortLogValue(file.lastShareCid) })
    void ensureFileContent(file).then(() => {
      syncLog('thumbnail preload complete', { fileId: file.id, fileName: file.name })
    }).catch((error) => {
      syncWarn('thumbnail preload failed', { fileId: file.id, fileName: file.name, cid: shortLogValue(file.lastCid), shareCid: shortLogValue(file.lastShareCid), error: describeError(error, 'unknown error') })
    })
  }

  function canResolveFileContent(file: FileRecord): boolean {
    const folderPassphrase = folderKeysRef.current[file.folderId]
    const filePassphrase = fileShareKeysRef.current[file.id]
    const folder = snapshotRef.current.folders.find((item) => item.id === file.folderId)
    const sharedRoot = nearestSharedAncestorFolder(snapshotRef.current, file.folderId)
    const sharedRootPassphrase = sharedRoot ? folderKeysRef.current[sharedRoot.id] : undefined
    return Boolean(
      file.dataUrl ||
      fileContentCacheRef.current[file.id] ||
      (file.lastCid && folderPassphrase) ||
      (file.lastCid && sharedRootPassphrase) ||
      ((file.lastShareCid ?? file.lastCid) && filePassphrase) ||
      (folder?.lastCid && folderPassphrase) ||
      (sharedRoot?.lastCid && sharedRootPassphrase),
    )
  }

  async function loadFileContentFromCandidates(file: FileRecord, candidates: Array<{ cid: string; passphrase: string; source: string }>): Promise<string> {
    let lastError: unknown
    for (const candidate of candidates) {
      try {
        syncLog('storage_get start for file content', { fileId: file.id, fileName: file.name, cid: shortLogValue(candidate.cid), source: candidate.source })
        const bundle = await loadEncryptedFileFromMist(candidate.cid, candidate.passphrase)
        if (!bundle.file.dataUrl) throw new Error(`${file.name} の本文が共有データに含まれていません`)
        syncLog('storage_get complete for file content', { fileId: file.id, fileName: file.name, cid: shortLogValue(candidate.cid), source: candidate.source })
        return bundle.file.dataUrl
      } catch (error) {
        lastError = error
        syncWarn('storage_get failed for file content candidate', { fileId: file.id, fileName: file.name, cid: shortLogValue(candidate.cid), source: candidate.source, error: describeError(error, 'unknown error') })
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${file.name} の本文を取得できませんでした`)
  }

  async function loadFileContentFromFolderBundle(file: FileRecord, folderCid: string, passphrase: string): Promise<string> {
    syncLog('storage_get start for parent folder content fallback', { fileId: file.id, fileName: file.name, folderCid: shortLogValue(folderCid) })
    const bundle = await materializeFolderBundleFiles(await loadEncryptedFolderFromMist(folderCid, passphrase), passphrase)
    const bundledFile = bundle.files.find((item) => item.id === file.id)
    if (!bundledFile) throw new Error(`${file.name} がフォルダー共有データに見つかりません`)
    if (bundledFile.lastCid && bundledFile.lastCid !== file.lastCid) {
      setSnapshot((current) => ({
        ...current,
        files: current.files.map((item) => (item.id === file.id ? stripFileContent(stampFilePatch(item, { lastCid: bundledFile.lastCid }, bundledFile.updatedAt, bundle.originNode)) : item)),
      }))
    }
    if (bundledFile.dataUrl) {
      syncLog('storage_get complete for parent folder content fallback', { fileId: file.id, fileName: file.name, folderCid: shortLogValue(folderCid) })
      return bundledFile.dataUrl
    }
    if (bundledFile.lastCid) return loadFileContentFromCandidates(file, [{ cid: bundledFile.lastCid, passphrase, source: 'parent-folder-file' }])
    throw new Error(`${file.name} の本文CIDがフォルダー共有データに含まれていません`)
  }

  async function downloadStoredFile(file: FileRecord): Promise<void> {
    const progressRequestId = startDownloadProgress(file, Boolean(file.dataUrl ?? fileContentCacheRef.current[file.id]))
    try {
      const fileWithContent = await ensureFileContent(file)
      updateDownloadProgress(file, 96, progressRequestId)
      downloadFile(fileWithContent)
      finishDownloadProgress(file, progressRequestId)
    } catch (error) {
      failDownloadProgress(progressRequestId)
      setNotice({ tone: 'error', text: describeError(error, 'ファイルをダウンロードできませんでした') })
    }
  }

  function patchCurrentFolder(patch: Partial<FolderRecord>) {
    if (!folderPanelFolder) return
    const now = new Date().toISOString()
    setSnapshot((current) => touchSnapshot({ ...current, folders: current.folders.map((folder) => (folder.id === folderPanelFolder.id ? stampFolderPatch(folder, patch, now, settings.nodeId) : folder)) }, settings.nodeId))
  }

  function beginCreateFolder() {
    if (currentFolderId && !currentFolder) {
      setNotice({ tone: 'error', text: '削除済みフォルダーにはフォルダーを作成できません' })
      return
    }
    const existingNames = new Set(childFolders(snapshot, currentFolderId).map((folder) => folder.name))
    const name = nextFolderName(existingNames)
    setFolderNameDraft(name)
    setSelectedFileId(null)
    setDetailFileId(null)
  }

  function cancelCreateFolder() {
    setFolderNameDraft(null)
  }

  function confirmCreateFolder() {
    if (folderNameDraft === null) return
    const name = folderNameDraft.trim()
    if (!name) return setNotice({ tone: 'error', text: 'フォルダー名を入力してください' })
    const existingNames = new Set(childFolders(snapshot, currentFolderId).map((folder) => folder.name.toLowerCase()))
    if (existingNames.has(name.toLowerCase())) return setNotice({ tone: 'error', text: '同じ名前のフォルダーがあります' })
    createFolder(name)
    setFolderNameDraft(null)
  }

  function createFolder(name: string) {
    if (currentFolderId && !snapshotRef.current.folders.some((item) => item.id === currentFolderId && !item.deletedAt)) {
      setNotice({ tone: 'error', text: '削除済みフォルダーにはフォルダーを作成できません' })
      return
    }
    const now = new Date().toISOString()
    const folder = makeFolder({ name, parentId: currentFolderId, color: folderColors[folders.length % folderColors.length] ?? 'teal', roomId: settings.roomId, now, nodeId: settings.nodeId })
    const sharedRoot = currentFolderId ? nearestSharedAncestorFolder(snapshotRef.current, currentFolderId) : undefined
    const inheritedKey = sharedRoot ? folderKeysRef.current[sharedRoot.id] : undefined
    setSnapshot((current) => touchSnapshot(addActivity({ ...current, folders: [...current.folders, folder] }, { actorNodeId: settings.nodeId, folderId: folder.id, action: 'folder.create', detail: `${folder.name} を作成` }, now), settings.nodeId))
    setFolderKeys((current) => ({ ...current, [folder.id]: inheritedKey || generateFolderKey() }))
    setCurrentFolderId(folder.id)
    setSelectedFileId(null)
    if (sharedRoot) announceFolderChange(sharedRoot, 'folder-upserted', undefined, folder)
    setNotice({ tone: 'success', text: `${folder.name} を作成しました` })
  }

  async function uploadFiles(fileList: FileList | null, targetFolderId = currentFolderId) {
    if (!fileList?.length) return
    if (!targetFolderId) return setNotice({ tone: 'error', text: 'アップロード先フォルダーを選択してください' })
    const folder = snapshotRef.current.folders.find((item) => item.id === targetFolderId)
    if (!folder) return setNotice({ tone: 'error', text: 'アップロード先フォルダーが見つかりません' })
    if (folder.deletedAt) {
      setNotice({ tone: 'error', text: '削除済みフォルダーにはアップロードできません' })
      setCurrentFolderId(activeAncestorFolderId(snapshotRef.current, folder.id))
      return
    }
    const sharedRoot = nearestSharedAncestorFolder(snapshotRef.current, targetFolderId)
    const storageFolder = sharedRoot ?? folder
    const passphrase = folderKeysRef.current[storageFolder.id] || folderKeysRef.current[targetFolderId] || generateFolderKey()
    if (!folderKeysRef.current[targetFolderId]) setFolderKeys((current) => ({ ...current, [targetFolderId]: passphrase }))
    if (sharedRoot && !folderKeysRef.current[sharedRoot.id]) setFolderKeys((current) => ({ ...current, [sharedRoot.id]: passphrase }))
    const now = new Date().toISOString()
    setBusy('upload')
    try {
      const uploaded = await Promise.all([...fileList].map(async (file) => {
        const record = await readBrowserFile(file, targetFolderId, now, settings.nodeId)
        const cid = await saveEncryptedFileToMist({ folder: storageFolder, file: record, passphrase, originNode: settings.nodeId })
        return stampFilePatch(record, { lastCid: cid }, now, settings.nodeId)
      }))
      setFileContentCache((current) => {
        const next = { ...current }
        for (const file of uploaded) {
          if (!file.dataUrl) continue
          const existing = snapshotRef.current.files.find((item) => item.folderId === file.folderId && item.name === file.name && !item.deletedAt)
          next[existing?.id ?? file.id] = file.dataUrl
        }
        return next
      })
      setSnapshot((current) => touchSnapshot(addActivity({ ...current, files: mergeUploadedFiles(current.files, uploaded.map(stripFileContent), now, settings.nodeId) }, { actorNodeId: settings.nodeId, folderId: targetFolderId, action: 'file.upload', detail: `${uploaded.length} 件のファイルを追加` }, now), settings.nodeId))
      for (const file of uploaded.map(stripFileContent)) announceFolderChange(storageFolder, 'file-upserted', file)
      setNotice({ tone: 'success', text: `${uploaded.length} 件のファイルを追加しました` })
    } catch (error) {
      setNotice({ tone: 'error', text: describeError(error, 'アップロードに失敗しました') })
    } finally {
      setBusy('')
    }
  }

  async function saveFolderToMist(shareAfterSave: boolean, anchor?: HTMLElement) {
    if (!currentFolder) return setNotice({ tone: 'error', text: '保存するフォルダーを選択してください' })
    const passphrase = currentFolderKey || generateFolderKey()
    if (!currentFolderKey) setFolderKeys((current) => ({ ...current, [currentFolder.id]: passphrase }))
    const now = new Date().toISOString()
    const clipboard = shareAfterSave ? reserveClipboardWrite() : undefined
    setBusy(shareAfterSave ? 'share' : 'save')
    if (shareAfterSave) {
      if (anchor) movePopover('folder', popoverPositionFromAnchor(anchor, 360))
      setFolderPanelFolderId(currentFolder.id)
      setFolderPanelOpen(true)
      setSettingsOpen(false)
      setProfileOpen(false)
      setDetailFileId(null)
      setExpandedPreviewOpen(false)
    }
    setNotice({ tone: 'info', text: shareAfterSave ? '共有URLを作成中...' : 'mistlibへ保存中...' })
    try {
      const folderForSave = shareAfterSave ? stampFolderPatch(currentFolder, { shareEnabled: true, sharedRoomId: settings.roomId }, now, settings.nodeId) : currentFolder
      const foldersForSave = foldersForSync(snapshot, currentFolder.id).map((folder) => (folder.id === currentFolder.id ? folderForSave : folder))
      const filesForSave = await ensureFolderFilesStored(folderForSave, folderFilesForSync(snapshot, currentFolder.id), passphrase)
      const cid = await saveEncryptedFolderToMist({ folder: folderForSave, folders: foldersForSave, files: filesForSave, passphrase, originNode: settings.nodeId })
      clearFolderSyncTimer(currentFolder.id)
      const filesForSaveById = new Map(filesForSave.map((file) => [file.id, stripFileContent(file)]))
      syncSignaturesRef.current[currentFolder.id] = sharedFolderSignature({ ...snapshot, folders: snapshot.folders.map((folder) => (folder.id === currentFolder.id ? folderForSave : folder)), files: snapshot.files.map((file) => filesForSaveById.get(file.id) ?? file) }, currentFolder.id)
      markFolderSaved(currentFolder, cid, now, shareAfterSave, filesForSave)
      if (shareAfterSave) network.broadcastShare({ clock: snapshot.clock + 1, folderId: currentFolder.id, folderName: currentFolder.name, cid })
      const copied = shareAfterSave ? await writeReservedClipboard(makeFolderShareUrl(currentFolder, settings.roomId, snapshot.clock + 1, cid, passphrase, shareProfile), clipboard) : false
      setNotice({ tone: 'success', text: shareAfterSave ? copied ? '共有URLをコピーしました' : '共有URLを作成しました' : '暗号化してmistlibへ保存しました' })
    } catch (error) {
      clipboard?.cancel(); setNotice({ tone: 'error', text: describeError(error, 'mistlib保存に失敗しました') })
    } finally {
      setBusy('')
    }
  }

  async function shareFile(file: FileRecord) {
    const folder = folders.find((item) => item.id === file.folderId)
    if (!folder) return setNotice({ tone: 'error', text: '共有するファイルのフォルダーが見つかりません' })
    const passphrase = fileShareKeys[file.id] || generateFileShareKey()
    if (!fileShareKeys[file.id]) setFileShareKeys((current) => ({ ...current, [file.id]: passphrase }))
    const now = new Date().toISOString()
    const clipboard = reserveClipboardWrite()
    setBusy(`file-share-${file.id}`)
    setDetailFileId(file.id); setSettingsOpen(false); setNotice({ tone: 'info', text: '共有URLを作成中...' })
    try {
      const fileWithContent = await ensureFileContent(file)
      const cid = await saveEncryptedFileToMist({ folder, file: fileWithContent, passphrase, originNode: settings.nodeId })
      markFileShared(file, cid, now)
      network.broadcastShare({ type: 'file-share', clock: snapshot.clock + 1, folderId: folder.id, folderName: folder.name, fileId: file.id, fileName: file.name, cid })
      const copied = await writeReservedClipboard(makeFileShareUrl(fileWithContent, folder, settings.roomId, snapshot.clock + 1, cid, passphrase, shareProfile), clipboard)
      setNotice({ tone: 'success', text: copied ? '共有URLをコピーしました' : '共有URLを作成しました' })
    } catch (error) {
      clipboard?.cancel(); setNotice({ tone: 'error', text: describeError(error, 'ファイル共有に失敗しました') })
    } finally {
      setBusy('')
    }
  }

  async function importShare(share: PendingShare) {
    if (!share.cid) return
    const passphrase = importKeys[share.cid]?.trim() ?? ''
    if (!passphrase) return setNotice({ tone: 'error', text: share.type === 'file-share' ? '共有ファイルの復号キーを入力してください' : '共有フォルダーの復号キーを入力してください' })
    setBusy(`import-${share.cid}`)
    try {
      if (share.type === 'file-share') await importFileShare(share, passphrase)
      else await importFolderShare(share, passphrase)
      markPendingShareImported(share)
    } catch (error) {
      setNotice({ tone: 'error', text: describeError(error, '共有を復号できませんでした') })
    } finally {
      setBusy('')
    }
  }

  async function importFolderShare(share: PendingShare, passphrase: string) {
    const bundle = await materializeFolderBundleFiles(await loadEncryptedFolderFromMist(share.cid ?? '', passphrase), passphrase)
    const remoteSnapshot = remoteFolderSnapshot(bundle, share)
    clearFolderSyncTimer(bundle.folder.id)
    setSnapshot((current) => {
      const next = addActivity(mergeSnapshots(current, remoteSnapshot), { actorNodeId: settings.nodeId, folderId: bundle.folder.id, action: 'folder.import', detail: `${bundle.folder.name} を復号して取り込み` })
      rememberImportedFolderSignature(bundle.folder.id, next, remoteSnapshot)
      return next
    })
    setFolderKeys((current) => ({ ...current, ...folderKeyUpdatesForBundle(bundle, passphrase) }))
    rememberFolderPeer({ ...share, folderId: bundle.folder.id })
    setCurrentFolderId(bundle.folder.id)
    setNotice({ tone: 'success', text: `${bundle.folder.name} を取り込みました` })
  }

  function rememberImportedFolderSignature(folderId: string, merged: StorageSnapshot, remote: StorageSnapshot) {
    const mergedSignature = sharedFolderSignature(merged, folderId)
    const remoteSignature = sharedFolderSignature(remote, folderId)
    syncSignaturesRef.current[folderId] = mergedSignature === remoteSignature ? mergedSignature : remoteSignature
  }

  async function importFileShare(share: PendingShare, passphrase: string) {
    const bundle = await loadEncryptedFileFromMist(share.cid ?? '', passphrase)
    const dataUrl = bundle.file.dataUrl
    if (dataUrl) setFileContentCache((current) => ({ ...current, [bundle.file.id]: dataUrl }))
    setSnapshot((current) => addActivity(mergeSnapshots(current, remoteFileSnapshot(bundle, share)), { actorNodeId: settings.nodeId, fileId: bundle.file.id, folderId: bundle.folder.id, action: 'file.import', detail: `${bundle.file.name} を復号して取り込み` }))
    setFileShareKeys((current) => ({ ...current, [bundle.file.id]: passphrase }))
    setCurrentFolderId(bundle.folder.id)
    setDetailFileId(bundle.file.id)
    setNotice({ tone: 'success', text: `${bundle.file.name} を取り込みました` })
  }

  function markFolderSaved(folder: FolderRecord, cid: string, now: string, shared: boolean, storedFiles: FileRecord[]) {
    setSnapshot((current) => {
      const patch = { lastCid: cid, lastSavedAt: now, lastSharedAt: shared ? now : folder.lastSharedAt, shareEnabled: shared ? true : folder.shareEnabled, sharedRoomId: settings.roomId }
      const foldersNext = current.folders.map((item) => (item.id === folder.id ? stampFolderPatch(item, patch, now, settings.nodeId) : item))
      const storedFilesById = new Map(storedFiles.map((file) => [file.id, stripFileContent(file)]))
      const filesNext = current.files.map((item) => storedFilesById.get(item.id) ?? item)
      return touchSnapshot(addActivity({ ...current, folders: foldersNext, files: filesNext }, { actorNodeId: settings.nodeId, folderId: folder.id, action: shared ? 'folder.share' : 'folder.save', detail: shared ? `${folder.name} をmistlib共有` : `${folder.name} を暗号化保存` }, now), settings.nodeId)
    })
  }

  function markFileShared(file: FileRecord, cid: string, now: string) {
    setSnapshot((current) => touchSnapshot(addActivity({ ...current, files: current.files.map((item) => (item.id === file.id ? stampFilePatch(item, { lastShareCid: cid }, now, settings.nodeId) : item)) }, { actorNodeId: settings.nodeId, fileId: file.id, folderId: file.folderId, action: 'file.share', detail: `${file.name} をmistlib共有` }, now), settings.nodeId))
  }

  function renameFile(file: FileRecord, name: string) {
    const nextName = name.trim()
    if (!nextName) return setNotice({ tone: 'error', text: 'ファイル名を入力してください' })
    const snapshotValue = snapshotRef.current
    const currentFile = snapshotValue.files.find((item) => item.id === file.id && !item.deletedAt)
    if (!currentFile) return setNotice({ tone: 'error', text: 'ファイルが見つかりません' })
    if (currentFile.name === nextName) return
    const duplicate = snapshotValue.files.some((item) => item.id !== currentFile.id && !item.deletedAt && item.folderId === currentFile.folderId && item.name.toLowerCase() === nextName.toLowerCase())
    if (duplicate) return setNotice({ tone: 'error', text: '同じ名前のファイルがあります' })
    const now = new Date().toISOString()
    const renamedFile = stripFileContent(stampFilePatch(currentFile, { name: nextName }, now, settings.nodeId))
    setSnapshot((current) => touchSnapshot(addActivity({ ...current, files: current.files.map((item) => (item.id === currentFile.id ? renamedFile : item)) }, { actorNodeId: settings.nodeId, fileId: currentFile.id, folderId: currentFile.folderId, action: 'file.rename', detail: `${currentFile.name} を ${nextName} に変更` }, now), settings.nodeId))
    const sharedRoot = nearestSharedAncestorFolder(snapshotValue, currentFile.folderId)
    if (sharedRoot) announceFolderChange(sharedRoot, 'file-upserted', renamedFile)
    setNotice({ tone: 'success', text: 'ファイル名を変更しました' })
  }

  function requestDeleteFile(file: FileRecord) {
    setDeleteRequest({ type: 'file', file })
    setSettingsOpen(false)
    setProfileOpen(false)
    setFolderPanelOpen(false)
    setDetailFileId(null)
  }

  function requestDeleteFolder(folder: FolderRecord) {
    setDeleteRequest({ type: 'folder', folder })
    setSettingsOpen(false)
    setProfileOpen(false)
    setFolderPanelOpen(false)
    setDetailFileId(null)
  }

  function confirmDelete() {
    if (!deleteRequest) return
    if (deleteRequest.type === 'file') deleteFile(deleteRequest.file)
    else deleteFolder(deleteRequest.folder)
    setDeleteRequest(null)
  }

  function deleteFile(file: FileRecord) {
    const now = new Date().toISOString()
    const deletedFile = stripFileContent(stampFilePatch(file, { deletedAt: now }, now, settings.nodeId))
    setSnapshot((current) => touchSnapshot(addActivity({ ...current, files: current.files.map((item) => (item.id === file.id ? deletedFile : item)) }, { actorNodeId: settings.nodeId, fileId: file.id, folderId: file.folderId, action: 'file.delete', detail: `${file.name} を削除` }, now), settings.nodeId))
    const folder = nearestSharedAncestorFolder(snapshotRef.current, file.folderId) ?? snapshotRef.current.folders.find((item) => item.id === file.folderId)
    if (folder) announceFolderChange(folder, 'file-deleted', deletedFile)
  }

  function deleteCurrentFolder() {
    if (!folderPanelFolder) return
    requestDeleteFolder(folderPanelFolder)
  }

  function deleteFolder(folder: FolderRecord) {
    const now = new Date().toISOString()
    const folderIds = descendantFolderIds(snapshot.folders, folder.id)
    setSnapshot((current) => {
      const deletedIds = descendantFolderIds(current.folders, folder.id)
      const foldersNext = current.folders.map((item) => (deletedIds.has(item.id) ? stampFolderPatch(item, { deletedAt: now }, now, settings.nodeId) : item))
      const filesNext = current.files.map((item) => (deletedIds.has(item.folderId) ? stampFilePatch(item, { deletedAt: now }, now, settings.nodeId) : item))
      return touchSnapshot(addActivity({ ...current, folders: foldersNext, files: filesNext }, { actorNodeId: settings.nodeId, folderId: folder.id, action: 'folder.delete', detail: `${folder.name} を削除` }, now), settings.nodeId)
    })
    if (currentFolderId && folderIds.has(currentFolderId)) setCurrentFolderId(folder.parentId)
    if (folderPanelFolderId && folderIds.has(folderPanelFolderId)) {
      setFolderPanelFolderId(null)
      setFolderPanelOpen(false)
    }
    setSelectedFileId(null)
    setDetailFileId(null)
    setFolderPanelOpen(false)
    const sharedRoot = nearestSharedAncestorFolder(snapshotRef.current, folder.id) ?? folder
    announceFolderChange(sharedRoot, 'folder-deleted', undefined, folder)
  }

  function beginItemDrag(item: BrowserDragItem, event: DragEvent) {
    writeBrowserDragItem(event.dataTransfer, item)
    dragItemRef.current = item
    setDragItem(item)
    setDragActive(false)
    setDropTargetFolderId(undefined)
  }

  function endItemDrag() {
    dragItemRef.current = null
    setDragItem(null)
    setDropTargetFolderId(undefined)
    setReorderTarget(null)
  }

  function handleBrowserItemDragOver(target: BrowserDragItem, event: DragEvent) {
    const item = dragItemRef.current
    if (!item) {
      if (target.type === 'folder' && hasExternalFiles(event.dataTransfer)) handleMoveTargetDragOver(target.id, event)
      return
    }
    const reorder = reorderTargetFromEvent(item, target, event)
    if (reorder) {
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      setDragActive(false)
      setDropTargetFolderId(undefined)
      setReorderTarget(reorder)
      return
    }
    setReorderTarget((current) => (current?.type === target.type && current.id === target.id ? null : current))
    if (target.type === 'folder') handleMoveTargetDragOver(target.id, event)
  }

  function handleBrowserItemDragLeave(target: BrowserDragItem, event: DragEvent) {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setReorderTarget((current) => (current?.type === target.type && current.id === target.id ? null : current))
    if (target.type === 'folder') handleMoveTargetDragLeave(target.id, event)
  }

  function handleBrowserItemDrop(target: BrowserDragItem, event: DragEvent) {
    const item = dragItemRef.current ?? readBrowserDragItem(event.dataTransfer)
    if (!item) {
      if (target.type === 'folder') handleMoveTargetDrop(target.id, event)
      return
    }
    const reorder = reorderTargetFromEvent(item, target, event)
    if (reorder?.type === target.type && reorder.id === target.id && canReorderDraggedItem(item, target)) {
      event.preventDefault()
      event.stopPropagation()
      endItemDrag()
      reorderDraggedItem(item, reorder)
      return
    }
    if (target.type === 'folder') handleMoveTargetDrop(target.id, event)
  }

  function handleMoveTargetDragOver(targetFolderId: string | null, event: DragEvent) {
    const item = dragItemRef.current
    const hasInternalItem = Boolean(item || hasBrowserDragItem(event.dataTransfer))
    const hasFiles = hasExternalFiles(event.dataTransfer)
    if (!hasInternalItem && !hasFiles) return
    event.preventDefault()
    event.stopPropagation()
    if (item) {
      const allowed = canMoveItemToFolder(item, targetFolderId)
      if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'move' : 'none'
      setDropTargetFolderId(allowed ? targetFolderId : undefined)
      return
    }
    if (event.dataTransfer) event.dataTransfer.dropEffect = targetFolderId ? 'copy' : 'none'
    setDropTargetFolderId(targetFolderId ? targetFolderId : undefined)
  }

  function handleMoveTargetDragLeave(targetFolderId: string | null, event: DragEvent) {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setDropTargetFolderId((current) => (current === targetFolderId ? undefined : current))
  }

  function handleMoveTargetDrop(targetFolderId: string | null, event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    const item = dragItemRef.current ?? readBrowserDragItem(event.dataTransfer)
    const filesToUpload = event.dataTransfer?.files ?? null
    setDragActive(false)
    endItemDrag()
    if (item) {
      void moveDraggedItem(item, targetFolderId)
      return
    }
    void uploadFiles(filesToUpload, targetFolderId)
  }

  function reorderTargetFromEvent(item: BrowserDragItem, target: BrowserDragItem, event: DragEvent): BrowserReorderTarget | null {
    if (!canReorderDraggedItem(item, target)) return null
    const ratio = itemDropRatio(event)
    if (target.type === 'folder' && ratio > 0.3 && ratio < 0.7) return null
    return { ...target, position: ratio < 0.5 ? 'before' : 'after' }
  }

  function itemDropRatio(event: DragEvent): number {
    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return 0.5
    const rect = target.getBoundingClientRect()
    if (browserViewMode === 'grid') return rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5
    return rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
  }

  function canReorderDraggedItem(item: BrowserDragItem, target: BrowserDragItem): boolean {
    if (query.trim() || item.type !== target.type || item.id === target.id) return false
    const snapshotValue = snapshotRef.current
    if (item.type === 'file') {
      const file = snapshotValue.files.find((value) => value.id === item.id && !value.deletedAt)
      const targetFile = snapshotValue.files.find((value) => value.id === target.id && !value.deletedAt)
      return Boolean(file && targetFile && file.folderId === currentFolderId && targetFile.folderId === currentFolderId)
    }
    const folder = snapshotValue.folders.find((value) => value.id === item.id && !value.deletedAt)
    const targetFolder = snapshotValue.folders.find((value) => value.id === target.id && !value.deletedAt)
    return Boolean(folder && targetFolder && folder.parentId === currentFolderId && targetFolder.parentId === currentFolderId)
  }

  function reorderDraggedItem(item: BrowserDragItem, target: BrowserReorderTarget): void {
    if (!canReorderDraggedItem(item, target)) return
    const now = new Date().toISOString()
    const snapshotValue = snapshotRef.current
    if (item.type === 'file') {
      const currentRows = snapshotValue.files.filter((file) => !file.deletedAt && file.folderId === currentFolderId).sort(compareFilesForDisplay)
      const nextIds = reorderIds(currentRows.map((file) => file.id), item.id, target.id, target.position)
      const orderById = new Map(nextIds.map((id, index) => [id, (index + 1) * 1000]))
      const movedFile = currentRows.find((file) => file.id === item.id)
      setSnapshot((current) => touchSnapshot(addActivity({ ...current, files: current.files.map((file) => {
        const sortOrder = orderById.get(file.id)
        return sortOrder === undefined || file.sortOrder === sortOrder ? file : stampFilePatch(file, { sortOrder }, now, settings.nodeId)
      }) }, { actorNodeId: settings.nodeId, folderId: currentFolderId ?? undefined, fileId: item.id, action: 'file.reorder', detail: `${movedFile?.name ?? 'ファイル'} を並び替え` }, now), settings.nodeId))
      setNotice({ tone: 'success', text: 'ファイルの並び順を更新しました' })
      return
    }
    const currentRows = snapshotValue.folders.filter((folder) => !folder.deletedAt && folder.parentId === currentFolderId).sort(compareFoldersForDisplay)
    const nextIds = reorderIds(currentRows.map((folder) => folder.id), item.id, target.id, target.position)
    const orderById = new Map(nextIds.map((id, index) => [id, (index + 1) * 1000]))
    const movedFolder = currentRows.find((folder) => folder.id === item.id)
    setSnapshot((current) => touchSnapshot(addActivity({ ...current, folders: current.folders.map((folder) => {
      const sortOrder = orderById.get(folder.id)
      return sortOrder === undefined || folder.sortOrder === sortOrder ? folder : stampFolderPatch(folder, { sortOrder }, now, settings.nodeId)
    }) }, { actorNodeId: settings.nodeId, folderId: item.id, action: 'folder.reorder', detail: `${movedFolder?.name ?? 'フォルダー'} を並び替え` }, now), settings.nodeId))
    setNotice({ tone: 'success', text: 'フォルダーの並び順を更新しました' })
  }

  function reorderIds(ids: string[], sourceId: string, targetId: string, position: BrowserReorderTarget['position']): string[] {
    const withoutSource = ids.filter((id) => id !== sourceId)
    const targetIndex = withoutSource.indexOf(targetId)
    if (targetIndex < 0) return ids
    const insertIndex = position === 'before' ? targetIndex : targetIndex + 1
    return [...withoutSource.slice(0, insertIndex), sourceId, ...withoutSource.slice(insertIndex)]
  }

  function canMoveItemToFolder(item: BrowserDragItem, targetFolderId: string | null): boolean {
    const snapshotValue = snapshotRef.current
    if (targetFolderId && !snapshotValue.folders.some((folder) => folder.id === targetFolderId && !folder.deletedAt)) return false
    if (item.type === 'file') {
      const file = snapshotValue.files.find((value) => value.id === item.id && !value.deletedAt)
      if (!file || !targetFolderId || file.folderId === targetFolderId) return false
      return !snapshotValue.files.some((value) => value.id !== file.id && !value.deletedAt && value.folderId === targetFolderId && value.name.toLowerCase() === file.name.toLowerCase())
    }
    const folder = snapshotValue.folders.find((value) => value.id === item.id && !value.deletedAt)
    if (!folder || folder.parentId === targetFolderId || folder.id === targetFolderId) return false
    if (targetFolderId && descendantFolderIds(snapshotValue.folders, folder.id).has(targetFolderId)) return false
    return !snapshotValue.folders.some((value) => value.id !== folder.id && !value.deletedAt && value.parentId === targetFolderId && value.name.toLowerCase() === folder.name.toLowerCase())
  }

  async function moveDraggedItem(item: BrowserDragItem, targetFolderId: string | null): Promise<void> {
    if (!canMoveItemToFolder(item, targetFolderId)) {
      setNotice({ tone: 'error', text: 'その場所には移動できません' })
      return
    }
    if (item.type === 'file') await moveFileToFolder(item.id, targetFolderId)
    else moveFolderToFolder(item.id, targetFolderId)
  }

  async function moveFileToFolder(fileId: string, targetFolderId: string | null): Promise<void> {
    if (!targetFolderId) return setNotice({ tone: 'error', text: 'ファイルはフォルダー内に移動してください' })
    const snapshotValue = snapshotRef.current
    const file = snapshotValue.files.find((item) => item.id === fileId && !item.deletedAt)
    const targetFolder = snapshotValue.folders.find((folder) => folder.id === targetFolderId && !folder.deletedAt)
    if (!file || !targetFolder) return setNotice({ tone: 'error', text: '移動先が見つかりません' })
    const sourceSharedRoot = nearestSharedAncestorFolder(snapshotValue, file.folderId)
    const targetSharedRoot = nearestSharedAncestorFolder(snapshotValue, targetFolderId)
    const storageFolder = targetSharedRoot ?? targetFolder
    const passphrase = folderKeysRef.current[storageFolder.id] || folderKeysRef.current[targetFolderId] || generateFolderKey()
    const keyUpdates: Record<string, string> = {}
    if (!folderKeysRef.current[targetFolderId]) keyUpdates[targetFolderId] = passphrase
    if (targetSharedRoot && !folderKeysRef.current[targetSharedRoot.id]) keyUpdates[targetSharedRoot.id] = passphrase
    if (Object.keys(keyUpdates).length > 0) {
      folderKeysRef.current = { ...folderKeysRef.current, ...keyUpdates }
      setFolderKeys((current) => ({ ...current, ...keyUpdates }))
    }
    const now = new Date().toISOString()
    setBusy(`move-file-${file.id}`)
    try {
      const fileWithContent = await ensureFileContent(file)
      const movedFileWithContent = { ...fileWithContent, folderId: targetFolderId }
      const cid = await saveEncryptedFileToMist({ folder: storageFolder, file: movedFileWithContent, passphrase, originNode: settings.nodeId })
      const movedFile = stripFileContent(stampFilePatch(file, { folderId: targetFolderId, lastCid: cid }, now, settings.nodeId))
      if (fileWithContent.dataUrl) setFileContentCache((current) => ({ ...current, [file.id]: fileWithContent.dataUrl ?? '' }))
      setSnapshot((current) => touchSnapshot(addActivity({ ...current, files: current.files.map((item) => (item.id === file.id ? movedFile : item)) }, { actorNodeId: settings.nodeId, folderId: targetFolderId, fileId: file.id, action: 'file.move', detail: `${file.name} を ${targetFolder.name} に移動` }, now), settings.nodeId))
      if (sourceSharedRoot && sourceSharedRoot.id !== targetSharedRoot?.id) {
        announceFolderChange(sourceSharedRoot, 'file-deleted', stripFileContent(stampFilePatch(file, { deletedAt: now }, now, settings.nodeId)))
      }
      if (targetSharedRoot) announceFolderChange(targetSharedRoot, 'file-upserted', movedFile)
      setNotice({ tone: 'success', text: `${file.name} を ${targetFolder.name} に移動しました` })
    } catch (error) {
      setNotice({ tone: 'error', text: describeError(error, 'ファイルを移動できませんでした') })
    } finally {
      setBusy('')
    }
  }

  function moveFolderToFolder(folderId: string, targetFolderId: string | null): void {
    const snapshotValue = snapshotRef.current
    const folder = snapshotValue.folders.find((item) => item.id === folderId && !item.deletedAt)
    const targetFolder = targetFolderId ? snapshotValue.folders.find((item) => item.id === targetFolderId && !item.deletedAt) : null
    if (!folder || (targetFolderId && !targetFolder)) return setNotice({ tone: 'error', text: '移動先が見つかりません' })
    const now = new Date().toISOString()
    const movedFolder = stampFolderPatch(folder, { parentId: targetFolderId }, now, settings.nodeId)
    const sourceSharedRoot = nearestSharedAncestorFolder(snapshotValue, folder.parentId)
    const targetSharedRoot = targetFolderId ? nearestSharedAncestorFolder(snapshotValue, targetFolderId) : undefined
    if (targetSharedRoot && folderKeysRef.current[targetSharedRoot.id]) {
      const folderIds = descendantFolderIds(snapshotValue.folders, folder.id)
      const keyUpdates = Object.fromEntries([...folderIds].filter((id) => !folderKeysRef.current[id]).map((id) => [id, folderKeysRef.current[targetSharedRoot.id] ?? '']))
      if (Object.keys(keyUpdates).length > 0) {
        folderKeysRef.current = { ...folderKeysRef.current, ...keyUpdates }
        setFolderKeys((current) => ({ ...current, ...keyUpdates }))
      }
    }
    setSnapshot((current) => touchSnapshot(addActivity({ ...current, folders: current.folders.map((item) => (item.id === folder.id ? movedFolder : item)) }, { actorNodeId: settings.nodeId, folderId: folder.id, action: 'folder.move', detail: `${folder.name} を ${targetFolder?.name ?? 'My Drive'} に移動` }, now), settings.nodeId))
    if (sourceSharedRoot && sourceSharedRoot.id !== targetSharedRoot?.id) announceFolderChange(sourceSharedRoot, 'folder-deleted', undefined, folder)
    if (targetSharedRoot) announceFolderChange(targetSharedRoot, 'folder-upserted', undefined, movedFolder)
    setNotice({ tone: 'success', text: `${folder.name} を ${targetFolder?.name ?? 'My Drive'} に移動しました` })
  }

  function saveSettingsDraft() {
    setSettings(normalizedSettingsDraft())
    setSettingsOpen(false)
    setNotice({ tone: 'success', text: '共有設定を保存しました' })
  }

  function saveProfileDraft() {
    setSettings(normalizedSettingsDraft())
    setProfileOpen(false)
    setNotice({ tone: 'success', text: 'プロフィールを保存しました' })
  }

  function normalizedSettingsDraft(): AppSettings {
    const avatarUrl = settingsDraft.avatarUrl.trim()
    const avatarFileId = avatarUrl ? '' : settingsDraft.avatarFileId && profileImageFiles.some((file) => file.id === settingsDraft.avatarFileId) ? settingsDraft.avatarFileId : ''
    return {
      ...settingsDraft,
      roomId: settingsDraft.roomId.trim() || 'tc-storage-main',
      signalingUrl: settingsDraft.signalingUrl.trim(),
      nodeId: settings.nodeId,
      identity: settings.identity,
      profileName: settingsDraft.profileName.trim() || 'Local user',
      avatarUrl,
      avatarFileId,
    }
  }

  function copyText(value: string, label: string) { void copyToClipboard(value).then((ok) => setNotice({ tone: ok ? 'success' : 'error', text: ok ? `${label} をコピーしました` : `${label} をコピーできませんでした` })) }

  function acceptLinkedShare({ share, key }: LinkedShare) {
    const linkedShare = { ...share, autoImport: true }
    setPendingShares((current) => [linkedShare, ...current.filter((item) => item.cid !== share.cid)].slice(0, 12)); if (share.cid) setImportKeys((current) => ({ ...current, [share.cid ?? '']: key }))
    setSettings((current) => current.roomId === share.roomId ? current : { ...current, roomId: share.roomId })
    setCurrentFolderId(null); setQuery(''); setSettingsOpen(false); setProfileOpen(false); setFolderPanelFolderId(null); setFolderPanelOpen(true); setDetailFileId(null); setSelectedFileId(null); setExpandedPreviewOpen(false); setNotice({ tone: 'info', text: '共有URLを読み込みました。取得を開始します' })
  }

  function selectFolder(folderId: string | null) {
    setCurrentFolderId(folderId)
    setFolderPanelFolderId(null)
    setFolderNameDraft(null)
    setSelectedFileId(null)
    setDetailFileId(null)
    setExpandedPreviewOpen(false)
    setSettingsOpen(false)
    setProfileOpen(false)
    setFolderPanelOpen(false)
  }

  function openFile(file: FileRecord) {
    setSelectedFileId(file.id)
    setExpandedPreviewOpen(true)
    setSettingsOpen(false)
    setProfileOpen(false)
    setFolderPanelOpen(false)
    setDetailFileId(null)
  }

  function showFileDetails(file: FileRecord, anchor?: HTMLElement) {
    if (anchor) movePopover('detail', popoverPositionFromAnchor(anchor, 360))
    setDetailFileId(file.id)
    setSettingsOpen(false)
    setProfileOpen(false)
    setFolderPanelOpen(false)
  }

  function showFolderDetails(folder: FolderRecord, anchor?: HTMLElement) {
    if (anchor) movePopover('folder', popoverPositionFromAnchor(anchor, 360))
    setFolderPanelFolderId(folder.id)
    setFolderPanelOpen(true)
    setSettingsOpen(false)
    setProfileOpen(false)
    setDetailFileId(null)
  }

  function openSettings(anchor?: HTMLElement) {
    if (anchor) movePopover('settings', popoverPositionFromAnchor(anchor, 330))
    setSettingsOpen(true)
    setProfileOpen(false)
    setDetailFileId(null)
    setFolderPanelOpen(false)
  }

  function openProfile(anchor?: HTMLElement) {
    if (anchor) movePopover('profile', popoverPositionFromAnchor(anchor, 320))
    setProfileOpen(true)
    setSettingsOpen(false)
    setDetailFileId(null)
    setFolderPanelOpen(false)
  }

  function openFolderPanel(anchor?: HTMLElement) {
    if (anchor) movePopover('folder', popoverPositionFromAnchor(anchor, 360))
    setFolderPanelFolderId(null)
    setFolderPanelOpen(true)
    setSettingsOpen(false)
    setProfileOpen(false)
    setDetailFileId(null)
  }

  function movePopover(kind: PopoverKind, position: PopoverPosition) {
    setPopoverPositions((current) => ({ ...current, [kind]: position }))
  }


  function movePreview(direction: -1 | 1) {
    if (!selectedFileId || previewFiles.length === 0) return
    const currentIndex = Math.max(0, previewFiles.findIndex((file) => file.id === selectedFileId))
    setSelectedFileId(previewFiles[(currentIndex + direction + previewFiles.length) % previewFiles.length]?.id ?? selectedFileId)
  }

  function handlePreviewKey(event: KeyboardEvent) {
    if (event.key === 'Escape') setExpandedPreviewOpen(false)
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      movePreview(event.key === 'ArrowLeft' ? -1 : 1)
    }
  }

  const storageUsed = files.reduce((total, file) => total + file.size, 0)
  const selectedPreviewProgress = selectedPreviewFile && !selectedPreviewFile.dataUrl ? fileLoadProgress[selectedPreviewFile.id] ?? 0 : 0

  return (
    <main class="app-shell">
      <Sidebar avatarUrl={avatarUrl} currentFolderId={currentFolderId} dragItem={dragItem} dropTargetFolderId={dropTargetFolderId} snapshot={snapshot} onItemDragEnd={endItemDrag} onItemDragStart={beginItemDrag} onMoveTargetDragLeave={handleMoveTargetDragLeave} onMoveTargetDragOver={handleMoveTargetDragOver} onMoveTargetDrop={handleMoveTargetDrop} onOpenProfile={openProfile} onOpenSettings={openSettings} onSelectFolder={selectFolder} />
      <section class="main-column">
        <BrowserPanel busy={busy} currentFolder={currentFolder} currentFolderId={currentFolderId} dragActive={dragActive} dragItem={dragItem} dropTargetFolderId={dropTargetFolderId} fileDataUrls={fileDataUrls} fileRows={fileRows} folderNameDraft={folderNameDraft} folderRows={folderRows} pendingFolderShares={pendingFolderShares} files={files} query={query} reorderTarget={reorderTarget} snapshot={snapshot} storageUsed={storageUsed} viewMode={browserViewMode} onBrowserItemDragLeave={handleBrowserItemDragLeave} onBrowserItemDragOver={handleBrowserItemDragOver} onBrowserItemDrop={handleBrowserItemDrop} onCancelCreateFolder={cancelCreateFolder} onCancelPendingShare={cancelPendingShare} onConfirmCreateFolder={confirmCreateFolder} onCopy={copyText} onCreateFolder={beginCreateFolder} onDeleteFolder={requestDeleteFolder} onDeleteFile={requestDeleteFile} onDrag={handleDrag} onDrop={handleDrop} onFolderNameDraft={setFolderNameDraft} onItemDragEnd={endItemDrag} onItemDragStart={beginItemDrag} onMoveTargetDragLeave={handleMoveTargetDragLeave} onMoveTargetDragOver={handleMoveTargetDragOver} onMoveTargetDrop={handleMoveTargetDrop} onOpenFile={openFile} onOpenFolderPanel={openFolderPanel} onPreloadFile={preloadFileContent} onQuery={setQuery} onSaveFolder={(share, anchor) => void saveFolderToMist(share, anchor)} onSelectFolder={selectFolder} onShareFile={(file) => void shareFile(file)} onShowFileDetails={showFileDetails} onShowFolderDetails={showFolderDetails} onToggleStar={toggleStar} onUploadFiles={(list) => void uploadFiles(list)} onViewMode={setBrowserViewMode} />
      </section>
      <TopSummary downloadProgress={downloadProgress} networkState={network.state} notice={notice} />
      {folderPanelOpen ? (
        <div class="floating-popover-layer" onMouseDown={() => setFolderPanelOpen(false)}>
          <DraggablePopover className="folder-popover" position={popoverPositions.folder} onMove={(position) => movePopover('folder', position)}>
            {renderFolderPanel()}
          </DraggablePopover>
        </div>
      ) : null}
      {profileOpen ? (
        <div class="floating-popover-layer" onMouseDown={() => setProfileOpen(false)}>
          <DraggablePopover className="profile-popover" position={popoverPositions.profile} onMove={(position) => movePopover('profile', position)}>
            <ProfilePanel avatarImages={profileAvatarImages} avatarPreviewUrl={draftAvatarUrl} draft={settingsDraft} onDraft={setSettingsDraft} onClose={() => setProfileOpen(false)} onOpenAvatarImages={openProfileAvatarImages} onSave={saveProfileDraft} onSelectAvatarImage={selectProfileAvatarImage} />
          </DraggablePopover>
        </div>
      ) : null}
      {settingsOpen ? (
        <div class="floating-popover-layer" onMouseDown={() => setSettingsOpen(false)}>
          <DraggablePopover className="settings-popover" position={popoverPositions.settings} onMove={(position) => movePopover('settings', position)}>
            <SettingsPanel draft={settingsDraft} onDraft={setSettingsDraft} onClose={() => setSettingsOpen(false)} onSave={saveSettingsDraft} />
          </DraggablePopover>
        </div>
      ) : null}
      {detailFileWithContent ? (
        <div class="floating-popover-layer" onMouseDown={() => setDetailFileId(null)}>
          <DraggablePopover className="file-detail-popover" position={popoverPositions.detail} onMove={(position) => movePopover('detail', position)}>
            <FileDetailPanel file={detailFileWithContent} busy={busy === `file-share-${detailFileWithContent.id}`} shareKey={fileShareKeys[detailFileWithContent.id] ?? ''} shareUrl={fileShareUrl} syncPeers={detailFolderPeers} onClose={() => setDetailFileId(null)} onCopy={copyText} onDownload={(file) => void downloadStoredFile(file)} onDelete={requestDeleteFile} onRename={renameFile} onShare={(file) => void shareFile(file)} />
          </DraggablePopover>
        </div>
      ) : null}
      {deleteRequest ? (
        <div class="floating-popover-layer" onMouseDown={() => setDeleteRequest(null)}>
          <DraggablePopover className="confirm-popover" position={popoverPositions.confirm} onMove={(position) => movePopover('confirm', position)}>
            <DeleteConfirmPanel request={deleteRequest} onCancel={() => setDeleteRequest(null)} onConfirm={confirmDelete} />
          </DraggablePopover>
        </div>
      ) : null}
      {expandedPreviewOpen && selectedPreviewFile ? <ExpandedPreview file={selectedPreviewFile} index={selectedFileIndex} loadingProgress={selectedPreviewProgress} total={previewFiles.length} onClose={() => setExpandedPreviewOpen(false)} onPrevious={() => movePreview(-1)} onNext={() => movePreview(1)} onDownload={(file) => void downloadStoredFile(file)} /> : null}
    </main>
  )

  function renderFolderPanel() {
    return <FolderPanel folder={folderPanelFolder} shareUrl={folderShareUrl} syncPeers={folderPanelPeers} pendingShares={pendingShares} importKeys={importKeys} busy={busy} onCancelShare={cancelPendingShare} onCopy={copyText} onDeleteFolder={deleteCurrentFolder} onImportKey={(cid, value) => setImportKeys((current) => ({ ...current, [cid]: value }))} onImportShare={(share) => void importShare(share)} onPatchFolder={patchCurrentFolder} />
  }

  function toggleStar(file: FileRecord) {
    const now = new Date().toISOString()
    setSnapshot((current) => touchSnapshot({ ...current, files: current.files.map((item) => (item.id === file.id ? stampFilePatch(item, { starred: !item.starred }, now, settings.nodeId) : item)) }, settings.nodeId))
  }

  function handleDrag(event: DragEvent) {
    const internalDrag = Boolean(dragItemRef.current || hasBrowserDragItem(event.dataTransfer))
    if (!internalDrag && !hasExternalFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    if (internalDrag) {
      if (event.type === 'dragleave') {
        const nextTarget = event.relatedTarget
        if (!(nextTarget instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(nextTarget))) {
          setDropTargetFolderId((current) => (current === currentFolderId ? undefined : current))
        }
        return
      }
      const item = dragItemRef.current
      const allowed = item ? canMoveItemToFolder(item, currentFolderId) : true
      if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'move' : 'none'
      setDragActive(false)
      setReorderTarget(null)
      setDropTargetFolderId(allowed ? currentFolderId : undefined)
      return
    }
    if (event.dataTransfer) event.dataTransfer.dropEffect = currentFolderId ? 'copy' : 'none'
    setDropTargetFolderId(undefined)
    setDragActive(Boolean(currentFolderId) && (event.type === 'dragenter' || event.type === 'dragover'))
  }

  function handleDrop(event: DragEvent) {
    handleMoveTargetDrop(currentFolderId, event)
  }
}
