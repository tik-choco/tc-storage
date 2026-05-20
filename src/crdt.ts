import type { ActivityEntry, FileRecord, FolderRecord, StorageSnapshot, VersionStamp } from './domain.js'

const baselineTimestamp = '1970-01-01T00:00:00.000Z'
const folderFields = [
  'name',
  'parentId',
  'sortOrder',
  'color',
  'encrypted',
  'shareEnabled',
  'sharedRoomId',
  'lastCid',
  'lastSavedAt',
  'lastSharedAt',
  'deletedAt',
] as const
const fileFields = [
  'folderId',
  'sortOrder',
  'name',
  'mimeType',
  'size',
  'checksum',
  'version',
  'starred',
  'lastCid',
  'lastShareCid',
  'deletedAt',
] as const

type FolderField = (typeof folderFields)[number]
type FileField = (typeof fileFields)[number]

export function stampFolderPatch(
  folder: FolderRecord,
  patch: Partial<FolderRecord>,
  updatedAt: string,
  nodeId: string,
): FolderRecord {
  const touched = Object.keys(patch).filter(isFolderField)
  const fieldVersions = { ...normalizeFolderVersions(folder).fieldVersions }
  for (const field of touched) fieldVersions[field] = { updatedAt, nodeId }
  return { ...folder, ...patch, fieldVersions, updatedAt }
}

export function stampFilePatch(
  file: FileRecord,
  patch: Partial<FileRecord>,
  updatedAt: string,
  nodeId: string,
): FileRecord {
  const touched = Object.keys(patch).filter(isFileField)
  const fieldVersions = { ...normalizeFileVersions(file).fieldVersions }
  for (const field of touched) fieldVersions[field] = { updatedAt, nodeId }
  return { ...file, ...patch, fieldVersions, updatedAt }
}

export function mergeSnapshots(local: StorageSnapshot, remote: StorageSnapshot): StorageSnapshot {
  const localSnapshot = normalizeSnapshot(local)
  const remoteSnapshot = normalizeSnapshot(remote)
  return {
    folders: mergeFolders(localSnapshot.folders, remoteSnapshot.folders),
    files: mergeFiles(localSnapshot.files, remoteSnapshot.files),
    activity: mergeActivity(localSnapshot.activity, remoteSnapshot.activity),
    clock: Math.max(localSnapshot.clock, remoteSnapshot.clock) + 1,
    originNode: localSnapshot.originNode,
  }
}

export function normalizeSnapshot(snapshot: StorageSnapshot): StorageSnapshot {
  const originNode = snapshot.originNode || 'local'
  return {
    ...snapshot,
    originNode,
    folders: (snapshot.folders ?? []).map((folder) => normalizeFolderVersions(folder, originNode)),
    files: (snapshot.files ?? []).map((file) => normalizeFileVersions(file, originNode)),
    activity: snapshot.activity ?? [],
    clock: snapshot.clock ?? 0,
  }
}

export function mergeFolders(local: FolderRecord[], remote: FolderRecord[]): FolderRecord[] {
  const map = new Map<string, FolderRecord>()
  for (const folder of [...local, ...remote]) {
    const existing = map.get(folder.id)
    map.set(folder.id, existing ? mergeFolder(existing, folder) : normalizeFolderVersions(folder))
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export function mergeFiles(local: FileRecord[], remote: FileRecord[]): FileRecord[] {
  const map = new Map<string, FileRecord>()
  for (const file of [...local, ...remote]) {
    const existing = map.get(file.id)
    map.set(file.id, existing ? mergeFile(existing, file) : normalizeFileVersions(file))
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export function normalizeFolderVersions(folder: FolderRecord, fallbackNodeId = 'local'): FolderRecord {
  const hasVersions = Boolean(folder.fieldVersions)
  const fieldVersions = { ...(folder.fieldVersions ?? {}) }
  for (const field of folderFields) {
    if (!fieldVersions[field]) {
      fieldVersions[field] = {
        updatedAt: hasVersions ? baselineTimestamp : folder.updatedAt,
        nodeId: fallbackNodeId,
      }
    }
  }
  return { ...folder, fieldVersions }
}

export function normalizeFileVersions(file: FileRecord, fallbackNodeId = 'local'): FileRecord {
  const hasVersions = Boolean(file.fieldVersions)
  const fieldVersions = { ...(file.fieldVersions ?? {}) }
  for (const field of fileFields) {
    if (!fieldVersions[field]) {
      fieldVersions[field] = {
        updatedAt: hasVersions ? baselineTimestamp : file.updatedAt,
        nodeId: fallbackNodeId,
      }
    }
  }
  return { ...file, fieldVersions }
}

export function compareStamp(a: VersionStamp, b: VersionStamp): number {
  const time = a.updatedAt.localeCompare(b.updatedAt)
  if (time !== 0) return time
  return a.nodeId.localeCompare(b.nodeId)
}

function mergeFolder(local: FolderRecord, remote: FolderRecord): FolderRecord {
  const left = normalizeFolderVersions(local)
  const right = normalizeFolderVersions(remote)
  const merged: FolderRecord = { ...left }
  const fieldVersions = { ...left.fieldVersions }

  for (const field of folderFields) {
    const localStamp = left.fieldVersions?.[field]
    const remoteStamp = right.fieldVersions?.[field]
    if (remoteStamp && (!localStamp || compareStamp(remoteStamp, localStamp) > 0)) {
      ;(merged as unknown as Record<string, unknown>)[field] = right[field]
      fieldVersions[field] = remoteStamp
    }
  }

  return { ...merged, fieldVersions, updatedAt: maxTimestamp(left.updatedAt, right.updatedAt) }
}

function mergeFile(local: FileRecord, remote: FileRecord): FileRecord {
  const left = normalizeFileVersions(local)
  const right = normalizeFileVersions(remote)
  const merged: FileRecord = { ...left }
  const fieldVersions = { ...left.fieldVersions }

  for (const field of fileFields) {
    const localStamp = left.fieldVersions?.[field]
    const remoteStamp = right.fieldVersions?.[field]
    if (remoteStamp && (!localStamp || compareStamp(remoteStamp, localStamp) > 0)) {
      ;(merged as unknown as Record<string, unknown>)[field] = right[field]
      fieldVersions[field] = remoteStamp
    }
  }

  return { ...merged, fieldVersions, updatedAt: maxTimestamp(left.updatedAt, right.updatedAt) }
}

function mergeActivity(local: ActivityEntry[], remote: ActivityEntry[]): ActivityEntry[] {
  const map = new Map<string, ActivityEntry>()
  for (const entry of [...local, ...remote]) map.set(entry.id, entry)
  return [...map.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80)
}

function maxTimestamp(a: string, b: string): string {
  return a >= b ? a : b
}

function isFolderField(field: string): field is FolderField {
  return folderFields.includes(field as FolderField)
}

function isFileField(field: string): field is FileField {
  return fileFields.includes(field as FileField)
}
