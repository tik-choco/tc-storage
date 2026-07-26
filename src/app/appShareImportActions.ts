import { pendingShareKey, type Notice, type PendingShare, type ShareImportProgress } from './appTypes.js'
import type { FileContentActions, MutableRef, SetState } from './appControllerTypes.js'
import { mergeSnapshots } from '../storage/crdt.js'
import type { FolderBundle, StorageSnapshot } from '../storage/domain.js'
import { addActivity } from '../storage/domain.js'
import { describeError } from '../util/errors.js'
import { loadEncryptedFileFromMist, loadEncryptedFolderFromMist } from '../storage/mistStorage.js'
import type { AppSettings } from '../storage/localSettings.js'
import { remoteFileSnapshot, remoteFolderSnapshot } from './appHelpers.js'
import { folderKeyHash } from '../crypto/folderKeyProof.js'
import { folderKeyUpdatesForBundle, shareLogDetails, syncLog, syncWarn, withoutRecordKey } from './appUtils.js'
import { sharedFolderSignature } from '../folder/folderSync.js'
import { makeShareImportProgress, withShareImportProgress, withoutShareImportProgress } from './shareImportProgress.js'

interface ShareImportOptions {
  accessRequestKeysRef?: MutableRef<Record<string, { folderId: string; roomId: string }>>
  autoImportCidsRef: MutableRef<Set<string>>
  autoImportFailuresRef?: MutableRef<Record<string, { retryAfter: number; signature: string }>>
  autoImportInFlightRef: MutableRef<Set<string>>
  clearFolderSyncTimer: (folderId: string) => void
  importKeys: Record<string, string>
  materializeFolderBundleFiles: FileContentActions['materializeFolderBundleFiles']
  pendingSharesRef: MutableRef<PendingShare[]>
  rememberFolderPeer: (share: PendingShare) => void
  setBusy: SetState<string>
  setCurrentFolderId: SetState<string | null>
  setDetailFileId: SetState<string | null>
  setFileContentCache: SetState<Record<string, string>>
  setFileShareKeys: SetState<Record<string, string>>
  setFolderKeys: SetState<Record<string, string>>
  setImportKeys: SetState<Record<string, string>>
  setNotice: SetState<Notice>
  setPendingShares: SetState<PendingShare[]>
  setShareImportProgress: SetState<Record<string, ShareImportProgress>>
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  snapshotRef: MutableRef<StorageSnapshot>
  syncSignaturesRef: MutableRef<Record<string, string>>
}

const failedShareRetryMs = 30_000

