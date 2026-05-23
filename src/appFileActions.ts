import type { BrowserDragItem, DeleteRequest, Notice } from './appTypes.js'
import type { FileContentActions, MistShare, MutableRef, SetState } from './appControllerTypes.js'
import { latestFilesByIdentity, mergeUploadedFiles, sameFileIdentity } from './appHelpers.js'
import { activeAncestorFolderId, nearestSharedAncestorFolder, shortLogValue, syncLog, syncWarn } from './appUtils.js'
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
  scheduleFolderSync: (folderId: string, reason: string) => void
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
    fileShareKeys, folderKeysRef, folders, networkRef, scheduleFolderSync, setBusy, setCurrentFolderId,
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
    const browserFiles = [...fileList]
    setBusy('upload')
    setNotice({ tone: 'info', text: `${browserFiles.length} 件のファイルを読み込み中...` })
    try {
      const uploaded = await Promise.all(browserFiles.map((file) => readBrowserFile(file, targetFolderId, now, settings.nodeId)))
      const optimisticFiles = optimisticUploadedFiles(snapshotRef.current.files, uploaded, now, settings.nodeId)
      setFileContentCache((current) => {
        const next = { ...current }
        for (const file of optimisticFiles) {
          if (!file.dataUrl) continue
          next[file.id] = file.dataUrl
        }
        return next
      })
      setSnapshot((current) => touchSnapshot(addActivity({ ...current, files: mergeUploadedFiles(current.files, optimisticFiles.map(stripFileContent), now, settings.nodeId) }, { actorNodeId: settings.nodeId, folderId: targetFolderId, action: 'file.upload', detail: `${uploaded.length} 件のファイルを追加` }, now), settings.nodeId))
      setNotice({ tone: 'success', text: `${uploaded.length} 件のファイルを追加しました。保存はバックグラウンドで続行します` })
      void storeUploadedFilesInBackground(optimisticFiles, storageFolder, passphrase)
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
    if (sharedRoot) {
      announceFolderChange(sharedRoot, 'file-upserted', renamedFile)
      scheduleSharedFolderSync(sharedRoot, 'local file rename')
    }
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
    if (folder) {
      announceFolderChange(folder, 'file-deleted', deletedFile)
      scheduleSharedFolderSync(folder, 'local file delete')
    }
  }

  function markFileShared(file: FileRecord, cid: string, now: string) {
    setSnapshot((current) => touchSnapshot(addActivity({ ...current, files: current.files.map((item) => (item.id === file.id ? stampFilePatch(item, { lastShareCid: cid }, now, settings.nodeId) : item)) }, { actorNodeId: settings.nodeId, fileId: file.id, folderId: file.folderId, action: 'file.share', detail: `${file.name} をmistlib共有` }, now), settings.nodeId))
  }

  function scheduleSharedFolderSync(folder: FolderRecord, reason: string): void {
    if (!folder.shareEnabled || !folderKeysRef.current[folder.id]) return
    scheduleFolderSync(folder.id, reason)
  }

  async function storeUploadedFilesInBackground(files: FileRecord[], storageFolder: FolderRecord, passphrase: string): Promise<void> {
    let failures = 0
    for (const file of files) {
      try {
        syncLog('background storage_add start for uploaded file', { fileId: file.id, fileName: file.name, folderId: storageFolder.id })
        const cid = await saveEncryptedFileToMist({ folder: storageFolder, file, passphrase, originNode: settings.nodeId })
        const storedAt = new Date().toISOString()
        const storedFile = stripFileContent(stampFilePatch(file, { lastCid: cid }, storedAt, settings.nodeId))
        setSnapshot((current) => touchSnapshot({
          ...current,
          files: current.files.map((item) => (
            item.id === file.id && !item.deletedAt && item.folderId === file.folderId && item.checksum === file.checksum && item.version === file.version
              ? stampFilePatch(item, { lastCid: cid }, storedAt, settings.nodeId)
              : item
          )),
        }, settings.nodeId))
        announceFolderChange(storageFolder, 'file-upserted', storedFile)
        scheduleSharedFolderSync(storageFolder, 'local file upload')
        syncLog('background storage_add complete for uploaded file', { fileId: file.id, fileName: file.name, cid: shortLogValue(cid) })
      } catch (error) {
        failures += 1
        syncWarn('background storage_add failed for uploaded file', { fileId: file.id, fileName: file.name, error: describeError(error, 'unknown error') })
      }
    }
    if (failures > 0) setNotice({ tone: 'error', text: `${failures} 件のバックグラウンド保存に失敗しました。次回同期で再試行します` })
  }

  return { confirmDelete, requestDeleteFile, renameFile, shareFile, uploadFiles }
}

export function optimisticUploadedFiles(currentFiles: FileRecord[], uploaded: FileRecord[], now: string, nodeId: string): FileRecord[] {
  return latestFilesByIdentity(uploaded).map((file) => {
    const existing = currentFiles.find((item) => sameFileIdentity(item, file) && !item.deletedAt)
    return existing
      ? stampFilePatch(existing, {
        checksum: file.checksum,
        dataUrl: file.dataUrl,
        deletedAt: undefined,
        lastCid: undefined,
        mimeType: file.mimeType,
        name: file.name,
        size: file.size,
        version: existing.version + 1,
      }, now, nodeId)
      : file
  })
}
