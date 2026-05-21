import type { PendingShare } from './appTypes.js'
import { stampFilePatch, stampFolderPatch } from './crdt.js'
import { stripFileContent, type FileBundle, type FileRecord, type FolderBundle, type FolderRecord, type StorageSnapshot } from './domain.js'

export function mergeUploadedFiles(currentFiles: FileRecord[], uploaded: FileRecord[], now: string, nodeId: string): FileRecord[] {
  let filesNext = [...currentFiles]
  for (const file of uploaded) {
    const index = filesNext.findIndex((item) => item.folderId === file.folderId && item.name === file.name && !item.deletedAt)
    const existing = filesNext[index]
    filesNext = index >= 0 && existing
      ? filesNext.with(index, stampFilePatch(existing, { mimeType: file.mimeType, size: file.size, dataUrl: file.dataUrl, checksum: file.checksum, lastCid: file.lastCid, version: existing.version + 1 }, now, nodeId))
      : [...filesNext, file]
  }
  return filesNext
}

export function remoteFolderSnapshot(bundle: FolderBundle, share: PendingShare, options: { preserveRootFolder?: FolderRecord } = {}): StorageSnapshot {
  const sharedAt = share.sentAt || bundle.exportedAt
  const rootPatch: Partial<FolderRecord> = {
    shareEnabled: true,
    sharedRoomId: share.roomId,
    lastCid: share.cid,
    lastSavedAt: bundle.exportedAt,
    lastSharedAt: sharedAt,
  }
  if (!options.preserveRootFolder) rootPatch.parentId = null
  const rootFolder = stampFolderPatch(
    bundle.folder,
    rootPatch,
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
