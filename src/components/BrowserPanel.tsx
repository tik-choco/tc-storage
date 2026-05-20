import {
  Folder,
  FolderPlus,
  HardDrive,
  Info,
  LayoutGrid,
  List,
  Search,
  Share2,
  Upload,
} from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { useRef } from 'preact/hooks'
import type { BrowserDragItem, BrowserViewMode } from '../appTypes.js'
import { folderPath, formatBytes, type FileRecord, type FolderRecord, type StorageSnapshot } from '../domain.js'
import { FileTable } from './BrowserTable.js'

export function BrowserPanel(props: {
  busy: string
  children?: ComponentChildren
  currentFolder: FolderRecord | null
  currentFolderId: string | null
  dragActive: boolean
  dragItem: BrowserDragItem | null
  dropTargetFolderId: string | null | undefined
  fileRows: FileRecord[]
  fileDataUrls: Record<string, string>
  folderRows: FolderRecord[]
  files: FileRecord[]
  folderNameDraft: string | null
  query: string
  snapshot: StorageSnapshot
  storageUsed: number
  viewMode: BrowserViewMode
  onCopy: (value: string, label: string) => void
  onCancelCreateFolder: () => void
  onConfirmCreateFolder: () => void
  onCreateFolder: () => void
  onDeleteFolder: (folder: FolderRecord) => void
  onDeleteFile: (file: FileRecord) => void
  onDrag: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  onItemDragEnd: () => void
  onItemDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onMoveTargetDragLeave: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDragOver: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDrop: (folderId: string | null, event: DragEvent) => void
  onFolderNameDraft: (value: string) => void
  onQuery: (value: string) => void
  onSaveFolder: (shareAfterSave: boolean, anchor?: HTMLElement) => void
  onOpenFile: (file: FileRecord) => void
  onOpenFolderPanel: (anchor?: HTMLElement) => void
  onShowFolderDetails: (folder: FolderRecord, anchor?: HTMLElement) => void
  onPreloadFile: (file: FileRecord) => void
  onSelectFolder: (folderId: string | null) => void
  onShareFile: (file: FileRecord) => void
  onShowFileDetails: (file: FileRecord, anchor?: HTMLElement) => void
  onToggleStar: (file: FileRecord) => void
  onUploadFiles: (fileList: FileList | null) => void
  onViewMode: (mode: BrowserViewMode) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentPath = props.currentFolderId ? folderPath(props.snapshot, props.currentFolderId) : []

  return (
    <>
      <header class="topbar">
        <Breadcrumbs currentPath={currentPath} onSelectFolder={props.onSelectFolder} />
        <BrowserActions busy={props.busy} currentFolder={props.currentFolder} storageUsed={props.storageUsed} onOpenFolderPanel={props.onOpenFolderPanel} onSaveFolder={props.onSaveFolder} />
        <input ref={fileInputRef} class="hidden-input" type="file" multiple onChange={(event) => props.onUploadFiles(event.currentTarget.files)} />
      </header>

      {props.children}
      <section class="browser-panel">
        <SearchStrip busy={props.busy} currentFolder={props.currentFolder} currentFolderId={props.currentFolderId} query={props.query} viewMode={props.viewMode} onCreateFolder={props.onCreateFolder} onQuery={props.onQuery} onUpload={() => fileInputRef.current?.click()} onViewMode={props.onViewMode} />
        <FileTable {...props} />
      </section>
    </>
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
  storageUsed: number
  onOpenFolderPanel: (anchor?: HTMLElement) => void
  onSaveFolder: (shareAfterSave: boolean, anchor?: HTMLElement) => void
}) {
  return (
    <div class={`browser-actions ${props.currentFolder ? '' : 'root-actions'}`}>
      <span class="used-pill" title="Used storage">
        <HardDrive size={15} />
        <span>Used</span>
        <strong>{formatBytes(props.storageUsed)}</strong>
      </span>
      {props.currentFolder ? (
        <>
          <button onClick={(event) => props.onOpenFolderPanel(event.currentTarget)} title="Folder details">
            <Info size={17} />
          </button>
          <button class="share-button" onClick={(event) => props.onSaveFolder(true, event.currentTarget)} disabled={props.busy === 'share'} title="Share encrypted folder">
            <Share2 size={17} />
            <span>{props.busy === 'share' ? 'Sharing' : 'Share'}</span>
          </button>
        </>
      ) : null}
    </div>
  )
}

function SearchStrip(props: {
  busy: string
  currentFolder: FolderRecord | null
  currentFolderId: string | null
  query: string
  viewMode: BrowserViewMode
  onCreateFolder: () => void
  onQuery: (value: string) => void
  onUpload: () => void
  onViewMode: (mode: BrowserViewMode) => void
}) {
  return (
    <div class="search-strip">
      <div class="search-box">
        <Search size={18} />
        <input value={props.query} onInput={(event) => props.onQuery(event.currentTarget.value)} placeholder="Search files and folders" />
      </div>
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
  )
}
