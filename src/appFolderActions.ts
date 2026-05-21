import type { DeleteRequest, Notice } from './appTypes.js'
import type { FileContentActions, MistShare, MutableRef, SetState } from './appControllerTypes.js'
import { descendantFolderIds, nextFolderName } from './appHelpers.js'
import { folderColors, nearestSharedAncestorFolder } from './appUtils.js'
import { reserveClipboardWrite, writeReservedClipboard } from './clipboard.js'
import { stampFilePatch, stampFolderPatch } from './crdt.js'
import { addActivity, childFolders, makeFolder, stripFileContent, touchSnapshot, type FileRecord, type FolderRecord, type StorageSnapshot } from './domain.js'
import { describeError } from './errors.js'
import { folderFilesForSync, foldersForSync, sharedFolderSignature } from './folderSync.js'
import { generateFolderKey } from './folderKeys.js'
import type { AppSettings } from './localSettings.js'
import { saveEncryptedFolderToMist } from './mistStorage.js'
import type { ShareProfile } from './p2p.js'
import { makeFolderShareUrl } from './shareLinks.js'

interface FolderActionOptions {
  announceFolderChange: (folder: FolderRecord, changeType: 'folder-upserted' | 'folder-deleted', file?: FileRecord, changedFolder?: FolderRecord) => void
  clearFolderSyncTimer: (folderId: string) => void
  currentFolder: FolderRecord | null
  currentFolderId: string | null
  currentFolderKey: string
  ensureFolderFilesStored: FileContentActions['ensureFolderFilesStored']
  folderPanelFolder: FolderRecord | null
  folderPanelFolderId: string | null
  folderKeysRef: MutableRef<Record<string, string>>
  folders: FolderRecord[]
  networkRef: MutableRef<MistShare>
  scheduleFolderSync: (folderId: string, reason: string) => void
  setBusy: SetState<string>
  setCurrentFolderId: SetState<string | null>
  setDetailFileId: SetState<string | null>
  setDeleteRequest: SetState<DeleteRequest | null>
  setExpandedPreviewOpen: SetState<boolean>
  setFolderKeys: SetState<Record<string, string>>
  setFolderNameDraft: SetState<string | null>
  setFolderPanelFolderId: SetState<string | null>
  setFolderPanelOpen: SetState<boolean>
  setNotice: SetState<Notice>
  setProfileOpen: SetState<boolean>
  setSelectedFileId: SetState<string | null>
  setSettingsOpen: SetState<boolean>
  setSnapshot: SetState<StorageSnapshot>
  settings: AppSettings
  shareProfile: ShareProfile
  snapshot: StorageSnapshot
  snapshotRef: MutableRef<StorageSnapshot>
  syncSignaturesRef: MutableRef<Record<string, string>>
}

