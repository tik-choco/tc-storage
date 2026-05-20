import { Check, Download, FileText, Folder, Info, Lock, Share2, ShieldCheck, Trash2, X } from 'lucide-preact'
import { useEffect } from 'preact/hooks'
import type { BrowserDragItem, BrowserReorderTarget, PendingShare } from '../appTypes.js'
import { filesInFolder, formatBytes, type FileRecord, type FolderRecord } from '../domain.js'
import { dateLabel } from '../format.js'
import type { DraftFolderProps } from './BrowserTableTypes.js'
import { DraftFolderInput } from './DraftFolderInput.js'

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
      <DraftFolderInput name={props.name} onChange={props.onChange} onKeyDown={handleKeyDown} />
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
  reorderTarget: BrowserReorderTarget | null
  selected: boolean
  shareBusy: boolean
  onDeleteFolder: (folder: FolderRecord) => void
  onDownloadFolder: (folder: FolderRecord) => void
  onDragEnd: () => void
  onDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onItemDragLeave: (target: BrowserDragItem, event: DragEvent) => void
  onItemDragOver: (target: BrowserDragItem, event: DragEvent) => void
  onItemDrop: (target: BrowserDragItem, event: DragEvent) => void
  onSelectFolder: (folderId: string | null) => void
  onShareFolder: (folder: FolderRecord) => void
  onShowFolderDetails: (folder: FolderRecord, anchor?: HTMLElement) => void
}) {
  const fileCount = filesInFolder({ folders: [], files: props.files, activity: [], clock: 0, originNode: '' }, props.folder.id).length
  const isDragSource = props.dragItem?.type === 'folder' && props.dragItem.id === props.folder.id
  const isDropTarget = props.dropTargetFolderId === props.folder.id
  const reorderClass = reorderTargetClass(props.reorderTarget, 'folder', props.folder.id)

  return (
    <div
      class={`tile-card folder-tile movable-item selectable-item folder-drop-target ${props.folder.shareEnabled ? 'shared-folder' : ''} ${props.selected ? 'selected-item' : ''} ${isDragSource ? 'drag-source' : ''} ${isDropTarget ? 'drop-target' : ''} ${reorderClass}`}
      data-select-id={props.folder.id}
      data-select-type="folder"
      draggable
      onClick={(event) => {
        if (!isActionClick(event)) props.onSelectFolder(props.folder.id)
      }}
      onDragEnd={props.onDragEnd}
      onDragLeave={(event) => props.onItemDragLeave({ type: 'folder', id: props.folder.id }, event)}
      onDragOver={(event) => props.onItemDragOver({ type: 'folder', id: props.folder.id }, event)}
      onDragStart={(event) => props.onDragStart({ type: 'folder', id: props.folder.id }, event)}
      onDrop={(event) => props.onItemDrop({ type: 'folder', id: props.folder.id }, event)}
      role="listitem"
    >
      <button class="tile-open" onClick={() => props.onSelectFolder(props.folder.id)} title="Open folder">
        <span class="tile-icon">
          <Folder size={34} class={`folder-stroke ${props.folder.shareEnabled ? 'shared' : props.folder.color}`} />
        </span>
        <strong>{props.folder.name}</strong>
      </button>
      <div class="tile-meta-row">
        <span class={`status-cell folder-status ${props.folder.shareEnabled ? 'shared-status' : ''}`}>
          {props.folder.shareEnabled ? <Share2 size={15} /> : <Lock size={15} />}
          {props.folder.shareEnabled ? 'Shared' : 'Encrypted'}
        </span>
        <span>{fileCount} files</span>
      </div>
      <span class="tile-date">{dateLabel(props.folder.updatedAt)}</span>
      <span class="row-actions tile-actions">
        <button onClick={(event) => props.onShowFolderDetails(props.folder, event.currentTarget)} title="Details"><Info size={16} /></button>
        <button onClick={() => props.onDownloadFolder(props.folder)} title="Download folder as ZIP"><Download size={16} /></button>
        <button onClick={() => props.onDeleteFolder(props.folder)} title="Delete folder"><Trash2 size={16} /></button>
        <button onClick={() => props.onShareFolder(props.folder)} disabled={props.shareBusy} title={props.shareBusy ? 'Sharing folder' : 'Share folder'}><Share2 size={16} /></button>
      </span>
    </div>
  )
}

export function PendingFolderShareTile(props: {
  busy: boolean
  share: PendingShare
  onCancelShare: (share: PendingShare) => void
}) {
  return (
    <div class="tile-card pending-folder-tile" role="listitem">
      <div class="tile-open pending-folder-open">
        <span class="tile-icon">
          <Folder size={34} class="folder-stroke blue" />
        </span>
        <strong>{props.share.folderName ?? 'Shared folder'}</strong>
      </div>
      <div class="tile-meta-row">
        <span class="status-cell"><Share2 size={15} />{props.busy ? '読み込み中' : '読み込み待ち'}</span>
        <span>共有待ち</span>
      </div>
      <span class="tile-date">{dateLabel(props.share.receivedAt)}</span>
      <span class="row-actions tile-actions">
        <button onClick={() => props.onCancelShare(props.share)} disabled={props.busy} title="Cancel pending share"><X size={16} /></button>
      </span>
    </div>
  )
}

