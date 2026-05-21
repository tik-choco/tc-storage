import type { BrowserDragItem, BrowserReorderTarget, Notice } from './appTypes.js'
import type { MoveActions, MutableRef, SetState } from './appControllerTypes.js'
import { reorderIds, sameItem, uniqueItems } from './appDragDropUtils.js'
import { descendantFolderIds } from './appHelpers.js'
import { nearestSharedAncestorFolder } from './appUtils.js'
import { stampFilePatch, stampFolderPatch } from './crdt.js'
import { addActivity, compareFilesForDisplay, compareFoldersForDisplay, touchSnapshot, type FileRecord, type FolderRecord, type StorageSnapshot } from './domain.js'
import { hasBrowserDragItem, hasExternalFiles, readBrowserDragItems, writeBrowserDragItems } from './dragDrop.js'
import type { AppSettings } from './localSettings.js'

interface DragDropOptions {
  announceFolderChange: (folder: FolderRecord, changeType: 'file-upserted' | 'folder-upserted', file?: FileRecord, changedFolder?: FolderRecord) => void
  browserViewMode: 'grid' | 'list'
  currentFolderId: string | null
  dragItemRef: MutableRef<BrowserDragItem | null>
  dragItemsRef: MutableRef<BrowserDragItem[]>
  moveActions: MoveActions
  scheduleFolderSync: (folderId: string, reason: string) => void
  selectedItems: BrowserDragItem[]
  setDragActive: SetState<boolean>
  setDragItem: SetState<BrowserDragItem | null>
  setDropTargetFolderId: SetState<string | null | undefined>
  setNotice: SetState<Notice>
  setReorderTarget: SetState<BrowserReorderTarget | null>
  setSelectedItems: SetState<BrowserDragItem[]>
  setSnapshot: SetState<StorageSnapshot>
  settings: AppSettings
  snapshotRef: MutableRef<StorageSnapshot>
  uploadFiles: (fileList: FileList | null, targetFolderId?: string | null) => Promise<void>
}

