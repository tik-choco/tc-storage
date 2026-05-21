import { useState } from 'preact/hooks'
import type { BrowserDragItem, BrowserReorderTarget, BrowserViewMode, DeleteRequest, FolderAccessRequest, FolderPanelMode, Notice, PendingShare } from './appTypes.js'
import { loadBrowserViewMode } from './appUtils.js'
import { initialPopoverPosition, type PopoverKind, type PopoverPosition } from './components/FloatingPopover.js'
import type { StorageSnapshot } from './domain.js'
import { loadFileShareKeys } from './fileShareKeys.js'
import { loadFolderAccessModes } from './folderAccess.js'
import { loadFolderKeys } from './folderKeys.js'
import { loadFolderSyncPeers, type FolderSyncPeers } from './folderPeers.js'
import { readFolderRoute } from './folderRoute.js'
import { loadSettings, type AppSettings } from './localSettings.js'
import { loadStoredSnapshot } from './localSnapshot.js'
import { loadImportKeys, loadPendingShares } from './pendingShares.js'

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
  const [browserViewMode, setBrowserViewMode] = useState<BrowserViewMode>(() => loadBrowserViewMode())
  const [pendingShares, setPendingShares] = useState<PendingShare[]>(() => loadPendingShares())
  const [folderAccessModes, setFolderAccessModes] = useState(() => loadFolderAccessModes())
  const [folderAccessRequests, setFolderAccessRequests] = useState<FolderAccessRequest[]>([])
  const [fileContentCache, setFileContentCache] = useState<Record<string, string>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
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
  const [popoverPositions, setPopoverPositions] = useState<Record<PopoverKind, PopoverPosition>>(() => ({
    profile: initialPopoverPosition('profile'),
    settings: initialPopoverPosition('settings'),
    detail: initialPopoverPosition('detail'),
    folder: initialPopoverPosition('folder'),
    confirm: initialPopoverPosition('confirm'),
  }))

  return {
    browserViewMode, busy, currentFolderId, deleteRequest, detailFileId, dragActive, dragItem, dropTargetFolderId,
    expandedPreviewOpen, fileContentCache, fileShareKeys, folderAccessModes, folderAccessRequests,
    folderKeys, folderNameDraft, folderPanelFolderId, folderPanelMode, folderPanelOpen, folderPeers, importKeys,
    notice, pendingShares, popoverPositions, profileOpen, query, reorderTarget, selectedFileId, selectedItems,
    setBrowserViewMode, setBusy, setCurrentFolderId, setDeleteRequest, setDetailFileId, setDragActive, setDragItem,
    setDropTargetFolderId, setExpandedPreviewOpen, setFileContentCache, setFileShareKeys, setFolderAccessModes,
    setFolderAccessRequests, setFolderKeys, setFolderNameDraft, setFolderPanelFolderId, setFolderPanelMode,
    setFolderPanelOpen, setFolderPeers, setImportKeys, setNotice, setPendingShares, setPopoverPositions,
    setProfileOpen, setQuery, setReorderTarget, setSelectedFileId, setSelectedItems, setSettings, setSettingsDraft,
    setSettingsOpen, setSnapshot, settings, settingsDraft, settingsOpen, snapshot,
  }
}
