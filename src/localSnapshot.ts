import { createInitialSnapshot, stripSnapshotFileContent, type StorageSnapshot } from './domain.js'

const snapshotKey = 'tc-storage-snapshot-v1'

export function loadStoredSnapshot(nodeId: string): StorageSnapshot {
  try {
    const parsed = JSON.parse(localStorage.getItem(snapshotKey) ?? '') as StorageSnapshot
    if (Array.isArray(parsed.folders) && Array.isArray(parsed.files)) return parsed
  } catch {
    // Fall through to a seeded workspace.
  }
  return createInitialSnapshot(nodeId)
}

export function persistSnapshot(snapshot: StorageSnapshot): void {
  localStorage.setItem(snapshotKey, JSON.stringify(stripSnapshotFileContent(snapshot)))
}
