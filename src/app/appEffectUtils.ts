import type { FileContentFailure } from './appControllerTypes.js'
import type { PendingShare } from './appTypes.js'
import { isEd25519DidKey } from '../crypto/didIdentity.js'

export const sharedFolderReannounceIntervalMs = 60_000
export const pendingShareRetryIntervalMs = 30_000

// The app is now joined to every room in `joinedRooms` simultaneously (see p2p.ts) -- there is no
// single "active" room anymore, so this keys off the whole joined-room set plus the (already
// cross-room-union) stable peer key rather than a single `networkRoomId`.
export function immediateConnectionAnnounceKey(options: {
  autoConnect: boolean
  joinedRooms: string[]
  networkMode: string
  networkNodeId?: string
  nodeId: string
  stablePeerCount: number
  stablePeerKey: string
}): string {
  if (!options.autoConnect || options.networkMode !== 'mistlib' || options.stablePeerCount === 0 || !options.stablePeerKey) return ''
  if (!isCurrentNetworkConnection(options)) return ''
  return `${options.joinedRooms.join(',')}:${options.nodeId}:${options.stablePeerKey}`
}

// "Current" here just means the connection is actually ours (nodeId matches the live network
// connection's nodeId), not that it's specifically the home room -- under the multi-room model
// every joined room is live at once (see p2p.ts), so there's no single room to compare against.
function isCurrentNetworkConnection(options: {
  networkNodeId?: string
  nodeId: string
}): boolean {
  return options.networkNodeId === options.nodeId
}

export function shouldRunSharedFolderReannounce(options: {
  autoConnect: boolean
  networkMode: string
  networkNodeId?: string
  nodeId: string
  stablePeerCount: number
}): boolean {
  if (!options.autoConnect || !isCurrentNetworkConnection(options)) return false
  if (options.networkMode === 'mistlib') return options.stablePeerCount > 0
  return options.networkMode === 'local-gossip'
}

// Gates auto-requesting folder access for a pending share: the share's room must be one we're
// actually joined to (part of `joinedRooms` = network.state.rooms) AND have at least one stable
// peer in specifically (stablePeersByRoom[share.roomId]) -- the overall cross-room union isn't
// enough, since a different joined room having peers says nothing about this share's room.
export function shouldRequestFolderAccessForPendingShare(options: {
  joinedRooms: string[]
  networkMode: string
  networkNodeId?: string
  nodeId: string
  share: PendingShare
  stablePeersByRoom: Record<string, string[]>
}): boolean {
  if (options.share.cid) return false
  if (options.share.type !== 'folder-share' || !options.share.autoImport || !options.share.folderId) return false
  if (options.networkMode !== 'mistlib' || options.networkNodeId !== options.nodeId) return false
  if (!options.joinedRooms.includes(options.share.roomId)) return false
  if ((options.stablePeersByRoom[options.share.roomId]?.length ?? 0) === 0) return false
  return isEd25519DidKey(options.nodeId)
}

export function retryablePendingShares(pendingShares: PendingShare[], importKeys: Record<string, string>): PendingShare[] {
  return pendingShares.filter((share) => share.autoImport && share.cid && importKeys[share.cid]?.trim())
}

// Folder shares still waiting for an access grant (no cid yet). These are retried on the same
// interval as cid-based imports: requestFolderAccess itself rate-limits via its resend cooldown
// and re-validates the local DID, so calling it periodically is safe even while disconnected.
export function pendingAccessRequestShares(pendingShares: PendingShare[]): PendingShare[] {
  return pendingShares.filter((share) => share.type === 'folder-share' && !share.cid && share.autoImport && Boolean(share.folderId))
}

export function shouldPreloadProfileAvatar(options: {
  avatarFileId: string
  hasDataUrl: boolean
  profileOpen: boolean
}): boolean {
  return options.profileOpen && Boolean(options.avatarFileId) && !options.hasDataUrl
}

export function failedThumbnailRetryPeerKey(options: {
  networkMode: string
  stablePeerCount: number
  stablePeerKey: string
}): string {
  if (options.networkMode !== 'mistlib' || options.stablePeerCount === 0) return ''
  return options.stablePeerKey
}

export function shouldRetryFileContentFailureAfterPeerConnection(failure: FileContentFailure): boolean {
  return failure.kind === 'block-not-found' || failure.kind === 'network' || failure.kind === 'decrypt' || failure.kind === 'parse'
}
