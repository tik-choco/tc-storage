import type { BrowserDragItem, BrowserReorderTarget } from './appTypes.js'

export function reorderIds(ids: string[], sourceId: string, targetId: string, position: BrowserReorderTarget['position']): string[] {
  const withoutSource = ids.filter((id) => id !== sourceId)
  const targetIndex = withoutSource.indexOf(targetId)
  if (targetIndex < 0) return ids
  const insertIndex = position === 'before' ? targetIndex : targetIndex + 1
  return [...withoutSource.slice(0, insertIndex), sourceId, ...withoutSource.slice(insertIndex)]
}

export function reorderIdBlock(ids: string[], sourceIds: string[], targetId: string, position: BrowserReorderTarget['position']): string[] {
  const sourceSet = new Set(sourceIds)
  if (sourceSet.size === 0 || sourceSet.has(targetId)) return ids
  const movedIds = ids.filter((id) => sourceSet.has(id))
  if (movedIds.length === 0) return ids
  const withoutSources = ids.filter((id) => !sourceSet.has(id))
  const targetIndex = withoutSources.indexOf(targetId)
  if (targetIndex < 0) return ids
  const insertIndex = position === 'before' ? targetIndex : targetIndex + 1
  return [...withoutSources.slice(0, insertIndex), ...movedIds, ...withoutSources.slice(insertIndex)]
}

export function uniqueItems(items: BrowserDragItem[]): BrowserDragItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.type}:${item.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function sameItem(a: BrowserDragItem, b: BrowserDragItem): boolean {
  return a.type === b.type && a.id === b.id
}
