import { Check, Download, FileText, Folder, Info, Lock, Share2, ShieldCheck, Trash2, Video, X } from 'lucide-preact'
import { useEffect, useRef } from 'preact/hooks'
import { selectFromPointerEvent } from '../app/appSelectionActions.js'
import type { BrowserDragItem, BrowserReorderTarget, PendingShare, ProgressStatus } from '../app/appTypes.js'
import { isImageFile, isMediaFile, isVideoFile, shouldPreloadVisibleThumbnail } from '../app/appUtils.js'
import { filesInFolder, formatBytes, type FileRecord, type FolderRecord } from '../storage/domain.js'
import { dateLabel } from '../util/format.js'
import type { DraftFolderProps } from './BrowserTableTypes.js'
import { DraftFolderInput } from './DraftFolderInput.js'
import { ProgressIndicator } from './ProgressIndicator.js'

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
  selectionActive: boolean
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
        if (isActionClick(event)) return
        if (props.selectionActive) selectTileItem(event, { type: 'folder', id: props.folder.id }, props.selected, props.onSelectItem)
        else props.onSelectFolder(props.folder.id)
      }}
      onDragEnd={props.onDragEnd}
      onDragLeave={(event) => props.onItemDragLeave({ type: 'folder', id: props.folder.id }, event)}
      onDragOver={(event) => props.onItemDragOver({ type: 'folder', id: props.folder.id }, event)}
      onDragStart={(event) => props.onDragStart({ type: 'folder', id: props.folder.id }, event)}
      onDrop={(event) => props.onItemDrop({ type: 'folder', id: props.folder.id }, event)}
      role="listitem"
    >
      <button class="tile-open" onClick={(event) => {
        if (props.selectionActive) selectTileItem(event, { type: 'folder', id: props.folder.id }, props.selected, props.onSelectItem)
        else props.onSelectFolder(props.folder.id)
      }} title={props.selectionActive ? 'Select folder' : 'Open folder'}>
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
        <button onClick={(event) => props.onShareFolder(props.folder, event.currentTarget)} disabled={props.shareBusy} title={props.shareBusy ? 'Sharing folder' : 'Share folder'}><Share2 size={16} /></button>
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
        <span class="status-cell"><Share2 size={15} />{props.share.cid ? props.busy ? '読み込み中' : '読み込み待ち' : '承認待ち'}</span>
        <span>{props.share.cid ? '共有待ち' : 'リクエスト中'}</span>
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
  progress?: ProgressStatus
  reorderTarget: BrowserReorderTarget | null
  selected: boolean
  selectionActive: boolean
  onDeleteFile: (file: FileRecord) => void
  onDownloadFile: (file: FileRecord) => void
  onDragEnd: () => void
  onDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onItemDragLeave: (target: BrowserDragItem, event: DragEvent) => void
  onItemDragOver: (target: BrowserDragItem, event: DragEvent) => void
  onItemDrop: (target: BrowserDragItem, event: DragEvent) => void
  onOpenFile: (file: FileRecord) => void
  onPreloadFile: (file: FileRecord) => void
  onSelectItem: (item: BrowserDragItem, selected: boolean, range?: boolean) => void
  onShareFile: (file: FileRecord) => void
  onShowFileDetails: (file: FileRecord, anchor?: HTMLElement) => void
}) {
  const tileRef = useRef<HTMLDivElement>(null)
  const isDragSource = props.dragItem?.type === 'file' && props.dragItem.id === props.file.id
  const reorderClass = reorderTargetClass(props.reorderTarget, 'file', props.file.id)
  const previewLoading = Boolean(props.progress) || shouldPreloadVisibleThumbnail({ dataUrl: props.dataUrl, file: props.file, visible: true })

  useEffect(() => {
    if (!shouldPreloadVisibleThumbnail({ dataUrl: props.dataUrl, file: props.file, visible: true })) return
    const element = tileRef.current
    if (!element) return
    let requested = false
    const requestPreload = () => {
      if (requested || !shouldPreloadVisibleThumbnail({ dataUrl: props.dataUrl, file: props.file, visible: true })) return
      requested = true
      props.onPreloadFile(props.file)
    }
    if (typeof IntersectionObserver !== 'function') {
      const frame = window.requestAnimationFrame(requestPreload)
      return () => window.cancelAnimationFrame(frame)
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        requestPreload()
        observer.disconnect()
      }
    }, { rootMargin: '160px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [props.dataUrl, props.file.id, props.file.lastCid, props.file.lastShareCid, props.file.mimeType, props.file.name, props.file.size, props.file.deletedAt, props.onPreloadFile])

  if (isMediaFile(props.file)) {
    return (
      <div
        ref={tileRef}
        class={`tile-card file-tile media-only-tile movable-item selectable-item ${props.selected ? 'selected-item' : ''} ${isDragSource ? 'drag-source' : ''} ${reorderClass}`}
        data-select-id={props.file.id}
        data-select-type="file"
        draggable
        onClick={(event) => {
          if (isActionClick(event)) return
          if (props.selectionActive) selectTileItem(event, { type: 'file', id: props.file.id }, props.selected, props.onSelectItem)
          else props.onOpenFile(props.file)
        }}
        onDragEnd={props.onDragEnd}
        onDragLeave={(event) => props.onItemDragLeave({ type: 'file', id: props.file.id }, event)}
        onDragOver={(event) => props.onItemDragOver({ type: 'file', id: props.file.id }, event)}
        onDragStart={(event) => props.onDragStart({ type: 'file', id: props.file.id }, event)}
        onDrop={(event) => props.onItemDrop({ type: 'file', id: props.file.id }, event)}
        role="listitem"
      >
        <button class="media-only-button" onClick={(event) => {
          if (props.selectionActive) selectTileItem(event, { type: 'file', id: props.file.id }, props.selected, props.onSelectItem)
          else props.onOpenFile(props.file)
        }} aria-label={props.selectionActive ? `Select ${props.file.name}` : `Open preview for ${props.file.name}`}>
          <FileTilePreview dataUrl={props.dataUrl} file={props.file} isLoading={previewLoading} mediaOnly={true} />
        </button>
        <ProgressIndicator className="tile-progress media-progress" progress={props.progress} />
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
      ref={tileRef}
      class={`tile-card file-tile movable-item selectable-item ${props.selected ? 'selected-item' : ''} ${isDragSource ? 'drag-source' : ''} ${reorderClass}`}
      data-select-id={props.file.id}
      data-select-type="file"
      draggable
      onClick={(event) => {
        if (isActionClick(event)) return
        if (props.selectionActive) selectTileItem(event, { type: 'file', id: props.file.id }, props.selected, props.onSelectItem)
        else props.onOpenFile(props.file)
      }}
      onDragEnd={props.onDragEnd}
      onDragLeave={(event) => props.onItemDragLeave({ type: 'file', id: props.file.id }, event)}
      onDragOver={(event) => props.onItemDragOver({ type: 'file', id: props.file.id }, event)}
      onDragStart={(event) => props.onDragStart({ type: 'file', id: props.file.id }, event)}
      onDrop={(event) => props.onItemDrop({ type: 'file', id: props.file.id }, event)}
      role="listitem"
    >
      <button class="tile-open" onClick={(event) => {
        if (props.selectionActive) selectTileItem(event, { type: 'file', id: props.file.id }, props.selected, props.onSelectItem)
        else props.onOpenFile(props.file)
      }} title={props.selectionActive ? 'Select file' : 'Open preview'}>
        <FileTilePreview dataUrl={props.dataUrl} file={props.file} isLoading={previewLoading} />
        <strong>{props.file.name}</strong>
      </button>
      <div class="tile-meta-row">
        <span class="status-cell"><ShieldCheck size={15} />v{props.file.version}</span>
        <span>{formatBytes(props.file.size)}</span>
      </div>
      <ProgressIndicator className="tile-progress" progress={props.progress} />
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

function FileTilePreview(props: { dataUrl: string | undefined; file: FileRecord; isLoading?: boolean; mediaOnly?: boolean }) {
  const isImage = isImageFile(props.file)
  const isVideo = isVideoFile(props.file)
  const previewClass = `tile-preview media-tile-preview${props.mediaOnly ? ' media-only-preview' : ''}`

  if (isImage && props.dataUrl) {
    return (
      <span class={previewClass}>
        <img src={props.dataUrl} alt="" decoding="async" loading="eager" />
      </span>
    )
  }

  if (isVideo && props.dataUrl) {
    return (
      <span class={previewClass}>
        <VideoTileThumbnail dataUrl={props.dataUrl} fileName={props.file.name} />
      </span>
    )
  }

  if ((isImage || isVideo) && props.isLoading) {
    return (
      <span class={`${previewClass} thumbnail-loading`} aria-label="Loading preview">
        <span class="thumbnail-skeleton" aria-hidden="true" />
      </span>
    )
  }

  if (isVideo) {
    return (
      <span class={`${previewClass} video-placeholder`} aria-label="Video preview">
        <Video size={34} aria-hidden="true" />
      </span>
    )
  }

  return (
    <span class="tile-icon file-tile-icon">
      <FileText size={32} />
    </span>
  )
}

function VideoTileThumbnail(props: { dataUrl: string; fileName: string }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let cancelled = false
    let frame = 0
    const revealFrame = () => {
      if (cancelled) return
      const target = Number.isFinite(video.duration) && video.duration > 0.25 ? 0.15 : 0
      if (Math.abs(video.currentTime - target) <= 0.01) return
      try {
        video.currentTime = target
      } catch {
        // Some codecs reject early seeks until more data is available.
      }
    }
    const scheduleReveal = () => {
      if (cancelled) return
      if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        revealFrame()
        return
      }
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(revealFrame)
    }
    video.addEventListener('loadedmetadata', scheduleReveal)
    video.addEventListener('loadeddata', scheduleReveal)
    video.addEventListener('canplay', scheduleReveal)
    video.load()
    scheduleReveal()
    return () => {
      cancelled = true
      if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
      video.removeEventListener('loadedmetadata', scheduleReveal)
      video.removeEventListener('loadeddata', scheduleReveal)
      video.removeEventListener('canplay', scheduleReveal)
    }
  }, [props.dataUrl])

  return <video ref={videoRef} src={props.dataUrl} muted playsInline preload="auto" aria-label={`Preview for ${props.fileName}`} />
}

function isActionClick(event: MouseEvent): boolean {
  const target = event.target
  return target instanceof Element && Boolean(target.closest('button,input,a,select,textarea'))
}

function selectTileItem(
  event: MouseEvent,
  item: BrowserDragItem,
  selected: boolean,
  onSelectItem: (item: BrowserDragItem, selected: boolean, range?: boolean) => void,
) {
  event.preventDefault()
  event.stopPropagation()
  const next = selectFromPointerEvent(event, selected)
  onSelectItem(item, next.selected, next.range)
}