export function createShareImportActions(options: ShareImportOptions) {
  const {
    accessRequestKeysRef, autoImportCidsRef, autoImportFailuresRef, autoImportInFlightRef, clearFolderSyncTimer,
    importKeys, materializeFolderBundleFiles, pendingSharesRef, rememberFolderPeer, setBusy, setCurrentFolderId,
    setDetailFileId, setFileContentCache, setFileShareKeys, setFolderKeys, setImportKeys, setNotice,
    setPendingShares, setShareImportProgress, setSnapshot, settingsRef, snapshotRef, syncSignaturesRef,
  } = options

  function storageRuntimeSettings() {
    return { nodeId: settingsRef.current.nodeId }
  }

  function publishShareImportProgress(key: string, progress: ShareImportProgress): void {
    setShareImportProgress((current) => withShareImportProgress(current, key, progress))
  }

  function clearShareImportProgress(key: string): void {
    setShareImportProgress((current) => withoutShareImportProgress(current, key))
  }

  /** Cache any file content the bundle already carries inline, ahead of the (possibly slow)
   * legacy-body re-upload pass, so file rows can render content immediately. */
  function cacheInlineBundleContent(bundle: FolderBundle): void {
    const cacheNext: Record<string, string> = {}
    for (const file of bundle.files) if (file.dataUrl) cacheNext[file.id] = file.dataUrl
    if (Object.keys(cacheNext).length > 0) setFileContentCache((current) => ({ ...current, ...cacheNext }))
  }

  /** Fetches+decrypts a folder-share bundle, publishing staged progress along the way.
   * Callers still need to merge the returned (un-materialized) bundle into the snapshot
   * and kick off `backgroundMaterializeFolderShare` for the legacy-body re-upload pass. */
  async function fetchFolderShareBundle(share: PendingShare, passphrase: string): Promise<FolderBundle> {
    const progressKey = pendingShareKey(share)
    // `connecting` covers the mistlib module load + runtime init that runs before the first byte
    // is requested; loadEncryptedFolderFromMist then reports the fetch/decrypt boundary itself.
    publishShareImportProgress(progressKey, makeShareImportProgress('connecting'))
    const bundle = await loadEncryptedFolderFromMist(share.cid ?? '', passphrase, storageRuntimeSettings(), {
      onPhase: (phase) => publishShareImportProgress(progressKey, makeShareImportProgress(phase)),
    })
    publishShareImportProgress(progressKey, makeShareImportProgress('materializing', { folderId: bundle.folder.id }))
    cacheInlineBundleContent(bundle)
    return bundle
  }

  /** Merges a folder bundle's metadata into the snapshot via the existing per-field LWW merge.
   * `forceActivity` mirrors the pre-staging behavior (always log + track signature); the
   * background re-merge pass instead only logs/tracks when the merge actually changed something,
   * so re-uploading legacy bodies doesn't spam the activity log with no-op entries. */
  function mergeFolderBundleIntoSnapshot(bundle: FolderBundle, share: PendingShare, action: string, detail: string, now: string, forceActivity: boolean): void {
    setSnapshot((current) => {
      const previousLocalSignature = sharedFolderSignature(current, bundle.folder.id)
      const remoteSnapshot = remoteFolderSnapshot(bundle, share, {
        preserveRootFolder: current.folders.find((item) => item.id === bundle.folder.id && !item.deletedAt),
      })
      const merged = mergeSnapshots(current, remoteSnapshot)
      const changed = sharedFolderSignature(merged, bundle.folder.id) !== previousLocalSignature
      const next = forceActivity || changed
        ? addActivity(merged, { actorNodeId: settingsRef.current.nodeId, folderId: bundle.folder.id, action, detail }, now)
        : merged
      if (forceActivity || changed) rememberImportedFolderSignature(bundle.folder.id, previousLocalSignature, next, remoteSnapshot)
      return next
    })
  }

  /** Re-uploads legacy inline file bodies in the background (not awaited by the caller) and
   * re-merges the resulting `lastCid`s once done. Failures here are non-fatal: the metadata
   * merge already landed, so we just log a warning and leave the pending files as-is. */
  function backgroundMaterializeFolderShare(share: PendingShare, bundle: FolderBundle, passphrase: string, action: string, detail: (folderName: string) => string): void {
    void materializeFolderBundleFiles(bundle, passphrase)
      .then((materialized) => {
        mergeFolderBundleIntoSnapshot(materialized, share, action, detail(materialized.folder.name), new Date().toISOString(), false)
      })
      .catch((error) => {
        syncWarn('folder-share legacy content materialize failed after metadata merge', { ...shareLogDetails(share), folderId: bundle.folder.id, error: describeError(error, 'unknown error') })
      })
  }

  async function autoImportFolderShare(share: PendingShare, passphrase: string) {
    const cid = share.cid
    if (!cid) return
    if (isShareFailureCoolingDown(share, passphrase)) return
    autoImportInFlightRef.current.add(cid)
    try {
      syncLog('storage_get start for folder-share', shareLogDetails(share))
      const bundle = await fetchFolderShareBundle(share, passphrase)
      syncLog('storage_get complete for folder-share', { ...shareLogDetails(share), folderId: bundle.folder.id, folderName: bundle.folder.name, fileCount: bundle.files.length })
      const now = new Date().toISOString()
      clearFolderSyncTimer(bundle.folder.id)
      // Merge folder+file metadata first (no legacy body upload yet) so the folder row and its
      // file rows can render right away; the slow re-upload pass runs in the background below.
      mergeFolderBundleIntoSnapshot(bundle, share, 'folder.sync', `${bundle.folder.name} を自動同期`, now, true)
      setFolderKeys((current) => ({ ...current, ...folderKeyUpdatesForBundle(bundle, passphrase) }))
      rememberFolderPeer(share)
      markPendingShareImported(share)
      clearShareFailure(share)
      setNotice({ tone: 'success', text: `${bundle.folder.name} を自動同期しました` })
      backgroundMaterializeFolderShare(share, bundle, passphrase, 'folder.sync', (folderName) => `${folderName} を自動同期`)
    } catch (error) {
      publishShareImportProgress(pendingShareKey(share), makeShareImportProgress('failed'))
      rememberShareFailure(share, passphrase)
      syncWarn('storage_get failed for folder-share', { ...shareLogDetails(share), error: describeError(error, 'unknown error') })
      setNotice({ tone: 'error', text: describeError(error, '共有フォルダーの自動同期に失敗しました') })
    } finally {
      autoImportInFlightRef.current.delete(cid)
    }
  }

  async function autoImportLinkedShare(share: PendingShare, passphrase: string, options: { force?: boolean } = {}) {
    if (!share.cid) return
    if (!options.force && isShareFailureCoolingDown(share, passphrase)) return
    autoImportInFlightRef.current.add(share.cid)
    try {
      syncLog('storage_get start for linked share', shareLogDetails(share))
      if (share.type === 'file-share') await importFileShare(share, passphrase)
      else await importFolderShare(share, passphrase)
      markPendingShareImported(share)
      clearShareFailure(share)
      syncLog('storage_get complete for linked share', shareLogDetails(share))
    } catch (error) {
      publishShareImportProgress(pendingShareKey(share), makeShareImportProgress('failed'))
      rememberShareFailure(share, passphrase)
      syncWarn('storage_get failed for linked share; keeping pending for retry', { ...shareLogDetails(share), error: describeError(error, 'unknown error') })
      setNotice({ tone: 'info', text: '共有データを待機中です。送り主がオンラインになったら自動的に再試行します' })
    } finally {
      autoImportInFlightRef.current.delete(share.cid)
    }
  }

  function isPendingShareAlreadyImported(share: PendingShare): boolean {
    const snapshotValue = snapshotRef.current
    if (share.type === 'folder-share') {
      const folder = share.folderId ? snapshotValue.folders.find((item) => item.id === share.folderId && !item.deletedAt) : undefined
      if (folder && share.folderSignature && share.folderSignature === sharedFolderSignature(snapshotValue, folder.id)) return true
      if (!share.cid) return Boolean(folder)
      return folder?.lastCid === share.cid
    }
    if (!share.cid) return true
    const file = share.fileId ? snapshotValue.files.find((item) => item.id === share.fileId && !item.deletedAt) : undefined
    return Boolean(file && (file.lastShareCid === share.cid || file.lastCid === share.cid))
  }

  function markPendingShareImported(share: PendingShare): void {
    const cid = share.cid
    if (!cid) return
    autoImportCidsRef.current.add(cid)
    const pendingMatches = pendingSharesRef.current.filter((item) => pendingShareMatchesImported(item, share))
    setPendingShares((current) => current.filter((item) => !pendingShareMatchesImported(item, share)))
    setImportKeys((current) => {
      let next = withoutRecordKey(current, cid)
      for (const pending of pendingMatches) {
        if (pending.cid) next = withoutRecordKey(next, pending.cid)
      }
      return next
    })
    // Drop the pending-share-keyed progress entry outright: once the share is imported, the
    // pending row disappears (filtered out of pendingShares above) and the real FolderRow/
    // FolderTile takes over, computing its own "n/m received" straight from the file cache
    // (see browserProgressUtils.ts) instead of from a second, easily-stale progress entry.
    clearShareImportProgress(pendingShareKey(share))
    if (accessRequestKeysRef && share.type === 'folder-share' && share.folderId) {
      accessRequestKeysRef.current = Object.fromEntries(Object.entries(accessRequestKeysRef.current).filter(([, entry]) => !(entry.folderId === share.folderId && entry.roomId === share.roomId)))
    }
  }

  function cancelPendingShare(share: PendingShare): void {
    const key = pendingShareKey(share)
    setPendingShares((current) => current.filter((item) => pendingShareKey(item) !== key))
    if (share.cid) setImportKeys((current) => withoutRecordKey(current, share.cid ?? ''))
    clearAccessRequestKeysForShare(share)
    clearShareImportProgress(key)
    setNotice({ tone: 'info', text: '共有待ちをキャンセルしました' })
  }

  async function importShare(share: PendingShare) {
    if (!share.cid) return setNotice({ tone: 'info', text: '共有元の承認を待っています' })
    const passphrase = importKeys[share.cid]?.trim() ?? ''
    if (!passphrase) return setNotice({ tone: 'error', text: share.type === 'file-share' ? '共有ファイルの復号キーを入力してください' : '共有フォルダーの復号キーを入力してください' })
    setBusy(`import-${share.cid}`)
    try {
      if (share.type === 'file-share') await importFileShare(share, passphrase)
      else await importFolderShare(share, passphrase)
      markPendingShareImported(share)
    } catch (error) {
      publishShareImportProgress(pendingShareKey(share), makeShareImportProgress('failed'))
      setNotice({ tone: 'error', text: describeError(error, '共有を復号できませんでした') })
    } finally {
      setBusy('')
    }
  }

  async function importFolderShare(share: PendingShare, passphrase: string) {
    const bundle = await fetchFolderShareBundle(share, passphrase)
    clearFolderSyncTimer(bundle.folder.id)
    // Merge metadata first, same staging as the auto-import path, then re-upload legacy bodies
    // in the background so the manual "取り込み" action doesn't block on it either.
    mergeFolderBundleIntoSnapshot(bundle, share, 'folder.import', `${bundle.folder.name} を復号して取り込み`, new Date().toISOString(), true)
    setFolderKeys((current) => ({ ...current, ...folderKeyUpdatesForBundle(bundle, passphrase) }))
    rememberFolderPeer({ ...share, folderId: bundle.folder.id })
    setCurrentFolderId(bundle.folder.id)
    setNotice({ tone: 'success', text: `${bundle.folder.name} を取り込みました` })
    backgroundMaterializeFolderShare(share, bundle, passphrase, 'folder.import', (folderName) => `${folderName} を復号して取り込み`)
  }

  async function importFileShare(share: PendingShare, passphrase: string) {
    const progressKey = pendingShareKey(share)
    publishShareImportProgress(progressKey, makeShareImportProgress('connecting'))
    const bundle = await loadEncryptedFileFromMist(share.cid ?? '', passphrase, storageRuntimeSettings(), {
      onPhase: (phase) => publishShareImportProgress(progressKey, makeShareImportProgress(phase)),
    })
    const dataUrl = bundle.file.dataUrl
    if (dataUrl) setFileContentCache((current) => ({ ...current, [bundle.file.id]: dataUrl }))
    setSnapshot((current) => addActivity(mergeSnapshots(current, remoteFileSnapshot(bundle, share)), { actorNodeId: settingsRef.current.nodeId, fileId: bundle.file.id, folderId: bundle.folder.id, action: 'file.import', detail: `${bundle.file.name} を復号して取り込み` }))
    setFileShareKeys((current) => ({ ...current, [bundle.file.id]: passphrase }))
    setCurrentFolderId(bundle.folder.id)
    setDetailFileId(bundle.file.id)
    setNotice({ tone: 'success', text: `${bundle.file.name} を取り込みました` })
  }

  function rememberImportedFolderSignature(folderId: string, previousLocalSignature: string, merged: StorageSnapshot, remote: StorageSnapshot) {
    const mergedSignature = sharedFolderSignature(merged, folderId)
    const remoteSignature = sharedFolderSignature(remote, folderId)
    syncSignaturesRef.current[folderId] = folderSignatureForImportedShareTracking({
      previousLocalSignature,
      mergedSignature,
      remoteSignature,
    })
  }

  function pendingShareMatchesImported(pending: PendingShare, imported: PendingShare): boolean {
    if (pending.roomId !== imported.roomId || pending.type !== imported.type) return false
    if (pending.cid && pending.cid === imported.cid) return true
    if (imported.type === 'folder-share' && pending.type === 'folder-share' && imported.folderId && pending.folderId === imported.folderId) return true
    if (imported.type === 'file-share' && pending.type === 'file-share' && imported.fileId && pending.fileId === imported.fileId) return true
    return false
  }

  function clearAccessRequestKeysForShare(share: PendingShare): void {
    if (!accessRequestKeysRef || share.type !== 'folder-share' || !share.folderId) return
    const shareKey = pendingShareKey(share)
    accessRequestKeysRef.current = Object.fromEntries(Object.entries(accessRequestKeysRef.current).filter(([key, entry]) => (
      key !== shareKey &&
      !(entry.folderId === share.folderId && entry.roomId === share.roomId)
    )))
  }

  function isShareFailureCoolingDown(share: PendingShare, passphrase: string): boolean {
    const key = pendingShareKey(share)
    const failure = autoImportFailuresRef?.current[key]
    return Boolean(failure && failure.signature === shareFailureSignature(share, passphrase) && failure.retryAfter > Date.now())
  }

  function rememberShareFailure(share: PendingShare, passphrase: string): void {
    if (!autoImportFailuresRef) return
    autoImportFailuresRef.current[pendingShareKey(share)] = { retryAfter: Date.now() + failedShareRetryMs, signature: shareFailureSignature(share, passphrase) }
  }

  function clearShareFailure(share: PendingShare): void {
    if (autoImportFailuresRef) delete autoImportFailuresRef.current[pendingShareKey(share)]
  }

  function shareFailureSignature(share: PendingShare, passphrase: string): string {
    return JSON.stringify({
      cid: share.cid ?? '',
      folderId: share.folderId ?? '',
      fileId: share.fileId ?? '',
      passphraseHash: folderKeyHash(share.folderId ?? share.fileId ?? share.cid ?? share.roomId, passphrase),
      roomId: share.roomId,
      type: share.type,
    })
  }

  return { autoImportFolderShare, autoImportLinkedShare, cancelPendingShare, importShare, isPendingShareAlreadyImported, markPendingShareImported }
}

export function folderSignatureForImportedShareTracking(options: {
  previousLocalSignature: string
  mergedSignature: string
  remoteSignature: string
}): string {
  if (options.mergedSignature === options.remoteSignature) return options.mergedSignature
  if (options.mergedSignature === options.previousLocalSignature) return options.mergedSignature
  return options.remoteSignature
}
