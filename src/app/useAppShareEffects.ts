import { useEffect, useRef } from 'preact/hooks'
import type { PendingShare } from './appTypes.js'
import { folderLogDetails, shareLogDetails, shortLogValue, syncLog } from './appUtils.js'
import type { StorageSnapshot } from '../storage/domain.js'
import { immediateConnectionAnnounceKey, pendingShareRetryIntervalMs, retryablePendingShares, sharedFolderReannounceIntervalMs, shouldRequestFolderAccessForPendingShare, shouldRunSharedFolderReannounce } from './appEffectUtils.js'
import { canAutoImportFolderShare, hasSharedFolderChangesSinceLastShare, sharedFolderSignature } from '../folder/folderSync.js'
import type { AppSettings } from '../storage/localSettings.js'
import type { useMistShare } from '../p2p/p2p.js'

type MutableRef<T> = { current: T }
type MistShare = ReturnType<typeof useMistShare>

interface AppShareEffectsOptions {
  announceSharedFolders: (options?: { publishLocalChangesImmediately?: boolean }) => void
  autoImportCidsRef: MutableRef<Set<string>>
  autoImportFolderShare: (share: PendingShare, passphrase: string) => Promise<void>
  autoImportInFlightRef: MutableRef<Set<string>>
  autoImportLinkedShare: (share: PendingShare, passphrase: string, options?: { force?: boolean }) => Promise<void>
  clearFolderSyncTimer: (folderId: string) => void
  folderKeys: Record<string, string>
  importKeys: Record<string, string>
  isPendingShareAlreadyImported: (share: PendingShare) => boolean
  markPendingShareImported: (share: PendingShare) => void
  network: MistShare
  networkMode: string
  pendingShares: PendingShare[]
  requestFolderAccess: (share: PendingShare) => Promise<void>
  scheduleFolderSync: (folderId: string, reason: string) => void
  settings: AppSettings
  snapshot: StorageSnapshot
  stablePeerCount: number
  stablePeerKey: string
  syncSignaturesRef: MutableRef<Record<string, string>>
  syncTimersRef: MutableRef<Record<string, number>>
}

