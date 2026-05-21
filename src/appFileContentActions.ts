import type { Notice } from './appTypes.js'
import type { FileContentActions, MutableRef, SetState } from './appControllerTypes.js'
import { descendantFolderIds } from './appHelpers.js'
import { stampFilePatch } from './crdt.js'
import { activeFiles, activeFolders, stripFileContent, type FileRecord, type FolderBundle, type FolderRecord, type StorageSnapshot } from './domain.js'
import { describeError } from './errors.js'
import { downloadBlob, downloadFile } from './fileIO.js'
import { compareZipFiles, makeFolderZipLayout, safeDownloadName, zipFilePath } from './folderZip.js'
import { folderKeyHash } from './folderKeyProof.js'
import { loadEncryptedFileFromMist, loadEncryptedFolderFromMist, saveEncryptedFileToMist } from './mistStorage.js'
import { nearestSharedAncestorFolder, shortLogValue, syncLog, syncWarn } from './appUtils.js'
import type { AppSettings } from './localSettings.js'
import { createZipBlob, dataUrlToBytes } from './zip.js'

type DownloadTarget = Pick<FileRecord, 'id' | 'name'>
type SaveEncryptedFile = typeof saveEncryptedFileToMist

const failedContentRetryMs = 30_000

interface FileContentOptions {
  failDownloadProgress: (requestId: number) => void
  failFileLoadProgress: (fileId: string) => void
  fileContentCacheRef: MutableRef<Record<string, string>>
  fileContentFailuresRef?: MutableRef<Record<string, { retryAfter: number; signature: string }>>
  fileContentLoadsRef: MutableRef<Partial<Record<string, Promise<string>>>>
  fileContentStorageRef?: MutableRef<Record<string, string>>
  fileShareKeysRef: MutableRef<Record<string, string>>
  finishDownloadProgress: (file: DownloadTarget, requestId: number) => void
  finishFileLoadProgress: (fileId: string) => void
  folderKeysRef: MutableRef<Record<string, string>>
  setFileContentCache: SetState<Record<string, string>>
  setNotice: SetState<Notice>
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  snapshotRef: MutableRef<StorageSnapshot>
  saveEncryptedFile?: SaveEncryptedFile
  startDownloadProgress: (file: DownloadTarget, cached: boolean) => number
  startFileLoadProgress: (file: FileRecord) => string
  updateDownloadProgress: (file: DownloadTarget, percent: number, requestId: number, label?: string) => void
}

