import type { FileRecord, FolderRecord, StorageSnapshot } from '../storage/domain.js'
import { stripFileContent } from '../storage/domain.js'
import { mergeSnapshots, normalizeFolderVersions, normalizeFileVersions } from '../storage/crdt.js'
import { descendantFolderIds } from '../app/appHelpers.js'
import { isRecord, parseHead, safeInt, stableStringify, HASH_RE, verifyHead } from '../escrow/head'
import type { EscrowHead } from '../escrow/head'
import { deriveEscrowKeys, utf8 } from '../escrow/crypto'

export const APP = 'tc-storage'
export const PACK_APP = 'tc-storage/content-pack/1'
export const CHECKPOINT_SCHEMA = 'tc-storage/folder-checkpoint/1'
export const PACK_BYTES = 8 * 1024 * 1024
export const MANIFEST_BYTES = 16 * 1024 * 1024
export const MAX_PACKS = 1023
export interface ContentEntry {
  fileId: string
  checksum: string
  size: number
  segments: {
    packDigest: string
    offset: number
    length: number
  }[]
}
export interface PackEntry {
  digest: string
  length: number
  head: EscrowHead
}
export interface FolderCheckpoint {
  v: 1
  rootFolderId: string
  appRoomId: string
  snapshot: StorageSnapshot
  contents: ContentEntry[]
  packs: PackEntry[]
}
export const folderInput = (id: string, key: string) => JSON.stringify(['folder', id, key.trim()])
export const packInput = (id: string, key: string, digest: string) => JSON.stringify(['folder', id, key.trim(), digest])
export const contentIdentity = (f: Pick<FileRecord, 'id' | 'checksum' | 'size'>) =>
  JSON.stringify([f.id, f.checksum, f.size])
export const validRoom = (r: unknown): r is string => typeof r === 'string' && /^[A-Za-z0-9_./:-]{1,96}$/.test(r)
export function validSetting(v: unknown): v is NonNullable<FolderRecord['escrow']> {
  return (
    isRecord(v) &&
    Object.keys(v).length === 2 &&
    (v.mode === 'auto' || v.mode === 'off' || v.mode === 'custom') &&
    (v.mode === 'custom' ? validRoom(v.room) : v.room === '')
  )
}
const publication = new Set(['lastCid', 'lastSavedAt', 'lastSharedAt'])
// stripFileContent can omit the entire map for metadata-only records. Escrow must
// retain every original CRDT stamp, removing only the inline-content stamp.
function stripCheckpointFile(file: FileRecord): FileRecord {
  const { dataUrl: _dataUrl, ...fieldVersions } = file.fieldVersions ?? {}
  return { ...stripFileContent(file), fieldVersions }
}
export function projectFolder(snapshot: StorageSnapshot, rootId: string): StorageSnapshot {
  const ids = descendantFolderIds(snapshot.folders, rootId)
  const folders = snapshot.folders
    .filter((f) => ids.has(f.id))
    .map((f) => {
      if (f.id !== rootId && f.shareEnabled && !f.deletedAt) throw new Error('Nested shared roots are unsupported')
      const normalized = normalizeFolderVersions(f, snapshot.originNode || 'local')
      const record = { ...normalized, fieldVersions: { ...normalized.fieldVersions } }
      for (const field of publication) {
        delete (record as unknown as Record<string, unknown>)[field]
        delete record.fieldVersions[field]
      }
      if (record.id === rootId) record.parentId = null
      // Publication changes updatedAt too; use the retained original field stamps.
      record.updatedAt =
        Object.values(record.fieldVersions)
          .map((s) => s.updatedAt)
          .sort()
          .at(-1) ?? record.updatedAt
      return record
    })
    .sort((a, b) => a.id.localeCompare(b.id))
  if (!folders.some((f) => f.id === rootId)) throw new Error('Missing shared root')
  return {
    ...snapshot,
    folders,
    files: snapshot.files
      .filter((f) => ids.has(f.folderId))
      .map((f) => stripCheckpointFile(normalizeFileVersions(f, snapshot.originNode || 'local')))
      .sort((a, b) => a.id.localeCompare(b.id)),
    activity: [],
  }
}
export function checkpointFingerprint(snapshot: StorageSnapshot, root: string): string {
  const scoped = projectFolder(snapshot, root)
  return stableStringify({ folders: scoped.folders, files: scoped.files })
}
export function mergeFolderCheckpoint(local: StorageSnapshot, checkpoint: FolderCheckpoint): StorageSnapshot {
  const root = local.folders.find((f) => f.id === checkpoint.rootFolderId)
  const scope = root ? descendantFolderIds(local.folders, root.id) : new Set<string>()
  // Existing records placed outside this share (including move destinations) remain local.
  const folders = checkpoint.snapshot.folders.filter(
    (f) => f.id === checkpoint.rootFolderId || !local.folders.some((l) => l.id === f.id && !scope.has(l.id)),
  )
  const files = checkpoint.snapshot.files.filter(
    (f) => !local.files.some((l) => l.id === f.id && !scope.has(l.folderId)),
  )
  if (
    folders.some((f) => local.files.some((l) => l.id === f.id)) ||
    files.some((f) => local.folders.some((l) => l.id === f.id))
  )
    throw new Error('Checkpoint identity collides with unrelated local records')
  const remote = {
    ...checkpoint.snapshot,
    files,
    folders: folders.map((f) =>
      root && f.id === root.id
        ? {
            ...f,
            parentId: root.parentId,
            fieldVersions: {
              ...f.fieldVersions,
              ...(root.fieldVersions?.parentId && { parentId: root.fieldVersions.parentId }),
            },
          }
        : f,
    ),
  }
  const merged = mergeSnapshots(local, remote)
  merged.files = merged.files.map((file) => {
    const before = local.files.find((f) => f.id === file.id)
    return before && (before.checksum !== file.checksum || before.size !== file.size) ? stripCheckpointFile(file) : file
  })
  // Placement is local even when its parent stamp is older than the exported one.
  if (root)
    merged.folders = merged.folders.map((f) =>
      f.id === root.id
        ? {
            ...f,
            parentId: root.parentId,
            fieldVersions: {
              ...f.fieldVersions,
              ...(root.fieldVersions?.parentId && { parentId: root.fieldVersions.parentId }),
            },
          }
        : f,
    )
  return merged
}
const folderFields = [
  'id',
  'name',
  'parentId',
  'sortOrder',
  'color',
  'encrypted',
  'shareEnabled',
  'sharedRoomId',
  'escrow',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'fieldVersions',
]
const fileFields = [
  'id',
  'folderId',
  'sortOrder',
  'name',
  'mimeType',
  'size',
  'checksum',
  'version',
  'starred',
  'lastCid',
  'lastShareCid',
  'deletedAt',
  'createdAt',
  'updatedAt',
  'fieldVersions',
]
const text = (v: unknown, max = 4096): v is string =>
  typeof v === 'string' && v.length > 0 && utf8(v).length <= max && !/[\u0000-\u001f]/.test(v)
