import type { FileRecord, FolderRecord, StorageSnapshot } from '../storage/domain.js'
import { stampFilePatch, mergeFolders, mergeFiles, normalizeFolderVersions, normalizeFileVersions } from '../storage/crdt.js'
import { canApplyFileCid, compareFilesForDisplay } from '../storage/domain.js'

export function foldersForSync(snapshot: StorageSnapshot, folderId: string): FolderRecord[] {
  const ids = descendantFolderIds(snapshot.folders, folderId)
  const history = snapshot.scopeTombstones?.find((scope) => scope.scopeId === folderId)?.folders ?? []
  const current = snapshot.folders.filter((folder) => ids.has(folder.id))
    .map((f) => normalizeFolderVersions(f, snapshot.originNode))
  const exits = history.filter((f) => !returnedToScope(snapshot, ids, f.id, f.deletedAt))
    .map((f) => normalizeFolderVersions(f, snapshot.originNode))
  // A scope projection keeps former parent placement, including parents outside the projection.
  return mergeFolders(current, exits, false)
    .sort((a, b) => folderSortKey(a).localeCompare(folderSortKey(b)) || a.id.localeCompare(b.id))
}

export function folderFilesForSync(snapshot: StorageSnapshot, folderId: string): FileRecord[] {
  const ids = descendantFolderIds(snapshot.folders, folderId)
  const history = snapshot.scopeTombstones?.find((scope) => scope.scopeId === folderId)?.files ?? []
  const current = snapshot.files.filter((file) => ids.has(file.folderId))
    .map((f) => normalizeFileVersions(f, snapshot.originNode))
  const exits = history.filter((f) => {
    const record = snapshot.files.find((item) => item.id === f.id)
    return !record || !returnedToScope(snapshot, ids, record.folderId, f.deletedAt, record.fieldVersions?.folderId?.updatedAt)
  }).map((f) => normalizeFileVersions(f, snapshot.originNode))
  return mergeFiles(current, exits)
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

export function shouldDeferRemoteFolderStateImport(options: {
  folder: FolderRecord | undefined
  snapshot: StorageSnapshot
}): boolean {
  if (!options.folder) return false
  return hasSharedFolderChangesSinceLastShare(options.snapshot, options.folder)
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
    sharedRoomId: folder.sharedRoomId ?? '',
    ...(folder.escrow && { escrow: folder.escrow, escrowVersion: folder.fieldVersions?.escrow }),
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
    lastCid: file.lastCid ?? '',
    version: file.version,
    starred: file.starred,
    deletedAt: file.deletedAt ?? '',
  }
}

// Apply only the uploaded reference to a current, still matching content revision.
export function applyStoredFileCids(snapshot: StorageSnapshot, stored: FileRecord[], now: string, nodeId: string): StorageSnapshot {
  const uploads = new Map(stored.map((f) => [f.id, f]))
  return { ...snapshot, files: snapshot.files.map((file) => {
    const upload = uploads.get(file.id)
    return upload?.lastCid && canApplyFileCid(file, upload)
      ? stampFilePatch(file, { lastCid: upload.lastCid }, now, nodeId) : file
  }) }
}

// A later move back into this share supersedes its former source-scope exit.
function returnedToScope(snapshot: StorageSnapshot, ids: Set<string>, folderId: string, removedAt?: string, fileMoveAt?: string): boolean {
  if (!ids.has(folderId) || !removedAt) return false
  if (fileMoveAt && fileMoveAt > removedAt) return true
  const seen = new Set<string>()
  let id: string | null = folderId
  while (id && !seen.has(id)) {
    seen.add(id)
    const folder = snapshot.folders.find((f) => f.id === id)
    if (!folder || !folder.parentId || !ids.has(folder.parentId)) break
    if ((folder.fieldVersions?.parentId?.updatedAt ?? folder.updatedAt) > removedAt) return true
    id = folder.parentId
  }
  return false
}
