import { pendingShareKey, type FolderPanelMode, type Notice, type PendingShare } from './appTypes.js'
import type { SetState } from './appControllerTypes.js'
import { copyToClipboard } from './clipboard.js'
import type { FileRecord, FolderRecord } from './domain.js'
import { defaultRoomId, type AppSettings } from './localSettings.js'
import type { LinkedShare } from './shareLinks.js'
import type { PopoverKind, PopoverPosition } from './components/FloatingPopover.js'
import { popoverPositionFromAnchor } from './components/FloatingPopover.js'

interface PanelOptions {
  previewFiles: FileRecord[]
  profileImageFiles: FileRecord[]
  selectedFileId: string | null
  setCurrentFolderId: SetState<string | null>
  setDetailFileId: SetState<string | null>
  setExpandedPreviewOpen: SetState<boolean>
  setFolderNameDraft: SetState<string | null>
  setFolderPanelFolderId: SetState<string | null>
  setFolderPanelMode: SetState<FolderPanelMode>
  setFolderPanelOpen: SetState<boolean>
  setImportKeys: SetState<Record<string, string>>
  setNotice: SetState<Notice>
  setPendingShares: SetState<PendingShare[]>
  setPopoverPositions: SetState<Record<PopoverKind, PopoverPosition>>
  setProfileOpen: SetState<boolean>
  setSelectedFileId: SetState<string | null>
  setSettings: SetState<AppSettings>
  setSettingsOpen: SetState<boolean>
  settings: AppSettings
  settingsDraft: AppSettings
}

export function createPanelActions(options: PanelOptions) {
  const {
    previewFiles, profileImageFiles, selectedFileId, setCurrentFolderId, setDetailFileId,
    setExpandedPreviewOpen, setFolderNameDraft, setFolderPanelFolderId, setFolderPanelMode, setFolderPanelOpen, setImportKeys,
    setNotice, setPendingShares, setPopoverPositions, setProfileOpen, setSelectedFileId,
    setSettings, setSettingsOpen, settings, settingsDraft,
  } = options

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
    const avatarFileId = settingsDraft.avatarFileId && profileImageFiles.some((file) => file.id === settingsDraft.avatarFileId) ? settingsDraft.avatarFileId : ''
    return {
      ...settingsDraft,
      roomId: settingsDraft.roomId.trim() || defaultRoomId(),
      nodeId: settings.nodeId,
      identity: settings.identity,
      profileName: settingsDraft.profileName.trim() || 'Local user',
      avatarUrl: '',
      avatarFileId,
    }
  }

  function copyText(value: string, label: string) {
    void copyToClipboard(value).then((ok) => setNotice({ tone: ok ? 'success' : 'error', text: ok ? `${label} をコピーしました` : `${label} をコピーできませんでした` }))
  }

  function acceptLinkedShare({ share, key }: LinkedShare) {
    const linkedShare = { ...share, autoImport: true }
    const keyValue = pendingShareKey(share)
    setPendingShares((current) => [linkedShare, ...current.filter((item) => pendingShareKey(item) !== keyValue)].slice(0, 12))
    if (share.cid) setImportKeys((current) => ({ ...current, [share.cid ?? '']: key }))
    setSettings((current) => current.roomId === share.roomId && current.autoConnect ? current : { ...current, roomId: share.roomId, autoConnect: true })
    setCurrentFolderId(null)
    setSettingsOpen(false)
    setProfileOpen(false)
    setFolderPanelFolderId(null)
    setFolderPanelMode('details')
    setFolderPanelOpen(false)
    setDetailFileId(null)
    setSelectedFileId(null)
    setExpandedPreviewOpen(false)
    setNotice({ tone: 'info', text: share.type === 'folder-share' && !share.cid ? '共有URLを読み込みました。共有ルームへ接続して参加承認をリクエストします' : '共有URLを読み込みました。共有ルームへ接続して取得を開始します' })
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
    setFolderPanelMode('details')
    setFolderPanelOpen(true)
    setSettingsOpen(false)
    setProfileOpen(false)
    setDetailFileId(null)
  }

  function showFolderShare(folder: FolderRecord, anchor?: HTMLElement) {
    if (anchor) movePopover('folder', popoverPositionFromAnchor(anchor, 360))
    setFolderPanelFolderId(folder.id)
    setFolderPanelMode('share')
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
    setFolderPanelMode('details')
    setFolderPanelOpen(true)
    setSettingsOpen(false)
    setProfileOpen(false)
    setDetailFileId(null)
  }

  function openFolderSharePanel(anchor?: HTMLElement) {
    if (anchor) movePopover('folder', popoverPositionFromAnchor(anchor, 360))
    setFolderPanelFolderId(null)
    setFolderPanelMode('share')
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

  return { acceptLinkedShare, copyText, handlePreviewKey, movePopover, movePreview, openFile, openFolderPanel, openFolderSharePanel, openProfile, openSettings, saveProfileDraft, saveSettingsDraft, selectFolder, showFileDetails, showFolderDetails, showFolderShare }
}
