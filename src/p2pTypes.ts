import type { FileRecord, FolderRecord } from './domain.js'

export type MistModule = typeof import('./vendor/mistlib-wasm/mistlib_wasm.js')

export type MistRoomController = Pick<MistModule, 'init' | 'join_room' | 'register_event_callback' | 'update_position'>

export type ShareProfile = {
  name: string
  avatarUrl?: string
}

export type ShareEnvelope = {
  type: 'hello' | 'folder-share' | 'file-share' | 'folder-state' | 'folder-change' | 'folder-access-request' | 'folder-access-grant' | 'folder-access-denied'
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
  targetNodeId?: string
  requestId?: string
  accessPublicKey?: string
  accessGrantPublicKey?: string
  accessGrantIv?: string
  accessGrantCipherText?: string
}

export type NetworkState = {
  mode: 'idle' | 'connecting' | 'mistlib' | 'local-gossip' | 'offline'
  peers: string[]
  stablePeers: string[]
  lastEvent: string
  lastSyncAt?: string
  messagesSent: number
  messagesReceived: number
}

export type BroadcastSharePayload = Omit<ShareEnvelope, 'type' | 'from' | 'roomId' | 'sentAt'> & {
  type?: 'folder-share' | 'file-share' | 'folder-state' | 'folder-change' | 'folder-access-request' | 'folder-access-grant' | 'folder-access-denied'
}
