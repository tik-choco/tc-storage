import { useEffect, useRef, type Dispatch, type StateUpdater } from 'preact/hooks'
import type { FileContentFailure } from './appControllerTypes.js'
import { failedThumbnailRetryPeerKey, shouldPreloadProfileAvatar, shouldRetryFileContentFailureAfterPeerConnection } from './appEffectUtils.js'
import type { BrowserSortMode, BrowserViewMode, FolderAccessMode, Notice, PendingShare } from './appTypes.js'
import { activeAncestorFolderId, canPreloadPreviewContent, isSeededLegacySnapshot, syncLog } from './appUtils.js'
import { ensureDidIdentity, publicDidIdentity } from '../crypto/didIdentity.js'
import { reconcileSharedDidIdentity } from '../crypto/sharedDidIdentity.js'
import { createMistDidIdentityBackend } from '../storage/mistStorage.js'
import type { FileRecord, FolderRecord, StorageSnapshot } from '../storage/domain.js'
import { describeError } from '../util/errors.js'
import { debugWarn } from '../util/logging.js'
import { saveFolderSyncPeers, type FolderSyncPeers } from '../folder/folderPeers.js'
import { saveJoinedRooms, type JoinedRoom } from '../storage/joinedRooms.js'
import { readFolderRoute, replaceFolderRoute } from '../folder/folderRoute.js'
import { ensureFolderKeys, saveFolderKeys } from '../crypto/folderKeys.js'
import { saveFolderAccessModes } from '../folder/folderAccess.js'
import { saveFileShareKeys } from '../crypto/fileShareKeys.js'
import { saveSettings, type AppSettings } from '../storage/localSettings.js'
import { persistSnapshot } from '../storage/localSnapshot.js'
import type { useMistShare } from '../p2p/p2p.js'
import { saveImportKeys, savePendingShares } from '../share/pendingShares.js'
import { useShareLinkImport, type LinkedShare } from '../share/shareLinks.js'
import { useAppShareEffects } from './useAppShareEffects.js'
import { useDriveIndexPublishEffect } from './useDriveIndexPublishEffect.js'
import { useFolderImportEffect } from './useFolderImportEffect.js'

type MutableRef<T> = { current: T }
type MistShare = ReturnType<typeof useMistShare>

interface AppEffectsOptions {
  acceptLinkedShare: (share: LinkedShare) => void
  announceSharedFolders: (options?: { publishLocalChangesImmediately?: boolean }) => void
  autoImportFolderShare: (share: PendingShare, passphrase: string) => Promise<void>
  autoImportInFlightRef: MutableRef<Set<string>>
  autoImportCidsRef: MutableRef<Set<string>>
  autoImportLinkedShare: (share: PendingShare, passphrase: string, options?: { force?: boolean }) => Promise<void>
  browserViewMode: BrowserViewMode
  browserViewModeKey: string
  browserSortMode: BrowserSortMode
  browserSortModeKey: string
  canResolveFileContent: (file: FileRecord) => boolean
  clearFolderSyncTimer: (folderId: string) => void
  currentFolder: FolderRecord | null
  currentFolderId: string | null
  detailFileId: string | null
  ensureFileContent: (file: FileRecord, options?: { suppressRepairRequest?: boolean; trackProgress?: boolean }) => Promise<FileRecord>
  expandedPreviewOpen: boolean
  fileContentCacheRef: MutableRef<Record<string, string>>
  fileContentFailuresRef: MutableRef<Record<string, FileContentFailure>>
  fileContentCache: Record<string, string>
  fileDataUrls: Record<string, string>
  fileShareKeys: Record<string, string>
  fileShareKeysRef: MutableRef<Record<string, string>>
  files: FileRecord[]
  folderAccessModes: Record<string, FolderAccessMode>
  folderAccessModesRef: MutableRef<Record<string, FolderAccessMode>>
  folderKeys: Record<string, string>
  folderKeysRef: MutableRef<Record<string, string>>
  folderPeers: FolderSyncPeers
  folders: FolderRecord[]
  handlePreviewKey: (event: KeyboardEvent) => void
  importKeys: Record<string, string>
  importKeysRef: MutableRef<Record<string, string>>
  joinedRooms: JoinedRoom[]
  isPendingShareAlreadyImported: (share: PendingShare) => boolean
  markPendingShareImported: (share: PendingShare) => void
  network: MistShare
  networkRef: MutableRef<MistShare>
  pendingShares: PendingShare[]
  pendingSharesRef: MutableRef<PendingShare[]>
  preloadFileContent: (file: FileRecord) => void
  previewFiles: FileRecord[]
  profileOpen: boolean
  requestFolderAccess: (share: PendingShare) => Promise<void>
  scheduleFolderSync: (folderId: string, reason: string) => void
  selectedFile: FileRecord | null
  selectedFileId: string | null
  selectedPreviewFile: FileRecord | null
  setCurrentFolderId: Dispatch<StateUpdater<string | null>>
  setDetailFileId: Dispatch<StateUpdater<string | null>>
  setExpandedPreviewOpen: Dispatch<StateUpdater<boolean>>
  setFolderKeys: Dispatch<StateUpdater<Record<string, string>>>
  setFolderNameDraft: Dispatch<StateUpdater<string | null>>
  setNotice: Dispatch<StateUpdater<Notice>>
  setSelectedFileId: Dispatch<StateUpdater<string | null>>
  setSettings: Dispatch<StateUpdater<AppSettings>>
  setSettingsDraft: Dispatch<StateUpdater<AppSettings>>
  setSnapshot: Dispatch<StateUpdater<StorageSnapshot>>
  settings: AppSettings
  settingsOpen: boolean
  settingsRef: MutableRef<AppSettings>
  snapshot: StorageSnapshot
  snapshotLoadedFromStorage: boolean
  snapshotRef: MutableRef<StorageSnapshot>
  syncSignaturesRef: MutableRef<Record<string, string>>
  syncTimersRef: MutableRef<Record<string, number>>
  networkMode: string
  stablePeerCount: number
  stablePeerKey: string
  selectFolder: (folderId: string | null) => void
}

