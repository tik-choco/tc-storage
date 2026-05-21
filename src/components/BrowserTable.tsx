import { useEffect, useRef, useState } from 'preact/hooks'
import { pendingShareKey, type BrowserDragItem } from '../appTypes.js'
import { emptySelectionActions } from '../appSelectionActions.js'
import { DropOverlay } from './BrowserDropOverlay.js'
import { FileRow, FolderRow, NewFolderRow, PendingFolderShareRow } from './BrowserRows.js'
import type { BrowserTableProps } from './BrowserTableTypes.js'
import { FileTile, FolderTile, NewFolderTile, PendingFolderShareTile } from './BrowserTiles.js'

type Marquee = {
  additive: boolean
  baseSelection: BrowserDragItem[]
  currentX: number
  currentY: number
  startX: number
  startY: number
}

type PendingLongPress = Marquee & {
  pointerId: number
  timer: number
}

const longPressDelayMs = 360
const longPressMoveTolerancePx = 10

export function FileTable(props: BrowserTableProps) {
  const isCurrentDropTarget = props.dropTargetFolderId === props.currentFolderId
  const selection = props.selection ?? emptySelectionActions
  const selectionRef = useRef(selection)
  const tableRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<Marquee | null>(null)
  const pendingLongPressRef = useRef<PendingLongPress | null>(null)
  const suppressClickRef = useRef(false)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const marqueeStyle = marquee ? marqueeRect(marquee, tableRef.current) : null
  selectionRef.current = selection
  useEffect(() => () => cancelPendingLongPress(), [])
  const tableProps = {
    ref: tableRef,
    onClickCapture: (event: MouseEvent) => {
      if (!suppressClickRef.current) return
      event.preventDefault()
      event.stopPropagation()
      suppressClickRef.current = false
    },
    onContextMenu: (event: MouseEvent) => {
      if (!marqueeRef.current && !suppressClickRef.current) return
      event.preventDefault()
    },
    onPointerCancel: (event: PointerEvent) => { cancelPendingLongPress(); finishMarquee(event) },
    onPointerDown: (event: PointerEvent) => beginPointerSelection(event),
    onPointerMove: (event: PointerEvent) => {
      if (marqueeRef.current) updateMarquee(event)
      else updatePendingLongPress(event)
    },
    onPointerUp: (event: PointerEvent) => { cancelPendingLongPress(); finishMarquee(event) },
  }

  if (props.viewMode === 'grid') {
    return (
      <div {...tableProps} class={`table table-grid drop-zone ${marquee ? 'marquee-active' : ''} ${props.dragActive ? 'drag-active' : ''} ${isCurrentDropTarget ? 'drop-target' : ''}`} role="list" aria-label="Files and folders" onDragEnter={props.onDrag} onDragOver={props.onDrag} onDragLeave={props.onDrag} onDrop={props.onDrop}>
        {props.dragActive ? <DropOverlay folder={props.currentFolder} /> : null}
        {marqueeStyle ? <div class="selection-marquee" style={marqueeStyle} /> : null}
        {props.folderNameDraft !== null ? <NewFolderTile name={props.folderNameDraft} onCancel={props.onCancelCreateFolder} onChange={props.onFolderNameDraft} onConfirm={props.onConfirmCreateFolder} /> : null}
        {props.pendingFolderShares.map((share) => <PendingFolderShareTile busy={Boolean(share.cid) && props.busy === `import-${share.cid}`} share={share} onCancelShare={props.onCancelPendingShare} key={pendingShareKey(share)} />)}
        {props.folderRows.map((folder) => <FolderTile selected={selection.isItemSelected({ type: 'folder', id: folder.id })} dragItem={props.dragItem} dropTargetFolderId={props.dropTargetFolderId} folder={folder} files={props.files} reorderTarget={props.reorderTarget} shareBusy={props.busy === 'share'} onDeleteFolder={props.onDeleteFolder} onDownloadFolder={props.onDownloadFolder} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onItemDragLeave={props.onBrowserItemDragLeave} onItemDragOver={props.onBrowserItemDragOver} onItemDrop={props.onBrowserItemDrop} onSelectFolder={props.onSelectFolder} onShareFolder={props.onShareFolder} onShowFolderDetails={props.onShowFolderDetails} key={folder.id} />)}
        {props.fileRows.map((file) => <FileTile selected={selection.isItemSelected({ type: 'file', id: file.id })} busy={props.busy === `file-share-${file.id}`} dataUrl={props.fileDataUrls[file.id]} dragItem={props.dragItem} file={file} reorderTarget={props.reorderTarget} onDeleteFile={props.onDeleteFile} onDownloadFile={props.onDownloadFile} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onItemDragLeave={props.onBrowserItemDragLeave} onItemDragOver={props.onBrowserItemDragOver} onItemDrop={props.onBrowserItemDrop} onOpenFile={props.onOpenFile} onPreloadFile={props.onPreloadFile} onShareFile={props.onShareFile} onShowFileDetails={props.onShowFileDetails} key={file.id} />)}
        {props.pendingFolderShares.length === 0 && props.folderRows.length === 0 && props.fileRows.length === 0 ? <div class="empty-row tile-empty">No files or folders</div> : null}
      </div>
    )
  }

  return (
    <div {...tableProps} class={`table drop-zone ${marquee ? 'marquee-active' : ''} ${props.dragActive ? 'drag-active' : ''} ${isCurrentDropTarget ? 'drop-target' : ''}`} role="table" aria-label="Files and folders" onDragEnter={props.onDrag} onDragOver={props.onDrag} onDragLeave={props.onDrag} onDrop={props.onDrop}>
      {props.dragActive ? <DropOverlay folder={props.currentFolder} /> : null}
      {marqueeStyle ? <div class="selection-marquee" style={marqueeStyle} /> : null}
      <div class="table-row table-head" role="row">
        <span><input type="checkbox" checked={selection.allVisibleSelected} onChange={() => selection.toggleSelectAllVisible()} aria-label="Select all visible items" /></span>
        <span>Name</span>
        <span>Status</span>
        <span>Size</span>
        <span>Updated</span>
        <span>Actions</span>
      </div>
      {props.folderNameDraft !== null ? <NewFolderRow name={props.folderNameDraft} onCancel={props.onCancelCreateFolder} onChange={props.onFolderNameDraft} onConfirm={props.onConfirmCreateFolder} /> : null}
      {props.pendingFolderShares.map((share) => <PendingFolderShareRow busy={Boolean(share.cid) && props.busy === `import-${share.cid}`} share={share} onCancelShare={props.onCancelPendingShare} key={pendingShareKey(share)} />)}
      {props.folderRows.map((folder) => <FolderRow selected={selection.isItemSelected({ type: 'folder', id: folder.id })} dragItem={props.dragItem} dropTargetFolderId={props.dropTargetFolderId} folder={folder} files={props.files} reorderTarget={props.reorderTarget} shareBusy={props.busy === 'share'} onDeleteFolder={props.onDeleteFolder} onDownloadFolder={props.onDownloadFolder} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onItemDragLeave={props.onBrowserItemDragLeave} onItemDragOver={props.onBrowserItemDragOver} onItemDrop={props.onBrowserItemDrop} onSelectFolder={props.onSelectFolder} onSelectItem={selection.toggleItemSelection} onShareFolder={props.onShareFolder} onShowFolderDetails={props.onShowFolderDetails} key={folder.id} />)}
      {props.fileRows.map((file) => <FileRow selected={selection.isItemSelected({ type: 'file', id: file.id })} busy={props.busy === `file-share-${file.id}`} dragItem={props.dragItem} file={file} reorderTarget={props.reorderTarget} onDeleteFile={props.onDeleteFile} onDownloadFile={props.onDownloadFile} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onItemDragLeave={props.onBrowserItemDragLeave} onItemDragOver={props.onBrowserItemDragOver} onItemDrop={props.onBrowserItemDrop} onOpenFile={props.onOpenFile} onSelectItem={selection.toggleItemSelection} onShareFile={props.onShareFile} onShowFileDetails={props.onShowFileDetails} key={file.id} />)}
      {props.pendingFolderShares.length === 0 && props.folderRows.length === 0 && props.fileRows.length === 0 ? <div class="empty-row">No files or folders</div> : null}
    </div>
  )

  function beginPointerSelection(event: PointerEvent): void {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') {
      scheduleLongPressSelection(event)
      return
    }
    beginMarquee(event)
  }

  function beginMarquee(event: PointerEvent, allowSelectableItem = false): void {
    if (event.button !== 0 || !tableRef.current || isActionClick(event)) return
    const target = event.target
    if (!allowSelectableItem && target instanceof Element && target.closest('.selectable-item')) return
    event.preventDefault()
    startMarquee({
      additive: event.metaKey || event.ctrlKey,
      baseSelection: selectionRef.current.selectedItems,
      currentX: event.clientX,
      currentY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    }, event.pointerId)
  }

  function scheduleLongPressSelection(event: PointerEvent): void {
    if (event.button !== 0 || !tableRef.current || isLongPressBlocked(event)) return
    cancelPendingLongPress()
    const pending = {
      additive: false,
      baseSelection: selectionRef.current.selectedItems,
      currentX: event.clientX,
      currentY: event.clientY,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: 0,
    }
    pending.timer = window.setTimeout(() => {
      if (pendingLongPressRef.current?.pointerId !== pending.pointerId) return
      pendingLongPressRef.current = null
      suppressNextClick()
      startMarquee(pending, pending.pointerId)
    }, longPressDelayMs)
    pendingLongPressRef.current = pending
  }

  function startMarquee(next: Marquee, pointerId: number): void {
    if (!tableRef.current) return
    marqueeRef.current = next
    tableRef.current.setPointerCapture(pointerId)
    setMarquee(next)
    applyMarqueeSelection(next)
  }

  function updatePendingLongPress(event: PointerEvent): void {
    const pending = pendingLongPressRef.current
    if (!pending || pending.pointerId !== event.pointerId) return
    pending.currentX = event.clientX
    pending.currentY = event.clientY
    if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) > longPressMoveTolerancePx) {
      cancelPendingLongPress()
    }
  }

  function updateMarquee(event: PointerEvent): void {
    if (!marqueeRef.current || !tableRef.current) return
    event.preventDefault()
    const next = { ...marqueeRef.current, currentX: event.clientX, currentY: event.clientY }
    marqueeRef.current = next
    setMarquee(next)
    applyMarqueeSelection(next)
  }

  function finishMarquee(event: PointerEvent): void {
    if (!marqueeRef.current) return
    updateMarquee(event)
    const table = tableRef.current
    if (table?.hasPointerCapture(event.pointerId)) {
      table.releasePointerCapture(event.pointerId)
    }
    marqueeRef.current = null
    setMarquee(null)
  }

  function applyMarqueeSelection(next: Marquee): void {
    if (!tableRef.current) return
    const selectedByMarquee = intersectingItems(tableRef.current, next)
    selectionRef.current.setSelection(next.additive ? [...next.baseSelection, ...selectedByMarquee] : selectedByMarquee)
  }

  function cancelPendingLongPress(): void {
    if (pendingLongPressRef.current) window.clearTimeout(pendingLongPressRef.current.timer)
    pendingLongPressRef.current = null
  }

  function suppressNextClick(): void {
    suppressClickRef.current = true
    window.setTimeout(() => { suppressClickRef.current = false }, 500)
  }
}

