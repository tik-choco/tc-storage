import type { Notice } from './appTypes.js'
import type { FileContentActions, MistShare, MutableRef, SetState } from './appControllerTypes.js'
import { stampFolderPatch } from './crdt.js'
import { addActivity, stripFileContent, touchSnapshot, type FileRecord, type FolderRecord, type StorageSnapshot } from './domain.js'
import { describeError } from './errors.js'
import { folderFilesForSync, foldersForSync, hasSharedFolderChangesSinceLastShare, sharedFolderSignature } from './folderSync.js'
import type { AppSettings } from './localSettings.js'
import { saveEncryptedFolderToMist } from './mistStorage.js'
import type { ShareEnvelope } from './p2p.js'
import { folderLogDetails, shortLogValue, syncLog, syncWarn } from './appUtils.js'

interface FolderSyncOptions {
  ensureFolderFilesStored: FileContentActions['ensureFolderFilesStored']
  hasUntrustedFolderContent: FileContentActions['hasUntrustedFolderContent']
  folderKeysRef: MutableRef<Record<string, string>>
  networkRef: MutableRef<MistShare>
  setNotice: SetState<Notice>
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  snapshotRef: MutableRef<StorageSnapshot>
  syncInFlightRef: MutableRef<Set<string>>
  syncSignaturesRef: MutableRef<Record<string, string>>
  syncTimersRef: MutableRef<Record<string, number>>
}

