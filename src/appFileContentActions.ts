import type { Notice } from './appTypes.js'
import type { FileContentActions, FileContentFailure, FileContentFailureKind, FileContentPreloadQueue, MistShare, MutableRef, SetState } from './appControllerTypes.js'
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
import type { ShareEnvelope } from './p2p.js'
import { createZipBlob, dataUrlToBytes } from './zip.js'

type DownloadTarget = Pick<FileRecord, 'id' | 'name'>
type FileContentCandidate = { cid: string; passphrase: string; source: string }
type LoadEncryptedFile = typeof loadEncryptedFileFromMist
type LoadEncryptedFolder = typeof loadEncryptedFolderFromMist
type SaveEncryptedFile = typeof saveEncryptedFileToMist
type StoredFileProof = { cid: string; signature: string }

const failedContentRetryMs = 30_000

interface FileContentOptions {
  failDownloadProgress: (requestId: number) => void
  failFileLoadProgress: (fileId: string) => void
  fileContentCacheRef: MutableRef<Record<string, string>>
  fileContentFailuresRef?: MutableRef<Record<string, FileContentFailure>>
  fileContentLoadsRef: MutableRef<Partial<Record<string, Promise<string>>>>
  fileContentPreloadQueueRef?: MutableRef<FileContentPreloadQueue>
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
  loadEncryptedFile?: LoadEncryptedFile
  loadEncryptedFolder?: LoadEncryptedFolder
  networkRef?: MutableRef<MistShare>
  saveEncryptedFile?: SaveEncryptedFile
  startDownloadProgress: (file: DownloadTarget, cached: boolean) => number
  startFileLoadProgress: (file: FileRecord) => string
  updateDownloadProgress: (file: DownloadTarget, percent: number, requestId: number, label?: string) => void
}

