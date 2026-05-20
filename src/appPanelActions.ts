import type { PendingShare } from './appTypes.js'
import type { SetState } from './appControllerTypes.js'
import { copyToClipboard } from './clipboard.js'
import type { FileRecord, FolderRecord } from './domain.js'
import type { AppSettings } from './localSettings.js'
import type { LinkedShare } from './shareLinks.js'
import type { Notice } from './appTypes.js'
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
    setExpandedPreviewOpen, setFolderNameDraft, setFolderPanelFolderId, setFolderPanelOpen, setImportKeys,
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

  function copyText(value: string, label: string) {
    void copyToClipboard(value).then((ok) => setNotice({ tone: ok ? 'success' : 'error', text: ok ? `${label} をコピーしました` : `${label} をコピーできませんでした` }))
  }

  function acceptLinkedShare({ share, key }: LinkedShare) {
    const linkedShare = { ...share, autoImport: true }
    setPendingShares((current) => [linkedShare, ...current.filter((item) => item.cid !== share.cid)].slice(0, 12))
    if (share.cid) setImportKeys((current) => ({ ...current, [share.cid ?? '']: key }))
    setSettings((current) => current.roomId === share.roomId ? current : { ...current, roomId: share.roomId })
    setCurrentFolderId(null)
    setSettingsOpen(false)
    setProfileOpen(false)
    setFolderPanelFolderId(null)
    setFolderPanelOpen(true)
    setDetailFileId(null)
    setSelectedFileId(null)
    setExpandedPreviewOpen(false)
    setNotice({ tone: 'info', text: '共有URLを読み込みました。取得を開始します' })
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

  return { acceptLinkedShare, copyText, handlePreviewKey, movePopover, movePreview, openFile, openFolderPanel, openProfile, openSettings, saveProfileDraft, saveSettingsDraft, selectFolder, showFileDetails, showFolderDetails }
}
