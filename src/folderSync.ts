import type { FileRecord, FolderRecord, StorageSnapshot } from './domain.js'
import { compareFilesForDisplay } from './domain.js'

export function foldersForSync(snapshot: StorageSnapshot, folderId: string): FolderRecord[] {
  const ids = descendantFolderIds(snapshot.folders, folderId)
  return snapshot.folders
    .filter((folder) => ids.has(folder.id))
    .sort((a, b) => folderSortKey(a).localeCompare(folderSortKey(b)) || a.id.localeCompare(b.id))
}

export function folderFilesForSync(snapshot: StorageSnapshot, folderId: string): FileRecord[] {
  const ids = descendantFolderIds(snapshot.folders, folderId)
  return snapshot.files
    .filter((file) => ids.has(file.folderId))
    .sort((a, b) => a.folderId.localeCompare(b.folderId) || compareFilesForDisplay(a, b))
}

export function sharedFolderSignature(snapshot: StorageSnapshot, folderId: string): string {
  const folder = snapshot.folders.find((item) => item.id === folderId)
  if (!folder) return ''
  return JSON.stringify({
    folders: foldersForSync(snapshot, folderId).map(pickFolderSyncFields),
    files: folderFilesForSync(snapshot, folderId).map(pickFileSyncFields),
  })
}

export function hasSharedFolderChangesSinceLastShare(snapshot: StorageSnapshot, folder: FolderRecord): boolean {
  if (!folder.lastCid || !folder.lastSharedAt) return true
  return sharedFolderContentUpdatedAt(snapshot, folder.id) > folder.lastSharedAt
}

export function canAutoImportFolderShare(options: {
  folder: FolderRecord | undefined
  incomingCid: string | undefined
  passphrase: string | undefined
}): boolean {
  if (!options.folder || !options.incomingCid || !options.passphrase) return false
  return options.folder.lastCid !== options.incomingCid
}

export function canAutoImportFolderState(options: {
  folder: FolderRecord | undefined
  incomingCid: string | undefined
  incomingSignature: string | undefined
  localSignature: string
  passphrase: string | undefined
}): boolean {
  if (!canAutoImportFolderShare(options)) return false
  return Boolean(options.incomingSignature && options.incomingSignature !== options.localSignature)
}

function sharedFolderContentUpdatedAt(snapshot: StorageSnapshot, folderId: string): string {
  const updatedAtValues = [
    ...foldersForSync(snapshot, folderId).map((folder) => folder.updatedAt),
    ...folderFilesForSync(snapshot, folderId).map((file) => file.updatedAt),
  ]
  return updatedAtValues.reduce((latest, value) => (value > latest ? value : latest), '')
}

function descendantFolderIds(folders: FolderRecord[], folderId: string): Set<string> {
  const ids = new Set([folderId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }
  return ids
}

function folderSortKey(folder: FolderRecord): string {
  return `${folder.parentId ?? ''}/${String(folder.sortOrder ?? 0).padStart(12, '0')}/${folder.name}`
}

function pickFolderSyncFields(folder: FolderRecord) {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    sortOrder: folder.sortOrder ?? 0,
    color: folder.color,
    encrypted: folder.encrypted,
    shareEnabled: folder.shareEnabled,
    deletedAt: folder.deletedAt ?? '',
  }
}

function pickFileSyncFields(file: FileRecord) {
  return {
    id: file.id,
    folderId: file.folderId,
    sortOrder: file.sortOrder ?? 0,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    checksum: file.checksum,
    version: file.version,
    starred: file.starred,
    deletedAt: file.deletedAt ?? '',
  }
}