export function createFileContentActions(options: FileContentOptions): FileContentActions {
  const {
    failDownloadProgress, failFileLoadProgress, fileContentCacheRef, fileContentFailuresRef, fileContentLoadsRef,
    fileContentPreloadQueueRef, fileContentStorageRef, fileShareKeysRef, finishDownloadProgress, finishFileLoadProgress, folderKeysRef,
    loadEncryptedFile = loadEncryptedFileFromMist, loadEncryptedFolder = loadEncryptedFolderFromMist,
    networkRef, saveEncryptedFile = saveEncryptedFileToMist, setFileContentCache, setNotice, setSnapshot, settingsRef,
    snapshotRef, startDownloadProgress, startFileLoadProgress, updateDownloadProgress,
  } = options

  function storageRuntimeSettings() {
    return { nodeId: settingsRef.current.nodeId }
  }

  async function ensureFolderFilesStored(folder: FolderRecord, filesForSave: FileRecord[], passphrase: string): Promise<FileRecord[]> {
    const storedFiles: FileRecord[] = []
    for (const file of filesForSave) {
      const previouslyStoredFile = file.deletedAt ? undefined : fileStoredForFolder(file, folder, passphrase)
      if (previouslyStoredFile) {
        storedFiles.push(previouslyStoredFile)
        continue
      }
      if (file.deletedAt || isFileStoredForFolder(file, folder, passphrase)) {
        storedFiles.push(file)
        continue
      }
      const fileWithContent = await ensureFileContent(file)
      syncLog('storage_add start for file content', { folderId: folder.id, fileFolderId: file.folderId, fileId: file.id, fileName: file.name })
      const cid = await saveEncryptedFile({ folder, file: fileWithContent, passphrase, originNode: settingsRef.current.nodeId, runtimeNodeId: settingsRef.current.nodeId})
      syncLog('storage_add complete for file content', { folderId: folder.id, fileFolderId: file.folderId, fileId: file.id, fileName: file.name, cid: shortLogValue(cid) })
      const storedFile = stampFilePatch(fileWithContent, { lastCid: cid }, new Date().toISOString(), settingsRef.current.nodeId)
      rememberStoredFile(storedFile, folder, passphrase)
      storedFiles.push(storedFile)
    }
    return storedFiles
  }

  function isFileStoredForFolder(file: FileRecord, folder: FolderRecord, passphrase: string): boolean {
    if (fileStoredForFolder(file, folder, passphrase)) return true
    if (!file.lastCid) return false
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
      const cid = await saveEncryptedFile({ folder: bundle.folder, file, passphrase, originNode: bundle.originNode, runtimeNodeId: settingsRef.current.nodeId})
      syncLog('storage_add complete for legacy folder file content', { folderId: bundle.folder.id, fileId: file.id, fileName: file.name, cid: shortLogValue(cid) })
      files.push(stampFilePatch(file, { lastCid: cid }, bundle.exportedAt, bundle.originNode))
    }
    if (Object.keys(cacheNext).length > 0) setFileContentCache((current) => ({ ...current, ...cacheNext }))
    return { ...bundle, files }
  }

  async function ensureFileContent(file: FileRecord, options: { suppressRepairRequest?: boolean; trackProgress?: boolean } = {}): Promise<FileRecord> {
    const cached = file.dataUrl ?? fileContentCacheRef.current[file.id]
    if (cached) {
      syncLog('file content cache hit', { fileId: file.id, fileName: file.name, hasRecordDataUrl: Boolean(file.dataUrl), hasMemoryCache: Boolean(fileContentCacheRef.current[file.id]) })
      return { ...file, dataUrl: cached }
    }
    const progressFileId = options.trackProgress ? startFileLoadProgress(file) : ''
    const loading = fileContentLoadsRef.current[file.id]
    try {
      if (loading) {
        syncLog('file content load joined existing request', { fileId: file.id, fileName: file.name })
        const dataUrl = await loading
        if (progressFileId) finishFileLoadProgress(progressFileId)
        return { ...file, dataUrl }
      }
      const candidates = fileContentCandidates(file)
      const folderBundleCandidate = folderBundleContentCandidate(file)
      syncLog('file content resolution planned', fileContentPlanDetails(file, candidates, folderBundleCandidate))
      if (candidates.length === 0 && !folderBundleCandidate) throw new Error(`${file.name} のCIDまたは復号キーがありません`)
      const promise = candidates.length > 0
        ? loadFileContentFromCandidates(file, candidates).catch(async (error) => {
          if (!folderBundleCandidate) throw error
          syncWarn('file content candidates failed; trying parent folder bundle', { fileId: file.id, fileName: file.name, folderCid: shortLogValue(folderBundleCandidate.cid), error: describeError(error, 'unknown error') })
          return loadFileContentFromFolderBundle(file, folderBundleCandidate.cid, folderBundleCandidate.passphrase, attemptedCandidateKeys(candidates))
        })
        : loadFileContentFromFolderBundle(file, folderBundleCandidate!.cid, folderBundleCandidate!.passphrase, new Set())
      fileContentLoadsRef.current[file.id] = promise
      try {
        const dataUrl = await promise
        clearContentFailure(file)
        setFileContentCache((current) => ({ ...current, [file.id]: dataUrl }))
        syncLog('file content cached for preview', { fileId: file.id, fileName: file.name, bytes: dataUrlByteLength(dataUrl) })
        if (progressFileId) finishFileLoadProgress(progressFileId)
        return { ...file, dataUrl }
      } finally {
        delete fileContentLoadsRef.current[file.id]
      }
    } catch (error) {
      if (progressFileId) failFileLoadProgress(progressFileId)
      const errorKind = contentErrorKind(error)
      rememberContentFailure(file, errorKind)
      if (!options.suppressRepairRequest) requestFileContentRepair(file, errorKind)
      throw error
    }
  }

  function preloadFileContent(file: FileRecord): void {
    if (file.dataUrl || fileContentCacheRef.current[file.id] || fileContentLoadsRef.current[file.id] || !canResolveFileContent(file)) return
    if (isContentFailureCoolingDown(file)) {
      syncLog('preview preload skipped: previous content failure cooling down', { fileId: file.id, fileName: file.name, cid: shortLogValue(file.lastCid), shareCid: shortLogValue(file.lastShareCid) })
      return
    }
    const queue = fileContentPreloadQueueRef?.current
    if (!queue) {
      startPreviewPreload(file)
      return
    }
    queue.items.set(file.id, file)
    drainPreviewPreloadQueue()
  }

  function drainPreviewPreloadQueue(): void {
    const queue = fileContentPreloadQueueRef?.current
    if (!queue || queue.running) return
    const next = queue.items.entries().next()
    if (next.done) return
    const [fileId, queuedFile] = next.value
    queue.items.delete(fileId)
    queue.running = true
    schedulePreloadTask(() => {
      const currentFile = snapshotRef.current.files.find((item) => item.id === queuedFile.id && !item.deletedAt) ?? queuedFile
      void startPreviewPreload(currentFile).finally(() => {
        queue.running = false
        drainPreviewPreloadQueue()
      })
    })
  }

  function startPreviewPreload(file: FileRecord): Promise<void> {
    if (file.dataUrl || fileContentCacheRef.current[file.id] || fileContentLoadsRef.current[file.id] || !canResolveFileContent(file)) return Promise.resolve()
    if (isContentFailureCoolingDown(file)) {
      syncLog('preview preload skipped: previous content failure cooling down', { fileId: file.id, fileName: file.name, cid: shortLogValue(file.lastCid), shareCid: shortLogValue(file.lastShareCid) })
      return Promise.resolve()
    }
    syncLog('preview preload requested', { fileId: file.id, fileName: file.name, cid: shortLogValue(file.lastCid), shareCid: shortLogValue(file.lastShareCid) })
    return ensureFileContent(file, { trackProgress: true }).then(() => {
      clearContentFailure(file)
      syncLog('preview preload complete', { fileId: file.id, fileName: file.name })
    }).catch((error) => {
      const errorKind = contentErrorKind(error)
      rememberContentFailure(file, errorKind)
      syncWarn('preview preload failed', { fileId: file.id, fileName: file.name, cid: shortLogValue(file.lastCid), shareCid: shortLogValue(file.lastShareCid), errorKind, error: describeError(error, 'unknown error') })
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

  function requestFileContentRepair(file: FileRecord, kind: FileContentFailureKind): void {
    if (!networkRef || !shouldRequestFileContentRepair(kind) || !file.lastCid) return
    const snapshotValue = snapshotRef.current
    const folder = snapshotValue.folders.find((item) => item.id === file.folderId && !item.deletedAt)
    const sharedRoot = nearestSharedAncestorFolder(snapshotValue, file.folderId) ?? (folder?.shareEnabled ? folder : undefined)
    if (!sharedRoot) return
    syncLog('requesting file content repair from peers', {
      fileId: file.id,
      fileName: file.name,
      folderId: sharedRoot.id,
      cid: shortLogValue(file.lastCid),
      errorKind: kind,
    })
    networkRef.current.broadcastShare({
      type: 'file-content-repair-request',
      clock: snapshotValue.clock + 1,
      folderId: sharedRoot.id,
      folderName: sharedRoot.name,
      fileId: file.id,
      fileName: file.name,
      cid: file.lastCid,
    })
  }

  function handleFileContentRepairRequest(request: Pick<ShareEnvelope, 'cid' | 'fileId' | 'fileName' | 'folderId' | 'from'>): void {
    if (!networkRef || !request.folderId || !request.fileId || !request.cid) return
    const snapshotValue = snapshotRef.current
    const sharedRoot = snapshotValue.folders.find((item) => item.id === request.folderId && !item.deletedAt && item.shareEnabled)
    const passphrase = sharedRoot ? folderKeysRef.current[sharedRoot.id] : ''
    if (!sharedRoot || !passphrase) return
    const folderIds = descendantFolderIds(activeFolders(snapshotValue), sharedRoot.id)
    const file = activeFiles(snapshotValue).find((item) => item.id === request.fileId && folderIds.has(item.folderId))
    if (!file) return
    if (file.lastCid && file.lastCid !== request.cid) {
      syncLog('file content repair request answered with current metadata', {
        requester: shortLogValue(request.from),
        folderId: sharedRoot.id,
        fileId: file.id,
        fileName: file.name,
        requestedCid: shortLogValue(request.cid),
        currentCid: shortLogValue(file.lastCid),
      })
      networkRef.current.broadcastShare({
        type: 'folder-change',
        clock: snapshotRef.current.clock + 1,
        changeType: 'file-upserted',
        folderId: sharedRoot.id,
        folderName: sharedRoot.name,
        fileId: file.id,
        fileName: file.name,
        file: stripFileContent(file),
        cid: file.lastCid,
      })
      return
    }
    void repairSharedFileContent(sharedRoot, file, passphrase, request)
  }

  async function repairSharedFileContent(
    sharedRoot: FolderRecord,
    file: FileRecord,
    passphrase: string,
    request: Pick<ShareEnvelope, 'cid' | 'fileId' | 'fileName' | 'from'>,
  ): Promise<void> {
    const cached = file.dataUrl ?? fileContentCacheRef.current[file.id]
    if (!cached && !canResolveFileContent(file)) {
      syncLog('file content repair request skipped: content not available locally', {
        requester: shortLogValue(request.from),
        folderId: sharedRoot.id,
        fileId: file.id,
        fileName: file.name,
        requestedCid: shortLogValue(request.cid),
      })
      return
    }
    try {
      syncLog('file content repair storage_add start', {
        requester: shortLogValue(request.from),
        folderId: sharedRoot.id,
        fileId: file.id,
        fileName: file.name,
        requestedCid: shortLogValue(request.cid),
      })
      const fileWithContent = cached ? { ...file, dataUrl: cached } : await ensureFileContent(file, { suppressRepairRequest: true })
      const cid = await saveEncryptedFile({ folder: sharedRoot, file: fileWithContent, passphrase, originNode: settingsRef.current.nodeId, runtimeNodeId: settingsRef.current.nodeId})
      const now = new Date().toISOString()
      const repairedFile = stripFileContent(stampFilePatch(fileWithContent, { lastCid: cid }, now, settingsRef.current.nodeId))
      rememberStoredFile(repairedFile, sharedRoot, passphrase)
      setSnapshot((current) => ({
        ...current,
        files: current.files.map((item) => (item.id === file.id ? repairedFile : item)),
      }))
      networkRef?.current.broadcastShare({
        type: 'folder-change',
        clock: snapshotRef.current.clock + 1,
        changeType: 'file-upserted',
        folderId: sharedRoot.id,
        folderName: sharedRoot.name,
        fileId: repairedFile.id,
        fileName: repairedFile.name,
        file: repairedFile,
        cid,
      })
      syncLog('file content repair storage_add complete', {
        requester: shortLogValue(request.from),
        folderId: sharedRoot.id,
        fileId: repairedFile.id,
        fileName: repairedFile.name,
        previousCid: shortLogValue(request.cid),
        cid: shortLogValue(cid),
      })
    } catch (error) {
      syncWarn('file content repair failed', {
        requester: shortLogValue(request.from),
        folderId: sharedRoot.id,
        fileId: file.id,
        fileName: file.name,
        requestedCid: shortLogValue(request.cid),
        error: describeError(error, 'unknown error'),
      })
    }
  }

  function hasUntrustedFolderContent(folderId: string): boolean {
    const snapshot = snapshotRef.current
    const folder = snapshot.folders.find((item) => item.id === folderId && !item.deletedAt)
    const passphrase = folder ? folderKeysRef.current[folder.id] : ''
    if (!folder || !passphrase) return false
    const folderIds = descendantFolderIds(activeFolders(snapshot), folderId)
    return activeFiles(snapshot).some((file) => (
      folderIds.has(file.folderId) &&
      shouldTrackFileStorageForFolder(snapshot, file, folder.id) &&
      Boolean(file.dataUrl || fileContentCacheRef.current[file.id]) &&
      !isFileStoredForFolder(file, folder, passphrase)
    ))
  }

  async function loadFileContentFromCandidates(file: FileRecord, candidates: FileContentCandidate[]): Promise<string> {
    let lastError: unknown
    for (const [index, candidate] of candidates.entries()) {
      try {
        syncLog('storage_get start for file content', { fileId: file.id, fileName: file.name, cid: shortLogValue(candidate.cid), source: candidate.source, candidateIndex: index + 1, candidateCount: candidates.length })
        const bundle = await loadEncryptedFile(candidate.cid, candidate.passphrase, storageRuntimeSettings())
        if (!bundle.file.dataUrl) throw new Error(`${file.name} の本文が共有データに含まれていません`)
        syncLog('storage_get complete for file content', { fileId: file.id, fileName: file.name, cid: shortLogValue(candidate.cid), source: candidate.source, candidateIndex: index + 1, candidateCount: candidates.length, bytes: dataUrlByteLength(bundle.file.dataUrl) })
        rememberResolvedFileCandidate(file, candidate)
        return bundle.file.dataUrl
      } catch (error) {
        lastError = error
        syncWarn('storage_get failed for file content candidate', { fileId: file.id, fileName: file.name, cid: shortLogValue(candidate.cid), source: candidate.source, candidateIndex: index + 1, candidateCount: candidates.length, errorKind: contentErrorKind(error), error: describeError(error, 'unknown error') })
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${file.name} の本文を取得できませんでした`)
  }

  async function loadFileContentFromFolderBundle(file: FileRecord, folderCid: string, passphrase: string, attemptedCandidates: Set<string>): Promise<string> {
    syncLog('storage_get start for parent folder content fallback', { fileId: file.id, fileName: file.name, folderCid: shortLogValue(folderCid) })
    const bundle = await materializeFolderBundleFiles(await loadEncryptedFolder(folderCid, passphrase, storageRuntimeSettings()), passphrase)
    const bundledFile = bundle.files.find((item) => item.id === file.id)
    if (!bundledFile) throw new Error(`${file.name} がフォルダー共有データに見つかりません`)
    syncLog('parent folder content fallback found file entry', {
      fileId: file.id,
      fileName: file.name,
      currentCid: shortLogValue(file.lastCid),
      bundledCid: shortLogValue(bundledFile.lastCid),
      bundledHasDataUrl: Boolean(bundledFile.dataUrl),
      bundledSize: bundledFile.size,
      bundledChecksum: bundledFile.checksum,
      folderCid: shortLogValue(folderCid),
    })
    if (bundledFile.dataUrl) {
      acceptBundledFileCid(file, bundledFile, bundle, 'parent-folder-dataUrl')
      syncLog('storage_get complete for parent folder content fallback', { fileId: file.id, fileName: file.name, folderCid: shortLogValue(folderCid) })
      return bundledFile.dataUrl
    }
    if (bundledFile.lastCid) {
      const candidate = { cid: bundledFile.lastCid, passphrase, source: 'parent-folder-file' }
      if (attemptedCandidates.has(candidateKey(candidate))) throw new Error(`${file.name} の本文CIDは既に同じ復号キーで試行済みです`)
      const dataUrl = await loadFileContentFromCandidates(file, [candidate])
      rememberStoredFile({ ...bundledFile, lastCid: bundledFile.lastCid }, bundle.folder, passphrase)
      acceptBundledFileCid(file, bundledFile, bundle, 'parent-folder-file')
      return dataUrl
    }
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
          path: zipFilePath(entries, zipLayout.folderPathById, folder, fileWithContent, zipLayout.usedPaths),
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

  function fileContentCandidates(file: FileRecord): FileContentCandidate[] {
    const candidates: FileContentCandidate[] = []
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

  function attemptedCandidateKeys(candidates: FileContentCandidate[]): Set<string> {
    return new Set(candidates.map(candidateKey))
  }

  function candidateKey(candidate: Pick<FileContentCandidate, 'cid' | 'passphrase'>): string {
    return `${candidate.cid}\0${candidate.passphrase}`
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
    fileContentStorageRef.current[fileStorageProofKey(file, folder, passphrase)] = JSON.stringify({
      cid: file.lastCid,
      signature: fileStorageProof(file),
    } satisfies StoredFileProof)
  }

  function rememberResolvedFileCandidate(file: FileRecord, candidate: FileContentCandidate): void {
    if (candidate.source === 'file-share') return
    const folder = candidate.source === 'shared-root'
      ? nearestSharedAncestorFolder(snapshotRef.current, file.folderId)
      : snapshotRef.current.folders.find((item) => item.id === file.folderId)
    if (!folder) return
    rememberStoredFile({ ...file, lastCid: candidate.cid }, folder, candidate.passphrase)
    syncLog('file content storage proof recorded from storage_get', {
      fileId: file.id,
      fileName: file.name,
      cid: shortLogValue(candidate.cid),
      source: candidate.source,
      proofFolderId: folder.id,
    })
  }

  function fileStorageProofKey(file: FileRecord, folder: FolderRecord, passphrase: string): string {
    return `${file.id}:${folder.id}:${folderKeyHash(folder.id, passphrase)}`
  }

  function fileStorageProof(file: FileRecord): string {
    return `${file.checksum}:${file.size}:${file.version}:${file.deletedAt ?? ''}`
  }

  function fileStoredForFolder(file: FileRecord, folder: FolderRecord, passphrase: string): FileRecord | undefined {
    const raw = fileContentStorageRef?.current[fileStorageProofKey(file, folder, passphrase)]
    if (!raw) return undefined
    try {
      const stored = JSON.parse(raw) as Partial<StoredFileProof>
      if (!stored.cid || stored.signature !== fileStorageProof(file)) return undefined
      return { ...file, lastCid: stored.cid }
    } catch {
      return undefined
    }
  }

  function shouldTrackFileStorageForFolder(snapshot: StorageSnapshot, file: FileRecord, folderId: string): boolean {
    const sharedRoot = nearestSharedAncestorFolder(snapshot, file.folderId)
    return !sharedRoot || sharedRoot.id === folderId
  }

  function isContentFailureCoolingDown(file: FileRecord): boolean {
    const failure = fileContentFailuresRef?.current[file.id]
    return Boolean(failure && failure.signature === fileContentSignature(file) && failure.retryAfter > Date.now())
  }

  function rememberContentFailure(file: FileRecord, kind: FileContentFailureKind): void {
    if (!fileContentFailuresRef) return
    fileContentFailuresRef.current[file.id] = { kind, retryAfter: Date.now() + failedContentRetryMs, signature: fileContentSignature(file) }
  }

  function clearContentFailure(file: FileRecord): void {
    if (fileContentFailuresRef) delete fileContentFailuresRef.current[file.id]
  }

  function fileContentSignature(file: FileRecord): string {
    const folder = snapshotRef.current.folders.find((item) => item.id === file.folderId)
    const sharedRoot = nearestSharedAncestorFolder(snapshotRef.current, file.folderId)
    return JSON.stringify([file.id, file.lastCid ?? '', file.lastShareCid ?? '', folder?.lastCid ?? '', sharedRoot?.lastCid ?? '', folderKeysRef.current[file.folderId] ? folderKeyHash(file.folderId, folderKeysRef.current[file.folderId]) : '', sharedRoot && folderKeysRef.current[sharedRoot.id] ? folderKeyHash(sharedRoot.id, folderKeysRef.current[sharedRoot.id]) : '', fileShareKeysRef.current[file.id] ? folderKeyHash(file.id, fileShareKeysRef.current[file.id]) : ''])
  }

  function acceptBundledFileCid(file: FileRecord, bundledFile: FileRecord, bundle: FolderBundle, source: string): void {
    if (!bundledFile.lastCid || bundledFile.lastCid === file.lastCid) return
    syncLog('accepting parent folder file cid after content resolved', { fileId: file.id, fileName: file.name, previousCid: shortLogValue(file.lastCid), nextCid: shortLogValue(bundledFile.lastCid), source })
    setSnapshot((current) => ({
      ...current,
      files: current.files.map((item) => (item.id === file.id ? stripFileContent(stampFilePatch(item, { lastCid: bundledFile.lastCid }, bundledFile.updatedAt, bundle.originNode)) : item)),
    }))
  }

  function fileContentPlanDetails(file: FileRecord, candidates: FileContentCandidate[], folderBundleCandidate: { cid: string; passphrase: string } | undefined): Record<string, unknown> {
    const folder = snapshotRef.current.folders.find((item) => item.id === file.folderId)
    const sharedRoot = nearestSharedAncestorFolder(snapshotRef.current, file.folderId)
    const folderPassphrase = folderKeysRef.current[file.folderId]
    const sharedRootPassphrase = sharedRoot ? folderKeysRef.current[sharedRoot.id] : undefined
    const filePassphrase = fileShareKeysRef.current[file.id]
    return {
      fileId: file.id,
      fileName: file.name,
      mimeType: file.mimeType,
      size: file.size,
      checksum: file.checksum,
      currentCid: shortLogValue(file.lastCid),
      shareCid: shortLogValue(file.lastShareCid),
      hasMemoryCache: Boolean(fileContentCacheRef.current[file.id]),
      hasRecordDataUrl: Boolean(file.dataUrl),
      folderId: file.folderId,
      folderCid: shortLogValue(folder?.lastCid),
      sharedRootId: sharedRoot?.id,
      sharedRootCid: shortLogValue(sharedRoot?.lastCid),
      hasFolderKey: Boolean(folderPassphrase),
      hasSharedRootKey: Boolean(sharedRootPassphrase),
      hasFileShareKey: Boolean(filePassphrase),
      folderKeyHash: folderPassphrase ? folderKeyHash(file.folderId, folderPassphrase) : '',
      sharedRootKeyHash: sharedRoot && sharedRootPassphrase ? folderKeyHash(sharedRoot.id, sharedRootPassphrase) : '',
      fileShareKeyHash: filePassphrase ? folderKeyHash(file.id, filePassphrase) : '',
      candidates: candidates.map((candidate) => ({ cid: shortLogValue(candidate.cid), source: candidate.source })),
      folderBundleCid: shortLogValue(folderBundleCandidate?.cid),
    }
  }

  function dataUrlByteLength(dataUrl: string): number | undefined {
    const commaIndex = dataUrl.indexOf(',')
    if (commaIndex === -1) return undefined
    const payload = dataUrl.slice(commaIndex + 1)
    if (!dataUrl.slice(0, commaIndex).includes(';base64')) return payload.length
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
    return Math.floor((payload.length * 3) / 4) - padding
  }

  function contentErrorKind(error: unknown): FileContentFailureKind {
    const message = describeError(error, 'unknown error')
    if (message.includes('Block not found')) return 'block-not-found'
    if (message.includes('Network error') || message.includes('storage_get') || message.includes('retrieval failed')) return 'network'
    if (message.includes('復号') || message.includes('decrypt') || message.includes('AES-GCM')) return 'decrypt'
    if (message.includes('JSON')) return 'parse'
    if (message.includes('本文') || message.includes('data')) return 'missing-data'
    return 'unknown'
  }

  return { canResolveFileContent, downloadFolderAsZip, downloadStoredFile, ensureFileContent, ensureFolderFilesStored, handleFileContentRepairRequest, hasUntrustedFolderContent, materializeFolderBundleFiles, preloadFileContent }
}

function shouldRequestFileContentRepair(kind: FileContentFailureKind): boolean {
  return kind === 'decrypt' || kind === 'parse' || kind === 'block-not-found' || kind === 'network'
}

function schedulePreloadTask(task: () => void): void {
  const scheduler = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  }
  if (typeof scheduler.requestIdleCallback === 'function') {
    scheduler.requestIdleCallback(task, { timeout: 1200 })
    return
  }
  globalThis.setTimeout(task, 80)
}
