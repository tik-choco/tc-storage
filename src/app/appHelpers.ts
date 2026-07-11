import type { BrowserSortMode, PendingShare } from './appTypes.js'
import { stampFilePatch, stampFolderPatch } from '../storage/crdt.js'
import { compareFilesForDisplay, compareFoldersForDisplay, stripFileContent, type FileBundle, type FileRecord, type FolderBundle, type FolderRecord, type StorageSnapshot } from '../storage/domain.js'

export function mergeUploadedFiles(currentFiles: FileRecord[], uploaded: FileRecord[], now: string, nodeId: string): FileRecord[] {
  let filesNext = [...currentFiles]
  for (const file of latestFilesByIdentity(uploaded)) {
    const index = filesNext.findIndex((item) => sameFileIdentity(item, file) && !item.deletedAt)
    const existing = filesNext[index]
    filesNext = index >= 0 && existing
      ? filesNext.with(index, stampFilePatch(existing, { name: file.name, mimeType: file.mimeType, size: file.size, dataUrl: file.dataUrl, checksum: file.checksum, lastCid: file.lastCid, version: existing.version + 1 }, now, nodeId))
      : [...filesNext, file]
  }
  return filesNext
}

export function latestFilesByIdentity(files: FileRecord[]): FileRecord[] {
  return [...files.reduce((map, file) => map.set(fileIdentityKey(file), file), new Map<string, FileRecord>()).values()]
}

export function sameFileIdentity(left: Pick<FileRecord, 'id' | 'lastCid'>, right: Pick<FileRecord, 'id' | 'lastCid'>): boolean {
  return fileIdentityKey(left) === fileIdentityKey(right)
}

export function fileIdentityKey(file: Pick<FileRecord, 'id' | 'lastCid'>): string {
  return file.lastCid ? `cid:${file.lastCid}` : `id:${file.id}`
}

export function remoteFolderSnapshot(bundle: FolderBundle, share: PendingShare, options: { preserveRootFolder?: FolderRecord } = {}): StorageSnapshot {
  const sharedAt = share.sentAt || bundle.exportedAt
  const contentPatch: Partial<FolderRecord> = { lastCid: share.cid, lastSavedAt: bundle.exportedAt }
  const sharePatch: Partial<FolderRecord> = { shareEnabled: true, sharedRoomId: share.roomId, lastSharedAt: sharedAt }
  if (!options.preserveRootFolder) sharePatch.parentId = null
  const rootFolder = stampFolderPatch(
    stampFolderPatch(bundle.folder, contentPatch, bundle.exportedAt, bundle.originNode),
    sharePatch,
    sharedAt,
    bundle.originNode,
  )
  const preservedRootFolder = options.preserveRootFolder
    ? preserveRootFolderParent(rootFolder, options.preserveRootFolder)
    : rootFolder
  const bundledFolders = bundle.folders?.length ? bundle.folders : [bundle.folder]
  const folders = [
    preservedRootFolder,
    ...bundledFolders.filter((folder) => folder.id !== preservedRootFolder.id),
  ]
  return {
    folders,
    files: bundle.files.map(stripFileContent),
    activity: [{ id: `remote-${share.cid}`, actorNodeId: bundle.originNode, folderId: bundle.folder.id, action: 'folder.import', detail: `${bundle.folder.name} を共有から取り込み`, at: bundle.exportedAt }],
    clock: share.clock,
    originNode: bundle.originNode,
  }
}

function preserveRootFolderParent(rootFolder: FolderRecord, localFolder: FolderRecord): FolderRecord {
  const fieldVersions: NonNullable<FolderRecord['fieldVersions']> = { ...rootFolder.fieldVersions }
  const localParentVersion = localFolder.fieldVersions?.parentId
  if (localParentVersion) fieldVersions.parentId = localParentVersion
  return { ...rootFolder, parentId: localFolder.parentId, fieldVersions }
}

/** Like `remoteFolderSnapshot` but for a one-off `folder-export` shared-bus
 * import: no PendingShare/roomId involved, and the folder is not marked as
 * P2P-shared (shareEnabled/sharedRoomId are left as the bundle exported them). */
