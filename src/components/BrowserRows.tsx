import { Check, Copy, FileText, Folder, Info, Lock, Share2, ShieldCheck, Star, Trash2, X } from 'lucide-preact'
import type { BrowserDragItem } from '../appTypes.js'
import { filesInFolder, formatBytes, type FileRecord, type FolderRecord } from '../domain.js'
import { dateLabel } from '../format.js'
import type { DraftFolderProps } from './BrowserTableTypes.js'

export function NewFolderRow(props: DraftFolderProps) {
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') props.onConfirm()
    if (event.key === 'Escape') props.onCancel()
  }

  return (
    <div class="table-row draft-folder-row" role="row">
      <div class="name-cell draft-folder-name">
        <Folder size={20} class="folder-stroke teal" />
        <input value={props.name} autoFocus onInput={(event) => props.onChange(event.currentTarget.value)} onKeyDown={handleKeyDown} placeholder="Folder name" />
      </div>
      <span class="status-cell">
        <Lock size={15} />
        Encrypted
      </span>
      <span>0 files</span>
      <span>New</span>
      <span class="row-actions">
        <button onClick={props.onConfirm} title="Create folder"><Check size={16} /></button>
        <button onClick={props.onCancel} title="Cancel"><X size={16} /></button>
      </span>
    </div>
  )
}

export function FolderRow(props: {
  dragItem: BrowserDragItem | null
  dropTargetFolderId: string | null | undefined
  folder: FolderRecord
  files: FileRecord[]
  onCopy: (value: string, label: string) => void
  onDeleteFolder: (folder: FolderRecord) => void
  onDragEnd: () => void
  onDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onMoveTargetDragLeave: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDragOver: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDrop: (folderId: string | null, event: DragEvent) => void
  onSelectFolder: (folderId: string | null) => void
  onShowFolderDetails: (folder: FolderRecord, anchor?: HTMLElement) => void
}) {
  const isDragSource = props.dragItem?.type === 'folder' && props.dragItem.id === props.folder.id
  const isDropTarget = props.dropTargetFolderId === props.folder.id

  return (
    <div
      class={`table-row movable-item folder-drop-target ${isDragSource ? 'drag-source' : ''} ${isDropTarget ? 'drop-target' : ''}`}
      draggable
      onDragEnd={props.onDragEnd}
      onDragLeave={(event) => props.onMoveTargetDragLeave(props.folder.id, event)}
      onDragOver={(event) => props.onMoveTargetDragOver(props.folder.id, event)}
      onDragStart={(event) => props.onDragStart({ type: 'folder', id: props.folder.id }, event)}
      onDrop={(event) => props.onMoveTargetDrop(props.folder.id, event)}
      role="row"
    >
      <button class="name-cell" onClick={() => props.onSelectFolder(props.folder.id)}>
        <Folder size={20} class={`folder-stroke ${props.folder.color}`} />
        <span>{props.folder.name}</span>
      </button>
      <span class="status-cell">
        <Lock size={15} />
        {props.folder.shareEnabled ? 'Shared' : 'Encrypted'}
      </span>
      <span>{filesInFolder({ folders: [], files: props.files, activity: [], clock: 0, originNode: '' }, props.folder.id).length} files</span>
      <span>{dateLabel(props.folder.updatedAt)}</span>
      <span class="row-actions">
        {props.folder.lastCid ? <button onClick={() => props.onCopy(props.folder.lastCid ?? '', 'CID')} title="Copy CID"><Copy size={16} /></button> : null}
        <button onClick={(event) => props.onShowFolderDetails(props.folder, event.currentTarget)} title="Details"><Info size={16} /></button>
        <button onClick={() => props.onDeleteFolder(props.folder)} title="Delete folder"><Trash2 size={16} /></button>
      </span>
    </div>
  )
}

export function FileRow(props: {
  busy: boolean
  dragItem: BrowserDragItem | null
  file: FileRecord
  onDeleteFile: (file: FileRecord) => void
  onDragEnd: () => void
  onDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onOpenFile: (file: FileRecord) => void
  onShareFile: (file: FileRecord) => void
  onShowFileDetails: (file: FileRecord, anchor?: HTMLElement) => void
  onToggleStar: (file: FileRecord) => void
}) {
  const isDragSource = props.dragItem?.type === 'file' && props.dragItem.id === props.file.id

  return (
    <div
      class={`table-row movable-item ${isDragSource ? 'drag-source' : ''}`}
      draggable
      onDragEnd={props.onDragEnd}
      onDragStart={(event) => props.onDragStart({ type: 'file', id: props.file.id }, event)}
      role="row"
    >
      <div class="name-cell file-name-cell">
        <button class="file-open-button" onClick={() => props.onOpenFile(props.file)} title="Open preview">
          <FileText size={20} />
          <span>{props.file.name}</span>
        </button>
        <button class="name-detail-button" onClick={(event) => props.onShowFileDetails(props.file, event.currentTarget)} title="Details">
          <Info size={16} />
        </button>
      </div>
      <span class="status-cell"><ShieldCheck size={15} />v{props.file.version}</span>
      <span>{formatBytes(props.file.size)}</span>
      <span>{dateLabel(props.file.updatedAt)}</span>
      <span class="row-actions">
        <button onClick={() => props.onToggleStar(props.file)} title="Star"><Star size={16} fill={props.file.starred ? 'currentColor' : 'none'} /></button>
        <button onClick={() => props.onShareFile(props.file)} disabled={props.busy} title={props.busy ? 'Sharing file' : 'Share file'}><Share2 size={16} /></button>
        <button onClick={() => props.onDeleteFile(props.file)} title="Delete"><Trash2 size={16} /></button>
      </span>
    </div>
  )
}
