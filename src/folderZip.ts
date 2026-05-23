import { childFolders, compareFilesForDisplay, type FileRecord, type FolderRecord, type StorageSnapshot } from './domain.js'
import type { ZipEntry } from './zip.js'

export type FolderZipLayout = {
  entries: ZipEntry[]
  folderPathById: Map<string, string>
  usedPaths: Set<string>
}

export function makeFolderZipLayout(snapshot: StorageSnapshot, root: FolderRecord, folderIds: Set<string>): FolderZipLayout {
  const entries: ZipEntry[] = []
  const folderPathById = new Map<string, string>()
  const usedPaths = new Set<string>()
  for (const folder of orderedFolders(snapshot, root, folderIds)) {
    const parentPath = folder.parentId ? folderPathById.get(folder.parentId) : undefined
    const folderPath = folder.id === root.id
      ? safeZipSegment(root.name, 'Folder')
      : `${parentPath ?? safeZipSegment(root.name, 'Folder')}/${safeZipSegment(folder.name, 'Folder')}`
    const path = uniqueZipPath(`${folderPath}/`, usedPaths)
    folderPathById.set(folder.id, path.slice(0, -1))
    entries.push({ data: new Uint8Array(), modifiedAt: folder.updatedAt, path })
  }
  return { entries, folderPathById, usedPaths }
}

export function zipFilePath(entries: ZipEntry[], folderPathById: Map<string, string>, root: FolderRecord, file: FileRecord, usedPaths = new Set(entries.map((entry) => entry.path))): string {
  const folderPath = folderPathById.get(file.folderId) ?? safeZipSegment(root.name, 'Folder')
  return uniqueZipPath(`${folderPath}/${safeZipSegment(file.name, 'file')}`, usedPaths)
}

export function compareZipFiles(a: FileRecord, b: FileRecord): number {
  return a.folderId.localeCompare(b.folderId) || compareFilesForDisplay(a, b)
}

export function safeDownloadName(name: string): string {
  const cleaned = safeZipSegment(name, 'Folder').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned || 'Folder'
}

function orderedFolders(snapshot: StorageSnapshot, root: FolderRecord, folderIds: Set<string>): FolderRecord[] {
  const folders: FolderRecord[] = []
  function visit(folder: FolderRecord): void {
    folders.push(folder)
    for (const child of childFolders(snapshot, folder.id).filter((item) => folderIds.has(item.id))) visit(child)
  }
  visit(root)
  return folders
}

function safeZipSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[\\/\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback
  return cleaned
}

function uniqueZipPath(path: string, usedPaths: Set<string>): string {
  const directory = path.endsWith('/')
  const body = directory ? path.slice(0, -1) : path
  const slashIndex = body.lastIndexOf('/')
  const parent = slashIndex >= 0 ? body.slice(0, slashIndex + 1) : ''
  const name = slashIndex >= 0 ? body.slice(slashIndex + 1) : body
  const dotIndex = directory ? -1 : name.lastIndexOf('.')
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name
  const extension = dotIndex > 0 ? name.slice(dotIndex) : ''
  let candidate = path
  for (let index = 2; usedPaths.has(candidate); index += 1) {
    candidate = `${parent}${base} (${index})${extension}${directory ? '/' : ''}`
  }
  usedPaths.add(candidate)
  return candidate
}
