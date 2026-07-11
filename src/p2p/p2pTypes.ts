import type { FileRecord, FolderRecord } from '../storage/domain.js'

export type MistModule = typeof import('../vendor/mistlib-wasm/mistlib_wasm.js')

/** The subset of the mistlib surface used to join/leave/observe individual rooms while joined to several at once. */
export type MistRoomController = Pick<
  MistModule,
  | 'init_with_config'
  | 'register_event_callback'
  | 'join_room_async'
  | 'is_room_joined'
  | 'leave_room_id'
  | 'send_message_in_room'
  | 'get_neighbors_in_room'
  | 'update_position_in_room'
>

export type ShareProfile = {
  name: string
}

export type ShareEnvelope = {
  type: 'hello' | 'folder-share' | 'file-share' | 'folder-state' | 'folder-change' | 'file-content-repair-request' | 'folder-access-request' | 'folder-access-grant' | 'folder-access-denied'
  from: string
  roomId: string
  sentAt: string
  clock: number
  changeType?: 'file-upserted' | 'file-deleted' | 'folder-upserted' | 'folder-deleted'
  folderSignature?: string
  folderId?: string
  folderName?: string
  folder?: FolderRecord
  fileId?: string
  fileName?: string
  file?: FileRecord
  cid?: string
  senderProfile?: ShareProfile
  signature?: string
  ownerNodeId?: string
  accessGrantMode?: 'owner' | 'shared'
  folderKeyHash?: string
  targetNodeId?: string
  requestId?: string
  accessPublicKey?: string
  accessGrantProof?: string
  accessGrantPublicKey?: string
  accessGrantIv?: string
  accessGrantCipherText?: string
}

export type NetworkState = {
  mode: 'idle' | 'connecting' | 'mistlib' | 'local-gossip' | 'offline'
  /** The user's own home room (`settings.roomId`); kept for display/back-compat. */
  roomId?: string
  /** Every room currently joined (home room plus any joined shared rooms). */
  rooms: string[]
  nodeId?: string
  /** Union of peers across all joined rooms. */
  peers: string[]
  /** Union of stable peers across all joined rooms. */
  stablePeers: string[]
  /** Raw peers, keyed by room id. */
  peersByRoom: Record<string, string[]>
  /** Stable peers, keyed by room id. */
  stablePeersByRoom: Record<string, string[]>
  lastEvent: string
  lastSyncAt?: string
  messagesSent: number
  messagesReceived: number
}

export type BroadcastSharePayload = Omit<ShareEnvelope, 'type' | 'from' | 'roomId' | 'sentAt'> & {
  type?: 'folder-share' | 'file-share' | 'folder-state' | 'folder-change' | 'file-content-repair-request' | 'folder-access-request' | 'folder-access-grant' | 'folder-access-denied'
}
