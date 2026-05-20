import type { BrowserDragItem } from './appTypes.js'

const browserDragType = 'application/x-tc-storage-item'
const browserDragItemsType = 'application/x-tc-storage-items'

export function writeBrowserDragItem(dataTransfer: DataTransfer | null, item: BrowserDragItem): void {
  writeBrowserDragItems(dataTransfer, [item])
}

export function writeBrowserDragItems(dataTransfer: DataTransfer | null, items: BrowserDragItem[]): void {
  if (!dataTransfer) return
  const first = items[0]
  dataTransfer.effectAllowed = 'move'
  dataTransfer.setData(browserDragItemsType, JSON.stringify(items))
  if (first) dataTransfer.setData(browserDragType, JSON.stringify(first))
  dataTransfer.setData('text/plain', items.length > 1 ? `${items.length} items` : first ? `${first.type}:${first.id}` : 'items')
}

export function readBrowserDragItem(dataTransfer: DataTransfer | null): BrowserDragItem | null {
  if (!dataTransfer) return null
  const value = dataTransfer.getData(browserDragType)
  if (!value) return null
  try {
    const item = JSON.parse(value) as Partial<BrowserDragItem>
    return (item.type === 'file' || item.type === 'folder') && typeof item.id === 'string'
      ? { type: item.type, id: item.id }
      : null
  } catch {
    return null
  }
}

export function readBrowserDragItems(dataTransfer: DataTransfer | null): BrowserDragItem[] {
  if (!dataTransfer) return []
  const value = dataTransfer.getData(browserDragItemsType)
  if (!value) {
    const item = readBrowserDragItem(dataTransfer)
    return item ? [item] : []
  }
  try {
    const items = JSON.parse(value) as Partial<BrowserDragItem>[]
    return Array.isArray(items) ? items.filter(isBrowserDragItem).map((item) => ({ type: item.type, id: item.id })) : []
  } catch {
    return []
  }
}

export function hasBrowserDragItem(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).some((type) => type === browserDragType || type === browserDragItemsType))
}

export function hasExternalFiles(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes('Files'))
}

function isBrowserDragItem(item: Partial<BrowserDragItem>): item is BrowserDragItem {
  return (item.type === 'file' || item.type === 'folder') && typeof item.id === 'string'
}
