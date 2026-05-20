import { useRef, useState } from 'preact/hooks'
import type { BrowserDragItem } from '../appTypes.js'
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

export function FileTable(props: BrowserTableProps) {
  const isCurrentDropTarget = props.dropTargetFolderId === props.currentFolderId
  const selection = props.selection ?? emptySelectionActions
  const selectionRef = useRef(selection)
  const tableRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<Marquee | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const marqueeStyle = marquee ? marqueeRect(marquee, tableRef.current) : null
  selectionRef.current = selection
  const tableProps = {
    ref: tableRef,
    onPointerCancel: (event: PointerEvent) => finishMarquee(event),
    onPointerDown: (event: PointerEvent) => beginMarquee(event),
    onPointerMove: (event: PointerEvent) => updateMarquee(event),
    onPointerUp: (event: PointerEvent) => finishMarquee(event),
  }

  if (props.viewMode === 'grid') {
    return (
      <div {...tableProps} class={`table table-grid drop-zone ${marquee ? 'marquee-active' : ''} ${props.dragActive ? 'drag-active' : ''} ${isCurrentDropTarget ? 'drop-target' : ''}`} role="list" aria-label="Files and folders" onDragEnter={props.onDrag} onDragOver={props.onDrag} onDragLeave={props.onDrag} onDrop={props.onDrop}>
        {props.dragActive ? <DropOverlay folder={props.currentFolder} /> : null}
        {marqueeStyle ? <div class="selection-marquee" style={marqueeStyle} /> : null}
        {props.folderNameDraft !== null ? <NewFolderTile name={props.folderNameDraft} onCancel={props.onCancelCreateFolder} onChange={props.onFolderNameDraft} onConfirm={props.onConfirmCreateFolder} /> : null}
        {props.pendingFolderShares.map((share) => <PendingFolderShareTile busy={props.busy === `import-${share.cid}`} share={share} onCancelShare={props.onCancelPendingShare} key={share.cid} />)}
        {props.folderRows.map((folder) => <FolderTile selected={selection.isItemSelected({ type: 'folder', id: folder.id })} dragItem={props.dragItem} dropTargetFolderId={props.dropTargetFolderId} folder={folder} files={props.files} reorderTarget={props.reorderTarget} onDeleteFolder={props.onDeleteFolder} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onItemDragLeave={props.onBrowserItemDragLeave} onItemDragOver={props.onBrowserItemDragOver} onItemDrop={props.onBrowserItemDrop} onSelectFolder={props.onSelectFolder} onShowFolderDetails={props.onShowFolderDetails} key={folder.id} />)}
        {props.fileRows.map((file) => <FileTile selected={selection.isItemSelected({ type: 'file', id: file.id })} busy={props.busy === `file-share-${file.id}`} dataUrl={props.fileDataUrls[file.id]} dragItem={props.dragItem} file={file} reorderTarget={props.reorderTarget} onDeleteFile={props.onDeleteFile} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onItemDragLeave={props.onBrowserItemDragLeave} onItemDragOver={props.onBrowserItemDragOver} onItemDrop={props.onBrowserItemDrop} onOpenFile={props.onOpenFile} onPreloadFile={props.onPreloadFile} onShareFile={props.onShareFile} onShowFileDetails={props.onShowFileDetails} key={file.id} />)}
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
      {props.pendingFolderShares.map((share) => <PendingFolderShareRow busy={props.busy === `import-${share.cid}`} share={share} onCancelShare={props.onCancelPendingShare} key={share.cid} />)}
      {props.folderRows.map((folder) => <FolderRow selected={selection.isItemSelected({ type: 'folder', id: folder.id })} dragItem={props.dragItem} dropTargetFolderId={props.dropTargetFolderId} folder={folder} files={props.files} reorderTarget={props.reorderTarget} onDeleteFolder={props.onDeleteFolder} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onItemDragLeave={props.onBrowserItemDragLeave} onItemDragOver={props.onBrowserItemDragOver} onItemDrop={props.onBrowserItemDrop} onSelectFolder={props.onSelectFolder} onSelectItem={selection.toggleItemSelection} onShowFolderDetails={props.onShowFolderDetails} key={folder.id} />)}
      {props.fileRows.map((file) => <FileRow selected={selection.isItemSelected({ type: 'file', id: file.id })} busy={props.busy === `file-share-${file.id}`} dragItem={props.dragItem} file={file} reorderTarget={props.reorderTarget} onDeleteFile={props.onDeleteFile} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onItemDragLeave={props.onBrowserItemDragLeave} onItemDragOver={props.onBrowserItemDragOver} onItemDrop={props.onBrowserItemDrop} onOpenFile={props.onOpenFile} onSelectItem={selection.toggleItemSelection} onShareFile={props.onShareFile} onShowFileDetails={props.onShowFileDetails} key={file.id} />)}
      {props.pendingFolderShares.length === 0 && props.folderRows.length === 0 && props.fileRows.length === 0 ? <div class="empty-row">No files or folders</div> : null}
    </div>
  )

  function beginMarquee(event: PointerEvent): void {
    if (event.button !== 0 || !tableRef.current || isActionClick(event)) return
    const target = event.target
    if (target instanceof Element && target.closest('.selectable-item')) return
    event.preventDefault()
    const next = {
      additive: event.metaKey || event.ctrlKey,
      baseSelection: selectionRef.current.selectedItems,
      currentX: event.clientX,
      currentY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    }
    marqueeRef.current = next
    tableRef.current.setPointerCapture(event.pointerId)
    setMarquee(next)
    applyMarqueeSelection(next)
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
