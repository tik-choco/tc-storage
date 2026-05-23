import type { BrowserViewMode, PendingShare } from './appTypes.js'
import type { FileRecord, FolderBundle, FolderRecord, StorageSnapshot } from './domain.js'
import { debugInfo, debugWarn } from './logging.js'
import type { ShareEnvelope } from './p2p.js'

export const folderColors = ['teal', 'blue', 'amber', 'rose', 'slate'] as const
export const browserViewModeKey = 'tc-storage-browser-view-mode-v1'

export function syncLog(message: string, details?: Record<string, unknown>): void {
  debugInfo('sync', message, details)
}

export function syncWarn(message: string, details?: Record<string, unknown>): void {
  debugWarn('sync', message, details)
}

export function isSeededLegacySnapshot(snapshot: StorageSnapshot): boolean {
  return (
    snapshot.folders.length === 0 &&
    snapshot.files.length === 0 &&
    snapshot.activity.length === 1 &&
    snapshot.activity[0]?.action === 'init' &&
    !snapshot.originNode.startsWith('did:key:')
  )
}

export function isImageFile(file: Pick<FileRecord, 'mimeType'>): boolean {
  return file.mimeType.startsWith('image/')
}

export function isVideoFile(file: Pick<FileRecord, 'mimeType'>): boolean {
  return file.mimeType.startsWith('video/')
}

export function isMediaFile(file: Pick<FileRecord, 'mimeType'>): boolean {
  return isImageFile(file) || isVideoFile(file)
}

export function canPreloadThumbnail(file: Pick<FileRecord, 'deletedAt' | 'mimeType'>): boolean {
  return !file.deletedAt && isMediaFile(file)
}

export function shouldPreloadVisibleThumbnail(options: {
  dataUrl: string | undefined
  file: Pick<FileRecord, 'deletedAt' | 'lastCid' | 'lastShareCid' | 'mimeType'>
  visible: boolean
}): boolean {
  return options.visible && !options.dataUrl && canPreloadThumbnail(options.file) && Boolean(options.file.lastCid || options.file.lastShareCid)
}

export function nearestSharedAncestorFolder(snapshot: StorageSnapshot, folderId: string | null): FolderRecord | undefined {
  if (!folderId) return undefined
  const visited = new Set<string>()
  let current = snapshot.folders.find((folder) => folder.id === folderId)
  while (current) {
    if (visited.has(current.id)) return undefined
    visited.add(current.id)
    if (!current.deletedAt && current.shareEnabled) return current
    current = current.parentId ? snapshot.folders.find((folder) => folder.id === current?.parentId) : undefined
  }
  return undefined
}

export function activeAncestorFolderId(snapshot: StorageSnapshot, folderId: string | null): string | null {
  if (!folderId) return null
  const visited = new Set<string>()
  let current = snapshot.folders.find((folder) => folder.id === folderId)
  while (current?.parentId) {
    if (visited.has(current.id)) return null
    visited.add(current.id)
    const parent = snapshot.folders.find((folder) => folder.id === current?.parentId)
    if (!parent || visited.has(parent.id)) return null
    if (!parent.deletedAt) return parent.id
    current = parent
  }
  return null
}

export function folderKeyUpdatesForBundle(bundle: FolderBundle, passphrase: string): Record<string, string> {
  const folders = bundle.folders?.length ? bundle.folders : [bundle.folder]
  return Object.fromEntries(folders.map((folder) => [folder.id, passphrase]))
}

export function withoutRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record
  return rest
}

export function envelopeLogDetails(envelope: ShareEnvelope): Record<string, unknown> {
  return {
    type: envelope.type,
    from: shortLogValue(envelope.from),
    roomId: envelope.roomId,
    folderId: envelope.folderId,
    folderName: envelope.folderName,
    changeType: envelope.changeType,
    changedFolderId: envelope.folder?.id,
    changedFolderName: envelope.folder?.name,
    fileId: envelope.fileId,
    fileName: envelope.fileName,
    cid: shortLogValue(envelope.cid),
    clock: envelope.clock,
    sentAt: envelope.sentAt,
    hasFolderSignature: Boolean(envelope.folderSignature),
  }
}

export function shareLogDetails(share: PendingShare): Record<string, unknown> {
  return {
    type: share.type,
    from: shortLogValue(share.from),
    roomId: share.roomId,
    folderId: share.folderId,
    folderName: share.folderName,
    fileId: share.fileId,
    fileName: share.fileName,
    cid: shortLogValue(share.cid),
    clock: share.clock,
    receivedAt: share.receivedAt,
    hasFolderSignature: Boolean(share.folderSignature),
  }
}

export function folderLogDetails(folder: FolderRecord): Record<string, unknown> {
  return {
    folderId: folder.id,
    folderName: folder.name,
    lastCid: shortLogValue(folder.lastCid),
    lastSharedAt: folder.lastSharedAt,
    updatedAt: folder.updatedAt,
    shareEnabled: folder.shareEnabled,
  }
}

export function shortLogValue(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length > 28 ? `${value.slice(0, 14)}...${value.slice(-8)}` : value
}

export function loadBrowserViewMode(): BrowserViewMode {
  return localStorage.getItem(browserViewModeKey) === 'list' ? 'list' : 'grid'
}
