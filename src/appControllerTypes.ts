import type { Dispatch, StateUpdater } from 'preact/hooks'
import type { BrowserDragItem } from './appTypes.js'
import type { FileRecord } from './domain.js'
import type { useMistShare } from './p2p.js'

export type MutableRef<T> = { current: T }
export type SetState<T> = Dispatch<StateUpdater<T>>
export type MistShare = ReturnType<typeof useMistShare>

export interface FileContentActions {
  canResolveFileContent: (file: FileRecord) => boolean
  downloadStoredFile: (file: FileRecord) => Promise<void>
  ensureFileContent: (file: FileRecord, options?: { trackProgress?: boolean }) => Promise<FileRecord>
  ensureFolderFilesStored: (folder: import('./domain.js').FolderRecord, filesForSave: FileRecord[], passphrase: string) => Promise<FileRecord[]>
  materializeFolderBundleFiles: (bundle: import('./domain.js').FolderBundle, passphrase: string) => Promise<import('./domain.js').FolderBundle>
  preloadFileContent: (file: FileRecord) => void
}

export interface MoveActions {
  canMoveItemToFolder: (item: BrowserDragItem, targetFolderId: string | null) => boolean
  moveDraggedItem: (item: BrowserDragItem, targetFolderId: string | null) => Promise<void>
}
