import type { BrowserDragItem, DeleteRequest, Notice } from './appTypes.js'
import type { FileContentActions, MistShare, MutableRef, SetState } from './appControllerTypes.js'
import { mergeUploadedFiles } from './appHelpers.js'
import { activeAncestorFolderId, nearestSharedAncestorFolder } from './appUtils.js'
import { reserveClipboardWrite, writeReservedClipboard } from './clipboard.js'
import { stampFilePatch } from './crdt.js'
import { addActivity, stripFileContent, touchSnapshot, type FileRecord, type FolderRecord, type StorageSnapshot } from './domain.js'
import { describeError } from './errors.js'
import { readBrowserFile } from './fileIO.js'
import { generateFileShareKey } from './fileShareKeys.js'
import { generateFolderKey } from './folderKeys.js'
import type { AppSettings } from './localSettings.js'
import { saveEncryptedFileToMist } from './mistStorage.js'
import type { ShareProfile } from './p2p.js'
import { makeFileShareUrl } from './shareLinks.js'

interface FileActionOptions {
  announceFolderChange: (folder: FolderRecord, changeType: 'file-upserted' | 'file-deleted', file?: FileRecord) => void
  currentFolderId: string | null
  deleteFolder: (folder: FolderRecord) => void
  deleteRequest: DeleteRequest | null
  ensureFileContent: FileContentActions['ensureFileContent']
  fileShareKeys: Record<string, string>
  folderKeysRef: MutableRef<Record<string, string>>
  folders: FolderRecord[]
  networkRef: MutableRef<MistShare>
  setBusy: SetState<string>
  setCurrentFolderId: SetState<string | null>
  setDeleteRequest: SetState<DeleteRequest | null>
  setDetailFileId: SetState<string | null>
  setFileContentCache: SetState<Record<string, string>>
  setFileShareKeys: SetState<Record<string, string>>
  setFolderKeys: SetState<Record<string, string>>
  setFolderPanelOpen: SetState<boolean>
  setNotice: SetState<Notice>
  setProfileOpen: SetState<boolean>
  setSettingsOpen: SetState<boolean>
  setSelectedItems: SetState<BrowserDragItem[]>
  setSnapshot: SetState<StorageSnapshot>
  settings: AppSettings
  shareProfile: ShareProfile
  snapshot: StorageSnapshot
  snapshotRef: MutableRef<StorageSnapshot>
}

export function createFileActions(options: FileActionOptions) {
  const {
    announceFolderChange, currentFolderId, deleteFolder, deleteRequest, ensureFileContent,
    fileShareKeys, folderKeysRef, folders, networkRef, setBusy, setCurrentFolderId,
    setDeleteRequest, setDetailFileId, setFileContentCache, setFileShareKeys, setFolderKeys,
    setFolderPanelOpen, setNotice, setProfileOpen, setSelectedItems, setSettingsOpen, setSnapshot, settings,
    shareProfile, snapshot, snapshotRef,
  } = options

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

  async function shareFile(file: FileRecord) {
    const folder = folders.find((item) => item.id === file.folderId)
    if (!folder) return setNotice({ tone: 'error', text: '共有するファイルのフォルダーが見つかりません' })
    const passphrase = fileShareKeys[file.id] || generateFileShareKey()
    if (!fileShareKeys[file.id]) setFileShareKeys((current) => ({ ...current, [file.id]: passphrase }))
    const now = new Date().toISOString()
    const clipboard = reserveClipboardWrite()
    setBusy(`file-share-${file.id}`)
    setDetailFileId(file.id)
    setSettingsOpen(false)
    setNotice({ tone: 'info', text: '共有URLを作成中...' })
    try {
      const fileWithContent = await ensureFileContent(file)
      const cid = await saveEncryptedFileToMist({ folder, file: fileWithContent, passphrase, originNode: settings.nodeId })
      markFileShared(file, cid, now)
      networkRef.current.broadcastShare({ type: 'file-share', clock: snapshot.clock + 1, folderId: folder.id, folderName: folder.name, fileId: file.id, fileName: file.name, cid })
      const copied = await writeReservedClipboard(makeFileShareUrl(fileWithContent, folder, settings.roomId, snapshot.clock + 1, cid, passphrase, shareProfile), clipboard)
      setNotice({ tone: 'success', text: copied ? '共有URLをコピーしました' : '共有URLを作成しました' })
    } catch (error) {
      clipboard?.cancel()
      setNotice({ tone: 'error', text: describeError(error, 'ファイル共有に失敗しました') })
    } finally {
      setBusy('')
    }
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

  function confirmDelete() {
    if (!deleteRequest) return
    if (deleteRequest.type === 'file') deleteFile(deleteRequest.file)
    else if (deleteRequest.type === 'folder') deleteFolder(deleteRequest.folder)
    else {
      for (const file of deleteRequest.files) deleteFile(file)
      for (const folder of deleteRequest.folders) deleteFolder(folder)
      setSelectedItems([])
    }
    setDeleteRequest(null)
  }

  function deleteFile(file: FileRecord) {
    const now = new Date().toISOString()
    const deletedFile = stripFileContent(stampFilePatch(file, { deletedAt: now }, now, settings.nodeId))
    setSnapshot((current) => touchSnapshot(addActivity({ ...current, files: current.files.map((item) => (item.id === file.id ? deletedFile : item)) }, { actorNodeId: settings.nodeId, fileId: file.id, folderId: file.folderId, action: 'file.delete', detail: `${file.name} を削除` }, now), settings.nodeId))
    const folder = nearestSharedAncestorFolder(snapshotRef.current, file.folderId) ?? snapshotRef.current.folders.find((item) => item.id === file.folderId)
    if (folder) announceFolderChange(folder, 'file-deleted', deletedFile)
  }

  function markFileShared(file: FileRecord, cid: string, now: string) {
    setSnapshot((current) => touchSnapshot(addActivity({ ...current, files: current.files.map((item) => (item.id === file.id ? stampFilePatch(item, { lastShareCid: cid }, now, settings.nodeId) : item)) }, { actorNodeId: settings.nodeId, fileId: file.id, folderId: file.folderId, action: 'file.share', detail: `${file.name} をmistlib共有` }, now), settings.nodeId))
  }

  return { confirmDelete, requestDeleteFile, renameFile, shareFile, uploadFiles }
}