export function useAppShareEffects(options: AppShareEffectsOptions): void {
  const {
    announceSharedFolders, autoImportCidsRef, autoImportFolderShare, autoImportInFlightRef, autoImportLinkedShare,
    clearFolderSyncTimer, folderKeys, importKeys, isPendingShareAlreadyImported, markPendingShareImported, network,
    networkMode, pendingShares, requestFolderAccess, scheduleFolderSync, settings, snapshot, stablePeerCount,
    stablePeerKey, syncSignaturesRef, syncTimersRef,
  } = options
  const lastConnectionAnnounceKeyRef = useRef('')
  // The app is now joined to every room in network.state.rooms simultaneously (see p2p.ts) --
  // there's no single "active" room to key effects off of, so a stable string of the joined-room
  // set stands in for the old network.state.roomId dependency.
  const joinedRoomsKey = network.state.rooms.join(',')

  useEffect(() => {
    const sharedFolders = snapshot.folders.filter((folder) => folder.shareEnabled && folderKeys[folder.id])
    const sharedIds = new Set(sharedFolders.map((folder) => folder.id))
    for (const folderId of Object.keys(syncSignaturesRef.current)) {
      if (!sharedIds.has(folderId)) {
        syncLog('stop tracking shared folder signature', { folderId })
        clearFolderSyncTimer(folderId)
        delete syncSignaturesRef.current[folderId]
      }
    }
    for (const folder of sharedFolders) {
      const signature = sharedFolderSignature(snapshot, folder.id)
      const previous = syncSignaturesRef.current[folder.id]
      if (!previous) {
        syncSignaturesRef.current[folder.id] = signature
        const hasLocalChanges = hasSharedFolderChangesSinceLastShare(snapshot, folder)
        syncLog('start tracking shared folder signature', { ...folderLogDetails(folder), hasLocalChanges })
        if (hasLocalChanges) scheduleFolderSync(folder.id, 'initial shared folder has local changes')
        continue
      }
      if (previous === signature) continue
      syncSignaturesRef.current[folder.id] = signature
      syncLog('local shared folder signature changed', folderLogDetails(folder))
      scheduleFolderSync(folder.id, 'local shared folder changed')
    }
  }, [folderKeys, snapshot])
  useEffect(() => {
    for (const share of pendingShares) {
      if (!share.cid) {
        if (shouldRequestFolderAccessForPendingShare({
          joinedRooms: network.state.rooms,
          networkMode,
          networkNodeId: network.state.nodeId,
          nodeId: settings.nodeId,
          share,
          stablePeersByRoom: network.state.stablePeersByRoom,
        })) {
          void requestFolderAccess(share)
        }
        continue
      }
      const linkedPassphrase = importKeys[share.cid]?.trim() ?? ''
      if (share.autoImport && linkedPassphrase) {
        if (autoImportCidsRef.current.has(share.cid) || autoImportInFlightRef.current.has(share.cid)) continue
        if (isPendingShareAlreadyImported(share)) {
          markPendingShareImported(share)
          continue
        }
        void autoImportLinkedShare(share, linkedPassphrase)
        continue
      }
      if (share.type !== 'folder-share' || !share.folderId) continue
      const folder = snapshot.folders.find((item) => item.id === share.folderId)
      const passphrase = folderKeys[share.folderId]
      if (!folder || !passphrase || !canAutoImportFolderShare({ folder, incomingCid: share.cid, passphrase })) continue
      const localSignature = sharedFolderSignature(snapshot, share.folderId)
      if (share.folderSignature && share.folderSignature === localSignature) {
        syncLog('pending folder-share skipped: signatures match', { ...shareLogDetails(share), signatureLength: localSignature.length })
        markPendingShareImported(share)
        continue
      }
      if (autoImportCidsRef.current.has(share.cid) || autoImportInFlightRef.current.has(share.cid)) continue
      syncLog('pending folder-share accepted: storage_get will start', { ...shareLogDetails(share), localCid: shortLogValue(folder.lastCid) })
      void autoImportFolderShare(share, passphrase)
    }
  }, [folderKeys, importKeys, joinedRoomsKey, network.state.nodeId, network.state.stablePeersByRoom, networkMode, pendingShares, settings.nodeId, settings.roomId, snapshot.files, snapshot.folders, stablePeerCount])
  useEffect(() => {
    const retryableShares = retryablePendingShares(pendingShares, importKeys)
    if (retryableShares.length === 0) return undefined
    const timer = window.setInterval(() => {
      for (const share of retryableShares) {
        const cid = share.cid
        if (!cid || autoImportCidsRef.current.has(cid) || autoImportInFlightRef.current.has(cid)) continue
        const passphrase = importKeys[cid]?.trim() ?? ''
        if (passphrase) void autoImportLinkedShare(share, passphrase)
      }
    }, pendingShareRetryIntervalMs)
    return () => window.clearInterval(timer)
  }, [autoImportCidsRef, autoImportInFlightRef, autoImportLinkedShare, importKeys, pendingShares])
  useEffect(() => () => {
    for (const timer of Object.values(syncTimersRef.current)) window.clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!shouldRunSharedFolderReannounce({
      autoConnect: settings.autoConnect,
      networkMode,
      networkNodeId: network.state.nodeId,
      nodeId: settings.nodeId,
      stablePeerCount,
    })) return undefined
    const timer = window.setInterval(announceSharedFolders, sharedFolderReannounceIntervalMs)
    return () => window.clearInterval(timer)
  }, [network.state.nodeId, joinedRoomsKey, networkMode, settings.autoConnect, settings.nodeId, stablePeerCount, stablePeerKey])
  useEffect(() => {
    const key = immediateConnectionAnnounceKey({
      autoConnect: settings.autoConnect,
      joinedRooms: network.state.rooms,
      networkMode,
      networkNodeId: network.state.nodeId,
      nodeId: settings.nodeId,
      stablePeerCount,
      stablePeerKey,
    })
    if (!key) {
      lastConnectionAnnounceKeyRef.current = ''
      return
    }
    if (lastConnectionAnnounceKeyRef.current === key) return
    lastConnectionAnnounceKeyRef.current = key
    syncLog('stable peer connected: announcing shared folders immediately', { rooms: network.state.rooms, stablePeerCount })
    announceSharedFolders({ publishLocalChangesImmediately: true })
    for (const share of retryablePendingShares(pendingShares, importKeys)) {
      const cid = share.cid
      if (!cid || autoImportCidsRef.current.has(cid) || autoImportInFlightRef.current.has(cid)) continue
      const passphrase = importKeys[cid]?.trim() ?? ''
      if (passphrase) void autoImportLinkedShare(share, passphrase, { force: true })
    }
  }, [network.state.nodeId, joinedRoomsKey, networkMode, settings.autoConnect, settings.nodeId, stablePeerCount, stablePeerKey])
}
