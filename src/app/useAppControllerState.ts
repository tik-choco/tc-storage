import { useState } from 'preact/hooks'
import type { BrowserDragItem, BrowserReorderTarget, BrowserSortMode, BrowserViewMode, DeleteRequest, DownloadConfirmRequest, FolderAccessRequest, FolderPanelMode, Notice, PendingShare } from './appTypes.js'
import { loadBrowserSortMode, loadBrowserViewMode } from './appUtils.js'
import { initialPopoverPosition, type PopoverKind, type PopoverPosition } from '../components/FloatingPopover.js'
import type { StorageSnapshot } from '../storage/domain.js'
import { loadFileShareKeys } from '../crypto/fileShareKeys.js'
import { loadFolderAccessModes } from '../folder/folderAccess.js'
import { loadFolderKeys } from '../crypto/folderKeys.js'
import { loadFolderSyncPeers, type FolderSyncPeers } from '../folder/folderPeers.js'
import { readFolderRoute } from '../folder/folderRoute.js'
import { loadSettings, type AppSettings } from '../storage/localSettings.js'
import { loadStoredSnapshot } from '../storage/localSnapshot.js'
import { loadImportKeys, loadPendingShares } from '../share/pendingShares.js'
import { loadJoinedRooms, type JoinedRoom } from '../storage/joinedRooms.js'
import { shouldShowOnboarding } from '../storage/onboarding.js'
import { loadThemePreference, type ThemePreference } from '../storage/theme.js'

export function useAppControllerState() {
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
  const [browserSortMode, setBrowserSortMode] = useState<BrowserSortMode>(() => loadBrowserSortMode())
  const [browserViewMode, setBrowserViewMode] = useState<BrowserViewMode>(() => loadBrowserViewMode())
  const [pendingShares, setPendingShares] = useState<PendingShare[]>(() => loadPendingShares())
  const [joinedRooms, setJoinedRooms] = useState<JoinedRoom[]>(() => loadJoinedRooms())
  const [onboardingOpen, setOnboardingOpen] = useState(() => shouldShowOnboarding())
  const [folderAccessModes, setFolderAccessModes] = useState(() => loadFolderAccessModes())
  const [folderAccessRequests, setFolderAccessRequests] = useState<FolderAccessRequest[]>([])
  const [fileContentCache, setFileContentCache] = useState<Record<string, string>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => loadThemePreference())
  const [folderPanelOpen, setFolderPanelOpen] = useState(false)
  const [folderPanelMode, setFolderPanelMode] = useState<FolderPanelMode>('details')
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
  const [downloadConfirmRequest, setDownloadConfirmRequest] = useState<DownloadConfirmRequest | null>(null)
  const [popoverPositions, setPopoverPositions] = useState<Record<PopoverKind, PopoverPosition>>(() => ({
    profile: initialPopoverPosition('profile'),
    settings: initialPopoverPosition('settings'),
    detail: initialPopoverPosition('detail'),
    folder: initialPopoverPosition('folder'),
    confirm: initialPopoverPosition('confirm'),
  }))

  return {
    browserSortMode, browserViewMode, busy, currentFolderId, deleteRequest, detailFileId, downloadConfirmRequest, dragActive, dragItem, dropTargetFolderId,
    expandedPreviewOpen, fileContentCache, fileShareKeys, folderAccessModes, folderAccessRequests,
    folderKeys, folderNameDraft, folderPanelFolderId, folderPanelMode, folderPanelOpen, folderPeers, importKeys,
    joinedRooms, notice, onboardingOpen, pendingShares, popoverPositions, profileOpen, query, reorderTarget, selectedFileId, selectedItems,
    setBrowserSortMode, setBrowserViewMode, setBusy, setCurrentFolderId, setDeleteRequest, setDetailFileId, setDownloadConfirmRequest, setDragActive, setDragItem,
    setDropTargetFolderId, setExpandedPreviewOpen, setFileContentCache, setFileShareKeys, setFolderAccessModes,
    setFolderAccessRequests, setFolderKeys, setFolderNameDraft, setFolderPanelFolderId, setFolderPanelMode,
    setFolderPanelOpen, setFolderPeers, setImportKeys, setJoinedRooms, setNotice, setOnboardingOpen, setPendingShares, setPopoverPositions,
    setProfileOpen, setQuery, setReorderTarget, setSelectedFileId, setSelectedItems, setSettings, setSettingsDraft,
    setSettingsOpen, setSnapshot, setThemePreference, settings, settingsDraft, settingsOpen, snapshot, themePreference,
  }
}
