import { createInitialSnapshot, stripSnapshotFileContent, type StorageSnapshot } from './domain.js'
import { debugInfo, debugWarn } from './logging.js'

const snapshotKey = 'tc-storage-snapshot-v1'
let lastPersistSummary = ''

export function loadStoredSnapshot(nodeId: string): StorageSnapshot {
  try {
    const parsed = JSON.parse(localStorage.getItem(snapshotKey) ?? '') as StorageSnapshot
    if (Array.isArray(parsed.folders) && Array.isArray(parsed.files)) {
      debugInfo('local-snapshot', 'snapshot loaded', snapshotSummary(parsed))
      return parsed
    }
  } catch (error) {
    debugWarn('local-snapshot', 'snapshot load failed; using initial snapshot', { error: error instanceof Error ? error.message : String(error) })
    // Fall through to a seeded workspace.
  }
  const initial = createInitialSnapshot(nodeId)
  debugInfo('local-snapshot', 'initial snapshot created', snapshotSummary(initial))
  return initial
}

export function persistSnapshot(snapshot: StorageSnapshot): void {
  const stripped = stripSnapshotFileContent(snapshot)
  localStorage.setItem(snapshotKey, JSON.stringify(stripped))
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
