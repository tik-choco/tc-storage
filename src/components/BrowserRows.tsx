import { Check, Download, FileText, Folder, Info, Lock, Share2, ShieldCheck, Trash2, X } from 'lucide-preact'
import { selectFromPointerEvent } from '../app/appSelectionActions.js'
import type { BrowserDragItem, BrowserReorderTarget, PendingShare, ProgressStatus } from '../app/appTypes.js'
import { filesInFolder, formatBytes, type FileRecord, type FolderRecord } from '../storage/domain.js'
import { dateLabel } from '../util/format.js'
import type { DraftFolderProps } from './BrowserTableTypes.js'
import { DraftFolderInput } from './DraftFolderInput.js'
import { ProgressIndicator } from './ProgressIndicator.js'

export function NewFolderRow(props: DraftFolderProps) {
  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') props.onConfirm()
    if (event.key === 'Escape') props.onCancel()
  }

  return (
    <div class="table-row draft-folder-row" role="row">
      <span class="selection-cell" />
      <div class="name-cell draft-folder-name">
        <Folder size={20} class="folder-stroke teal" />
        <DraftFolderInput name={props.name} onChange={props.onChange} onKeyDown={handleKeyDown} />
      </div>
      <span class="status-cell folder-status">
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
  onSelectItem: (item: BrowserDragItem, selected: boolean, range?: boolean) => void
  onShareFolder: (folder: FolderRecord, anchor?: HTMLElement) => void
  onShowFolderDetails: (folder: FolderRecord, anchor?: HTMLElement) => void
}) {
  const isDragSource = props.dragItem?.type === 'folder' && props.dragItem.id === props.folder.id
  const isDropTarget = props.dropTargetFolderId === props.folder.id
  const reorderClass = reorderTargetClass(props.reorderTarget, 'folder', props.folder.id)

  return (
    <div
      class={`table-row movable-item selectable-item folder-drop-target ${props.folder.shareEnabled ? 'shared-folder' : ''} ${props.selected ? 'selected-item' : ''} ${isDragSource ? 'drag-source' : ''} ${isDropTarget ? 'drop-target' : ''} ${reorderClass}`}
      data-select-id={props.folder.id}
      data-select-type="folder"
      draggable
      onClick={(event) => handleSelectClick(event, { type: 'folder', id: props.folder.id }, props.selected, props.onSelectItem)}
      onDragEnd={props.onDragEnd}
      onDragLeave={(event) => props.onItemDragLeave({ type: 'folder', id: props.folder.id }, event)}
      onDragOver={(event) => props.onItemDragOver({ type: 'folder', id: props.folder.id }, event)}
      onDragStart={(event) => props.onDragStart({ type: 'folder', id: props.folder.id }, event)}
      onDrop={(event) => props.onItemDrop({ type: 'folder', id: props.folder.id }, event)}
      role="row"
    >
      <span class="selection-cell">
        <input type="checkbox" checked={props.selected} onClick={(event) => props.onSelectItem({ type: 'folder', id: props.folder.id }, event.currentTarget.checked, event.shiftKey)} aria-label={`Select ${props.folder.name}`} />
      </span>
      <button class="name-cell" onClick={() => props.onSelectFolder(props.folder.id)}>
        <Folder size={20} class={`folder-stroke ${props.folder.shareEnabled ? 'shared' : props.folder.color}`} />
        <span>{props.folder.name}</span>
      </button>
      <span class={`status-cell folder-status ${props.folder.shareEnabled ? 'shared-status' : ''}`}>
        {props.folder.shareEnabled ? <Share2 size={15} /> : <Lock size={15} />}
        {props.folder.shareEnabled ? 'Shared' : 'Encrypted'}
      </span>
      <span>{filesInFolder({ folders: [], files: props.files, activity: [], clock: 0, originNode: '' }, props.folder.id).length} files</span>
      <span>{dateLabel(props.folder.updatedAt)}</span>
      <span class="row-actions">
        <button onClick={(event) => props.onShowFolderDetails(props.folder, event.currentTarget)} title="Details"><Info size={16} /></button>
        <button onClick={() => props.onDownloadFolder(props.folder)} title="Download folder as ZIP"><Download size={16} /></button>
        <button onClick={() => props.onDeleteFolder(props.folder)} title="Delete folder"><Trash2 size={16} /></button>
        <button onClick={(event) => props.onShareFolder(props.folder, event.currentTarget)} disabled={props.shareBusy} title={props.shareBusy ? 'Sharing folder' : 'Share folder'}><Share2 size={16} /></button>
      </span>
    </div>
  )
}

