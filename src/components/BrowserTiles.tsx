import { Check, Copy, FileText, Folder, Info, Lock, Share2, ShieldCheck, Star, Trash2, X } from 'lucide-preact'
import { useEffect } from 'preact/hooks'
import type { BrowserDragItem } from '../appTypes.js'
import { filesInFolder, formatBytes, type FileRecord, type FolderRecord } from '../domain.js'
import { dateLabel } from '../format.js'
import type { DraftFolderProps } from './BrowserTableTypes.js'

export function NewFolderTile(props: DraftFolderProps) {
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') props.onConfirm()
    if (event.key === 'Escape') props.onCancel()
  }

  return (
    <div class="tile-card draft-folder-tile" role="listitem">
      <div class="tile-icon">
        <Folder size={30} class="folder-stroke teal" />
      </div>
      <input value={props.name} autoFocus onInput={(event) => props.onChange(event.currentTarget.value)} onKeyDown={handleKeyDown} placeholder="Folder name" />
      <span class="tile-meta">New folder</span>
      <span class="row-actions tile-actions">
        <button onClick={props.onConfirm} title="Create folder"><Check size={16} /></button>
        <button onClick={props.onCancel} title="Cancel"><X size={16} /></button>
      </span>
    </div>
  )
}

export function FolderTile(props: {
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
  const fileCount = filesInFolder({ folders: [], files: props.files, activity: [], clock: 0, originNode: '' }, props.folder.id).length
  const isDragSource = props.dragItem?.type === 'folder' && props.dragItem.id === props.folder.id
  const isDropTarget = props.dropTargetFolderId === props.folder.id

  return (
    <div
      class={`tile-card folder-tile movable-item folder-drop-target ${isDragSource ? 'drag-source' : ''} ${isDropTarget ? 'drop-target' : ''}`}
      draggable
      onDragEnd={props.onDragEnd}
      onDragLeave={(event) => props.onMoveTargetDragLeave(props.folder.id, event)}
      onDragOver={(event) => props.onMoveTargetDragOver(props.folder.id, event)}
      onDragStart={(event) => props.onDragStart({ type: 'folder', id: props.folder.id }, event)}
      onDrop={(event) => props.onMoveTargetDrop(props.folder.id, event)}
      role="listitem"
    >
      <button class="tile-open" onClick={() => props.onSelectFolder(props.folder.id)} title="Open folder">
        <span class="tile-icon">
          <Folder size={34} class={`folder-stroke ${props.folder.color}`} />
        </span>
        <strong>{props.folder.name}</strong>
      </button>
      <div class="tile-meta-row">
        <span class="status-cell">
          <Lock size={15} />
          {props.folder.shareEnabled ? 'Shared' : 'Encrypted'}
        </span>
        <span>{fileCount} files</span>
      </div>
      <span class="tile-date">{dateLabel(props.folder.updatedAt)}</span>
      <span class="row-actions tile-actions">
        {props.folder.lastCid ? <button onClick={() => props.onCopy(props.folder.lastCid ?? '', 'CID')} title="Copy CID"><Copy size={16} /></button> : null}
        <button onClick={(event) => props.onShowFolderDetails(props.folder, event.currentTarget)} title="Details"><Info size={16} /></button>
        <button onClick={() => props.onDeleteFolder(props.folder)} title="Delete folder"><Trash2 size={16} /></button>
      </span>
    </div>
  )
}

export function FileTile(props: {
  busy: boolean
  dataUrl: string | undefined
  dragItem: BrowserDragItem | null
  file: FileRecord
  onDeleteFile: (file: FileRecord) => void
  onDragEnd: () => void
  onDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onOpenFile: (file: FileRecord) => void
  onPreloadFile: (file: FileRecord) => void
  onShareFile: (file: FileRecord) => void
  onShowFileDetails: (file: FileRecord, anchor?: HTMLElement) => void
  onToggleStar: (file: FileRecord) => void
}) {
  const isDragSource = props.dragItem?.type === 'file' && props.dragItem.id === props.file.id

  useEffect(() => {
    if (!props.dataUrl && isMediaFile(props.file) && (props.file.lastCid || props.file.lastShareCid)) {
      props.onPreloadFile(props.file)
    }
  }, [props.dataUrl, props.file.id, props.file.lastCid, props.file.lastShareCid, props.file.mimeType])

  if (isMediaFile(props.file)) {
    return (
      <div
        class={`tile-card file-tile media-only-tile movable-item ${isDragSource ? 'drag-source' : ''}`}
        draggable
        onDragEnd={props.onDragEnd}
        onDragStart={(event) => props.onDragStart({ type: 'file', id: props.file.id }, event)}
        role="listitem"
      >
        <button class="media-only-button" onClick={() => props.onOpenFile(props.file)} aria-label={`Open preview for ${props.file.name}`}>
          <FileTilePreview dataUrl={props.dataUrl} file={props.file} mediaOnly={true} />
        </button>
        <div class="media-only-overlay">
          <strong class="media-only-name">{props.file.name}</strong>
          <span class="media-only-actions">
            <button onClick={() => props.onToggleStar(props.file)} aria-label="Star file"><Star size={16} fill={props.file.starred ? 'currentColor' : 'none'} /></button>
            <button onClick={(event) => props.onShowFileDetails(props.file, event.currentTarget)} aria-label="Show file details"><Info size={16} /></button>
            <button onClick={() => props.onShareFile(props.file)} disabled={props.busy} aria-label={props.busy ? 'Sharing file' : 'Share file'}><Share2 size={16} /></button>
            <button onClick={() => props.onDeleteFile(props.file)} aria-label="Delete file"><Trash2 size={16} /></button>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      class={`tile-card file-tile movable-item ${isDragSource ? 'drag-source' : ''}`}
      draggable
      onDragEnd={props.onDragEnd}
      onDragStart={(event) => props.onDragStart({ type: 'file', id: props.file.id }, event)}
      role="listitem"
    >
      <button class="tile-open" onClick={() => props.onOpenFile(props.file)} title="Open preview">
        <FileTilePreview dataUrl={props.dataUrl} file={props.file} />
        <strong>{props.file.name}</strong>
      </button>
      <div class="tile-meta-row">
        <span class="status-cell"><ShieldCheck size={15} />v{props.file.version}</span>
        <span>{formatBytes(props.file.size)}</span>
      </div>
      <span class="tile-date">{dateLabel(props.file.updatedAt)}</span>
      <span class="row-actions tile-actions">
        <button onClick={() => props.onToggleStar(props.file)} title="Star"><Star size={16} fill={props.file.starred ? 'currentColor' : 'none'} /></button>
        <button onClick={(event) => props.onShowFileDetails(props.file, event.currentTarget)} title="Details"><Info size={16} /></button>
        <button onClick={() => props.onShareFile(props.file)} disabled={props.busy} title={props.busy ? 'Sharing file' : 'Share file'}><Share2 size={16} /></button>
        <button onClick={() => props.onDeleteFile(props.file)} title="Delete"><Trash2 size={16} /></button>
      </span>
    </div>
  )
}

function isMediaFile(file: FileRecord) {
  return file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/')
}

function FileTilePreview(props: { dataUrl: string | undefined; file: FileRecord; mediaOnly?: boolean }) {
  const isImage = props.file.mimeType.startsWith('image/')
  const isVideo = props.file.mimeType.startsWith('video/')
  const previewClass = `tile-preview media-tile-preview${props.mediaOnly ? ' media-only-preview' : ''}`

  if (isImage && props.dataUrl) {
    return (
      <span class={previewClass}>
        <img src={props.dataUrl} alt="" loading="lazy" />
      </span>
    )
  }

  if (isVideo && props.dataUrl) {
    return (
      <span class={previewClass}>
        <video src={props.dataUrl} muted playsInline preload="metadata" />
      </span>
    )
  }

  if (isImage || isVideo) {
    return (
      <span class={`${previewClass} thumbnail-loading`} aria-label="Loading preview">
        <span class="thumbnail-skeleton" aria-hidden="true" />
      </span>
    )
  }

  return (
    <span class="tile-icon file-tile-icon">
      <FileText size={32} />
    </span>
  )
}