export function useAppEffects(options: AppEffectsOptions): void {
  const {
    acceptLinkedShare, announceSharedFolders, autoImportCidsRef, autoImportFolderShare, autoImportInFlightRef, autoImportLinkedShare,
    browserSortMode, browserSortModeKey, browserViewMode, browserViewModeKey, canResolveFileContent, clearFolderSyncTimer, currentFolder,
    currentFolderId, detailFileId, ensureFileContent, expandedPreviewOpen, fileContentCache, fileContentCacheRef, fileDataUrls,
    fileContentFailuresRef, fileShareKeys, fileShareKeysRef, files, folderAccessModes, folderAccessModesRef, folderKeys, folderKeysRef, folderPeers, folders,
    handlePreviewKey, importKeys, importKeysRef, isPendingShareAlreadyImported, joinedRooms, markPendingShareImported,
    network, networkRef, networkMode, pendingShares, pendingSharesRef, preloadFileContent,
    previewFiles, profileOpen, requestFolderAccess, scheduleFolderSync, selectedFile, selectedFileId, selectedPreviewFile,
    selectFolder, setCurrentFolderId, setDetailFileId, setExpandedPreviewOpen, setFolderKeys,
    setFolderNameDraft, setNotice, setSelectedFileId, setSettings, setSettingsDraft, settings, settingsOpen,
    setSnapshot, settingsRef, snapshot, snapshotLoadedFromStorage, snapshotRef, stablePeerCount, stablePeerKey, syncSignaturesRef, syncTimersRef,
  } = options
  const lastFailedThumbnailRetryPeerKeyRef = useRef('')
  const persistFailureNoticeShownRef = useRef(false)
  const settingsPersistFailureNoticeShownRef = useRef(false)

  useEffect(() => { snapshotRef.current = snapshot }, [snapshot])
  useEffect(() => { folderAccessModesRef.current = folderAccessModes }, [folderAccessModes])
  useEffect(() => { folderKeysRef.current = folderKeys }, [folderKeys])
  useEffect(() => { fileShareKeysRef.current = fileShareKeys }, [fileShareKeys])
  useEffect(() => { fileContentCacheRef.current = fileContentCache }, [fileContentCache])
  useEffect(() => { importKeysRef.current = importKeys }, [importKeys])
  useEffect(() => { pendingSharesRef.current = pendingShares }, [pendingShares])
  useEffect(() => { settingsRef.current = settings }, [settings])
  useEffect(() => { networkRef.current = network }, [network])
  useEffect(() => {
    let cancelled = false
    void ensureDidIdentity().then((identity) => {
      if (cancelled) return
      const publicIdentity = publicDidIdentity(identity)
      setSettings((current) => (
        current.nodeId === identity.did && current.identity?.did === identity.did
          ? current
          : { ...current, nodeId: identity.did, identity: publicIdentity }
      ))
      setSnapshot((current) => (
        isSeededLegacySnapshot(current)
          ? {
            ...current,
            originNode: identity.did,
            activity: current.activity.map((entry) => ({ ...entry, actorNodeId: identity.did })),
          }
          : current
      ))
      void reconcileSharedDidIdentity({
        localIdentity: identity,
        backend: createMistDidIdentityBackend(identity.did),
        storage: localStorage,
      }).catch((error) => console.warn('tc-storage: shared DID identity reconciliation failed', error))
    }).catch((error) => setNotice({ tone: 'error', text: describeError(error, 'Ed25519 DIDの生成に失敗しました') }))
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (persistSnapshot(snapshot)) return
    if (persistFailureNoticeShownRef.current) return
    persistFailureNoticeShownRef.current = true
    setNotice({ tone: 'error', text: 'ローカル保存に失敗しました(ブラウザの保存容量が上限に達しています)。古いサイトデータの削除やファイルのバックアップを検討してください。' })
  }, [snapshot])
  useDriveIndexPublishEffect({ folderKeys, settingsRef, snapshot })
  useEffect(() => {
    // Each save is independent: one throwing (e.g. QuotaExceededError) must not
    // prevent the rest from persisting. folderKeys/fileShareKeys additionally
    // report success/failure themselves (they never throw).
    let anyFailed = false
    const persist = (label: string, save: () => void) => {
      try {
        save()
      } catch (error) {
        anyFailed = true
        debugWarn('app-effects', `failed to persist ${label}`, { error: error instanceof Error ? error.message : String(error) })
      }
    }
    persist('settings', () => saveSettings(settings))
    persist('folder access modes', () => saveFolderAccessModes(folderAccessModes))
    // If the initial load fell back to an empty snapshot (corrupt/missing storage), the
    // in-memory folders/files list does not reflect what may still exist elsewhere (other
    // storage, or a peer to sync from later). Pruning against it would permanently delete
    // decryption keys for content that isn't actually gone, so skip pruning in that case.
    if (!saveFolderKeys(folderKeys, snapshotLoadedFromStorage ? snapshotRef.current.folders.map((folder) => folder.id) : undefined)) anyFailed = true
    if (!saveFileShareKeys(fileShareKeys, snapshotLoadedFromStorage ? snapshotRef.current.files.map((file) => file.id) : undefined)) anyFailed = true
    persist('folder sync peers', () => saveFolderSyncPeers(folderPeers))
    persist('joined rooms', () => saveJoinedRooms(joinedRooms))
    if (anyFailed && !settingsPersistFailureNoticeShownRef.current) {
      settingsPersistFailureNoticeShownRef.current = true
      setNotice({ tone: 'error', text: 'ローカル保存に失敗しました(ブラウザの保存容量が上限に達しています)。古いサイトデータの削除やファイルのバックアップを検討してください。' })
    }
  }, [settings, folderAccessModes, folderKeys, fileShareKeys, folderPeers, joinedRooms, snapshotLoadedFromStorage])
  useEffect(() => {
    const sharesSaved = savePendingShares(pendingShares)
    const keysSaved = saveImportKeys(importKeys)
    if ((sharesSaved && keysSaved) || settingsPersistFailureNoticeShownRef.current) return
    settingsPersistFailureNoticeShownRef.current = true
    setNotice({ tone: 'error', text: 'ローカル保存に失敗しました(ブラウザの保存容量が上限に達しています)。古いサイトデータの削除やファイルのバックアップを検討してください。' })
  }, [importKeys, pendingShares])
  useEffect(() => localStorage.setItem(browserSortModeKey, browserSortMode), [browserSortMode, browserSortModeKey])
  useEffect(() => localStorage.setItem(browserViewModeKey, browserViewMode), [browserViewMode, browserViewModeKey])
  useEffect(() => setSettingsDraft(settings), [profileOpen, settings, settingsOpen])
  useEffect(() => setFolderKeys((current) => ensureFolderKeys(folders, current)), [folders])
  useEffect(() => replaceFolderRoute(currentFolderId), [currentFolderId])
  useEffect(() => { document.title = currentFolder ? `${currentFolder.name} - TC Storage` : 'TC Storage' }, [currentFolder])
  useEffect(() => {
    const handlePopState = () => selectFolder(readFolderRoute())
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])
  useEffect(() => {
    if (!currentFolderId || currentFolder) return
    const fallbackFolderId = activeAncestorFolderId(snapshot, currentFolderId)
    syncLog('current folder is no longer active; leaving deleted folder', { folderId: currentFolderId, fallbackFolderId })
    setCurrentFolderId(fallbackFolderId)
    setFolderNameDraft(null)
  }, [currentFolder, currentFolderId, snapshot])
  useEffect(() => {
    if (!shouldPreloadProfileAvatar({ avatarFileId: settings.avatarFileId, hasDataUrl: Boolean(fileDataUrls[settings.avatarFileId]), profileOpen })) return
    const file = files.find((item) => item.id === settings.avatarFileId)
    if (file && canResolveFileContent(file)) preloadFileContent(file)
  }, [fileDataUrls, fileShareKeys, files, folderKeys, profileOpen, settings.avatarFileId])
  useEffect(() => {
    const retryPeerKey = failedThumbnailRetryPeerKey({ networkMode, stablePeerCount, stablePeerKey })
    if (!retryPeerKey) {
      lastFailedThumbnailRetryPeerKeyRef.current = ''
      return
    }
    if (lastFailedThumbnailRetryPeerKeyRef.current === retryPeerKey) return
    lastFailedThumbnailRetryPeerKeyRef.current = retryPeerKey
    const retryableIds = Object.entries(fileContentFailuresRef.current)
      .filter(([, failure]) => shouldRetryFileContentFailureAfterPeerConnection(failure))
      .map(([fileId]) => fileId)
    if (retryableIds.length === 0) return
    for (const fileId of retryableIds) delete fileContentFailuresRef.current[fileId]
    syncLog('retrying failed preview preloads after stable peer connection', { failedCount: retryableIds.length, stablePeerCount })
    const failed = new Set(retryableIds)
    for (const file of files) {
      if (failed.has(file.id) && canPreloadPreviewContent(file) && canResolveFileContent(file)) preloadFileContent(file)
    }
  }, [canResolveFileContent, fileContentFailuresRef, files, networkMode, preloadFileContent, stablePeerCount, stablePeerKey])
  useShareLinkImport(acceptLinkedShare)
  useFolderImportEffect({ setFolderKeys, setNotice, setSnapshot, settingsRef })
  useAppShareEffects({
    announceSharedFolders, autoImportCidsRef, autoImportFolderShare, autoImportInFlightRef, autoImportLinkedShare,
    clearFolderSyncTimer, folderKeys, importKeys, isPendingShareAlreadyImported, markPendingShareImported, network,
    networkMode, pendingShares, requestFolderAccess, scheduleFolderSync, settings, snapshot, stablePeerCount,
    stablePeerKey, syncSignaturesRef, syncTimersRef,
  })
  useEffect(() => { if (selectedFileId && !files.some((file) => file.id === selectedFileId)) { setSelectedFileId(null); setExpandedPreviewOpen(false) } }, [files, selectedFileId])
  useEffect(() => { if (detailFileId && !files.some((file) => file.id === detailFileId)) setDetailFileId(null) }, [detailFileId, files])
  useEffect(() => {
    if (!expandedPreviewOpen || !selectedFileId) return
    const handler = (event: KeyboardEvent) => handlePreviewKey(event)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [expandedPreviewOpen, previewFiles, selectedFileId])
  useEffect(() => {
    if (!expandedPreviewOpen || !selectedFile || selectedPreviewFile?.dataUrl || !canResolveFileContent(selectedFile)) return
    let cancelled = false
    void ensureFileContent(selectedFile, { trackProgress: true }).catch((error) => {
      if (!cancelled) setNotice({ tone: 'error', text: describeError(error, 'ファイル本文を取得できませんでした') })
    })
    return () => { cancelled = true }
  }, [expandedPreviewOpen, selectedFile?.id, selectedPreviewFile?.dataUrl])
  useEffect(() => {
    if (!expandedPreviewOpen || !selectedFileId) return
    const currentIndex = previewFiles.findIndex((file) => file.id === selectedFileId)
    if (currentIndex < 0) return
    for (const file of [previewFiles[currentIndex - 1], previewFiles[currentIndex + 1]]) {
      if (!file || fileDataUrls[file.id] || !canPreloadPreviewContent(file) || !canResolveFileContent(file)) continue
      preloadFileContent(file)
    }
  }, [canResolveFileContent, expandedPreviewOpen, fileDataUrls, preloadFileContent, previewFiles, selectedFileId])
}
