import type { BrowserDragItem, Notice } from './appTypes.js'
import type { FileContentActions, MoveActions, MutableRef, SetState } from './appControllerTypes.js'
import { descendantFolderIds } from './appHelpers.js'
import { nearestSharedAncestorFolder } from './appUtils.js'
import { stampFilePatch, stampFolderPatch } from './crdt.js'
import { addActivity, stripFileContent, touchSnapshot, type FileRecord, type FolderRecord, type StorageSnapshot } from './domain.js'
import { describeError } from './errors.js'
import { generateFolderKey } from './folderKeys.js'
import type { AppSettings } from './localSettings.js'
import { saveEncryptedFileToMist } from './mistStorage.js'

interface MoveOptions {
  announceFolderChange: (folder: FolderRecord, changeType: 'file-upserted' | 'file-deleted' | 'folder-upserted' | 'folder-deleted', file?: FileRecord, changedFolder?: FolderRecord) => void
  ensureFileContent: FileContentActions['ensureFileContent']
  folderKeysRef: MutableRef<Record<string, string>>
  scheduleFolderSync: (folderId: string, reason: string) => void
  setBusy: SetState<string>
  setFileContentCache: SetState<Record<string, string>>
  setFolderKeys: SetState<Record<string, string>>
  setNotice: SetState<Notice>
  setSnapshot: SetState<StorageSnapshot>
  settings: AppSettings
  snapshotRef: MutableRef<StorageSnapshot>
}

export function createMoveActions(options: MoveOptions): MoveActions {
  const {
    announceFolderChange, ensureFileContent, folderKeysRef, scheduleFolderSync, setBusy, setFileContentCache,
    setFolderKeys, setNotice, setSnapshot, settings, snapshotRef,
  } = options

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
        scheduleSharedFolderSync(sourceSharedRoot, 'local file move out')
      }
      if (targetSharedRoot) {
        announceFolderChange(targetSharedRoot, 'file-upserted', movedFile)
        scheduleSharedFolderSync(targetSharedRoot, 'local file move in')
      }
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
    if (sourceSharedRoot && sourceSharedRoot.id !== targetSharedRoot?.id) {
      announceFolderChange(sourceSharedRoot, 'folder-deleted', undefined, folder)
      scheduleSharedFolderSync(sourceSharedRoot, 'local folder move out')
    }
    if (targetSharedRoot) {
      announceFolderChange(targetSharedRoot, 'folder-upserted', undefined, movedFolder)
      scheduleSharedFolderSync(targetSharedRoot, 'local folder move in')
    }
    setNotice({ tone: 'success', text: `${folder.name} を ${targetFolder?.name ?? 'My Drive'} に移動しました` })
  }

  function scheduleSharedFolderSync(folder: FolderRecord, reason: string): void {
    if (!folder.shareEnabled || !folderKeysRef.current[folder.id]) return
    scheduleFolderSync(folder.id, reason)
  }

  return { canMoveItemToFolder, moveDraggedItem }
}