function marqueeRect(marquee: Marquee, table: HTMLElement | null): Record<string, string> | null {
  if (!table) return null
  const tableRect = table.getBoundingClientRect()
  const left = Math.min(marquee.startX, marquee.currentX) - tableRect.left
  const top = Math.min(marquee.startY, marquee.currentY) - tableRect.top
  return {
    height: `${Math.abs(marquee.currentY - marquee.startY)}px`,
    left: `${left}px`,
    top: `${top}px`,
    width: `${Math.abs(marquee.currentX - marquee.startX)}px`,
  }
}

function intersectingItems(table: HTMLElement, marquee: Marquee): BrowserDragItem[] {
  const rect = {
    bottom: Math.max(marquee.startY, marquee.currentY),
    left: Math.min(marquee.startX, marquee.currentX),
    right: Math.max(marquee.startX, marquee.currentX),
    top: Math.min(marquee.startY, marquee.currentY),
  }
  return [...table.querySelectorAll<HTMLElement>('[data-select-type][data-select-id]')]
    .filter((element) => intersects(rect, element.getBoundingClientRect()))
    .map((element) => ({ type: element.dataset.selectType as BrowserDragItem['type'], id: element.dataset.selectId ?? '' }))
    .filter((item) => item.id)
}

function intersects(a: { bottom: number; left: number; right: number; top: number }, b: DOMRect): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top
}

function isActionClick(event: MouseEvent): boolean {
  const target = event.target
  return target instanceof Element && Boolean(target.closest('button,input,a,select,textarea'))
}

function isLongPressBlocked(event: PointerEvent): boolean {
  const target = event.target
  return target instanceof Element && Boolean(target.closest('input,a,select,textarea,.row-actions'))
}
