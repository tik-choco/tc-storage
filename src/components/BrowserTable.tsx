import { DropOverlay } from './BrowserDropOverlay.js'
import { FileRow, FolderRow, NewFolderRow } from './BrowserRows.js'
import type { BrowserTableProps } from './BrowserTableTypes.js'
import { FileTile, FolderTile, NewFolderTile } from './BrowserTiles.js'

export function FileTable(props: BrowserTableProps) {
  const isCurrentDropTarget = props.dropTargetFolderId === props.currentFolderId

  if (props.viewMode === 'grid') {
    return (
      <div class={`table table-grid drop-zone ${props.dragActive ? 'drag-active' : ''} ${isCurrentDropTarget ? 'drop-target' : ''}`} role="list" aria-label="Files and folders" onDragEnter={props.onDrag} onDragOver={props.onDrag} onDragLeave={props.onDrag} onDrop={props.onDrop}>
        {props.dragActive ? <DropOverlay folder={props.currentFolder} /> : null}
        {props.folderNameDraft !== null ? <NewFolderTile name={props.folderNameDraft} onCancel={props.onCancelCreateFolder} onChange={props.onFolderNameDraft} onConfirm={props.onConfirmCreateFolder} /> : null}
        {props.folderRows.map((folder) => <FolderTile dragItem={props.dragItem} dropTargetFolderId={props.dropTargetFolderId} folder={folder} files={props.files} onCopy={props.onCopy} onDeleteFolder={props.onDeleteFolder} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onMoveTargetDragLeave={props.onMoveTargetDragLeave} onMoveTargetDragOver={props.onMoveTargetDragOver} onMoveTargetDrop={props.onMoveTargetDrop} onSelectFolder={props.onSelectFolder} onShowFolderDetails={props.onShowFolderDetails} key={folder.id} />)}
        {props.fileRows.map((file) => <FileTile busy={props.busy === `file-share-${file.id}`} dataUrl={props.fileDataUrls[file.id]} dragItem={props.dragItem} file={file} onDeleteFile={props.onDeleteFile} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onOpenFile={props.onOpenFile} onPreloadFile={props.onPreloadFile} onShareFile={props.onShareFile} onShowFileDetails={props.onShowFileDetails} onToggleStar={props.onToggleStar} key={file.id} />)}
        {props.folderRows.length === 0 && props.fileRows.length === 0 ? <div class="empty-row tile-empty">No files or folders</div> : null}
      </div>
    )
  }

  return (
    <div class={`table drop-zone ${props.dragActive ? 'drag-active' : ''} ${isCurrentDropTarget ? 'drop-target' : ''}`} role="table" aria-label="Files and folders" onDragEnter={props.onDrag} onDragOver={props.onDrag} onDragLeave={props.onDrag} onDrop={props.onDrop}>
      {props.dragActive ? <DropOverlay folder={props.currentFolder} /> : null}
      <div class="table-row table-head" role="row">
        <span>Name</span>
        <span>Status</span>
        <span>Size</span>
        <span>Updated</span>
        <span>Actions</span>
      </div>
      {props.folderNameDraft !== null ? <NewFolderRow name={props.folderNameDraft} onCancel={props.onCancelCreateFolder} onChange={props.onFolderNameDraft} onConfirm={props.onConfirmCreateFolder} /> : null}
      {props.folderRows.map((folder) => <FolderRow dragItem={props.dragItem} dropTargetFolderId={props.dropTargetFolderId} folder={folder} files={props.files} onCopy={props.onCopy} onDeleteFolder={props.onDeleteFolder} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onMoveTargetDragLeave={props.onMoveTargetDragLeave} onMoveTargetDragOver={props.onMoveTargetDragOver} onMoveTargetDrop={props.onMoveTargetDrop} onSelectFolder={props.onSelectFolder} onShowFolderDetails={props.onShowFolderDetails} key={folder.id} />)}
      {props.fileRows.map((file) => <FileRow busy={props.busy === `file-share-${file.id}`} dragItem={props.dragItem} file={file} onDeleteFile={props.onDeleteFile} onDragEnd={props.onItemDragEnd} onDragStart={props.onItemDragStart} onOpenFile={props.onOpenFile} onShareFile={props.onShareFile} onShowFileDetails={props.onShowFileDetails} onToggleStar={props.onToggleStar} key={file.id} />)}
      {props.folderRows.length === 0 && props.fileRows.length === 0 ? <div class="empty-row">No files or folders</div> : null}
    </div>
  )
}
