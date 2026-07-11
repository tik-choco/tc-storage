import { compactSnapshotTombstones, createInitialSnapshot, dropAllTombstones, stripSnapshotFileContent, type StorageSnapshot } from './domain.js'
import { debugInfo, debugWarn } from '../util/logging.js'

type JsonStorage = Pick<Storage, 'getItem' | 'setItem'>

const snapshotKey = 'tc-storage-snapshot-v1'
// Local-persistence-only fallback; the in-memory snapshot keeps its full activity log.
const trimmedActivityCount = 10
let lastPersistSummary = ''

export function loadStoredSnapshot(nodeId: string, storage: JsonStorage = localStorage, now: number = Date.now()): StorageSnapshot {
  try {
    const parsed = JSON.parse(storage.getItem(snapshotKey) ?? '') as StorageSnapshot
    if (Array.isArray(parsed.folders) && Array.isArray(parsed.files)) {
      const compacted = compactSnapshotTombstones(parsed, now)
      const droppedCount = parsed.folders.length - compacted.folders.length + (parsed.files.length - compacted.files.length)
      debugInfo('local-snapshot', 'snapshot loaded', snapshotSummary(compacted))
      if (droppedCount > 0) debugInfo('local-snapshot', 'stale tombstones compacted from stored snapshot', { droppedCount })
      return compacted
    }
  } catch (error) {
    debugWarn('local-snapshot', 'snapshot load failed; using initial snapshot', { error: error instanceof Error ? error.message : String(error) })
    // Fall through to a seeded workspace.
  }
  const initial = createInitialSnapshot(nodeId)
  debugInfo('local-snapshot', 'initial snapshot created', snapshotSummary(initial))
  return initial
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
  // (and its tombstones) is untouched, so sync/merge still works; only local persistence loses them.
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