export function createDragDropActions(options: DragDropOptions) {
  const {
    announceFolderChange, browserViewMode, currentFolderId, dragItemRef, dragItemsRef, moveActions, scheduleFolderSync, selectedItems, setDragActive, setDragItem,
    setDropTargetFolderId, setNotice, setReorderTarget, setSelectedItems, setSnapshot, settings, snapshotRef, uploadFiles,
  } = options

  function beginItemDrag(item: BrowserDragItem, event: DragEvent) {
    const items = selectedItems.some((value) => sameItem(value, item)) ? selectedItems : [item]
    writeBrowserDragItems(event.dataTransfer, items)
    dragItemRef.current = item
    dragItemsRef.current = items
    setDragItem(item)
    setDragActive(false)
    setDropTargetFolderId(undefined)
  }

  function endItemDrag() {
    dragItemRef.current = null
    dragItemsRef.current = []
    setDragItem(null)
    setDropTargetFolderId(undefined)
    setReorderTarget(null)
  }

  function handleBrowserItemDragOver(target: BrowserDragItem, event: DragEvent) {
    const item = dragItemRef.current
    if (!item) {
      if (target.type === 'folder' && hasExternalFiles(event.dataTransfer)) handleMoveTargetDragOver(target.id, event)
      return
    }
    const reorder = dragItemsRef.current.length <= 1 ? reorderTargetFromEvent(item, target, event) : null
    if (reorder) {
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      setDragActive(false)
      setDropTargetFolderId(undefined)
      setReorderTarget(reorder)
      return
    }
    setReorderTarget((current) => (current?.type === target.type && current.id === target.id ? null : current))
    if (target.type === 'folder') handleMoveTargetDragOver(target.id, event)
  }

  function handleBrowserItemDragLeave(target: BrowserDragItem, event: DragEvent) {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setReorderTarget((current) => (current?.type === target.type && current.id === target.id ? null : current))
    if (target.type === 'folder') handleMoveTargetDragLeave(target.id, event)
  }

  function handleBrowserItemDrop(target: BrowserDragItem, event: DragEvent) {
    const items = currentDragItems(event.dataTransfer)
    const item = items[0]
    if (!item) {
      if (target.type === 'folder') handleMoveTargetDrop(target.id, event)
      return
    }
    const reorder = items.length <= 1 ? reorderTargetFromEvent(item, target, event) : null
    if (reorder?.type === target.type && reorder.id === target.id && canReorderDraggedItem(item, target)) {
      event.preventDefault()
      event.stopPropagation()
      endItemDrag()
      reorderDraggedItem(item, reorder)
      return
    }
    if (target.type === 'folder') handleMoveTargetDrop(target.id, event)
  }

  function handleMoveTargetDragOver(targetFolderId: string | null, event: DragEvent) {
    const items = currentDragItems(event.dataTransfer)
    const hasInternalItem = Boolean(items.length || hasBrowserDragItem(event.dataTransfer))
    const hasFiles = hasExternalFiles(event.dataTransfer)
    if (!hasInternalItem && !hasFiles) return
    event.preventDefault()
    event.stopPropagation()
    if (items.length) {
      const allowed = movableItemsForTarget(items, targetFolderId).length > 0
      if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'move' : 'none'
      setDropTargetFolderId(allowed ? targetFolderId : undefined)
      return
    }
    if (event.dataTransfer) event.dataTransfer.dropEffect = targetFolderId ? 'copy' : 'none'
    setDropTargetFolderId(targetFolderId ? targetFolderId : undefined)
  }

  function handleMoveTargetDragLeave(targetFolderId: string | null, event: DragEvent) {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setDropTargetFolderId((current) => (current === targetFolderId ? undefined : current))
  }

  function handleMoveTargetDrop(targetFolderId: string | null, event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    const items = currentDragItems(event.dataTransfer)
    const filesToUpload = event.dataTransfer?.files ?? null
    setDragActive(false)
    endItemDrag()
    if (items.length) {
      void moveDraggedItems(items, targetFolderId)
      return
    }
    void uploadFiles(filesToUpload, targetFolderId)
  }

  function reorderTargetFromEvent(item: BrowserDragItem, target: BrowserDragItem, event: DragEvent): BrowserReorderTarget | null {
    if (!canReorderDraggedItem(item, target)) return null
    const ratio = itemDropRatio(event)
    if (target.type === 'folder' && ratio > 0.3 && ratio < 0.7) return null
    return { ...target, position: ratio < 0.5 ? 'before' : 'after' }
  }

  function itemDropRatio(event: DragEvent): number {
    const target = event.currentTarget
    if (!(target instanceof HTMLElement)) return 0.5
    const rect = target.getBoundingClientRect()
    if (browserViewMode === 'grid') return rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5
    return rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
  }

  function canReorderDraggedItem(item: BrowserDragItem, target: BrowserDragItem): boolean {
    if (item.type !== target.type || item.id === target.id) return false
    const snapshotValue = snapshotRef.current
    if (item.type === 'file') {
      const file = snapshotValue.files.find((value) => value.id === item.id && !value.deletedAt)
      const targetFile = snapshotValue.files.find((value) => value.id === target.id && !value.deletedAt)
      return Boolean(file && targetFile && file.folderId === currentFolderId && targetFile.folderId === currentFolderId)
    }
    const folder = snapshotValue.folders.find((value) => value.id === item.id && !value.deletedAt)
    const targetFolder = snapshotValue.folders.find((value) => value.id === target.id && !value.deletedAt)
    return Boolean(folder && targetFolder && folder.parentId === currentFolderId && targetFolder.parentId === currentFolderId)
  }

  function reorderDraggedItem(item: BrowserDragItem, target: BrowserReorderTarget): void {
    if (!canReorderDraggedItem(item, target)) return
    const now = new Date().toISOString()
    const snapshotValue = snapshotRef.current
    if (item.type === 'file') {
      const currentRows = snapshotValue.files.filter((file) => !file.deletedAt && file.folderId === currentFolderId).sort(compareFilesForDisplay)
      const nextIds = reorderIds(currentRows.map((file) => file.id), item.id, target.id, target.position)
      const orderById = new Map(nextIds.map((id, index) => [id, (index + 1) * 1000]))
      const movedFile = currentRows.find((file) => file.id === item.id)
      const changedFiles = currentRows.flatMap((file) => {
        const sortOrder = orderById.get(file.id)
        return sortOrder === undefined || file.sortOrder === sortOrder ? [] : [stampFilePatch(file, { sortOrder }, now, settings.nodeId)]
      })
      const changedFilesById = new Map(changedFiles.map((file) => [file.id, file]))
      setSnapshot((current) => touchSnapshot(addActivity({ ...current, files: current.files.map((file) => {
        return changedFilesById.get(file.id) ?? file
      }) }, { actorNodeId: settings.nodeId, folderId: currentFolderId ?? undefined, fileId: item.id, action: 'file.reorder', detail: `${movedFile?.name ?? 'ファイル'} を並び替え` }, now), settings.nodeId))
      announceReorderedSharedFiles(changedFiles)
      setNotice({ tone: 'success', text: 'ファイルの並び順を更新しました' })
      return
    }
    const currentRows = snapshotValue.folders.filter((folder) => !folder.deletedAt && folder.parentId === currentFolderId).sort(compareFoldersForDisplay)
    const nextIds = reorderIds(currentRows.map((folder) => folder.id), item.id, target.id, target.position)
    const orderById = new Map(nextIds.map((id, index) => [id, (index + 1) * 1000]))
    const movedFolder = currentRows.find((folder) => folder.id === item.id)
    const changedFolders = currentRows.flatMap((folder) => {
      const sortOrder = orderById.get(folder.id)
      return sortOrder === undefined || folder.sortOrder === sortOrder ? [] : [stampFolderPatch(folder, { sortOrder }, now, settings.nodeId)]
    })
    const changedFoldersById = new Map(changedFolders.map((folder) => [folder.id, folder]))
    setSnapshot((current) => touchSnapshot(addActivity({ ...current, folders: current.folders.map((folder) => {
      return changedFoldersById.get(folder.id) ?? folder
    }) }, { actorNodeId: settings.nodeId, folderId: item.id, action: 'folder.reorder', detail: `${movedFolder?.name ?? 'フォルダー'} を並び替え` }, now), settings.nodeId))
    announceReorderedSharedFolders(changedFolders)
    setNotice({ tone: 'success', text: 'フォルダーの並び順を更新しました' })
  }

  function announceReorderedSharedFiles(files: FileRecord[]): void {
    const folder = nearestSharedAncestorFolder(snapshotRef.current, currentFolderId)
    if (!folder) return
    scheduleFolderSync(folder.id, 'local file reorder')
    for (const file of files) announceFolderChange(folder, 'file-upserted', file)
  }

  function announceReorderedSharedFolders(folders: FolderRecord[]): void {
    const snapshotValue = snapshotRef.current
    const containerSharedFolder = nearestSharedAncestorFolder(snapshotValue, currentFolderId)
    if (containerSharedFolder) {
      scheduleFolderSync(containerSharedFolder.id, 'local folder reorder')
      for (const folder of folders) announceFolderChange(containerSharedFolder, 'folder-upserted', undefined, folder)
      return
    }
    const groups = new Map<string, { folder: FolderRecord; changedFolders: FolderRecord[] }>()
    for (const folder of folders) {
      const sharedFolder = nearestSharedAncestorFolder(snapshotValue, folder.id)
      if (!sharedFolder) continue
      const group = groups.get(sharedFolder.id)
      if (group) group.changedFolders.push(folder)
      else groups.set(sharedFolder.id, { folder: sharedFolder, changedFolders: [folder] })
    }
    for (const group of groups.values()) {
      scheduleFolderSync(group.folder.id, 'local folder reorder')
      for (const folder of group.changedFolders) announceFolderChange(group.folder, 'folder-upserted', undefined, folder)
    }
  }

  function handleDrag(event: DragEvent) {
    const items = currentDragItems(event.dataTransfer)
    const internalDrag = Boolean(items.length || hasBrowserDragItem(event.dataTransfer))
    if (!internalDrag && !hasExternalFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    if (internalDrag) {
      if (event.type === 'dragleave') {
        const nextTarget = event.relatedTarget
        if (!(nextTarget instanceof Node && event.currentTarget instanceof Node && event.currentTarget.contains(nextTarget))) {
          setDropTargetFolderId((current) => (current === currentFolderId ? undefined : current))
        }
        return
      }
      const allowed = items.length ? movableItemsForTarget(items, currentFolderId).length > 0 : true
      if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'move' : 'none'
      setDragActive(false)
      setReorderTarget(null)
      setDropTargetFolderId(allowed ? currentFolderId : undefined)
      return
    }
    if (event.dataTransfer) event.dataTransfer.dropEffect = currentFolderId ? 'copy' : 'none'
    setDropTargetFolderId(undefined)
    setDragActive(Boolean(currentFolderId) && (event.type === 'dragenter' || event.type === 'dragover'))
  }

  function handleDrop(event: DragEvent) {
    handleMoveTargetDrop(currentFolderId, event)
  }

  function currentDragItems(dataTransfer: DataTransfer | null): BrowserDragItem[] {
    return dragItemsRef.current.length ? dragItemsRef.current : readBrowserDragItems(dataTransfer)
  }

  async function moveDraggedItems(items: BrowserDragItem[], targetFolderId: string | null): Promise<void> {
    const movableItems = movableItemsForTarget(items, targetFolderId)
    if (movableItems.length === 0) {
      setNotice({ tone: 'error', text: 'その場所には移動できません' })
      return
    }
    for (const item of movableItems) await moveActions.moveDraggedItem(item, targetFolderId)
    setSelectedItems((current) => current.filter((item) => !movableItems.some((moved) => sameItem(moved, item))))
    if (movableItems.length > 1) setNotice({ tone: 'success', text: `${movableItems.length} 件を移動しました` })
  }

  function movableItemsForTarget(items: BrowserDragItem[], targetFolderId: string | null): BrowserDragItem[] {
    return uniqueItems(items).filter((item) => !isCoveredByDraggedFolder(item, items) && moveActions.canMoveItemToFolder(item, targetFolderId))
  }

  function isCoveredByDraggedFolder(item: BrowserDragItem, items: BrowserDragItem[]): boolean {
    const snapshotValue = snapshotRef.current
    const selectedFolders = items.flatMap((value) => value.type === 'folder' ? snapshotValue.folders.find((folder) => folder.id === value.id && !folder.deletedAt) ?? [] : [])
    if (item.type === 'folder') return selectedFolders.some((folder) => folder.id !== item.id && descendantFolderIds(snapshotValue.folders, folder.id).has(item.id))
    const file = snapshotValue.files.find((value) => value.id === item.id && !value.deletedAt)
    return Boolean(file && selectedFolders.some((folder) => descendantFolderIds(snapshotValue.folders, folder.id).has(file.folderId)))
  }

  return { beginItemDrag, endItemDrag, handleBrowserItemDragLeave, handleBrowserItemDragOver, handleBrowserItemDrop, handleDrag, handleDrop, handleMoveTargetDragLeave, handleMoveTargetDragOver, handleMoveTargetDrop }
}