export function remoteImportedFolderSnapshot(bundle: FolderBundle, cid: string): StorageSnapshot {
  const contentPatch: Partial<FolderRecord> = { lastCid: cid, lastSavedAt: bundle.exportedAt }
  const rootFolder = stampFolderPatch(bundle.folder, contentPatch, bundle.exportedAt, bundle.originNode)
  const bundledFolders = bundle.folders?.length ? bundle.folders : [bundle.folder]
  const folders = [rootFolder, ...bundledFolders.filter((folder) => folder.id !== rootFolder.id)]
  return {
    folders,
    files: bundle.files.map(stripFileContent),
    activity: [{ id: `remote-import-${cid}`, actorNodeId: bundle.originNode, folderId: bundle.folder.id, action: 'folder-import', detail: `${bundle.folder.name} をフォルダエクスポートから取り込み`, at: bundle.exportedAt }],
    clock: 0,
    originNode: bundle.originNode,
  }
}

export function remoteFileSnapshot(bundle: FileBundle, share: PendingShare): StorageSnapshot {
  const sharedAt = share.sentAt || bundle.exportedAt
  const file = share.cid
    ? stampFilePatch(bundle.file, { lastShareCid: share.cid }, sharedAt, bundle.originNode)
    : bundle.file
  return {
    folders: [bundle.folder],
    files: [stripFileContent(file)],
    activity: [{ id: `remote-${share.cid}`, actorNodeId: bundle.originNode, fileId: bundle.file.id, folderId: bundle.folder.id, action: 'file.import', detail: `${bundle.file.name} を共有から取り込み`, at: bundle.exportedAt }],
    clock: share.clock,
    originNode: bundle.originNode,
  }
}

export function filterByName<T extends { name: string }>(items: T[], query: string): T[] {
  const normalized = query.toLowerCase()
  return items.filter((item) => item.name.toLowerCase().includes(normalized))
}

export function sortBrowserFolders(folders: FolderRecord[], sortMode: BrowserSortMode): FolderRecord[] {
  const rows = [...folders]
  if (sortMode === 'manual') return rows
  return rows.sort((left, right) => compareFoldersByMode(left, right, sortMode))
}

export function sortBrowserFiles(files: FileRecord[], sortMode: BrowserSortMode): FileRecord[] {
  const rows = [...files]
  if (sortMode === 'manual') return rows
  return rows.sort((left, right) => compareFilesByMode(left, right, sortMode))
}

export function descendantFolderIds(folders: FolderRecord[], folderId: string): Set<string> {
  const ids = new Set([folderId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }
  return ids
}

export function nextFolderName(existingNames: Set<string>): string {
  const base = 'New folder'
  if (!existingNames.has(base)) return base
  for (let index = 2; ; index += 1) {
    const name = `${base} ${index}`
    if (!existingNames.has(name)) return name
  }
}

function compareFoldersByMode(left: FolderRecord, right: FolderRecord, sortMode: BrowserSortMode): number {
  if (sortMode === 'name-asc') return compareNames(left, right) || compareFoldersForDisplay(left, right)
  if (sortMode === 'name-desc') return compareNames(right, left) || compareFoldersForDisplay(left, right)
  if (sortMode === 'updated-desc') return right.updatedAt.localeCompare(left.updatedAt) || compareFoldersForDisplay(left, right)
  if (sortMode === 'updated-asc') return left.updatedAt.localeCompare(right.updatedAt) || compareFoldersForDisplay(left, right)
  return compareNames(left, right) || compareFoldersForDisplay(left, right)
}

function compareFilesByMode(left: FileRecord, right: FileRecord, sortMode: BrowserSortMode): number {
  if (sortMode === 'name-asc') return compareNames(left, right) || compareFilesForDisplay(left, right)
  if (sortMode === 'name-desc') return compareNames(right, left) || compareFilesForDisplay(left, right)
  if (sortMode === 'updated-desc') return right.updatedAt.localeCompare(left.updatedAt) || compareFilesForDisplay(left, right)
  if (sortMode === 'updated-asc') return left.updatedAt.localeCompare(right.updatedAt) || compareFilesForDisplay(left, right)
  if (sortMode === 'size-desc') return right.size - left.size || compareFilesForDisplay(left, right)
  if (sortMode === 'size-asc') return left.size - right.size || compareFilesForDisplay(left, right)
  return compareFilesForDisplay(left, right)
}

function compareNames(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
}