export function createFileContentActions(options: FileContentOptions): FileContentActions {
  const {
    failDownloadProgress, failFileLoadProgress, fileContentCacheRef, fileContentFailuresRef, fileContentLoadsRef,
    fileContentStorageRef, fileShareKeysRef, finishDownloadProgress, finishFileLoadProgress, folderKeysRef,
    saveEncryptedFile = saveEncryptedFileToMist, setFileContentCache, setNotice, setSnapshot, settingsRef,
    snapshotRef, startDownloadProgress, startFileLoadProgress, updateDownloadProgress,
  } = options

  async function ensureFolderFilesStored(folder: FolderRecord, filesForSave: FileRecord[], passphrase: string): Promise<FileRecord[]> {
    const storedFiles: FileRecord[] = []
    for (const file of filesForSave) {
      if (file.deletedAt || isFileStoredForFolder(file, folder, passphrase)) {
        storedFiles.push(file)
        continue
      }
      const fileWithContent = await ensureFileContent(file)
      syncLog('storage_add start for file content', { folderId: folder.id, fileFolderId: file.folderId, fileId: file.id, fileName: file.name })
      const cid = await saveEncryptedFile({ folder, file: fileWithContent, passphrase, originNode: settingsRef.current.nodeId })
      syncLog('storage_add complete for file content', { folderId: folder.id, fileFolderId: file.folderId, fileId: file.id, fileName: file.name, cid: shortLogValue(cid) })
      const storedFile = stampFilePatch(fileWithContent, { lastCid: cid }, new Date().toISOString(), settingsRef.current.nodeId)
      rememberStoredFile(storedFile, folder, passphrase)
      storedFiles.push(storedFile)
    }
    return storedFiles
  }

  function isFileStoredForFolder(file: FileRecord, folder: FolderRecord, passphrase: string): boolean {
    if (!file.lastCid) return false
    if (fileContentStorageRef?.current[file.id] === fileStorageProof(file, folder, passphrase)) return true
    if (file.dataUrl || fileContentCacheRef.current[file.id]) return false
    if (file.folderId === folder.id || folderKeysRef.current[file.folderId] === passphrase) return true
    return false
  }

  async function materializeFolderBundleFiles(bundle: FolderBundle, passphrase: string): Promise<FolderBundle> {
    const cacheNext: Record<string, string> = {}
    const files: FileRecord[] = []
    for (const file of bundle.files) {
      if (file.dataUrl) cacheNext[file.id] = file.dataUrl
      if (file.deletedAt || file.lastCid || !file.dataUrl) {
        files.push(file)
        continue
      }
      syncLog('storage_add start for legacy folder file content', { folderId: bundle.folder.id, fileId: file.id, fileName: file.name })
      const cid = await saveEncryptedFile({ folder: bundle.folder, file, passphrase, originNode: bundle.originNode })
      syncLog('storage_add complete for legacy folder file content', { folderId: bundle.folder.id, fileId: file.id, fileName: file.name, cid: shortLogValue(cid) })
      files.push(stampFilePatch(file, { lastCid: cid }, bundle.exportedAt, bundle.originNode))
    }
    if (Object.keys(cacheNext).length > 0) setFileContentCache((current) => ({ ...current, ...cacheNext }))
    return { ...bundle, files }
  }

  async function ensureFileContent(file: FileRecord, options: { trackProgress?: boolean } = {}): Promise<FileRecord> {
    const cached = file.dataUrl ?? fileContentCacheRef.current[file.id]
    if (cached) return { ...file, dataUrl: cached }
    const progressFileId = options.trackProgress ? startFileLoadProgress(file) : ''
    const loading = fileContentLoadsRef.current[file.id]
    try {
      if (loading) {
        const dataUrl = await loading
        if (progressFileId) finishFileLoadProgress(progressFileId)
        return { ...file, dataUrl }
      }
      const candidates = fileContentCandidates(file)
      const folderBundleCandidate = folderBundleContentCandidate(file)
      if (candidates.length === 0 && !folderBundleCandidate) throw new Error(`${file.name} のCIDまたは復号キーがありません`)
      const promise = candidates.length > 0
        ? loadFileContentFromCandidates(file, candidates).catch(async (error) => {
          if (!folderBundleCandidate) throw error
          syncWarn('file content candidates failed; trying parent folder bundle', { fileId: file.id, fileName: file.name, folderCid: shortLogValue(folderBundleCandidate.cid), error: describeError(error, 'unknown error') })
          return loadFileContentFromFolderBundle(file, folderBundleCandidate.cid, folderBundleCandidate.passphrase)
        })
        : loadFileContentFromFolderBundle(file, folderBundleCandidate!.cid, folderBundleCandidate!.passphrase)
      fileContentLoadsRef.current[file.id] = promise
      try {
        const dataUrl = await promise
        clearContentFailure(file)
        setFileContentCache((current) => ({ ...current, [file.id]: dataUrl }))
        if (progressFileId) finishFileLoadProgress(progressFileId)
        return { ...file, dataUrl }
      } finally {
        delete fileContentLoadsRef.current[file.id]
      }
    } catch (error) {
      if (progressFileId) failFileLoadProgress(progressFileId)
      throw error
    }
  }

  function preloadFileContent(file: FileRecord): void {
    if (file.dataUrl || fileContentCacheRef.current[file.id] || fileContentLoadsRef.current[file.id] || !canResolveFileContent(file)) return
    if (isContentFailureCoolingDown(file)) return
    syncLog('thumbnail preload requested', { fileId: file.id, fileName: file.name, cid: shortLogValue(file.lastCid), shareCid: shortLogValue(file.lastShareCid) })
    void ensureFileContent(file, { trackProgress: true }).then(() => {
      clearContentFailure(file)
      syncLog('thumbnail preload complete', { fileId: file.id, fileName: file.name })
    }).catch((error) => {
      rememberContentFailure(file)
      syncWarn('thumbnail preload failed', { fileId: file.id, fileName: file.name, cid: shortLogValue(file.lastCid), shareCid: shortLogValue(file.lastShareCid), error: describeError(error, 'unknown error') })
    })
  }

  function canResolveFileContent(file: FileRecord): boolean {
    const folderPassphrase = folderKeysRef.current[file.folderId]
    const filePassphrase = fileShareKeysRef.current[file.id]
    const folder = snapshotRef.current.folders.find((item) => item.id === file.folderId)
    const sharedRoot = nearestSharedAncestorFolder(snapshotRef.current, file.folderId)
    const sharedRootPassphrase = sharedRoot ? folderKeysRef.current[sharedRoot.id] : undefined
    return Boolean(file.dataUrl || fileContentCacheRef.current[file.id] || (file.lastCid && folderPassphrase) ||
      (file.lastCid && sharedRootPassphrase) || ((file.lastShareCid ?? file.lastCid) && filePassphrase) ||
      (folder?.lastCid && folderPassphrase) || (sharedRoot?.lastCid && sharedRootPassphrase))
  }

  function hasUntrustedFolderContent(folderId: string): boolean {
    const snapshot = snapshotRef.current
    const folder = snapshot.folders.find((item) => item.id === folderId && !item.deletedAt)
    const passphrase = folder ? folderKeysRef.current[folder.id] : ''
    if (!folder || !passphrase) return false
    const folderIds = descendantFolderIds(activeFolders(snapshot), folderId)
    return activeFiles(snapshot).some((file) => folderIds.has(file.folderId) && Boolean(file.dataUrl || fileContentCacheRef.current[file.id]) && !isFileStoredForFolder(file, folder, passphrase))
  }

  async function loadFileContentFromCandidates(file: FileRecord, candidates: Array<{ cid: string; passphrase: string; source: string }>): Promise<string> {
    let lastError: unknown
    for (const candidate of candidates) {
      try {
        syncLog('storage_get start for file content', { fileId: file.id, fileName: file.name, cid: shortLogValue(candidate.cid), source: candidate.source })
        const bundle = await loadEncryptedFileFromMist(candidate.cid, candidate.passphrase)
        if (!bundle.file.dataUrl) throw new Error(`${file.name} の本文が共有データに含まれていません`)
        syncLog('storage_get complete for file content', { fileId: file.id, fileName: file.name, cid: shortLogValue(candidate.cid), source: candidate.source })
        return bundle.file.dataUrl
      } catch (error) {
        lastError = error
        syncWarn('storage_get failed for file content candidate', { fileId: file.id, fileName: file.name, cid: shortLogValue(candidate.cid), source: candidate.source, error: describeError(error, 'unknown error') })
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${file.name} の本文を取得できませんでした`)
  }

  async function loadFileContentFromFolderBundle(file: FileRecord, folderCid: string, passphrase: string): Promise<string> {
    syncLog('storage_get start for parent folder content fallback', { fileId: file.id, fileName: file.name, folderCid: shortLogValue(folderCid) })
    const bundle = await materializeFolderBundleFiles(await loadEncryptedFolderFromMist(folderCid, passphrase), passphrase)
    const bundledFile = bundle.files.find((item) => item.id === file.id)
    if (!bundledFile) throw new Error(`${file.name} がフォルダー共有データに見つかりません`)
    if (bundledFile.lastCid && bundledFile.lastCid !== file.lastCid) {
      setSnapshot((current) => ({
        ...current,
        files: current.files.map((item) => (item.id === file.id ? stripFileContent(stampFilePatch(item, { lastCid: bundledFile.lastCid }, bundledFile.updatedAt, bundle.originNode)) : item)),
      }))
    }
    if (bundledFile.dataUrl) {
      syncLog('storage_get complete for parent folder content fallback', { fileId: file.id, fileName: file.name, folderCid: shortLogValue(folderCid) })
      return bundledFile.dataUrl
    }
    if (bundledFile.lastCid) return loadFileContentFromCandidates(file, [{ cid: bundledFile.lastCid, passphrase, source: 'parent-folder-file' }])
    throw new Error(`${file.name} の本文CIDがフォルダー共有データに含まれていません`)
  }

  async function downloadStoredFile(file: FileRecord): Promise<void> {
    const progressRequestId = startDownloadProgress(file, Boolean(file.dataUrl ?? fileContentCacheRef.current[file.id]))
    try {
      const fileWithContent = await ensureFileContent(file, { trackProgress: true })
      downloadFile(fileWithContent)
      finishDownloadProgress(file, progressRequestId)
    } catch (error) {
      failDownloadProgress(progressRequestId)
      setNotice({ tone: 'error', text: describeError(error, 'ファイルをダウンロードできませんでした') })
    }
  }

  async function downloadFolderAsZip(folder: FolderRecord): Promise<void> {
    const snapshot = snapshotRef.current
    const activeFolderRows = activeFolders(snapshot)
    const folderIds = descendantFolderIds(activeFolderRows, folder.id)
    const filesForDownload = activeFiles(snapshot).filter((file) => folderIds.has(file.folderId)).sort(compareZipFiles)
    const target = { id: `folder-zip-${folder.id}`, name: `${safeDownloadName(folder.name)}.zip` }
    const progressRequestId = startDownloadProgress(target, false)

    try {
      const zipLayout = makeFolderZipLayout(snapshot, folder, folderIds)
      const entries = zipLayout.entries
      for (const [index, file] of filesForDownload.entries()) {
        const fileWithContent = await ensureFileContent(file, { trackProgress: true })
        if (!fileWithContent.dataUrl) throw new Error(`${file.name} の本文がローカルにありません`)
        entries.push({
          data: dataUrlToBytes(fileWithContent.dataUrl),
          modifiedAt: fileWithContent.updatedAt,
          path: zipFilePath(entries, zipLayout.folderPathById, folder, fileWithContent),
        })
        updateDownloadProgress(target, 8 + ((index + 1) / Math.max(filesForDownload.length, 1)) * 76, progressRequestId, 'Preparing ZIP')
      }
      updateDownloadProgress(target, 90, progressRequestId, 'Building ZIP')
      downloadBlob(createZipBlob(entries), target.name)
      finishDownloadProgress(target, progressRequestId)
      setNotice({ tone: 'success', text: `${folder.name} をZIPでダウンロードしました` })
    } catch (error) {
      failDownloadProgress(progressRequestId)
      setNotice({ tone: 'error', text: describeError(error, 'フォルダーをダウンロードできませんでした') })
    }
  }

  function fileContentCandidates(file: FileRecord): Array<{ cid: string; passphrase: string; source: string }> {
    const candidates: Array<{ cid: string; passphrase: string; source: string }> = []
    const folderPassphrase = folderKeysRef.current[file.folderId]
    const sharedRoot = nearestSharedAncestorFolder(snapshotRef.current, file.folderId)
    const sharedRootPassphrase = sharedRoot ? folderKeysRef.current[sharedRoot.id] : undefined
    if (file.lastCid && sharedRoot && sharedRootPassphrase) candidates.push({ cid: file.lastCid, passphrase: sharedRootPassphrase, source: sharedRoot.id === file.folderId ? 'folder' : 'shared-root' })
    if (file.lastCid && folderPassphrase && folderPassphrase !== sharedRootPassphrase) candidates.push({ cid: file.lastCid, passphrase: folderPassphrase, source: 'folder' })
    const filePassphrase = fileShareKeysRef.current[file.id]
    const shareCid = file.lastShareCid ?? file.lastCid
    if (shareCid && filePassphrase) candidates.push({ cid: shareCid, passphrase: filePassphrase, source: 'file-share' })
    return candidates
  }

  function folderBundleContentCandidate(file: FileRecord): { cid: string; passphrase: string } | undefined {
    const folderPassphrase = folderKeysRef.current[file.folderId]
    const sharedRoot = nearestSharedAncestorFolder(snapshotRef.current, file.folderId)
    const sharedRootPassphrase = sharedRoot ? folderKeysRef.current[sharedRoot.id] : undefined
    const folder = snapshotRef.current.folders.find((item) => item.id === file.folderId)
    return sharedRoot?.lastCid && sharedRootPassphrase
      ? { cid: sharedRoot.lastCid, passphrase: sharedRootPassphrase }
      : folder?.lastCid && folderPassphrase
        ? { cid: folder.lastCid, passphrase: folderPassphrase }
        : undefined
  }

  function rememberStoredFile(file: FileRecord, folder: FolderRecord, passphrase: string): void {
    if (!file.lastCid || !fileContentStorageRef) return
    fileContentStorageRef.current[file.id] = fileStorageProof(file, folder, passphrase)
  }

  function fileStorageProof(file: FileRecord, folder: FolderRecord, passphrase: string): string {
    return `${file.lastCid ?? ''}:${folder.id}:${folderKeyHash(folder.id, passphrase)}:${file.checksum}:${file.size}`
  }

  function isContentFailureCoolingDown(file: FileRecord): boolean {
    const failure = fileContentFailuresRef?.current[file.id]
    return Boolean(failure && failure.signature === fileContentSignature(file) && failure.retryAfter > Date.now())
  }

  function rememberContentFailure(file: FileRecord): void {
    if (!fileContentFailuresRef) return
    fileContentFailuresRef.current[file.id] = { retryAfter: Date.now() + failedContentRetryMs, signature: fileContentSignature(file) }
  }

  function clearContentFailure(file: FileRecord): void {
    if (fileContentFailuresRef) delete fileContentFailuresRef.current[file.id]
  }

  function fileContentSignature(file: FileRecord): string {
    const folder = snapshotRef.current.folders.find((item) => item.id === file.folderId)
    const sharedRoot = nearestSharedAncestorFolder(snapshotRef.current, file.folderId)
    return JSON.stringify([file.id, file.lastCid ?? '', file.lastShareCid ?? '', folder?.lastCid ?? '', sharedRoot?.lastCid ?? '', folderKeysRef.current[file.folderId] ? folderKeyHash(file.folderId, folderKeysRef.current[file.folderId]) : '', sharedRoot && folderKeysRef.current[sharedRoot.id] ? folderKeyHash(sharedRoot.id, folderKeysRef.current[sharedRoot.id]) : '', fileShareKeysRef.current[file.id] ? folderKeyHash(file.id, fileShareKeysRef.current[file.id]) : ''])
  }

  return { canResolveFileContent, downloadFolderAsZip, downloadStoredFile, ensureFileContent, ensureFolderFilesStored, hasUntrustedFolderContent, materializeFolderBundleFiles, preloadFileContent }
}
