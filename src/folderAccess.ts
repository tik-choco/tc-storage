import type { FolderAccessMode } from './appTypes.js'

const folderAccessModesKey = 'tc-storage-folder-access-modes-v1'

export function loadFolderAccessModes(): Record<string, FolderAccessMode> {
  try {
    return normalizeFolderAccessModes(JSON.parse(localStorage.getItem(folderAccessModesKey) ?? '{}') as unknown)
  } catch {
    return {}
  }
}

export function saveFolderAccessModes(modes: Record<string, FolderAccessMode>): void {
  localStorage.setItem(folderAccessModesKey, JSON.stringify(normalizeFolderAccessModes(modes)))
}

export function normalizeFolderAccessMode(value: unknown): FolderAccessMode {
  return value === 'shared-approval' || value === 'open' ? value : 'approval'
}

function normalizeFolderAccessModes(value: unknown): Record<string, FolderAccessMode> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([folderId, mode]) => [folderId, normalizeFolderAccessMode(mode)]))
}
