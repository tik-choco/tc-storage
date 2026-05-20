import type { Notice, PendingShare } from './appTypes.js'
import type { FileContentActions, MutableRef, SetState } from './appControllerTypes.js'
import { mergeSnapshots } from './crdt.js'
import type { StorageSnapshot } from './domain.js'
import { addActivity } from './domain.js'
import { describeError } from './errors.js'
import { loadEncryptedFileFromMist, loadEncryptedFolderFromMist } from './mistStorage.js'
import type { AppSettings } from './localSettings.js'
import { remoteFileSnapshot, remoteFolderSnapshot } from './appHelpers.js'
import { folderKeyUpdatesForBundle, shareLogDetails, syncLog, syncWarn, withoutRecordKey } from './appUtils.js'
import { sharedFolderSignature } from './folderSync.js'

interface ShareImportOptions {
  autoImportCidsRef: MutableRef<Set<string>>
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
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  snapshotRef: MutableRef<StorageSnapshot>
  syncSignaturesRef: MutableRef<Record<string, string>>
}

export function createShareImportActions(options: ShareImportOptions) {
  const {
    autoImportCidsRef, autoImportInFlightRef, clearFolderSyncTimer, importKeys,
    materializeFolderBundleFiles, pendingSharesRef, rememberFolderPeer, setBusy, setCurrentFolderId,
    setDetailFileId, setFileContentCache, setFileShareKeys, setFolderKeys, setImportKeys, setNotice,
    setPendingShares, setSnapshot, settingsRef, snapshotRef, syncSignaturesRef,
  } = options

  async function autoImportFolderShare(share: PendingShare, passphrase: string) {
    const cid = share.cid
    if (!cid) return
    autoImportInFlightRef.current.add(cid)
    try {
      syncLog('storage_get start for folder-share', shareLogDetails(share))
      const bundle = await materializeFolderBundleFiles(await loadEncryptedFolderFromMist(cid, passphrase), passphrase)
      syncLog('storage_get complete for folder-share', { ...shareLogDetails(share), folderId: bundle.folder.id, folderName: bundle.folder.name, fileCount: bundle.files.length })
      const remoteSnapshot = remoteFolderSnapshot(bundle, share)
      const now = new Date().toISOString()
      clearFolderSyncTimer(bundle.folder.id)
      setSnapshot((current) => {
        const merged = mergeSnapshots(current, remoteSnapshot)
        const next = addActivity(merged, { actorNodeId: settingsRef.current.nodeId, folderId: bundle.folder.id, action: 'folder.sync', detail: `${bundle.folder.name} を自動同期` }, now)
        rememberImportedFolderSignature(bundle.folder.id, next, remoteSnapshot)
        return next
      })
      setFolderKeys((current) => ({ ...current, ...folderKeyUpdatesForBundle(bundle, passphrase) }))
      rememberFolderPeer(share)
      markPendingShareImported(share)
      setNotice({ tone: 'success', text: `${bundle.folder.name} を自動同期しました` })
    } catch (error) {
      syncWarn('storage_get failed for folder-share', { ...shareLogDetails(share), error: describeError(error, 'unknown error') })
      setNotice({ tone: 'error', text: describeError(error, '共有フォルダーの自動同期に失敗しました') })
    } finally {
      autoImportInFlightRef.current.delete(cid)
    }
  }

  async function autoImportLinkedShare(share: PendingShare, passphrase: string) {
    if (!share.cid) return
    autoImportInFlightRef.current.add(share.cid)
    try {
      syncLog('storage_get start for linked share', shareLogDetails(share))
      if (share.type === 'file-share') await importFileShare(share, passphrase)
      else await importFolderShare(share, passphrase)
      markPendingShareImported(share)
      syncLog('storage_get complete for linked share', shareLogDetails(share))
    } catch (error) {
      syncWarn('storage_get failed for linked share; keeping pending for retry', { ...shareLogDetails(share), error: describeError(error, 'unknown error') })
      setNotice({ tone: 'info', text: '共有データを待機中です。送り主がオンラインになったら自動的に再試行します' })
    } finally {
      autoImportInFlightRef.current.delete(share.cid)
    }
  }

  function isPendingShareAlreadyImported(share: PendingShare): boolean {
    if (!share.cid) return true
    const snapshotValue = snapshotRef.current
    if (share.type === 'folder-share') {
      const folder = share.folderId ? snapshotValue.folders.find((item) => item.id === share.folderId && !item.deletedAt) : undefined
      return folder?.lastCid === share.cid
    }
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
  }

  function cancelPendingShare(share: PendingShare): void {
    const cid = share.cid
    if (!cid) return
    setPendingShares((current) => current.filter((item) => item.cid !== cid))
    setImportKeys((current) => withoutRecordKey(current, cid))
    setNotice({ tone: 'info', text: '共有待ちをキャンセルしました' })
  }

  async function importShare(share: PendingShare) {
    if (!share.cid) return
    const passphrase = importKeys[share.cid]?.trim() ?? ''
    if (!passphrase) return setNotice({ tone: 'error', text: share.type === 'file-share' ? '共有ファイルの復号キーを入力してください' : '共有フォルダーの復号キーを入力してください' })
    setBusy(`import-${share.cid}`)
    try {
      if (share.type === 'file-share') await importFileShare(share, passphrase)
      else await importFolderShare(share, passphrase)
      markPendingShareImported(share)
    } catch (error) {
      setNotice({ tone: 'error', text: describeError(error, '共有を復号できませんでした') })
    } finally {
      setBusy('')
    }
  }

  async function importFolderShare(share: PendingShare, passphrase: string) {
    const bundle = await materializeFolderBundleFiles(await loadEncryptedFolderFromMist(share.cid ?? '', passphrase), passphrase)
    const remoteSnapshot = remoteFolderSnapshot(bundle, share)
    clearFolderSyncTimer(bundle.folder.id)
    setSnapshot((current) => {
      const next = addActivity(mergeSnapshots(current, remoteSnapshot), { actorNodeId: settingsRef.current.nodeId, folderId: bundle.folder.id, action: 'folder.import', detail: `${bundle.folder.name} を復号して取り込み` })
      rememberImportedFolderSignature(bundle.folder.id, next, remoteSnapshot)
      return next
    })
    setFolderKeys((current) => ({ ...current, ...folderKeyUpdatesForBundle(bundle, passphrase) }))
    rememberFolderPeer({ ...share, folderId: bundle.folder.id })
    setCurrentFolderId(bundle.folder.id)
    setNotice({ tone: 'success', text: `${bundle.folder.name} を取り込みました` })
  }

  async function importFileShare(share: PendingShare, passphrase: string) {
    const bundle = await loadEncryptedFileFromMist(share.cid ?? '', passphrase)
    const dataUrl = bundle.file.dataUrl
    if (dataUrl) setFileContentCache((current) => ({ ...current, [bundle.file.id]: dataUrl }))
    setSnapshot((current) => addActivity(mergeSnapshots(current, remoteFileSnapshot(bundle, share)), { actorNodeId: settingsRef.current.nodeId, fileId: bundle.file.id, folderId: bundle.folder.id, action: 'file.import', detail: `${bundle.file.name} を復号して取り込み` }))
    setFileShareKeys((current) => ({ ...current, [bundle.file.id]: passphrase }))
    setCurrentFolderId(bundle.folder.id)
    setDetailFileId(bundle.file.id)
    setNotice({ tone: 'success', text: `${bundle.file.name} を取り込みました` })
  }

  function rememberImportedFolderSignature(folderId: string, merged: StorageSnapshot, remote: StorageSnapshot) {
    const mergedSignature = sharedFolderSignature(merged, folderId)
    const remoteSignature = sharedFolderSignature(remote, folderId)
    syncSignaturesRef.current[folderId] = mergedSignature === remoteSignature ? mergedSignature : remoteSignature
  }

  function pendingShareMatchesImported(pending: PendingShare, imported: PendingShare): boolean {
    if (pending.cid && pending.cid === imported.cid) return true
    if (imported.type === 'folder-share' && pending.type === 'folder-share' && imported.folderId && pending.folderId === imported.folderId) return true
    if (imported.type === 'file-share' && pending.type === 'file-share' && imported.fileId && pending.fileId === imported.fileId) return true
    return false
  }

  return { autoImportFolderShare, autoImportLinkedShare, cancelPendingShare, importShare, isPendingShareAlreadyImported, markPendingShareImported }
}
