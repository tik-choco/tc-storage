import type { BrowserDragItem, DeleteRequest, Notice } from './appTypes.js'
import type { MoveActions, SetState } from './appControllerTypes.js'
import { descendantFolderIds } from './appHelpers.js'
import type { FileRecord, FolderRecord } from '../storage/domain.js'

interface SelectionOptions {
  fileRows: FileRecord[]
  files: FileRecord[]
  folderRows: FolderRecord[]
  folders: FolderRecord[]
  moveActions: MoveActions
  selectedItems: BrowserDragItem[]
  setDeleteRequest: SetState<DeleteRequest | null>
  setNotice: SetState<Notice>
  setSelectedItems: SetState<BrowserDragItem[]>
}

export function createSelectionActions(options: SelectionOptions) {
  const { fileRows, files, folderRows, folders, moveActions, selectedItems, setDeleteRequest, setNotice, setSelectedItems } = options
  const selectedKeys = new Set(selectedItems.map(itemKey))
  const selectedFiles = selectedItems.flatMap((item) => item.type === 'file' ? files.find((file) => file.id === item.id) ?? [] : [])
  const selectedFolders = selectedItems.flatMap((item) => item.type === 'folder' ? folders.find((folder) => folder.id === item.id) ?? [] : [])
  const selectedCount = selectedFiles.length + selectedFolders.length
  const visibleItems: BrowserDragItem[] = [
    ...folderRows.map((folder) => ({ type: 'folder' as const, id: folder.id })),
    ...fileRows.map((file) => ({ type: 'file' as const, id: file.id })),
  ]
  const allVisibleSelected = visibleItems.length > 0 && visibleItems.every((item) => selectedKeys.has(itemKey(item)))
  const moveTargetFolders = folders.filter((folder) => (
    canUseFolderAsMoveTarget(folder, folders, selectedFolders) &&
    selectedItems.some((item) => moveActions.canMoveItemToFolder(item, folder.id))
  ))

  function isItemSelected(item: BrowserDragItem): boolean {
    return selectedKeys.has(itemKey(item))
  }

  function toggleItemSelection(item: BrowserDragItem, selected: boolean, range = false): void {
    const anchor = selectedItems[selectedItems.length - 1]
    const rangeItems = range && anchor ? visibleRange(anchor, item) : []
    setSelectedItems((current) => {
      const itemsToUpdate = rangeItems.length > 0 ? rangeItems : [item]
      const updateKeys = new Set(itemsToUpdate.map(itemKey))
      const key = itemKey(item)
      const exists = current.some((value) => itemKey(value) === key)
      if (selected) return [...current, ...itemsToUpdate.filter((value) => !current.some((currentItem) => itemKey(currentItem) === itemKey(value)))]
      if (exists || rangeItems.length > 0) return current.filter((value) => !updateKeys.has(itemKey(value)))
      return current
    })
  }

  function clearSelection(): void {
    setSelectedItems([])
  }

  function setSelection(items: BrowserDragItem[]): void {
    setSelectedItems(uniqueItems(items))
  }

  function toggleSelectAllVisible(): void {
    if (allVisibleSelected) {
      const visibleKeys = new Set(visibleItems.map(itemKey))
      setSelectedItems((current) => current.filter((item) => !visibleKeys.has(itemKey(item))))
      return
    }
    setSelectedItems((current) => {
      const currentKeys = new Set(current.map(itemKey))
      return [...current, ...visibleItems.filter((item) => !currentKeys.has(itemKey(item)))]
    })
  }

  function requestDeleteSelection(): void {
    if (selectedCount === 0) return
    setDeleteRequest({ type: 'selection', files: selectedFiles, folders: selectedFolders })
  }

  async function moveSelectionToFolder(targetFolderId: string): Promise<void> {
    if (!targetFolderId || selectedCount === 0) return
    const movableItems = selectedItems.filter((item) => !isCoveredBySelectedFolder(item) && moveActions.canMoveItemToFolder(item, targetFolderId))
    if (movableItems.length === 0) {
      setNotice({ tone: 'error', text: '選択した項目はその場所に移動できません' })
      return
    }
    for (const item of movableItems) await moveActions.moveDraggedItem(item, targetFolderId)
    setSelectedItems((current) => current.filter((item) => !movableItems.some((moved) => itemKey(moved) === itemKey(item))))
    setNotice({ tone: 'success', text: `${movableItems.length} 件を移動しました` })
  }

  return {
    allVisibleSelected,
    clearSelection,
    isItemSelected,
    moveSelectionToFolder,
    moveTargetFolders,
    requestDeleteSelection,
    selectedCount,
    selectedItems,
    setSelection,
    toggleItemSelection,
    toggleSelectAllVisible,
  }

  function isCoveredBySelectedFolder(item: BrowserDragItem): boolean {
    if (item.type === 'folder') {
      return selectedFolders.some((folder) => folder.id !== item.id && descendantFolderIds(folders, folder.id).has(item.id))
    }
    const file = files.find((value) => value.id === item.id)
    return Boolean(file && selectedFolders.some((folder) => descendantFolderIds(folders, folder.id).has(file.folderId)))
  }

  function visibleRange(anchor: BrowserDragItem, item: BrowserDragItem): BrowserDragItem[] {
    const anchorIndex = visibleItems.findIndex((value) => itemKey(value) === itemKey(anchor))
    const itemIndex = visibleItems.findIndex((value) => itemKey(value) === itemKey(item))
    if (anchorIndex < 0 || itemIndex < 0) return []
    const start = Math.min(anchorIndex, itemIndex)
    const end = Math.max(anchorIndex, itemIndex)
    return visibleItems.slice(start, end + 1)
  }
}

export type SelectionActions = ReturnType<typeof createSelectionActions>

export const emptySelectionActions: SelectionActions = {
  allVisibleSelected: false,
  clearSelection: () => {},
  isItemSelected: () => false,
  moveSelectionToFolder: async () => {},
  moveTargetFolders: [],
  requestDeleteSelection: () => {},
  selectedCount: 0,
  selectedItems: [],
  setSelection: () => {},
  toggleItemSelection: () => {},
  toggleSelectAllVisible: () => {},
}

export function selectFromPointerEvent(event: MouseEvent, selected: boolean): { range: boolean; selected: boolean } {
  if (event.shiftKey) return { range: true, selected: true }
  return { range: false, selected: !selected }
}

function itemKey(item: BrowserDragItem): string {
  return `${item.type}:${item.id}`
}

function uniqueItems(items: BrowserDragItem[]): BrowserDragItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = itemKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function canUseFolderAsMoveTarget(folder: FolderRecord, folders: FolderRecord[], selectedFolders: FolderRecord[]): boolean {
  if (folder.deletedAt) return false
  return selectedFolders.every((selected) => selected.id !== folder.id && !descendantFolderIds(folders, selected.id).has(folder.id))
}
