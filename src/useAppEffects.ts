import { useCallback, useEffect, type Dispatch, type StateUpdater } from 'preact/hooks'
import type { BrowserViewMode, Notice, PendingShare } from './appTypes.js'
import { activeAncestorFolderId, canPreloadThumbnail, folderLogDetails, isSeededLegacySnapshot, shareLogDetails, shortLogValue, syncLog } from './appUtils.js'
import { ensureDidIdentity, publicDidIdentity } from './didIdentity.js'
import type { FileRecord, FolderRecord, StorageSnapshot } from './domain.js'
import { describeError } from './errors.js'
import { saveFolderSyncPeers, type FolderSyncPeers } from './folderPeers.js'
import { readFolderRoute, replaceFolderRoute } from './folderRoute.js'
import { canAutoImportFolderShare, hasSharedFolderChangesSinceLastShare, sharedFolderSignature } from './folderSync.js'
import { ensureFolderKeys, saveFolderKeys } from './folderKeys.js'
import { saveFileShareKeys } from './fileShareKeys.js'
import { saveSettings, type AppSettings } from './localSettings.js'
import { persistSnapshot } from './localSnapshot.js'
import type { useMistShare } from './p2p.js'
import { saveImportKeys, savePendingShares } from './pendingShares.js'
import { useShareLinkImport, type LinkedShare } from './shareLinks.js'

type MutableRef<T> = { current: T }
type MistShare = ReturnType<typeof useMistShare>

interface AppEffectsOptions {
  acceptLinkedShare: (share: LinkedShare) => void
  announceSharedFolders: () => void
  autoImportFolderShare: (share: PendingShare, passphrase: string) => Promise<void>
  autoImportInFlightRef: MutableRef<Set<string>>
  autoImportCidsRef: MutableRef<Set<string>>
  autoImportLinkedShare: (share: PendingShare, passphrase: string) => Promise<void>
  browserViewMode: BrowserViewMode
  browserViewModeKey: string
  canResolveFileContent: (file: FileRecord) => boolean
  clearFolderSyncTimer: (folderId: string) => void
  currentFolder: FolderRecord | null
  currentFolderId: string | null
  detailFileId: string | null
  ensureFileContent: (file: FileRecord, options?: { trackProgress?: boolean }) => Promise<FileRecord>
  expandedPreviewOpen: boolean
  fileContentCacheRef: MutableRef<Record<string, string>>
  fileContentCache: Record<string, string>
  fileDataUrls: Record<string, string>
  fileRows: FileRecord[]
  fileShareKeys: Record<string, string>
  fileShareKeysRef: MutableRef<Record<string, string>>
  files: FileRecord[]
  folderKeys: Record<string, string>
  folderKeysRef: MutableRef<Record<string, string>>
  folderPeers: FolderSyncPeers
  folders: FolderRecord[]
  handlePreviewKey: (event: KeyboardEvent) => void
  importKeys: Record<string, string>
  importKeysRef: MutableRef<Record<string, string>>
  isPendingShareAlreadyImported: (share: PendingShare) => boolean
  markPendingShareImported: (share: PendingShare) => void
  network: MistShare
  networkRef: MutableRef<MistShare>
  pendingShares: PendingShare[]
  pendingSharesRef: MutableRef<PendingShare[]>
  preloadFileContent: (file: FileRecord) => void
  previewFiles: FileRecord[]
  profileOpen: boolean
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
  snapshotRef: MutableRef<StorageSnapshot>
  syncSignaturesRef: MutableRef<Record<string, string>>
  syncTimersRef: MutableRef<Record<string, number>>
  networkMode: string
  peerCount: number
  selectFolder: (folderId: string | null) => void
}

