import { loadEncryptedFolderFromMist } from './mistStorage.js'
import type { FolderBundle } from './domain.js'
import type { SharedRecord } from './sharedBus.js'

/** Shared-bus topic any app can publish encrypted FolderBundle exports to.
 * See docs/data-contracts/docs/SHARED_BUS.md for the full contract. */
export const folderExportTopic = 'folder-export'

const legacyFolderImportCidStorageKey = 'tc-storage-travel-import-cid-v1'
const folderImportCidsStorageKey = 'tc-storage-folder-import-cids-v1'

export interface FolderExportMeta {
  folderId: string
  passphrase: string
}

type FolderImportCids = Record<string, string>

function readImportedFolderCids(): FolderImportCids {
  try {
    // One-time migration: the old single-cid guard predates the per-folder
    // map. Dropping it costs at most one redundant re-import, which the
    // per-field LWW merge makes harmless.
    if (localStorage.getItem(legacyFolderImportCidStorageKey) !== null) {
      localStorage.removeItem(legacyFolderImportCidStorageKey)
    }
    const parsed: unknown = JSON.parse(localStorage.getItem(folderImportCidsStorageKey) ?? '')
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as FolderImportCids : {}
  } catch {
    return {}
  }
}

function lastImportedFolderCid(folderId: string): string {
  return readImportedFolderCids()[folderId] ?? ''
}

export function rememberImportedFolderCid(folderId: string, cid: string): void {
  try {
    const cids = readImportedFolderCids()
    cids[folderId] = cid
    localStorage.setItem(folderImportCidsStorageKey, JSON.stringify(cids))
  } catch {
    // best-effort: a missed write only costs one redundant re-import later
  }
}

export function folderExportMeta(record: SharedRecord): FolderExportMeta | null {
  const folderId = record.meta.folderId
  const passphrase = record.meta.passphrase
  if (typeof folderId !== 'string' || !folderId) return null
  if (typeof passphrase !== 'string' || !passphrase) return null
  return { folderId, passphrase }
}

/** True when `record` carries a new cid for its folderId that hasn't been
 * imported yet. The per-field LWW merge makes re-imports harmless, so this
 * is an optimization, not a correctness requirement. */
export function shouldImportFolderRecord(record: SharedRecord | null, meta: FolderExportMeta | null): boolean {
  return Boolean(record && meta && record.cid && record.cid !== lastImportedFolderCid(meta.folderId))
}

export function loadImportedFolderBundle(cid: string, passphrase: string, nodeId: string): Promise<FolderBundle> {
  return loadEncryptedFolderFromMist(cid, passphrase, { nodeId })
}
