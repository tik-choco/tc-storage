import { Folder, Home, Settings, UserRound } from 'lucide-preact'
import type { BrowserDragItem } from '../appTypes.js'
import { childFolders, type FolderRecord, type StorageSnapshot } from '../domain.js'

export function Sidebar(props: {
  avatarUrl: string
  currentFolderId: string | null
  dragItem: BrowserDragItem | null
  dropTargetFolderId: string | null | undefined
  snapshot: StorageSnapshot
  onItemDragEnd: () => void
  onItemDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onMoveTargetDragLeave: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDragOver: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDrop: (folderId: string | null, event: DragEvent) => void
  onOpenProfile: (anchor?: HTMLElement) => void
  onOpenSettings: (anchor?: HTMLElement) => void
  onSelectFolder: (folderId: string | null) => void
}) {
  return (
    <aside class="sidebar">
      <div class="side-header">
        <button
          class={`side-icon-button folder-drop-target ${!props.currentFolderId ? 'selected' : ''} ${props.dropTargetFolderId === null ? 'drop-target' : ''}`}
          onClick={() => props.onSelectFolder(null)}
          onDragLeave={(event) => props.onMoveTargetDragLeave(null, event)}
          onDragOver={(event) => props.onMoveTargetDragOver(null, event)}
          onDrop={(event) => props.onMoveTargetDrop(null, event)}
          title="My Drive"
        >
          <Home size={17} />
        </button>
        <button class="side-icon-button" onClick={(event) => props.onOpenSettings(event.currentTarget)} title="Settings">
          <Settings size={17} />
        </button>
        <button class="side-profile-button" onClick={(event) => props.onOpenProfile(event.currentTarget)} title="Edit profile">
          <span class="avatar-frame small">
            {props.avatarUrl ? <img src={props.avatarUrl} alt="" /> : <UserRound size={15} />}
          </span>
        </button>
      </div>
      <nav class="side-nav" aria-label="Folders">
        {childFolders(props.snapshot, null).map((folder) => (
          <FolderTreeItem {...props} folder={folder} depth={0} key={folder.id} />
        ))}
      </nav>
    </aside>
  )
}

function FolderTreeItem(props: {
  currentFolderId: string | null
  depth: number
  dragItem: BrowserDragItem | null
  dropTargetFolderId: string | null | undefined
  folder: FolderRecord
  snapshot: StorageSnapshot
  onItemDragEnd: () => void
  onItemDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onMoveTargetDragLeave: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDragOver: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDrop: (folderId: string | null, event: DragEvent) => void
  onSelectFolder: (folderId: string | null) => void
}) {
  const isDragSource = props.dragItem?.type === 'folder' && props.dragItem.id === props.folder.id
  const isDropTarget = props.dropTargetFolderId === props.folder.id

  return (
    <div class="side-folder-branch">
      <button
        class={`side-folder-item movable-item folder-drop-target ${props.currentFolderId === props.folder.id ? 'selected' : ''} ${isDragSource ? 'drag-source' : ''} ${isDropTarget ? 'drop-target' : ''}`}
        draggable
        onDragEnd={props.onItemDragEnd}
        onDragLeave={(event) => props.onMoveTargetDragLeave(props.folder.id, event)}
        onDragOver={(event) => props.onMoveTargetDragOver(props.folder.id, event)}
        onDragStart={(event) => props.onItemDragStart({ type: 'folder', id: props.folder.id }, event)}
        onDrop={(event) => props.onMoveTargetDrop(props.folder.id, event)}
        style={{ '--folder-depth-offset': `${props.depth * 18}px` }}
        onClick={() => props.onSelectFolder(props.folder.id)}
      >
        <Folder size={17} class={`folder-stroke ${props.folder.color}`} />
        <span>{props.folder.name}</span>
      </button>
      {childFolders(props.snapshot, props.folder.id).map((folder) => (
        <FolderTreeItem {...props} folder={folder} depth={props.depth + 1} key={folder.id} />
      ))}
    </div>
  )
}