export function useAppEffects(options: AppEffectsOptions): void {
  const {
    acceptLinkedShare, announceSharedFolders, autoImportCidsRef, autoImportFolderShare, autoImportInFlightRef, autoImportLinkedShare,
    browserViewMode, browserViewModeKey, canResolveFileContent, clearFolderSyncTimer, currentFolder,
    currentFolderId, detailFileId, ensureFileContent, expandedPreviewOpen, fileContentCache, fileContentCacheRef, fileDataUrls,
    fileRows, fileShareKeys, fileShareKeysRef, files, folderKeys, folderKeysRef, folderPeers, folders,
    handlePreviewKey, importKeys, importKeysRef, isPendingShareAlreadyImported, markPendingShareImported,
    network, networkRef, networkMode, peerCount, pendingShares, pendingSharesRef, preloadFileContent,
    previewFiles, profileOpen, scheduleFolderSync, selectedFile, selectedFileId, selectedPreviewFile,
    selectFolder, setCurrentFolderId, setDetailFileId, setExpandedPreviewOpen, setFolderKeys,
    setFolderNameDraft, setNotice, setSelectedFileId, setSettings, setSettingsDraft, settings, settingsOpen,
    setSnapshot, settingsRef, snapshot, snapshotRef, syncSignaturesRef, syncTimersRef,
  } = options

  useEffect(() => { snapshotRef.current = snapshot }, [snapshot])
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
    }).catch((error) => setNotice({ tone: 'error', text: describeError(error, 'Ed25519 DIDの生成に失敗しました') }))
    return () => { cancelled = true }
  }, [])
  useEffect(() => persistSnapshot(snapshot), [snapshot])
  useEffect(() => { saveSettings(settings); saveFolderKeys(folderKeys); saveFileShareKeys(fileShareKeys); saveFolderSyncPeers(folderPeers) }, [settings, folderKeys, fileShareKeys, folderPeers])
  useEffect(() => { savePendingShares(pendingShares); saveImportKeys(importKeys) }, [importKeys, pendingShares])
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
    if (browserViewMode !== 'grid') return
    for (const file of fileRows.filter((item) => canPreloadThumbnail(item) && canResolveFileContent(item)).slice(0, 24)) {
      if (file.dataUrl || fileDataUrls[file.id]) continue
      preloadFileContent(file)
    }
  }, [browserViewMode, fileDataUrls, fileRows, fileShareKeys, folderKeys])
  useEffect(() => {
    if (!settings.avatarFileId || fileDataUrls[settings.avatarFileId]) return
    const file = files.find((item) => item.id === settings.avatarFileId)
    if (file && canResolveFileContent(file)) preloadFileContent(file)
  }, [fileDataUrls, fileShareKeys, files, folderKeys, settings.avatarFileId])
  useShareLinkImport(useCallback(acceptLinkedShare, []))
  useEffect(() => {
    const sharedFolders = snapshot.folders.filter((folder) => folder.shareEnabled && folderKeys[folder.id])
    const sharedIds = new Set(sharedFolders.map((folder) => folder.id))
    for (const folderId of Object.keys(syncSignaturesRef.current)) {
      if (!sharedIds.has(folderId)) {
        syncLog('stop tracking shared folder signature', { folderId })
        clearFolderSyncTimer(folderId)
        delete syncSignaturesRef.current[folderId]
      }
    }
    for (const folder of sharedFolders) {
      const signature = sharedFolderSignature(snapshot, folder.id)
      const previous = syncSignaturesRef.current[folder.id]
      if (!previous) {
        syncSignaturesRef.current[folder.id] = signature
        const hasLocalChanges = hasSharedFolderChangesSinceLastShare(snapshot, folder)
        syncLog('start tracking shared folder signature', { ...folderLogDetails(folder), hasLocalChanges })
        if (hasLocalChanges) scheduleFolderSync(folder.id, 'initial shared folder has local changes')
        continue
      }
      if (previous === signature) continue
      syncSignaturesRef.current[folder.id] = signature
      syncLog('local shared folder signature changed', folderLogDetails(folder))
      scheduleFolderSync(folder.id, 'local shared folder changed')
    }
  }, [folderKeys, snapshot])
  useEffect(() => {
    for (const share of pendingShares) {
      if (!share.cid) continue
      const linkedPassphrase = importKeys[share.cid]?.trim() ?? ''
      if (share.autoImport && linkedPassphrase) {
        if (autoImportCidsRef.current.has(share.cid) || autoImportInFlightRef.current.has(share.cid)) continue
        if (isPendingShareAlreadyImported(share)) {
          markPendingShareImported(share)
          continue
        }
        void autoImportLinkedShare(share, linkedPassphrase)
        continue
      }
      if (share.type !== 'folder-share' || !share.folderId) continue
      const folder = snapshot.folders.find((item) => item.id === share.folderId)
      const passphrase = folderKeys[share.folderId]
      if (!folder || !passphrase || !canAutoImportFolderShare({ folder, incomingCid: share.cid, passphrase })) continue
      if (autoImportCidsRef.current.has(share.cid) || autoImportInFlightRef.current.has(share.cid)) continue
      syncLog('pending folder-share accepted: storage_get will start', { ...shareLogDetails(share), localCid: shortLogValue(folder.lastCid) })
      void autoImportFolderShare(share, passphrase)
    }
  }, [folderKeys, importKeys, networkMode, peerCount, pendingShares, snapshot.files, snapshot.folders])
  useEffect(() => () => {
    for (const timer of Object.values(syncTimersRef.current)) window.clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!settings.autoConnect) return undefined
    const timer = window.setInterval(announceSharedFolders, 8000)
    return () => window.clearInterval(timer)
  }, [settings.autoConnect])
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
}
