import type { ShareEnvelope } from '../p2p/p2p.js'
import type { FileRecord, FolderRecord } from '../storage/domain.js'
import type { ShareProfile } from '../p2p/p2p.js'

export type Notice = {
  tone: 'info' | 'success' | 'error'
  text: string
}

export type PendingShare = ShareEnvelope & {
  autoImport?: boolean
  receivedAt: string
}

export type BrowserViewMode = 'list' | 'grid'
export type BrowserSortMode = 'manual' | 'name-asc' | 'name-desc' | 'updated-desc' | 'updated-asc' | 'size-desc' | 'size-asc'

export type BrowserDragItem = { type: 'file' | 'folder'; id: string }
export type BrowserReorderTarget = BrowserDragItem & { position: 'before' | 'after' }
export type DeleteRequest =
  | { type: 'file'; file: FileRecord }
  | { type: 'folder'; folder: FolderRecord }
  | { type: 'selection'; files: FileRecord[]; folders: FolderRecord[] }

export type DownloadConfirmRequest =
  | { type: 'file'; file: FileRecord; size: number }
  | { type: 'folder'; folder: FolderRecord; size: number }

export type DownloadProgress = {
  fileId: string
  fileName: string
  label: string
  percent?: number
}

export type ProgressStatus = {
  label: string
  percent?: number
}

export type SyncPeer = {
  nodeId: string
  profile?: ShareProfile
  lastSeenAt: string
}

export type FolderAccessMode = 'approval' | 'shared-approval'
export type FolderPanelMode = 'details' | 'share' | 'access'

export type FolderAccessRequest = {
  id: string
  folderId: string
  folderName?: string
  nodeId: string
  profile?: ShareProfile
  publicKey: string
  folderKeyHash?: string
  requestedAt: string
  requestId: string
  // The room the access-request envelope arrived on -- the reply (grant/denied) must target this
  // same room explicitly now that the app is joined to many rooms at once (see p2p.ts).
  roomId: string
}

export function pendingShareKey(share: Pick<PendingShare, 'cid' | 'fileId' | 'folderId' | 'roomId' | 'type'>): string {
  if (share.cid) return share.cid
  if (share.type === 'folder-share' && share.folderId) return `${share.roomId}:folder:${share.folderId}`
  if (share.type === 'file-share' && share.fileId) return `${share.roomId}:file:${share.fileId}`
  return `${share.roomId}:${share.type}`
}
