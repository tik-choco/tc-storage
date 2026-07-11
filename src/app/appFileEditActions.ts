import type { Notice } from './appTypes.js'
import type { MutableRef, SetState } from './appControllerTypes.js'
import { nearestSharedAncestorFolder, shortLogValue, syncLog, syncWarn } from './appUtils.js'
import { stampFilePatch } from '../storage/crdt.js'
import { addActivity, stripFileContent, touchSnapshot, type FileRecord, type FolderRecord, type StorageSnapshot } from '../storage/domain.js'
import { sha256Hex } from '../crypto/crypto.js'
import { bytesToBase64 } from '../crypto/cryptoEncoding.js'
import { generateFolderKey } from '../crypto/folderKeys.js'
import { describeError } from '../util/errors.js'
import type { AppSettings } from '../storage/localSettings.js'
import { saveEncryptedFileToMist } from '../storage/mistStorage.js'

type SaveEncryptedFile = typeof saveEncryptedFileToMist

interface FileEditOptions {
  announceFolderChange: (folder: FolderRecord, changeType: 'file-upserted' | 'file-deleted', file?: FileRecord) => void
  folderKeysRef: MutableRef<Record<string, string>>
  saveEncryptedFile?: SaveEncryptedFile
  scheduleFolderSync: (folderId: string, reason: string) => void
  setFileContentCache: SetState<Record<string, string>>
  setFolderKeys: SetState<Record<string, string>>
  setNotice: SetState<Notice>
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  snapshotRef: MutableRef<StorageSnapshot>
}

export interface FileEditActions {
  saveTextFileContent: (file: FileRecord, text: string) => Promise<void>
}

export function createFileEditActions(options: FileEditOptions): FileEditActions {
  const {
    announceFolderChange, folderKeysRef, saveEncryptedFile = saveEncryptedFileToMist, scheduleFolderSync,
    setFileContentCache, setFolderKeys, setNotice, setSnapshot, settingsRef, snapshotRef,
  } = options

  async function saveTextFileContent(file: FileRecord, text: string): Promise<void> {
    const current = snapshotRef.current.files.find((item) => item.id === file.id && !item.deletedAt)
    if (!current) {
      setNotice({ tone: 'error', text: '保存するファイルが見つかりません' })
      throw new Error(`${file.name} が見つかりません`)
    }
    const bytes = new TextEncoder().encode(text)
    const checksum = await sha256Hex(bytes)
    if (checksum === current.checksum) return
    const mimeType = current.mimeType || 'text/plain'
    const dataUrl = `data:${mimeType};base64,${bytesToBase64(bytes)}`
    const now = new Date().toISOString()
    const nodeId = settingsRef.current.nodeId
    const editedFile = stampFilePatch(current, {
      checksum,
      dataUrl,
      lastCid: undefined,
      size: bytes.length,
      version: current.version + 1,
    }, now, nodeId)
    setFileContentCache((cache) => ({ ...cache, [file.id]: dataUrl }))
    setSnapshot((snapshot) => touchSnapshot(addActivity({
      ...snapshot,
      files: snapshot.files.map((item) => (item.id === file.id ? stripFileContent(editedFile) : item)),
    }, { actorNodeId: nodeId, fileId: file.id, folderId: current.folderId, action: 'file.edit', detail: `${current.name} を編集` }, now), nodeId))
    setNotice({ tone: 'success', text: `${current.name} を保存しました` })
    void storeEditedFileInBackground(editedFile)
  }

  async function storeEditedFileInBackground(file: FileRecord): Promise<void> {
    const snapshot = snapshotRef.current
    const folder = snapshot.folders.find((item) => item.id === file.folderId && !item.deletedAt)
    if (!folder) {
      syncWarn('background storage_add skipped for edited file: folder missing', { fileId: file.id, fileName: file.name, folderId: file.folderId })
      return
    }
    const sharedRoot = nearestSharedAncestorFolder(snapshot, file.folderId)
    const storageFolder = sharedRoot ?? folder
    const passphrase = folderKeysRef.current[storageFolder.id] || folderKeysRef.current[file.folderId] || generateFolderKey()
    if (!folderKeysRef.current[file.folderId]) setFolderKeys((keys) => ({ ...keys, [file.folderId]: passphrase }))
    if (sharedRoot && !folderKeysRef.current[sharedRoot.id]) setFolderKeys((keys) => ({ ...keys, [sharedRoot.id]: passphrase }))
    try {
      syncLog('background storage_add start for edited file', { fileId: file.id, fileName: file.name, folderId: storageFolder.id })
      const cid = await saveEncryptedFile({ folder: storageFolder, file, passphrase, originNode: settingsRef.current.nodeId, runtimeNodeId: settingsRef.current.nodeId })
      const storedAt = new Date().toISOString()
      const storedFile = stripFileContent(stampFilePatch(file, { lastCid: cid }, storedAt, settingsRef.current.nodeId))
      setSnapshot((snapshot) => touchSnapshot({
        ...snapshot,
        files: snapshot.files.map((item) => (
          item.id === file.id && !item.deletedAt && item.checksum === file.checksum && item.version === file.version
            ? stampFilePatch(item, { lastCid: cid }, storedAt, settingsRef.current.nodeId)
            : item
        )),
      }, settingsRef.current.nodeId))
      announceFolderChange(storageFolder, 'file-upserted', storedFile)
      if (storageFolder.shareEnabled && folderKeysRef.current[storageFolder.id]) scheduleFolderSync(storageFolder.id, 'local file edit')
      syncLog('background storage_add complete for edited file', { fileId: file.id, fileName: file.name, cid: shortLogValue(cid) })
    } catch (error) {
      syncWarn('background storage_add failed for edited file', { fileId: file.id, fileName: file.name, error: describeError(error, 'unknown error') })
      setNotice({ tone: 'error', text: `${file.name} のバックグラウンド保存に失敗しました。次回同期で再試行します` })
    }
  }

  return { saveTextFileContent }
}
