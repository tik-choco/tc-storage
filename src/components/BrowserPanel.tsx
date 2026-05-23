import {
  Download,
  Folder,
  FolderPlus,
  Info,
  LayoutGrid,
  List,
  Search,
  Share2,
  Trash2,
  Upload,
  X,
} from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { useRef } from 'preact/hooks'
import type { BrowserDragItem, BrowserReorderTarget, BrowserViewMode, PendingShare, ProgressStatus } from '../appTypes.js'
import { emptySelectionActions, type SelectionActions } from '../appSelectionActions.js'
import { folderPath, type FileRecord, type FolderRecord, type StorageSnapshot } from '../domain.js'
import { FileTable } from './BrowserTable.js'

export function BrowserPanel(props: {
  busy: string
  children?: ComponentChildren
  currentFolder: FolderRecord | null
  currentFolderId: string | null
  dragActive: boolean
  dragItem: BrowserDragItem | null
  dropTargetFolderId: string | null | undefined
  reorderTarget: BrowserReorderTarget | null
  fileRows: FileRecord[]
  fileDataUrls: Record<string, string>
  fileLoadProgress: Record<string, ProgressStatus>
  folderRows: FolderRecord[]
  pendingFolderShares: PendingShare[]
  files: FileRecord[]
  folderNameDraft: string | null
  query: string
  snapshot: StorageSnapshot
  selection?: SelectionActions
  viewMode: BrowserViewMode
  onCancelCreateFolder: () => void
  onCancelPendingShare: (share: PendingShare) => void
  onConfirmCreateFolder: () => void
  onCreateFolder: () => void
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
  onQuery: (value: string) => void
  onOpenFile: (file: FileRecord) => void
  onOpenFolderPanel: (anchor?: HTMLElement) => void
  onOpenFolderSharePanel: (anchor?: HTMLElement) => void
  onShowFolderDetails: (folder: FolderRecord, anchor?: HTMLElement) => void
  onPreloadFile: (file: FileRecord) => void
  onSelectFolder: (folderId: string | null) => void
  onShareFile: (file: FileRecord) => void
  onShareFolder: (folder: FolderRecord, anchor?: HTMLElement) => void
  onShowFileDetails: (file: FileRecord, anchor?: HTMLElement) => void
  onUploadFiles: (fileList: FileList | null) => void
  onViewMode: (mode: BrowserViewMode) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentPath = props.currentFolderId ? folderPath(props.snapshot, props.currentFolderId) : []
  const selection = props.selection ?? emptySelectionActions

  return (
    <>
      {props.children}
      <section class="browser-panel">
        <input ref={fileInputRef} class="hidden-input" type="file" multiple onChange={(event) => props.onUploadFiles(event.currentTarget.files)} />
        <BrowserToolbar busy={props.busy} currentFolder={props.currentFolder} currentFolderId={props.currentFolderId} currentPath={currentPath} query={props.query} selection={selection} viewMode={props.viewMode} onCreateFolder={props.onCreateFolder} onDownloadFolder={props.onDownloadFolder} onOpenFolderPanel={props.onOpenFolderPanel} onOpenFolderSharePanel={props.onOpenFolderSharePanel} onQuery={props.onQuery} onSelectFolder={props.onSelectFolder} onUpload={() => fileInputRef.current?.click()} onViewMode={props.onViewMode} />
        <FileTable {...props} selection={selection} />
      </section>
    </>
  )
}

function SelectionBar(props: { selection: SelectionActions }) {
  const moveDisabled = props.selection.selectedCount === 0 || props.selection.moveTargetFolders.length === 0

  return (
    <div class="selection-bar">
      <label class="selection-toggle">
        <input type="checkbox" checked={props.selection.allVisibleSelected} onChange={() => props.selection.toggleSelectAllVisible()} />
        <span>{props.selection.selectedCount} selected</span>
      </label>
      <label class={`selection-move ${moveDisabled ? 'disabled' : ''}`} title={moveDisabled ? 'No move targets' : 'Move selected'}>
        <Folder size={16} />
        <select
          aria-label="Move selected"
          disabled={moveDisabled}
          value=""
          onChange={(event) => {
            const targetFolderId = event.currentTarget.value
            event.currentTarget.value = ''
            if (targetFolderId) void props.selection.moveSelectionToFolder(targetFolderId)
          }}
        >
          <option value="">Move to...</option>
          {props.selection.moveTargetFolders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
        </select>
      </label>
      <button type="button" class="danger" onClick={props.selection.requestDeleteSelection} disabled={props.selection.selectedCount === 0} title="Delete selected">
        <Trash2 size={16} />
        <span>Delete</span>
      </button>
      <button type="button" onClick={props.selection.clearSelection} disabled={props.selection.selectedCount === 0} title="Clear selection">
        <X size={16} />
      </button>
    </div>
  )
}

function Breadcrumbs(props: {
  currentPath: FolderRecord[]
  onSelectFolder: (folderId: string | null) => void
}) {
  if (props.currentPath.length === 0) return null

  return (
    <div class="breadcrumbs compact">
      <button onClick={() => props.onSelectFolder(null)} title="My Drive"><Folder size={16} /></button>
      {props.currentPath.map((folder) => (
        <button onClick={() => props.onSelectFolder(folder.id)} key={folder.id}>
          {folder.name}
        </button>
      ))}
    </div>
  )
}

function BrowserActions(props: {
  busy: string
  currentFolder: FolderRecord | null
  onDownloadFolder: (folder: FolderRecord) => void
  onOpenFolderPanel: (anchor?: HTMLElement) => void
  onOpenFolderSharePanel: (anchor?: HTMLElement) => void
}) {
  if (!props.currentFolder) return null

  return (
    <div class="browser-actions">
      <button onClick={(event) => props.onOpenFolderPanel(event.currentTarget)} title="Folder details">
        <Info size={17} />
      </button>
      <button onClick={() => props.onDownloadFolder(props.currentFolder!)} title="Download folder as ZIP">
        <Download size={17} />
      </button>
      <button class="share-button" onClick={(event) => props.onOpenFolderSharePanel(event.currentTarget)} disabled={props.busy === 'share'} title="Share folder">
        <Share2 size={17} />
        <span>Share</span>
      </button>
    </div>
  )
}

function BrowserToolbar(props: {
  busy: string
  currentFolder: FolderRecord | null
  currentFolderId: string | null
  currentPath: FolderRecord[]
  query: string
  selection: SelectionActions
  viewMode: BrowserViewMode
  onCreateFolder: () => void
  onDownloadFolder: (folder: FolderRecord) => void
  onOpenFolderPanel: (anchor?: HTMLElement) => void
  onOpenFolderSharePanel: (anchor?: HTMLElement) => void
  onQuery: (value: string) => void
  onSelectFolder: (folderId: string | null) => void
  onUpload: () => void
  onViewMode: (mode: BrowserViewMode) => void
}) {
  const selecting = props.selection.selectedCount > 0
  return (
    <div class={`browser-toolbar ${props.currentPath.length > 0 ? 'with-path' : ''}`}>
      <Breadcrumbs currentPath={props.currentPath} onSelectFolder={props.onSelectFolder} />
      {selecting ? <SelectionBar selection={props.selection} /> : <SearchBox query={props.query} onQuery={props.onQuery} />}
      <div class="browser-tool-actions">
        <div class="view-toggle" role="group" aria-label="View mode">
          <button type="button" class={props.viewMode === 'list' ? 'selected' : ''} aria-pressed={props.viewMode === 'list'} onClick={() => props.onViewMode('list')} title="List view">
            <List size={17} />
          </button>
          <button type="button" class={props.viewMode === 'grid' ? 'selected' : ''} aria-pressed={props.viewMode === 'grid'} onClick={() => props.onViewMode('grid')} title="Tile view">
            <LayoutGrid size={17} />
          </button>
        </div>
        <button type="button" onClick={props.onUpload} disabled={!props.currentFolder || props.busy === 'upload'} title="Upload files">
          <Upload size={17} />
        </button>
        <button type="button" onClick={props.onCreateFolder} disabled={Boolean(props.currentFolderId && !props.currentFolder)} title="Create folder">
          <FolderPlus size={17} />
        </button>
      </div>
      <BrowserActions busy={props.busy} currentFolder={props.currentFolder} onDownloadFolder={props.onDownloadFolder} onOpenFolderPanel={props.onOpenFolderPanel} onOpenFolderSharePanel={props.onOpenFolderSharePanel} />
    </div>
  )
}

function SearchBox(props: {
  query: string
  onQuery: (value: string) => void
}) {
  return (
    <div class="toolbar-search">
      <Search size={18} />
      <input value={props.query} onInput={(event) => props.onQuery(event.currentTarget.value)} placeholder="Search files and folders" />
    </div>
  )
}