export function createFolderActions(options: FolderActionOptions) {
  const {
    announceFolderChange, clearFolderSyncTimer, currentFolder, currentFolderId, currentFolderKey,
    ensureFolderFilesStored, folderKeysRef, folderPanelFolder, folderPanelFolderId, folders, networkRef,
    scheduleFolderSync, setBusy, setCurrentFolderId, setDeleteRequest, setDetailFileId, setExpandedPreviewOpen, setFolderKeys,
    setFolderNameDraft, setFolderPanelFolderId, setFolderPanelOpen, setNotice, setProfileOpen,
    setSelectedFileId, setSettingsOpen, setSnapshot, settings, shareProfile, snapshot, snapshotRef,
    syncSignaturesRef,
  } = options

  function patchCurrentFolder(patch: Partial<FolderRecord>) {
    if (!folderPanelFolder) return
    const now = new Date().toISOString()
    const sharedRoot = nearestSharedAncestorFolder(snapshotRef.current, folderPanelFolder.id)
    setSnapshot((current) => touchSnapshot({ ...current, folders: current.folders.map((folder) => (folder.id === folderPanelFolder.id ? stampFolderPatch(folder, patch, now, settings.nodeId) : folder)) }, settings.nodeId))
    const folderForSync = sharedRoot ?? (patch.shareEnabled ? { ...folderPanelFolder, shareEnabled: true } : undefined)
    if (folderForSync) scheduleSharedFolderSync(folderForSync, 'local folder settings changed')
  }

  function beginCreateFolder() {
    if (currentFolderId && !currentFolder) {
      setNotice({ tone: 'error', text: '削除済みフォルダーにはフォルダーを作成できません' })
      return
    }
    const existingNames = new Set(childFolders(snapshot, currentFolderId).map((folder) => folder.name))
    setFolderNameDraft(nextFolderName(existingNames))
    setSelectedFileId(null)
    setDetailFileId(null)
  }

  function cancelCreateFolder() {
    setFolderNameDraft(null)
  }

  function confirmCreateFolder(folderNameDraft: string | null) {
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
    setSelectedFileId(null)
    if (sharedRoot) {
      announceFolderChange(sharedRoot, 'folder-upserted', undefined, folder)
      scheduleSharedFolderSync(sharedRoot, 'local folder create')
    }
    setNotice({ tone: 'success', text: `${folder.name} を作成しました` })
  }

  async function saveFolderToMist(shareAfterSave: boolean) {
    if (!currentFolder) return setNotice({ tone: 'error', text: '保存するフォルダーを選択してください' })
    await saveFolder(currentFolder, currentFolderKey, shareAfterSave)
  }

  async function shareFolder(folder: FolderRecord) {
    await saveFolder(folder, folderKeysRef.current[folder.id] ?? '', true)
  }

  async function saveFolder(folder: FolderRecord, folderKey: string, shareAfterSave: boolean) {
    const sourceSnapshot = snapshotRef.current
    const targetFolder = sourceSnapshot.folders.find((item) => item.id === folder.id && !item.deletedAt)
    if (!targetFolder) return setNotice({ tone: 'error', text: '保存するフォルダーを選択してください' })
    const passphrase = folderKey || generateFolderKey()
    if (!folderKey) setFolderKeys((current) => ({ ...current, [targetFolder.id]: passphrase }))
    const now = new Date().toISOString()
    const clipboard = shareAfterSave ? reserveClipboardWrite() : undefined
    setBusy(shareAfterSave ? 'share' : 'save')
    if (shareAfterSave) {
      setFolderPanelFolderId(null)
      setFolderPanelOpen(false)
      setSettingsOpen(false)
      setProfileOpen(false)
      setDetailFileId(null)
      setExpandedPreviewOpen(false)
    }
    setNotice({ tone: 'info', text: shareAfterSave ? '共有URLを作成中...' : 'mistlibへ保存中...' })
    try {
      const folderForSave = shareAfterSave ? stampFolderPatch(targetFolder, { shareEnabled: true, sharedRoomId: settings.roomId }, now, settings.nodeId) : targetFolder
      const foldersForSave = foldersForSync(sourceSnapshot, targetFolder.id).map((item) => (item.id === targetFolder.id ? folderForSave : item))
      const filesForSave = await ensureFolderFilesStored(folderForSave, folderFilesForSync(sourceSnapshot, targetFolder.id), passphrase)
      const cid = await saveEncryptedFolderToMist({ folder: folderForSave, folders: foldersForSave, files: filesForSave, passphrase, originNode: settings.nodeId })
      clearFolderSyncTimer(targetFolder.id)
      const filesForSaveById = new Map(filesForSave.map((file) => [file.id, stripFileContent(file)]))
      syncSignaturesRef.current[targetFolder.id] = sharedFolderSignature({ ...sourceSnapshot, folders: sourceSnapshot.folders.map((item) => (item.id === targetFolder.id ? folderForSave : item)), files: sourceSnapshot.files.map((file) => filesForSaveById.get(file.id) ?? file) }, targetFolder.id)
      markFolderSaved(targetFolder, cid, now, shareAfterSave, filesForSave)
      if (shareAfterSave) networkRef.current.broadcastShare({ clock: sourceSnapshot.clock + 1, folderId: targetFolder.id, folderName: targetFolder.name, cid })
      const copied = shareAfterSave ? await writeReservedClipboard(makeFolderShareUrl(targetFolder, settings.roomId, shareProfile), clipboard) : false
      setNotice({ tone: 'success', text: shareAfterSave ? copied ? '共有URLをコピーしました' : '共有URLを作成しました' : '暗号化してmistlibへ保存しました' })
    } catch (error) {
      clipboard?.cancel()
      setNotice({ tone: 'error', text: describeError(error, 'mistlib保存に失敗しました') })
    } finally {
      setBusy('')
    }
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

  function deleteCurrentFolder() {
    if (folderPanelFolder) requestDeleteFolder(folderPanelFolder)
  }

  function requestDeleteFolder(folder: FolderRecord) {
    setDeleteRequest({ type: 'folder', folder })
    setSettingsOpen(false)
    setProfileOpen(false)
    setFolderPanelOpen(false)
    setDetailFileId(null)
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
    if (sharedRoot.id !== folder.id) scheduleSharedFolderSync(sharedRoot, 'local folder delete')
  }

  function scheduleSharedFolderSync(folder: FolderRecord, reason: string): void {
    if (!folder.shareEnabled || !folderKeysRef.current[folder.id]) return
    scheduleFolderSync(folder.id, reason)
  }

  return { beginCreateFolder, cancelCreateFolder, confirmCreateFolder, deleteCurrentFolder, deleteFolder, patchCurrentFolder, requestDeleteFolder, saveFolderToMist, shareFolder }
}
