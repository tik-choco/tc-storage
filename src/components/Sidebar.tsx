import { ChevronDown, ChevronRight, Folder, Home, Monitor, Moon, Settings, Sun, UserRound } from 'lucide-preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import type { BrowserDragItem } from '../app/appTypes.js'
import { childFolders, type FolderRecord, type StorageSnapshot } from '../storage/domain.js'
import type { ThemePreference } from '../storage/theme.js'

const themeToggleIcon: Record<ThemePreference, typeof Sun> = {
  light: Moon,
  dark: Monitor,
  auto: Sun,
}

const themeToggleLabel: Record<ThemePreference, string> = {
  light: 'Switch to dark mode',
  dark: 'Switch to auto (OS) mode',
  auto: 'Switch to light mode',
}

export function Sidebar(props: {
  avatarUrl: string
  currentFolderId: string | null
  dragItem: BrowserDragItem | null
  dropTargetFolderId: string | null | undefined
  snapshot: StorageSnapshot
  themePreference: ThemePreference
  onItemDragEnd: () => void
  onItemDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onMoveTargetDragLeave: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDragOver: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDrop: (folderId: string | null, event: DragEvent) => void
  onOpenProfile: (anchor?: HTMLElement) => void
  onOpenSettings: (anchor?: HTMLElement) => void
  onSelectFolder: (folderId: string | null) => void
  onToggleTheme: () => void
}) {
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(() => new Set())
  const rootFolders = useMemo(() => childFolders(props.snapshot, null), [props.snapshot])
  const currentAncestorIds = useMemo(() => ancestorFolderIds(props.snapshot, props.currentFolderId), [props.currentFolderId, props.snapshot])

  useEffect(() => {
    const activeFolderIds = new Set(props.snapshot.folders.filter((folder) => !folder.deletedAt).map((folder) => folder.id))
    setExpandedFolderIds((current) => {
      const next = new Set([...current].filter((id) => activeFolderIds.has(id)))
      for (const id of currentAncestorIds) next.add(id)
      return sameFolderIdSet(current, next) ? current : next
    })
  }, [currentAncestorIds, props.snapshot])

  function toggleFolderExpanded(folderId: string): void {
    setExpandedFolderIds((current) => {
      const next = new Set(current)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

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
        <button class="side-icon-button" onClick={props.onToggleTheme} title={themeToggleLabel[props.themePreference]}>
          {(() => {
            const ThemeIcon = themeToggleIcon[props.themePreference]
            return <ThemeIcon size={17} />
          })()}
        </button>
        <button class="side-profile-button" onClick={(event) => props.onOpenProfile(event.currentTarget)} title="Edit profile">
          <span class="avatar-frame small">
            {props.avatarUrl ? <img src={props.avatarUrl} alt="" /> : <UserRound size={15} />}
          </span>
        </button>
      </div>
      <nav class="side-nav" aria-label="Folders">
        {rootFolders.map((folder) => (
          <FolderTreeItem {...props} expandedFolderIds={expandedFolderIds} folder={folder} depth={0} key={folder.id} onToggleFolderExpanded={toggleFolderExpanded} />
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
  expandedFolderIds: Set<string>
  folder: FolderRecord
  snapshot: StorageSnapshot
  onItemDragEnd: () => void
  onItemDragStart: (item: BrowserDragItem, event: DragEvent) => void
  onMoveTargetDragLeave: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDragOver: (folderId: string | null, event: DragEvent) => void
  onMoveTargetDrop: (folderId: string | null, event: DragEvent) => void
  onSelectFolder: (folderId: string | null) => void
  onToggleFolderExpanded: (folderId: string) => void
}) {
  const childFolderRows = childFolders(props.snapshot, props.folder.id)
  const hasChildren = childFolderRows.length > 0
  const isExpanded = hasChildren && props.expandedFolderIds.has(props.folder.id)
  const isDragSource = props.dragItem?.type === 'folder' && props.dragItem.id === props.folder.id
  const isDropTarget = props.dropTargetFolderId === props.folder.id

  return (
    <div class="side-folder-branch">
      <div class="side-folder-row" style={{ '--folder-depth-offset': (props.depth * 18) + 'px' }}>
        <button
          type="button"
          class={['side-folder-toggle', hasChildren ? '' : 'empty'].filter(Boolean).join(' ')}
          disabled={!hasChildren}
          onClick={() => props.onToggleFolderExpanded(props.folder.id)}
          aria-expanded={hasChildren ? isExpanded : undefined}
          title={hasChildren ? (isExpanded ? 'Collapse folder' : 'Expand folder') : undefined}
        >
          {hasChildren ? (isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />) : null}
        </button>
        <button
          type="button"
          class={['side-folder-item', 'movable-item', 'folder-drop-target', props.folder.shareEnabled ? 'shared-folder' : '', props.currentFolderId === props.folder.id ? 'selected' : '', isDragSource ? 'drag-source' : '', isDropTarget ? 'drop-target' : ''].filter(Boolean).join(' ')}
          draggable
          onDragEnd={props.onItemDragEnd}
          onDragLeave={(event) => props.onMoveTargetDragLeave(props.folder.id, event)}
          onDragOver={(event) => props.onMoveTargetDragOver(props.folder.id, event)}
          onDragStart={(event) => props.onItemDragStart({ type: 'folder', id: props.folder.id }, event)}
          onDrop={(event) => props.onMoveTargetDrop(props.folder.id, event)}
          onClick={() => props.onSelectFolder(props.folder.id)}
        >
          <Folder size={17} class={['folder-stroke', props.folder.shareEnabled ? 'shared' : props.folder.color].join(' ')} />
          <span>{props.folder.name}</span>
        </button>
      </div>
      {isExpanded ? childFolderRows.map((folder) => (
        <FolderTreeItem {...props} folder={folder} depth={props.depth + 1} key={folder.id} />
      )) : null}
    </div>
  )
}

function ancestorFolderIds(snapshot: StorageSnapshot, folderId: string | null): string[] {
  const ids: string[] = []
  const visited = new Set<string>()
  let current = folderId ? snapshot.folders.find((folder) => folder.id === folderId && !folder.deletedAt) : undefined
  while (current?.parentId) {
    if (visited.has(current.id)) break
    visited.add(current.id)
    const parent = snapshot.folders.find((folder) => folder.id === current?.parentId && !folder.deletedAt)
    if (!parent || visited.has(parent.id)) break
    ids.push(parent.id)
    current = parent
  }
  return ids
}

function sameFolderIdSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const id of left) {
    if (!right.has(id)) return false
  }
  return true
}
