import type { ShareEnvelope } from './p2p.js'
import type { FileRecord, FolderRecord } from './domain.js'
import type { ShareProfile } from './p2p.js'

export type Notice = {
  tone: 'info' | 'success' | 'error'
  text: string
}

export type PendingShare = ShareEnvelope & {
  autoImport?: boolean
  receivedAt: string
}

export type BrowserViewMode = 'list' | 'grid'

export type DeleteRequest = { type: 'file'; file: FileRecord } | { type: 'folder'; folder: FolderRecord }

export type BrowserDragItem = { type: 'file' | 'folder'; id: string }
export type BrowserReorderTarget = BrowserDragItem & { position: 'before' | 'after' }

export type DownloadProgress = {
  fileId: string
  fileName: string
  percent: number
}

export type SyncPeer = {
  nodeId: string
  profile?: ShareProfile
  lastSeenAt: string
}
