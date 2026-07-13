import type { FolderRecord } from '../storage/domain.js'
import { bytesToBase64 } from './cryptoEncoding.js'
import { normalizeStringRecord } from '../storage/storageRecords.js'
import { debugWarn } from '../util/logging.js'

const folderKeysStorageKey = 'tc-storage-folder-keys-v1'

export function loadFolderKeys(): Record<string, string> {
  try {
    return normalizeStringRecord(JSON.parse(localStorage.getItem(folderKeysStorageKey) ?? '{}') as unknown)
  } catch {
    return {}
  }
}

/** Drops entries for folders that no longer exist in the snapshot at all
 * (fully removed, past tombstone retention) so this key doesn't grow without
 * bound. Deleted-but-still-present (tombstoned) folders keep their key. */
export function pruneFolderKeys(keys: Record<string, string>, existingFolderIds: Iterable<string>): Record<string, string> {
  const idSet = new Set(existingFolderIds)
  const pruned: Record<string, string> = {}
  for (const [folderId, key] of Object.entries(keys)) {
    if (idSet.has(folderId)) pruned[folderId] = key
  }
  return pruned
}

/** Persists folder decryption keys, optionally pruning entries for folders no
 * longer in the snapshot (pass `existingFolderIds` from the caller's
 * snapshot). Never throws; returns false (and logs) if the write fails, e.g.
 * because the storage quota is exhausted. */
export function saveFolderKeys(keys: Record<string, string>, existingFolderIds?: Iterable<string>): boolean {
  const normalized = normalizeStringRecord(keys)
  const pruned = existingFolderIds ? pruneFolderKeys(normalized, existingFolderIds) : normalized
  try {
    localStorage.setItem(folderKeysStorageKey, JSON.stringify(pruned))
    return true
  } catch (error) {
    debugWarn('folder-keys', 'failed to persist folder keys', { error: error instanceof Error ? error.message : String(error) })
    return false
  }
}

export function ensureFolderKeys(folders: FolderRecord[], current: Record<string, string>): Record<string, string> {
  let changed = false
  const next = { ...current }
  for (const folder of folders) {
    if (!folder.deletedAt && !next[folder.id]) {
      next[folder.id] = generateFolderKey()
      changed = true
    }
  }
  return changed ? next : current
}

export function generateFolderKey(): string {
  const bytes = new Uint8Array(24)
  const cryptoApi = globalThis.crypto
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('暗号キー生成に必要な安全な乱数生成が利用できません')
  }
  cryptoApi.getRandomValues(bytes)
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
