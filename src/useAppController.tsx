import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { descendantFolderIds, filterByName } from './appHelpers.js'
import type { BrowserDragItem, BrowserReorderTarget, BrowserViewMode, DeleteRequest, FolderAccessRequest, Notice, PendingShare } from './appTypes.js'
import { createAccessActions, type RequestKeyEntry } from './appAccessActions.js'
import { createDragDropActions } from './appDragDropActions.js'
import { createEnvelopeActions } from './appEnvelopeActions.js'
import { createFileActions } from './appFileActions.js'
import { createFileContentActions } from './appFileContentActions.js'
import { createFolderActions } from './appFolderActions.js'
import { createFolderSyncActions } from './appFolderSyncActions.js'
import { createMoveActions } from './appMoveActions.js'
import { createPanelActions } from './appPanelActions.js'
import { createPeerActions } from './appPeerActions.js'
import { createSelectionActions } from './appSelectionActions.js'
import { createShareImportActions } from './appShareImportActions.js'
import { browserViewModeKey, loadBrowserViewMode } from './appUtils.js'
import { initialPopoverPosition, type PopoverKind, type PopoverPosition } from './components/FloatingPopover.js'
import { activeFiles, activeFolders, childFolders, filesInFolder, type StorageSnapshot } from './domain.js'
import { loadFileShareKeys } from './fileShareKeys.js'
import { loadFolderSyncPeers, type FolderSyncPeers } from './folderPeers.js'
import { readFolderRoute } from './folderRoute.js'
import { loadFolderKeys } from './folderKeys.js'
import { loadFolderAccessModes } from './folderAccess.js'
import { loadSettings, type AppSettings } from './localSettings.js'
import { loadStoredSnapshot } from './localSnapshot.js'
import { useMistShare, type ShareEnvelope, type ShareProfile } from './p2p.js'
import { loadImportKeys, loadPendingShares } from './pendingShares.js'
import { makeFileShareUrl, makeFolderShareUrl } from './shareLinks.js'
import { useAppEffects } from './useAppEffects.js'
import { useProfileAvatarPicker } from './useProfileAvatarPicker.js'
import { useTransferProgress } from './useTransferProgress.js'

