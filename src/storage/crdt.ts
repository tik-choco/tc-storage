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
    clock: Math.max(localSnapshot.clock, remoteSnapshot.clock),
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
  return repairFolderHierarchy([...map.values()]).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
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
      assignMergedField(merged, field, right[field])
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
      assignMergedField(merged, field, right[field])
      fieldVersions[field] = remoteStamp
    }
  }

  return { ...merged, fieldVersions, updatedAt: maxTimestamp(left.updatedAt, right.updatedAt) }
}

function mergeActivity(local: ActivityEntry[], remote: ActivityEntry[]): ActivityEntry[] {
  const map = new Map<string, ActivityEntry>()
  for (const entry of [...local, ...remote]) {
    const existing = map.get(entry.id)
    map.set(entry.id, existing && compareActivityEntry(existing, entry) >= 0 ? existing : entry)
  }
  return [...map.values()].sort(compareActivityForDisplay).slice(0, 80)
}

function repairFolderHierarchy(folders: FolderRecord[]): FolderRecord[] {
  const repaired = new Map(folders.map((folder) => [folder.id, folder]))
  const detached = new Set<string>()

  for (const folder of folders.toSorted((a, b) => a.id.localeCompare(b.id))) {
    const seen = new Map<string, number>()
    const path: string[] = []
    let currentId: string | undefined = folder.id

    while (currentId) {
      const index = seen.get(currentId)
      if (index !== undefined) {
        detachCycle(path.slice(index), repaired, detached)
        break
      }
      const current = repaired.get(currentId)
      if (!current) break
      seen.set(currentId, path.length)
      path.push(currentId)
      const parentId = current.parentId ?? undefined
      if (!parentId) break
      if (parentId === current.id || !repaired.has(parentId)) {
        detachFolder(current.id, repaired, detached)
        break
      }
      currentId = parentId
    }
  }

  return folders.map((folder) => repaired.get(folder.id) ?? folder)
}

function detachCycle(cycleIds: string[], repaired: Map<string, FolderRecord>, detached: Set<string>): void {
  const breakerId = cycleIds.toSorted()[0]
  if (breakerId) detachFolder(breakerId, repaired, detached)
}

function detachFolder(folderId: string, repaired: Map<string, FolderRecord>, detached: Set<string>): void {
  if (detached.has(folderId)) return
  const folder = repaired.get(folderId)
  if (!folder || folder.parentId === null) return
  repaired.set(folderId, { ...folder, parentId: null })
  detached.add(folderId)
}

function assignMergedField(record: FolderRecord | FileRecord, field: string, value: unknown): void {
  const writable = record as unknown as Record<string, unknown>
  if (value === undefined) delete writable[field]
  else writable[field] = value
}

function compareActivityForDisplay(a: ActivityEntry, b: ActivityEntry): number {
  return b.at.localeCompare(a.at) || a.id.localeCompare(b.id)
}

function compareActivityEntry(a: ActivityEntry, b: ActivityEntry): number {
  const time = a.at.localeCompare(b.at)
  if (time !== 0) return time
  return activityEntryKey(a).localeCompare(activityEntryKey(b))
}

function activityEntryKey(entry: ActivityEntry): string {
  return JSON.stringify([
    entry.id,
    entry.actorNodeId,
    entry.action,
    entry.detail,
    entry.folderId ?? '',
    entry.fileId ?? '',
  ])
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
