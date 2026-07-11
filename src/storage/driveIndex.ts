import { activeFiles, folderPath, type FolderRecord, type StorageSnapshot } from './domain.js'

/** Shared-bus topic this app publishes its file index to. See
 * docs/data-contracts/docs/SHARED_BUS.md for the full contract. */
export const driveIndexTopic = 'drive-index'

export interface DriveIndexEntry {
  id: string
  name: string
  mimeType: string
  size: number
  lastCid: string
  path: string
  passphrase: string
}

export interface DriveIndexMeta {
  version: 1
  updatedAt: string
  files: DriveIndexEntry[]
}

/** Resolves the decryption key for a folder: its own key if set, else the
 * nearest non-deleted ancestor's key. Mirrors the ancestor-walk in
 * `nearestSharedAncestorFolder` (src/app/appUtils.ts), but keyed on key
 * presence rather than the P2P `shareEnabled` flag. */
function resolveFolderPassphrase(snapshot: StorageSnapshot, folderKeys: Record<string, string>, folderId: string): string | undefined {
  const foldersById = new Map(snapshot.folders.map((folder) => [folder.id, folder]))
  const visited = new Set<string>()
  let current: FolderRecord | undefined = foldersById.get(folderId)
  while (current) {
    if (visited.has(current.id)) return undefined
    visited.add(current.id)
    if (!current.deletedAt && folderKeys[current.id]) return folderKeys[current.id]
    current = current.parentId ? foldersById.get(current.parentId) : undefined
  }
  return undefined
}

/** Builds the `drive-index` payload: every non-deleted file that has a
 * content cid and a resolvable decryption key (own folder's key, else
 * nearest ancestor folder's key). Per-file share keys are intentionally not
 * consulted here. */
export function buildDriveIndex(snapshot: StorageSnapshot, folderKeys: Record<string, string>, now: string = new Date().toISOString()): DriveIndexMeta {
  const files: DriveIndexEntry[] = []
  for (const file of activeFiles(snapshot)) {
    if (!file.lastCid) continue
    const passphrase = resolveFolderPassphrase(snapshot, folderKeys, file.folderId)
    if (!passphrase) continue
    files.push({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      lastCid: file.lastCid,
      path: folderPath(snapshot, file.folderId).map((folder) => folder.name).join('/'),
      passphrase,
    })
  }
  return { version: 1, updatedAt: now, files }
}
