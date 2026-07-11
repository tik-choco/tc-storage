import type { Dispatch, StateUpdater } from 'preact/hooks'
import type { BrowserDragItem } from './appTypes.js'
import type { FileRecord, FolderRecord } from '../storage/domain.js'
import type { ShareEnvelope, useMistShare } from '../p2p/p2p.js'

export type MutableRef<T> = { current: T }
export type SetState<T> = Dispatch<StateUpdater<T>>
export type MistShare = ReturnType<typeof useMistShare>

export interface FileContentPreloadQueue {
  items: Map<string, FileRecord>
  running: boolean
}

export type FileContentFailureKind = 'block-not-found' | 'network' | 'decrypt' | 'parse' | 'missing-data' | 'unknown'

export type FileContentFailure = {
  kind: FileContentFailureKind
  retryAfter: number
  signature: string
}

export type FolderStateAnnouncement = {
  audienceKey: string
  cid: string
  sentAt: number
  signature: string
}

export interface FileContentActions {
  canResolveFileContent: (file: FileRecord) => boolean
  downloadFolderAsZip: (folder: FolderRecord) => Promise<void>
  downloadStoredFile: (file: FileRecord) => Promise<void>
  ensureFileContent: (file: FileRecord, options?: { suppressRepairRequest?: boolean; trackProgress?: boolean }) => Promise<FileRecord>
  ensureFolderFilesStored: (folder: FolderRecord, filesForSave: FileRecord[], passphrase: string) => Promise<FileRecord[]>
  handleFileContentRepairRequest: (request: Pick<ShareEnvelope, 'cid' | 'fileId' | 'fileName' | 'folderId' | 'from'>) => void
  hasUntrustedFolderContent: (folderId: string) => boolean
  materializeFolderBundleFiles: (bundle: import('../storage/domain.js').FolderBundle, passphrase: string) => Promise<import('../storage/domain.js').FolderBundle>
  preloadFileContent: (file: FileRecord) => void
}

export interface MoveActions {
  canMoveItemToFolder: (item: BrowserDragItem, targetFolderId: string | null) => boolean
  moveDraggedItem: (item: BrowserDragItem, targetFolderId: string | null) => Promise<void>
}
