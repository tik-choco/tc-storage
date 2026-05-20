import type { BrowserDragItem } from './appTypes.js'

const browserDragType = 'application/x-tc-storage-item'

export function writeBrowserDragItem(dataTransfer: DataTransfer | null, item: BrowserDragItem): void {
  if (!dataTransfer) return
  dataTransfer.effectAllowed = 'move'
  dataTransfer.setData(browserDragType, JSON.stringify(item))
  dataTransfer.setData('text/plain', `${item.type}:${item.id}`)
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

export function hasBrowserDragItem(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes(browserDragType))
}

export function hasExternalFiles(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes('Files'))
}
