import { compactSnapshotTombstones, createInitialSnapshot, dropAllTombstones, stripSnapshotFileContent, type StorageSnapshot } from './domain.js'
import { mergeFolders, mergeFiles, normalizeSnapshot, normalizeFolderVersions, normalizeFileVersions } from './crdt.js'
import type { ActivityEntry, FileRecord, FolderRecord, VersionStamp } from './domain.js'
import { debugInfo, debugWarn } from '../util/logging.js'

type JsonStorage = Pick<Storage, 'getItem' | 'setItem'>

const snapshotKey = 'tc-storage-snapshot-v1'
// Local-persistence-only fallback; the in-memory snapshot keeps its full activity log.
const trimmedActivityCount = 10
let lastPersistSummary = ''

export interface StoredSnapshotLoadResult {
  snapshot: StorageSnapshot
  loadedFromStorage: boolean
}

export function loadStoredSnapshot(nodeId: string, storage: JsonStorage = localStorage, now: number = Date.now()): StoredSnapshotLoadResult {
  try {
    const parsed = migrateStoredSnapshot(JSON.parse(storage.getItem(snapshotKey) ?? ''), nodeId)
    if (parsed) {
      const compacted = compactSnapshotTombstones(parsed, now)
      const droppedCount = parsed.folders.length - compacted.folders.length + (parsed.files.length - compacted.files.length)
      debugInfo('local-snapshot', 'snapshot loaded', snapshotSummary(compacted))
      if (droppedCount > 0) debugInfo('local-snapshot', 'stale tombstones compacted from stored snapshot', { droppedCount })
      return { snapshot: compacted, loadedFromStorage: true }
    }
  } catch (error) {
    debugWarn('local-snapshot', 'snapshot load failed; using initial snapshot', { error: error instanceof Error ? error.message : String(error) })
    // Fall through to a seeded workspace.
  }
  const initial = createInitialSnapshot(nodeId)
  debugInfo('local-snapshot', 'initial snapshot created', snapshotSummary(initial))
  return { snapshot: initial, loadedFromStorage: false }
}

// Never throws. Returns false if the snapshot could not be persisted (e.g. storage quota
// exhausted by sibling apps sharing this origin), so the caller can surface a notice instead
// of crashing the render. fieldVersions are never pruned here since sync/merge relies on them.
// The serialized activity log is trimmed first; only as a final emergency measure are tombstoned
// (deletedAt) records dropped from the serialized copy, leaving the in-memory snapshot untouched.
export function persistSnapshot(snapshot: StorageSnapshot, storage: JsonStorage = localStorage): boolean {
  const stripped = stripSnapshotFileContent(snapshot)
  if (trySetItem(storage, stripped)) {
    logPersisted(snapshot)
    return true
  }
  const trimmed = { ...stripped, activity: stripped.activity.slice(0, trimmedActivityCount) }
  if (trySetItem(storage, trimmed)) {
    debugWarn('local-snapshot', 'snapshot persisted with trimmed activity after storage error', snapshotSummary(snapshot))
    logPersisted(snapshot)
    return true
  }
  // Last resort: drop tombstoned records from the serialized copy only. The in-memory snapshot
  // (and its tombstones) is untouched. Escrow-protected history is retained even in this copy.
  const tombstoneFree = dropAllTombstones(trimmed)
  if (trySetItem(storage, tombstoneFree)) {
    debugWarn('local-snapshot', 'tombstoned records dropped from local persistence due to quota exhaustion', snapshotSummary(snapshot))
    logPersisted(snapshot)
    return true
  }
  debugWarn('local-snapshot', 'snapshot persist failed; giving up', snapshotSummary(snapshot))
  return false
}