const date = (v: unknown) =>
  typeof v === 'string' &&
  /^\d{4}-\d\d-\d\dT/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v
function checkRecord(value: unknown, folder: boolean): void {
  if (!isRecord(value)) throw new Error('Invalid checkpoint record')
  const fields = folder ? folderFields : fileFields
  if (
    Object.keys(value).some((k) => !fields.includes(k)) ||
    !text(value.id, 256) ||
    !text(value.name) ||
    !date(value.createdAt) ||
    !date(value.updatedAt) ||
    (value.deletedAt !== undefined && !date(value.deletedAt)) ||
    (value.sortOrder !== undefined && (typeof value.sortOrder !== 'number' || !Number.isFinite(value.sortOrder)))
  )
    throw new Error('Invalid checkpoint record fields')
  if (!isRecord(value.fieldVersions)) throw new Error('Missing checkpoint stamps')
  const stampFields = folder ? [...folderFields, ...publication] : [...fileFields, 'dataUrl']
  for (const [key, stamp] of Object.entries(value.fieldVersions)) {
    if (
      !stampFields.includes(key) ||
      !isRecord(stamp) ||
      Object.keys(stamp).length !== 2 ||
      !date(stamp.updatedAt) ||
      !text(stamp.nodeId, 256)
    )
      throw new Error('Invalid checkpoint stamp')
  }
  if (folder) {
    if (
      !(value.parentId === null || text(value.parentId, 256)) ||
      !['teal', 'blue', 'amber', 'rose', 'slate'].includes(value.color as string) ||
      typeof value.encrypted !== 'boolean' ||
      typeof value.shareEnabled !== 'boolean' ||
      !text(value.sharedRoomId, 256) ||
      (value.escrow !== undefined && !validSetting(value.escrow))
    )
      throw new Error('Invalid checkpoint folder')
  } else if (
    !text(value.folderId, 256) ||
    !text(value.mimeType, 256) ||
    !safeInt(value.size, 0) ||
    !safeInt(value.version, 1) ||
    typeof value.starred !== 'boolean' ||
    typeof value.checksum !== 'string' ||
    !HASH_RE.test(value.checksum) ||
    ['lastCid', 'lastShareCid'].some((k) => value[k] !== undefined && !text(value[k], 1024))
  )
    throw new Error('Invalid checkpoint file')
}
export function encodeCheckpoint(checkpoint: FolderCheckpoint): Uint8Array {
  const bytes = utf8(stableStringify(checkpoint))
  if (bytes.length > MANIFEST_BYTES) throw new Error('Checkpoint metadata exceeds 16 MiB')
  if (checkpoint.packs.length > MAX_PACKS) throw new Error('Checkpoint exceeds 1023 packs')
  return bytes
}
/** All validation completes before any snapshot mutation or descriptor persistence. */
export async function validateCheckpoint(
  bytes: Uint8Array,
  root: string,
  key: string,
  room: string,
): Promise<FolderCheckpoint> {
  if (bytes.length > MANIFEST_BYTES) throw new Error('Checkpoint metadata exceeds 16 MiB')
  const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as FolderCheckpoint
  if (
    !isRecord(c) ||
    Object.keys(c).sort().join(',') !== 'appRoomId,contents,packs,rootFolderId,snapshot,v' ||
    c.v !== 1 ||
    c.rootFolderId !== root ||
    c.appRoomId !== room ||
    !isRecord(c.snapshot) ||
    Object.keys(c.snapshot).sort().join(',') !== 'activity,clock,files,folders,originNode' ||
    !safeInt(c.snapshot.clock, 0) ||
    !text(c.snapshot.originNode, 256) ||
    !Array.isArray(c.snapshot.activity) ||
    c.snapshot.activity.length ||
    !Array.isArray(c.snapshot.folders) ||
    !Array.isArray(c.snapshot.files) ||
    !Array.isArray(c.contents) ||
    !Array.isArray(c.packs) ||
    c.packs.length > MAX_PACKS ||
    c.snapshot.folders.length > 100000 ||
    c.snapshot.files.length > 100000
  )
    throw new Error('Invalid folder checkpoint')
  const ids = new Set<string>()
  const folders = new Map<string, FolderRecord>()
  for (const f of c.snapshot.folders) {
    checkRecord(f, true)
    if (ids.has(f.id)) throw new Error('Duplicate checkpoint id')
    ids.add(f.id)
    folders.set(f.id, f)
  }
  if (folders.get(root)?.parentId !== null) throw new Error('Invalid checkpoint root')
  for (const f of folders.values()) {
    if (f.id !== root && f.shareEnabled && !f.deletedAt) throw new Error('Nested shared roots are unsupported')
    const seen = new Set<string>()
    let current: FolderRecord | undefined = f
    while (current && current.id !== root) {
      if (seen.has(current.id) || !current.parentId) throw new Error('Invalid checkpoint hierarchy')
      seen.add(current.id)
      current = folders.get(current.parentId)
    }
    if (!current) throw new Error('Checkpoint hierarchy escapes root')
  }
  const fileMap = new Map<string, FileRecord>()
  for (const f of c.snapshot.files) {
    checkRecord(f, false)
    if (ids.has(f.id) || !folders.has(f.folderId)) throw new Error('Invalid checkpoint file placement')
    ids.add(f.id)
    fileMap.set(f.id, f)
  }
  const packs = new Map<string, PackEntry>()
  for (const p of c.packs) {
    if (
      !isRecord(p) ||
      Object.keys(p).sort().join(',') !== 'digest,head,length' ||
      typeof p.digest !== 'string' ||
      !HASH_RE.test(p.digest) ||
      !safeInt(p.length, 1, PACK_BYTES) ||
      packs.has(p.digest)
    )
      throw new Error('Invalid checkpoint pack')
    const keys = await deriveEscrowKeys(PACK_APP, packInput(root, key, p.digest))
    const head = parseHead(p.head, { slot: keys.slot, writer: keys.writer, maxBlob: PACK_BYTES + 28 })
    if (
      !head ||
      head.seq !== 1 ||
      head.parent !== null ||
      head.comp !== 'none' ||
      head.schema !== PACK_APP ||
      head.size !== p.length + 28 ||
      !(await verifyHead(head, { slot: keys.slot, writer: keys.writer }))
    )
      throw new Error('Invalid checkpoint pack head')
    packs.set(p.digest, p)
  }
  const admitted = new Set<string>()
  const referenced = new Set<string>()
  for (const entry of c.contents) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(',') !== 'checksum,fileId,segments,size' ||
      typeof entry.fileId !== 'string' ||
      admitted.has(entry.fileId) ||
      !Array.isArray(entry.segments) ||
      entry.segments.length > MAX_PACKS
    )
      throw new Error('Invalid checkpoint content')
    const file = fileMap.get(entry.fileId)
    if (!file || file.deletedAt || file.checksum !== entry.checksum || file.size !== entry.size)
      throw new Error('Checkpoint content identity mismatch')
    let size = 0
    for (const s of entry.segments) {
      if (
        !isRecord(s) ||
        Object.keys(s).sort().join(',') !== 'length,offset,packDigest' ||
        !safeInt(s.offset, 0) ||
        !safeInt(s.length, 1, PACK_BYTES) ||
        typeof s.packDigest !== 'string'
      )
        throw new Error('Invalid checkpoint segment')
      const p = packs.get(s.packDigest)
      if (!p || s.offset + s.length > p.length) throw new Error('Checkpoint segment out of bounds')
      referenced.add(s.packDigest)
      size += s.length
    }
    if (size !== file.size) throw new Error('Checkpoint content size mismatch')
    admitted.add(entry.fileId)
  }
  if (c.snapshot.files.some((f) => !f.deletedAt && !admitted.has(f.id)) || referenced.size !== packs.size)
    throw new Error('Checkpoint has missing content or unused packs')
  return c
}