export function useAppController() {
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
  const [folderAccessModes, setFolderAccessModes] = useState(() => loadFolderAccessModes())
  const [folderAccessRequests, setFolderAccessRequests] = useState<FolderAccessRequest[]>([])
  const [fileContentCache, setFileContentCache] = useState<Record<string, string>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [folderPanelOpen, setFolderPanelOpen] = useState(false)
  const [folderPanelAccessOnly, setFolderPanelAccessOnly] = useState(false)
  const [folderPanelFolderId, setFolderPanelFolderId] = useState<string | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [detailFileId, setDetailFileId] = useState<string | null>(null)
  const [expandedPreviewOpen, setExpandedPreviewOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [dragItem, setDragItem] = useState<BrowserDragItem | null>(null)
  const [selectedItems, setSelectedItems] = useState<BrowserDragItem[]>([])
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
  const transfer = useTransferProgress()

  const folders = useMemo(() => activeFolders(snapshot), [snapshot])
  const files = useMemo(() => activeFiles(snapshot), [snapshot])
  const currentFolder = folders.find((folder) => folder.id === currentFolderId) ?? null
  const folderPanelFolder = (folderPanelFolderId ? folders.find((folder) => folder.id === folderPanelFolderId) : currentFolder) ?? null
  const selectedFile = files.find((file) => file.id === selectedFileId) ?? null
  const detailFile = files.find((file) => file.id === detailFileId) ?? null
  const detailFolder = detailFile ? folders.find((folder) => folder.id === detailFile.folderId) ?? null : null
  const fileDataUrls = useMemo(() => Object.fromEntries(files.flatMap((file) => {
    const dataUrl = file.dataUrl ?? fileContentCache[file.id]
    return dataUrl ? [[file.id, dataUrl]] : []
  })), [fileContentCache, files])
  const selectedPreviewFile = selectedFile ? { ...selectedFile, dataUrl: fileDataUrls[selectedFile.id] } : null
  const detailFileWithContent = detailFile ? { ...detailFile, dataUrl: fileDataUrls[detailFile.id] } : null
  const profileImageFiles = useMemo(() => files.filter((file) => file.mimeType.startsWith('image/')), [files])
  const queryText = query.trim()
  const folderRows = useMemo(() => filterByName(currentFolderId ? currentFolder ? childFolders(snapshot, currentFolder.id) : [] : childFolders(snapshot, null), queryText), [currentFolder, currentFolderId, queryText, snapshot])
  const fileRows = useMemo(() => filterByName(currentFolder ? filesInFolder(snapshot, currentFolder.id) : [], queryText), [currentFolder, queryText, snapshot])
  const pendingFolderShares = useMemo(() => {
    if (currentFolderId !== null) return []
    const folderShares = pendingShares.filter((share) => share.autoImport && share.type === 'folder-share')
    return queryText ? filterByName(folderShares.map((share) => ({ ...share, name: share.folderName ?? 'Shared folder' })), queryText) : folderShares
  }, [currentFolderId, pendingShares, queryText])
  const shareProfile: ShareProfile = useMemo(() => ({ name: settings.profileName, avatarUrl: settings.avatarFileId ? undefined : settings.avatarUrl || undefined }), [settings.avatarFileId, settings.avatarUrl, settings.profileName])
  const currentFolderKey = currentFolder ? folderKeys[currentFolder.id] ?? '' : ''
  const folderPanelPeers = folderPanelFolder ? folderPeers[folderPanelFolder.id] ?? [] : []
  const folderPanelAccessMode = folderPanelFolder ? folderAccessModes[folderPanelFolder.id] ?? 'approval' : 'approval'
  const folderPanelAccessRequests = folderPanelFolder ? folderAccessRequests.filter((request) => request.folderId === folderPanelFolder.id) : []
  const detailFolderPeers = detailFolder ? folderPeers[detailFolder.id] ?? [] : []
  const avatarUrl = settings.avatarFileId ? fileDataUrls[settings.avatarFileId] ?? '' : settings.avatarUrl
  const draftAvatarUrl = settingsDraft.avatarFileId ? fileDataUrls[settingsDraft.avatarFileId] ?? '' : settingsDraft.avatarUrl
  const folderShareUrl = folderPanelFolder?.shareEnabled ? makeFolderShareUrl(folderPanelFolder, settings.roomId, shareProfile) : ''
  const detailFileShareCid = detailFile?.lastShareCid ?? detailFile?.lastCid
  const fileShareUrl = detailFile && detailFileShareCid && detailFolder && fileShareKeys[detailFile.id] ? makeFileShareUrl(detailFile, detailFolder, settings.roomId, snapshot.clock, detailFileShareCid, fileShareKeys[detailFile.id], shareProfile) : ''
  const previewFiles = useMemo(() => (selectedFile ? filesInFolder(snapshot, selectedFile.folderId) : fileRows), [fileRows, selectedFile, snapshot])
  const previewFilesWithContent = useMemo(() => previewFiles.map((file) => ({ ...file, dataUrl: fileDataUrls[file.id] })), [fileDataUrls, previewFiles])
  const selectedFileIndex = selectedFile ? previewFiles.findIndex((file) => file.id === selectedFile.id) : -1
  const selectedPreviewProgress = selectedPreviewFile && !selectedPreviewFile.dataUrl ? transfer.fileLoadProgress[selectedPreviewFile.id] ?? 0 : 0
  const storageUsed = files.reduce((total, file) => total + file.size, 0)
  const currentFolderStorageUsed = currentFolderId ? files.filter((file) => descendantFolderIds(folders, currentFolderId).has(file.folderId)).reduce((total, file) => total + file.size, 0) : storageUsed

  const envelopeHandlerRef = useRef<(envelope: ShareEnvelope) => void>(() => {})
  const network = useMistShare(settings, useCallback((envelope: ShareEnvelope) => envelopeHandlerRef.current(envelope), []))
  const snapshotRef = useRef(snapshot)
  const folderKeysRef = useRef(folderKeys)
  const folderAccessModesRef = useRef(folderAccessModes)
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
  const accessRequestKeysRef = useRef<Record<string, RequestKeyEntry>>({})
  const dragItemRef = useRef<BrowserDragItem | null>(null)
  const dragItemsRef = useRef<BrowserDragItem[]>([])

  const peerActions = createPeerActions({ setFolderPeers, settingsRef })
  const fileContent = createFileContentActions({ ...transfer, fileContentCacheRef, fileContentLoadsRef, fileShareKeysRef, folderKeysRef, setFileContentCache, setNotice, setSnapshot, settingsRef, snapshotRef })
  const folderSync = createFolderSyncActions({ ensureFolderFilesStored: fileContent.ensureFolderFilesStored, folderKeysRef, networkRef, setNotice, setSnapshot, settingsRef, snapshotRef, syncInFlightRef, syncSignaturesRef, syncTimersRef })
  const access = createAccessActions({
    accessRequestKeysRef,
    folderAccessModesRef,
    folderKeysRef,
    networkRef,
    openFolderAccessRequests: (folderId) => {
      setFolderPanelAccessOnly(true)
      setFolderPanelFolderId(folderId)
      setFolderPanelOpen(true)
      setSettingsOpen(false)
      setProfileOpen(false)
      setDetailFileId(null)
    },
    setFolderAccessRequests,
    setFolderKeys,
    setImportKeys,
    setNotice,
    setPendingShares,
    settingsRef,
    snapshotRef,
  })
  const shareImport = createShareImportActions({ autoImportCidsRef, autoImportInFlightRef, clearFolderSyncTimer: folderSync.clearFolderSyncTimer, importKeys, materializeFolderBundleFiles: fileContent.materializeFolderBundleFiles, pendingSharesRef, rememberFolderPeer: peerActions.rememberFolderPeer, setBusy, setCurrentFolderId, setDetailFileId, setFileContentCache, setFileShareKeys, setFolderKeys, setImportKeys, setNotice, setPendingShares, setSnapshot, settingsRef, snapshotRef, syncSignaturesRef })
  const panel = createPanelActions({ previewFiles, profileImageFiles, selectedFileId, setCurrentFolderId, setDetailFileId, setExpandedPreviewOpen, setFolderNameDraft, setFolderPanelAccessOnly, setFolderPanelFolderId, setFolderPanelOpen, setImportKeys, setNotice, setPendingShares, setPopoverPositions, setProfileOpen, setSelectedFileId, setSettings, setSettingsOpen, settings, settingsDraft })
  const envelope = createEnvelopeActions({ announceSharedFolders: folderSync.announceSharedFolders, autoImportCidsRef, autoImportFolderShare: shareImport.autoImportFolderShare, autoImportInFlightRef, autoImportLinkedShare: shareImport.autoImportLinkedShare, currentFolderId, detailFileId, folderKeysRef, folderPanelFolderId, handleFolderAccessGrant: access.handleFolderAccessGrant, handleFolderAccessRequest: access.handleFolderAccessRequest, helloResponseAtRef, importKeysRef, pendingSharesRef, preloadFileContent: fileContent.preloadFileContent, rememberFolderPeer: peerActions.rememberFolderPeer, scheduleFolderSync: folderSync.scheduleFolderSync, selectedFileId, setCurrentFolderId, setDetailFileId, setExpandedPreviewOpen, setFolderKeys, setFolderPanelFolderId, setFolderPanelOpen, setNotice, setPendingShares, setSelectedFileId, setSnapshot, snapshotRef })
  envelopeHandlerRef.current = envelope.handleEnvelope
  const folderActions = createFolderActions({ announceFolderChange: folderSync.announceFolderChange, clearFolderSyncTimer: folderSync.clearFolderSyncTimer, currentFolder, currentFolderId, currentFolderKey, ensureFolderFilesStored: fileContent.ensureFolderFilesStored, folderKeysRef, folderPanelFolder, folderPanelFolderId, folders, networkRef, scheduleFolderSync: folderSync.scheduleFolderSync, setBusy, setCurrentFolderId, setDeleteRequest, setDetailFileId, setExpandedPreviewOpen, setFolderKeys, setFolderNameDraft, setFolderPanelFolderId, setFolderPanelOpen, setNotice, setProfileOpen, setSelectedFileId, setSettingsOpen, setSnapshot, settings, shareProfile, snapshot, snapshotRef, syncSignaturesRef })
  const moveActions = createMoveActions({ announceFolderChange: folderSync.announceFolderChange, ensureFileContent: fileContent.ensureFileContent, folderKeysRef, scheduleFolderSync: folderSync.scheduleFolderSync, setBusy, setFileContentCache, setFolderKeys, setNotice, setSnapshot, settings, snapshotRef })
  const fileActions = createFileActions({ announceFolderChange: folderSync.announceFolderChange, currentFolderId, deleteFolder: folderActions.deleteFolder, deleteRequest, ensureFileContent: fileContent.ensureFileContent, fileShareKeys, folderKeysRef, folders, networkRef, scheduleFolderSync: folderSync.scheduleFolderSync, setBusy, setCurrentFolderId, setDeleteRequest, setDetailFileId, setFileContentCache, setFileShareKeys, setFolderKeys, setFolderPanelOpen, setNotice, setProfileOpen, setSelectedItems, setSettingsOpen, setSnapshot, settings, shareProfile, snapshot, snapshotRef })
  const selection = createSelectionActions({ fileRows, files, folderRows, folders, moveActions, selectedItems, setDeleteRequest, setNotice, setSelectedItems })
  const dragDrop = createDragDropActions({ announceFolderChange: folderSync.announceFolderChange, browserViewMode, currentFolderId, dragItemRef, dragItemsRef, moveActions, scheduleFolderSync: folderSync.scheduleFolderSync, selectedItems, setDragActive, setDragItem, setDropTargetFolderId, setNotice, setReorderTarget, setSelectedItems, setSnapshot, settings, snapshotRef, uploadFiles: fileActions.uploadFiles })
  const avatarPicker = useProfileAvatarPicker({ canResolveFileContent: fileContent.canResolveFileContent, ensureFileContent: fileContent.ensureFileContent, fileContentCacheRef, fileDataUrls, preloadFileContent: fileContent.preloadFileContent, profileImageFiles, selectedAvatarFileId: settingsDraft.avatarFileId, setNotice, setSettingsDraft })

  useAppEffects({
    acceptLinkedShare: panel.acceptLinkedShare,
    announceSharedFolders: folderSync.announceSharedFolders,
    autoImportCidsRef,
    autoImportFolderShare: shareImport.autoImportFolderShare,
    autoImportInFlightRef,
    autoImportLinkedShare: shareImport.autoImportLinkedShare,
    browserViewMode,
    browserViewModeKey,
    canResolveFileContent: fileContent.canResolveFileContent,
    clearFolderSyncTimer: folderSync.clearFolderSyncTimer,
    currentFolder,
    currentFolderId,
    detailFileId,
    ensureFileContent: fileContent.ensureFileContent,
    expandedPreviewOpen,
    fileContentCache,
    fileContentCacheRef,
    fileDataUrls,
    fileRows,
    fileShareKeys,
    fileShareKeysRef,
    files,
    folderAccessModes,
    folderAccessModesRef,
    folderKeys,
    folderKeysRef,
    folderPeers,
    folders,
    handlePreviewKey: panel.handlePreviewKey,
    importKeys,
    importKeysRef,
    isPendingShareAlreadyImported: shareImport.isPendingShareAlreadyImported,
    markPendingShareImported: shareImport.markPendingShareImported,
    network,
    networkMode: network.state.mode,
    networkRef,
    peerCount: network.state.peers.length,
    stablePeerCount: network.state.stablePeers.length,
    stablePeerKey: network.state.stablePeers.toSorted().join(','),
    pendingShares,
    pendingSharesRef,
    preloadFileContent: fileContent.preloadFileContent,
    previewFiles,
    profileOpen,
    scheduleFolderSync: folderSync.scheduleFolderSync,
    requestFolderAccess: access.requestFolderAccess,
    selectedFile,
    selectedFileId,
    selectedPreviewFile,
    selectFolder: panel.selectFolder,
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

  useEffect(() => setSelectedItems([]), [currentFolderId])

  return {
    avatarUrl,
    beginCreateFolder: folderActions.beginCreateFolder,
    beginItemDrag: dragDrop.beginItemDrag,
    browserViewMode,
    busy,
    cancelCreateFolder: folderActions.cancelCreateFolder,
    cancelPendingShare: shareImport.cancelPendingShare,
    confirmCreateFolder: () => folderActions.confirmCreateFolder(folderNameDraft),
    confirmDelete: fileActions.confirmDelete,
    copyText: panel.copyText,
    currentFolder,
    currentFolderId,
    currentFolderStorageUsed,
    deleteCurrentFolder: folderActions.deleteCurrentFolder,
    deleteRequest,
    detailFileWithContent,
    detailFolderPeers,
    downloadProgress: transfer.downloadProgress,
    downloadFolderAsZip: fileContent.downloadFolderAsZip,
    downloadStoredFile: fileContent.downloadStoredFile,
    draftAvatarUrl,
    dragActive,
    dragItem,
    dropTargetFolderId,
    endItemDrag: dragDrop.endItemDrag,
    expandedPreviewOpen,
    fileLoadProgress: transfer.fileLoadProgress,
    fileDataUrls,
    fileRows,
    fileShareKeys,
    fileShareUrl,
    files,
    folderNameDraft,
    folderPanelAccessOnly,
    folderPanelFolder,
    folderPanelOpen,
    folderPanelAccessMode,
    folderPanelAccessRequests,
    folderPanelPeers,
    folderRows,
    folderShareUrl,
    handleBrowserItemDragLeave: dragDrop.handleBrowserItemDragLeave,
    handleBrowserItemDragOver: dragDrop.handleBrowserItemDragOver,
    handleBrowserItemDrop: dragDrop.handleBrowserItemDrop,
    handleDrag: dragDrop.handleDrag,
    handleDrop: dragDrop.handleDrop,
    handleMoveTargetDragLeave: dragDrop.handleMoveTargetDragLeave,
    handleMoveTargetDragOver: dragDrop.handleMoveTargetDragOver,
    handleMoveTargetDrop: dragDrop.handleMoveTargetDrop,
    importKeys,
    importShare: shareImport.importShare,
    movePopover: panel.movePopover,
    movePreview: panel.movePreview,
    networkState: network.state,
    notice,
    openFile: panel.openFile,
    openFolderPanel: panel.openFolderPanel,
    openProfile: panel.openProfile,
    openProfileAvatarImages: avatarPicker.openProfileAvatarImages,
    openSettings: panel.openSettings,
    patchCurrentFolder: folderActions.patchCurrentFolder,
    pendingFolderShares,
    pendingShares,
    popoverPositions,
    preloadFileContent: fileContent.preloadFileContent,
    previewFiles,
    previewFilesWithContent,
    profileAvatarImages: avatarPicker.profileAvatarImages,
    profileOpen,
    query,
    renameFile: fileActions.renameFile,
    reorderTarget,
    requestDeleteFile: fileActions.requestDeleteFile,
    requestDeleteFolder: folderActions.requestDeleteFolder,
    saveFolderToMist: folderActions.saveFolderToMist,
    saveProfileDraft: panel.saveProfileDraft,
    saveSettingsDraft: panel.saveSettingsDraft,
    selectFolder: panel.selectFolder,
    selectProfileAvatarImage: avatarPicker.selectProfileAvatarImage,
    selectedFileIndex,
    selectedPreviewFile,
    selectedPreviewProgress,
    selection,
    setBrowserViewMode, setDeleteRequest, setDetailFileId, setExpandedPreviewOpen, setFolderNameDraft,
    setFolderAccessModes, setFolderPanelOpen, setImportKeys, setProfileOpen, setQuery, setSettingsDraft, setSettingsOpen,
    settingsDraft,
    settingsOpen,
    shareFile: fileActions.shareFile,
    shareFolder: folderActions.shareFolder,
    approveFolderAccess: access.approveFolderAccess,
    rejectFolderAccess: access.rejectFolderAccess,
    showFileDetails: panel.showFileDetails,
    showFolderDetails: panel.showFolderDetails,
    snapshot,
    storageUsed,
    uploadFiles: fileActions.uploadFiles,
  }
}

export type AppController = ReturnType<typeof useAppController>
