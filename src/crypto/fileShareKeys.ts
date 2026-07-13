import { generateFolderKey } from './folderKeys.js'
import { normalizeStringRecord } from '../storage/storageRecords.js'
import { debugWarn } from '../util/logging.js'

const fileShareKeysStorageKey = 'tc-storage-file-share-keys-v1'

export function loadFileShareKeys(): Record<string, string> {
  try {
    return normalizeStringRecord(JSON.parse(localStorage.getItem(fileShareKeysStorageKey) ?? '{}') as unknown)
  } catch {
    return {}
  }
}

/** Drops entries for files that no longer exist in the snapshot at all
 * (fully removed, past tombstone retention) so this key doesn't grow without
 * bound. Deleted-but-still-present (tombstoned) files keep their key. */
export function pruneFileShareKeys(keys: Record<string, string>, existingFileIds: Iterable<string>): Record<string, string> {
  const idSet = new Set(existingFileIds)
  const pruned: Record<string, string> = {}
  for (const [fileId, key] of Object.entries(keys)) {
    if (idSet.has(fileId)) pruned[fileId] = key
  }
  return pruned
}

/** Persists per-file share keys, optionally pruning entries for files no
 * longer in the snapshot (pass `existingFileIds` from the caller's
 * snapshot). Never throws; returns false (and logs) if the write fails, e.g.
 * because the storage quota is exhausted. */
export function saveFileShareKeys(keys: Record<string, string>, existingFileIds?: Iterable<string>): boolean {
  const normalized = normalizeStringRecord(keys)
  const pruned = existingFileIds ? pruneFileShareKeys(normalized, existingFileIds) : normalized
  try {
    localStorage.setItem(fileShareKeysStorageKey, JSON.stringify(pruned))
    return true
  } catch (error) {
    debugWarn('file-share-keys', 'failed to persist file share keys', { error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

export function generateFileShareKey(): string {
  return generateFolderKey()
}