function trySetItem(storage: JsonStorage, snapshot: StorageSnapshot): boolean {
  try {
    storage.setItem(snapshotKey, JSON.stringify(snapshot))
    return true
  } catch (error) {
    debugWarn('local-snapshot', 'snapshot persist attempt failed', { error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

function logPersisted(snapshot: StorageSnapshot): void {
  const summary = snapshotSummary(snapshot)
  const serialized = JSON.stringify(summary)
  if (serialized === lastPersistSummary) return
  lastPersistSummary = serialized
  debugInfo('local-snapshot', 'snapshot persisted', summary)
}

function snapshotSummary(snapshot: StorageSnapshot): Record<string, unknown> {
  const filesWithDataUrl = snapshot.files.filter((file) => Boolean(file.dataUrl)).length
  return {
    folderCount: snapshot.folders.length,
    fileCount: snapshot.files.length,
    folderCidCount: snapshot.folders.filter((folder) => Boolean(folder.lastCid)).length,
    fileCidCount: snapshot.files.filter((file) => Boolean(file.lastCid)).length,
    fileShareCidCount: snapshot.files.filter((file) => Boolean(file.lastShareCid)).length,
    filesWithDataUrl,
    dataUrlsStrippedForStorage: filesWithDataUrl,
    clock: snapshot.clock,
    originNode: snapshot.originNode,
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const validDate = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

// Local storage is recoverable per record: malformed siblings must not erase the workspace.
export function migrateStoredSnapshot(value: unknown, nodeId: string): StorageSnapshot | undefined {
  if (!isObject(value) || !Array.isArray(value.folders) || !Array.isArray(value.files)) return undefined
  const originNode = nonempty(value.originNode) ? value.originNode : nodeId
  const folders = mergeFolders(value.folders.flatMap((v) => {
    const f = migrateRecord(v, true)
    return f ? [normalizeFolderVersions(f as FolderRecord, originNode)] : []
  }), [])
  const folderIds = new Set(folders.map((f) => f.id))
  const files = mergeFiles(value.files.flatMap((v) => {
    const f = migrateRecord(v, false)
    return f && !folderIds.has(f.id) ? [normalizeFileVersions(f as FileRecord, originNode)] : []
  }), [])
  const activity = Array.isArray(value.activity) ? value.activity.filter((v): v is ActivityEntry =>
    isObject(v) && nonempty(v.id) && nonempty(v.actorNodeId) && typeof v.action === 'string' &&
    typeof v.detail === 'string' && validDate(v.at) &&
    (v.folderId === undefined || nonempty(v.folderId)) && (v.fileId === undefined || nonempty(v.fileId))) : []
  const scopeTombstones = Array.isArray(value.scopeTombstones) ? value.scopeTombstones.flatMap((scope) => {
    if (!isObject(scope) || !nonempty(scope.scopeId) || !Array.isArray(scope.folders) || !Array.isArray(scope.files)) return []
    return [{ scopeId: scope.scopeId,
      // Keep former parent placement; it is resolved in the scope projection, not globally.
      folders: scope.folders.flatMap((v) => { const f = migrateRecord(v, true); return f?.deletedAt ? [normalizeFolderVersions(f as FolderRecord, originNode)] : [] }),
      files: scope.files.flatMap((v) => { const f = migrateRecord(v, false); return f?.deletedAt ? [normalizeFileVersions(f as FileRecord, originNode)] : [] }) }]
  }) : undefined
  return normalizeSnapshot({ folders, files, activity,
    clock: Number.isSafeInteger(value.clock) && (value.clock as number) >= 0 ? value.clock as number : 0,
    originNode,
    ...(scopeTombstones && { scopeTombstones }) })
}

function migrateRecord(value: unknown, folder: boolean): FolderRecord | FileRecord | undefined {
  if (!isObject(value) || !nonempty(value.id) || !nonempty(value.name)) return undefined
  const createdAt = value.createdAt ?? value.updatedAt
  const updatedAt = value.updatedAt ?? value.createdAt
  if (!validDate(createdAt) || !validDate(updatedAt) ||
      (value.deletedAt !== undefined && !validDate(value.deletedAt)) ||
      (value.sortOrder !== undefined && !finite(value.sortOrder))) return undefined
  const record: Record<string, unknown> = { id: value.id, name: value.name,
    createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(updatedAt).toISOString() }
  if (folder) {
    if (!(value.parentId === undefined || value.parentId === null || nonempty(value.parentId)) ||
        (value.color !== undefined && !['teal', 'blue', 'amber', 'rose', 'slate'].includes(value.color as string)) ||
        ['encrypted', 'shareEnabled'].some((key) => value[key] !== undefined && typeof value[key] !== 'boolean') ||
        (value.sharedRoomId !== undefined && typeof value.sharedRoomId !== 'string')) return undefined
    Object.assign(record, { parentId: value.parentId ?? null, color: value.color ?? 'teal',
      encrypted: value.encrypted ?? true, shareEnabled: value.shareEnabled ?? false })
    // Absent sharedRoomId uses the home-room legacy fallback at publication time.
    if (value.sharedRoomId !== undefined) record.sharedRoomId = value.sharedRoomId
    if (value.escrow !== undefined) {
      const e = value.escrow
      if (!isObject(e) || !['auto', 'custom', 'off'].includes(e.mode as string) ||
          (e.mode === 'custom' ? typeof e.room !== 'string' || !/^[A-Za-z0-9_./:-]{1,96}$/.test(e.room) : e.room !== '')) return undefined
      record.escrow = { mode: e.mode, room: e.room }
    }
    for (const key of ['lastSavedAt', 'lastSharedAt']) if (validDate(value[key])) record[key] = new Date(value[key]).toISOString()
  } else {
    if (!nonempty(value.folderId) || typeof value.mimeType !== 'string' ||
        !Number.isSafeInteger(value.size) || (value.size as number) < 0 ||
        typeof value.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(value.checksum) ||
        (value.version !== undefined && (!Number.isSafeInteger(value.version) || (value.version as number) < 1)) ||
        (value.starred !== undefined && typeof value.starred !== 'boolean') ||
        (value.dataUrl !== undefined && typeof value.dataUrl !== 'string')) return undefined
    Object.assign(record, { folderId: value.folderId, mimeType: value.mimeType || 'application/octet-stream',
      size: value.size, checksum: value.checksum, version: value.version ?? 1, starred: value.starred ?? false })
    if (value.dataUrl !== undefined) record.dataUrl = value.dataUrl
  }
  if (finite(value.sortOrder)) record.sortOrder = value.sortOrder
  if (validDate(value.deletedAt)) record.deletedAt = new Date(value.deletedAt).toISOString()
  for (const key of ['lastCid', ...(folder ? [] : ['lastShareCid'])]) if (nonempty(value[key])) record[key] = value[key]
  if (isObject(value.fieldVersions)) {
    const versions: Record<string, VersionStamp> = {}
    // Include absent optional field stamps: they carry explicit CRDT clears.
    const allowed = new Set([...Object.keys(record), 'sortOrder', 'deletedAt', 'lastCid', ...(folder
      ? ['sharedRoomId', 'escrow', 'lastSavedAt', 'lastSharedAt'] : ['lastShareCid', 'dataUrl'])])
    for (const [key, stamp] of Object.entries(value.fieldVersions)) if (allowed.has(key) && isObject(stamp) && validDate(stamp.updatedAt) && nonempty(stamp.nodeId)) {
      versions[key] = { updatedAt: new Date(stamp.updatedAt).toISOString(), nodeId: stamp.nodeId }
    }
    record.fieldVersions = versions
  }
  return record as FolderRecord | FileRecord
}
