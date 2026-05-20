import type { BrowserDragItem, BrowserReorderTarget, BrowserViewMode, PendingShare } from '../appTypes.js'
import type { SelectionActions } from '../appSelectionActions.js'
import type { FileRecord, FolderRecord } from '../domain.js'

export type BrowserTableProps = {
  busy: string
  currentFolder: FolderRecord | null
  currentFolderId: string | null
  dragActive: boolean
  dragItem: BrowserDragItem | null
  dropTargetFolderId: string | null | undefined
  reorderTarget: BrowserReorderTarget | null
  fileRows: FileRecord[]
  fileDataUrls: Record<string, string>
  folderRows: FolderRecord[]
  pendingFolderShares: PendingShare[]
  selection?: SelectionActions
  files: FileRecord[]
  folderNameDraft: string | null
  viewMode: BrowserViewMode
  onCancelCreateFolder: () => void
  onCancelPendingShare: (share: PendingShare) => void
  onConfirmCreateFolder: () => void
  onDownloadFile: (file: FileRecord) => void
  onDownloadFolder: (folder: FolderRecord) => void
  onDeleteFolder: (folder: FolderRecord) => void
  onDeleteFile: (file: FileRecord) => void
  onDrag: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  onItemDragEnd: () => void
  onItemDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onBrowserItemDragLeave: (target: BrowserDragItem, event: DragEvent) => void
  onBrowserItemDragOver: (target: BrowserDragItem, event: DragEvent) => void
  onBrowserItemDrop: (target: BrowserDragItem, event: DragEvent) => void
  onMoveTargetDragLeave: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDragOver: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDrop: (folderId: string | null, event: DragEvent) => void
  onFolderNameDraft: (value: string) => void
  onOpenFile: (file: FileRecord) => void
  onPreloadFile: (file: FileRecord) => void
  onSelectFolder: (folderId: string | null) => void
  onShareFile: (file: FileRecord) => void
  onShareFolder: (folder: FolderRecord) => void
  onShowFileDetails: (file: FileRecord, anchor?: HTMLElement) => void
  onShowFolderDetails: (folder: FolderRecord, anchor?: HTMLElement) => void
}

export type DraftFolderProps = {
  name: string
  onCancel: () => void
  onChange: (value: string) => void
  onConfirm: () => void
}