export function PendingFolderShareRow(props: {
  busy: boolean
  share: PendingShare
  onCancelShare: (share: PendingShare) => void
}) {
  return (
    <div class="table-row pending-folder-row" role="row">
      <span class="selection-cell" />
      <div class="name-cell">
        <Folder size={20} class="folder-stroke blue" />
        <span>{props.share.folderName ?? 'Shared folder'}</span>
      </div>
      <span class="status-cell">
        <Share2 size={15} />
        {props.share.cid ? props.busy ? '読み込み中' : '読み込み待ち' : '承認待ち'}
      </span>
      <span>{props.share.cid ? '共有待ち' : 'リクエスト中'}</span>
      <span>{dateLabel(props.share.receivedAt)}</span>
      <span class="row-actions">
        <button onClick={() => props.onCancelShare(props.share)} disabled={props.busy} title="Cancel pending share"><X size={16} /></button>
      </span>
    </div>
  )
}

export function FileRow(props: {
  busy: boolean
  dragItem: BrowserDragItem | null
  file: FileRecord
  progress?: ProgressStatus
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
  onSelectItem: (item: BrowserDragItem, selected: boolean, range?: boolean) => void
  onShareFile: (file: FileRecord) => void
  onShowFileDetails: (file: FileRecord, anchor?: HTMLElement) => void
}) {
  const isDragSource = props.dragItem?.type === 'file' && props.dragItem.id === props.file.id
  const reorderClass = reorderTargetClass(props.reorderTarget, 'file', props.file.id)

  return (
    <div
      class={`table-row movable-item selectable-item ${props.selected ? 'selected-item' : ''} ${isDragSource ? 'drag-source' : ''} ${reorderClass}`}
      data-select-id={props.file.id}
      data-select-type="file"
      draggable
      onClick={(event) => handleSelectClick(event, { type: 'file', id: props.file.id }, props.selected, props.onSelectItem)}
      onDragEnd={props.onDragEnd}
      onDragLeave={(event) => props.onItemDragLeave({ type: 'file', id: props.file.id }, event)}
      onDragOver={(event) => props.onItemDragOver({ type: 'file', id: props.file.id }, event)}
      onDragStart={(event) => props.onDragStart({ type: 'file', id: props.file.id }, event)}
      onDrop={(event) => props.onItemDrop({ type: 'file', id: props.file.id }, event)}
      role="row"
    >
      <span class="selection-cell">
        <input type="checkbox" checked={props.selected} onClick={(event) => props.onSelectItem({ type: 'file', id: props.file.id }, event.currentTarget.checked, event.shiftKey)} aria-label={`Select ${props.file.name}`} />
      </span>
      <div class="name-cell file-name-cell">
        <button class="file-open-button" onClick={() => props.onOpenFile(props.file)} title="Open preview">
          <FileText size={20} />
          <span>{props.file.name}</span>
        </button>
      </div>
      <span class="status-cell">{props.progress ? <ProgressIndicator className="row-progress" progress={props.progress} /> : <><ShieldCheck size={15} />v{props.file.version}</>}</span>
      <span>{formatBytes(props.file.size)}</span>
      <span>{dateLabel(props.file.updatedAt)}</span>
      <span class="row-actions">
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

function handleSelectClick(
  event: MouseEvent,
  item: BrowserDragItem,
  selected: boolean,
  onSelectItem: (item: BrowserDragItem, selected: boolean, range?: boolean) => void,
) {
  if (isActionClick(event)) return
  const next = selectFromPointerEvent(event, selected)
  onSelectItem(item, next.selected, next.range)
}

function isActionClick(event: MouseEvent): boolean {
  const target = event.target
  return target instanceof Element && Boolean(target.closest('button,input,a,select,textarea'))
}