export function createFolderSyncActions(options: FolderSyncOptions) {
  const {
    ensureFolderFilesStored, folderKeysRef, hasUntrustedFolderContent, networkRef, setNotice, setSnapshot, settingsRef,
    snapshotRef, syncInFlightRef, syncSignaturesRef, syncTimersRef,
  } = options

  function announceSharedFolders(options: { publishLocalChangesImmediately?: boolean } = {}) {
    const snapshotValue = snapshotRef.current
    const folderKeysValue = folderKeysRef.current
    syncLog('announce shared folders tick', {
      sharedFolderCount: snapshotValue.folders.filter((folder) => folder.shareEnabled && folderKeysValue[folder.id]).length,
      roomId: settingsRef.current.roomId,
    })
    for (const folder of snapshotValue.folders) {
      if (!folder.shareEnabled || !folderKeysValue[folder.id]) continue
      const shouldPublishContent = hasUntrustedFolderContent(folder.id)
      if (!folder.lastCid || hasSharedFolderChangesSinceLastShare(snapshotValue, folder) || shouldPublishContent) {
        if (options.publishLocalChangesImmediately) {
          syncLog('announce found publishable folder content: publishing storage_add immediately', { ...folderLogDetails(folder), shouldPublishContent })
          void publishSharedFolder(folder.id)
        } else {
          syncLog('announce found publishable folder content: scheduling storage_add', { ...folderLogDetails(folder), shouldPublishContent })
          scheduleFolderSync(folder.id, shouldPublishContent ? 'announce found untrusted local content' : 'announce found local changes')
        }
        continue
      }
      syncLog('sending folder-state cid over send_message', { ...folderLogDetails(folder), signatureLength: sharedFolderSignature(snapshotValue, folder.id).length })
      networkRef.current.broadcastShare({
        type: 'folder-state',
        clock: snapshotValue.clock,
        folderId: folder.id,
        folderName: folder.name,
        cid: folder.lastCid,
        folderSignature: sharedFolderSignature(snapshotValue, folder.id),
      })
    }
  }

  function announceFolderChange(folder: FolderRecord, changeType: NonNullable<ShareEnvelope['changeType']>, file?: FileRecord, changedFolder?: FolderRecord) {
    if (!folder.shareEnabled || !folderKeysRef.current[folder.id]) return
    syncLog('sending folder-change over send_message', {
      ...folderLogDetails(folder),
      changeType,
      changedFolderId: changedFolder?.id,
      changedFolderName: changedFolder?.name,
      fileId: file?.id,
      fileName: file?.name,
      fileCid: shortLogValue(file?.lastCid),
    })
    networkRef.current.broadcastShare({
      type: 'folder-change',
      clock: snapshotRef.current.clock + 1,
      changeType,
      folderId: folder.id,
      folderName: folder.name,
      folder: changedFolder,
      fileId: file?.id,
      fileName: file?.name,
      file: file ? stripFileContent(file) : undefined,
      cid: file?.lastCid,
    })
  }

  function clearFolderSyncTimer(folderId: string) {
    const timer = syncTimersRef.current[folderId]
    if (timer !== undefined) window.clearTimeout(timer)
    delete syncTimersRef.current[folderId]
  }

  function scheduleFolderSync(folderId: string, reason: string) {
    clearFolderSyncTimer(folderId)
    syncLog('scheduled folder storage_add', { folderId, reason, delayMs: 900 })
    syncTimersRef.current[folderId] = window.setTimeout(() => {
      delete syncTimersRef.current[folderId]
      void publishSharedFolder(folderId)
    }, 900)
  }

  async function publishSharedFolder(folderId: string) {
    if (syncInFlightRef.current.has(folderId)) {
      syncLog('storage_add skipped: publish already in flight', { folderId })
      return
    }
    const snapshotValue = snapshotRef.current
    const settingsValue = settingsRef.current
    const folder = snapshotValue.folders.find((item) => item.id === folderId)
    const passphrase = folderKeysRef.current[folderId]
    if (!folder?.shareEnabled || !passphrase) {
      syncLog('storage_add skipped: folder not shareable or key missing', { folderId, hasFolder: Boolean(folder), shareEnabled: folder?.shareEnabled, hasPassphrase: Boolean(passphrase) })
      return
    }
    syncInFlightRef.current.add(folderId)
    try {
      const foldersForSave = foldersForSync(snapshotValue, folderId)
      const filesForSync = await ensureFolderFilesStored(folder, folderFilesForSync(snapshotValue, folderId), passphrase)
      syncLog('storage_add start for shared folder', { ...folderLogDetails(folder), folderCount: foldersForSave.length, fileCount: filesForSync.length })
      const cid = await saveEncryptedFolderToMist({ folder, folders: foldersForSave, files: filesForSync, passphrase, originNode: settingsValue.nodeId })
      syncLog('storage_add complete for shared folder', { ...folderLogDetails(folder), cid: shortLogValue(cid), folderCount: foldersForSave.length, fileCount: filesForSync.length })
      const now = new Date().toISOString()
      setSnapshot((current) => {
        const currentFolder = current.folders.find((item) => item.id === folderId)
        if (!currentFolder) return current
        const storedFilesById = new Map(filesForSync.map((file) => [file.id, stripFileContent(file)]))
        const foldersNext = current.folders.map((item) => (
          item.id === folderId
            ? stampFolderPatch(item, { lastCid: cid, lastSavedAt: now, lastSharedAt: now, shareEnabled: true, sharedRoomId: settingsValue.roomId }, now, settingsValue.nodeId)
            : item
        ))
        const filesNext = current.files.map((item) => storedFilesById.get(item.id) ?? item)
        const next = touchSnapshot(addActivity({ ...current, folders: foldersNext, files: filesNext }, { actorNodeId: settingsValue.nodeId, folderId, action: 'folder.sync', detail: `${currentFolder.name} を自動同期` }, now), settingsValue.nodeId)
        syncSignaturesRef.current[folderId] = sharedFolderSignature(next, folderId)
        return next
      })
      syncLog('broadcasting new folder-share cid over send_message', { ...folderLogDetails(folder), cid: shortLogValue(cid), clock: snapshotValue.clock + 1 })
      networkRef.current.broadcastShare({ clock: snapshotValue.clock + 1, folderId, folderName: folder.name, cid })
      setNotice({ tone: 'success', text: `${folder.name} を自動同期しました` })
    } catch (error) {
      syncWarn('storage_add failed for shared folder', { folderId, error: describeError(error, 'unknown error') })
      setNotice({ tone: 'error', text: describeError(error, `${folder.name} の自動同期に失敗しました`) })
    } finally {
      syncInFlightRef.current.delete(folderId)
    }
  }

  return { announceFolderChange, announceSharedFolders, clearFolderSyncTimer, publishSharedFolder, scheduleFolderSync }
}