export function FileTile(props: {
  busy: boolean
  dataUrl: string | undefined
  dragItem: BrowserDragItem | null
  file: FileRecord
  reorderTarget: BrowserReorderTarget | null
  selected: boolean
  onDeleteFile: (file: FileRecord) => void
  onDownloadFile: (file: FileRecord) => void
  onDragEnd: () => void
  onDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onItemDragLeave: (target: BrowserDragItem, event: DragEvent) => void
  onItemDragOver: (target: BrowserDragItem, event: DragEvent) => void
  onItemDrop: (target: BrowserDragItem, event: DragEvent) => void
  onOpenFile: (file: FileRecord) => void
  onPreloadFile: (file: FileRecord) => void
  onShareFile: (file: FileRecord) => void
  onShowFileDetails: (file: FileRecord, anchor?: HTMLElement) => void
}) {
  const isDragSource = props.dragItem?.type === 'file' && props.dragItem.id === props.file.id
  const reorderClass = reorderTargetClass(props.reorderTarget, 'file', props.file.id)

  useEffect(() => {
    if (!props.dataUrl && isMediaFile(props.file) && (props.file.lastCid || props.file.lastShareCid)) {
      props.onPreloadFile(props.file)
    }
  }, [props.dataUrl, props.file.id, props.file.lastCid, props.file.lastShareCid, props.file.mimeType])

  if (isMediaFile(props.file)) {
    return (
      <div
        class={`tile-card file-tile media-only-tile movable-item selectable-item ${props.selected ? 'selected-item' : ''} ${isDragSource ? 'drag-source' : ''} ${reorderClass}`}
        data-select-id={props.file.id}
        data-select-type="file"
        draggable
        onClick={(event) => {
          if (!isActionClick(event)) props.onOpenFile(props.file)
        }}
        onDragEnd={props.onDragEnd}
        onDragLeave={(event) => props.onItemDragLeave({ type: 'file', id: props.file.id }, event)}
        onDragOver={(event) => props.onItemDragOver({ type: 'file', id: props.file.id }, event)}
        onDragStart={(event) => props.onDragStart({ type: 'file', id: props.file.id }, event)}
        onDrop={(event) => props.onItemDrop({ type: 'file', id: props.file.id }, event)}
        role="listitem"
      >
        <button class="media-only-button" onClick={() => props.onOpenFile(props.file)} aria-label={`Open preview for ${props.file.name}`}>
          <FileTilePreview dataUrl={props.dataUrl} file={props.file} mediaOnly={true} />
        </button>
        <div class="media-only-overlay">
          <strong class="media-only-name">{props.file.name}</strong>
          <span class="media-only-actions">
            <button onClick={(event) => { event.stopPropagation(); props.onShowFileDetails(props.file, event.currentTarget) }} aria-label="Show file details"><Info size={16} /></button>
            <button onClick={(event) => { event.stopPropagation(); props.onDownloadFile(props.file) }} aria-label="Download file"><Download size={16} /></button>
            <button onClick={(event) => { event.stopPropagation(); props.onDeleteFile(props.file) }} aria-label="Delete file"><Trash2 size={16} /></button>
            <button onClick={(event) => { event.stopPropagation(); props.onShareFile(props.file) }} disabled={props.busy} aria-label={props.busy ? 'Sharing file' : 'Share file'}><Share2 size={16} /></button>
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      class={`tile-card file-tile movable-item selectable-item ${props.selected ? 'selected-item' : ''} ${isDragSource ? 'drag-source' : ''} ${reorderClass}`}
      data-select-id={props.file.id}
      data-select-type="file"
      draggable
      onClick={(event) => {
        if (!isActionClick(event)) props.onOpenFile(props.file)
      }}
      onDragEnd={props.onDragEnd}
      onDragLeave={(event) => props.onItemDragLeave({ type: 'file', id: props.file.id }, event)}
      onDragOver={(event) => props.onItemDragOver({ type: 'file', id: props.file.id }, event)}
      onDragStart={(event) => props.onDragStart({ type: 'file', id: props.file.id }, event)}
      onDrop={(event) => props.onItemDrop({ type: 'file', id: props.file.id }, event)}
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
        <button onClick={(event) => { event.stopPropagation(); props.onShowFileDetails(props.file, event.currentTarget) }} title="Details"><Info size={16} /></button>
        <button onClick={(event) => { event.stopPropagation(); props.onDownloadFile(props.file) }} title="Download file"><Download size={16} /></button>
        <button onClick={(event) => { event.stopPropagation(); props.onDeleteFile(props.file) }} title="Delete"><Trash2 size={16} /></button>
        <button onClick={(event) => { event.stopPropagation(); props.onShareFile(props.file) }} disabled={props.busy} title={props.busy ? 'Sharing file' : 'Share file'}><Share2 size={16} /></button>
      </span>
    </div>
  )
}

function reorderTargetClass(target: BrowserReorderTarget | null, type: BrowserDragItem['type'], id: string): string {
  return target?.type === type && target.id === id ? `reorder-${target.position}` : ''
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

function isActionClick(event: MouseEvent): boolean {
  const target = event.target
  return target instanceof Element && Boolean(target.closest('button,input,a,select,textarea'))
}
