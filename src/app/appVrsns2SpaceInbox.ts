// Consumes the shared `vrsns2-space-inbox` topic (published by tc-vrsns2,
// display name "TC Space", on the same origin) and imports each catalog item
// as a file into a dedicated "TC Space" folder.
//
// Unlike storage-drive-inbox / town-backup, the entries are PLAINTEXT: each
// item's `cid` points straight at the bytes via mistlib's storage_get, no
// AES-GCM layer to unwrap. That is deliberate on the sender's side — the
// bytes were already public in the shared mistlib content store the moment
// tc-vrsns2 published them (see tc-vrsns2's interop/tcSpace.ts header) — so
// re-encrypting here would only add a layer that cannot be decrypted by any
// other app anyway.
//
// tc-vrsns2 republishes its *entire* catalog (max 300 items) every time
// anything changes, and an item's id IS its cid: content-addressed, so any
// change to the bytes produces a brand-new id. This module therefore treats
// ids as opaque and never replaces in place:
//  - unseen id -> fetch bytes, create a new file, remember {cid, fileId}.
//  - seen id -> nothing to do. This also means a file the user deleted is
//    never resurrected as long as the item keeps the same cid — and since a
//    content change is a new cid, an item edited in tc-vrsns2 arrives as a
//    NEW file here (the old copy stays until the user deletes it). Deletion
//    does not propagate on this bus, matching every other inbox-family topic.
//
// Fetching an item's bytes (mist module load / storage_get) can fail
// transiently; those ids are simply left out of the tracked state so the
// next bus event or mount retries them, mirroring the note-doc-index fix in
// appNoteDocInbox.ts.
//
// Contract: topic `vrsns2-space-inbox` (v1); item shape is published by
// tc-vrsns2 (src/interop/tcSpace.ts). See
// protocol/docs/data-contracts/docs/SHARED_BUS.md.

import type { MutableRef, SetState } from './appControllerTypes.js'
import { sha256Hex } from '../crypto/crypto.js'
import { bytesToBase64 } from '../crypto/cryptoEncoding.js'
import { generateFolderKey } from '../crypto/folderKeys.js'
import { stampFilePatch } from '../storage/crdt.js'
import {
  addActivity,
  makeFileFromDataUrl,
  makeFolder,
  makeId,
  stripFileContent,
  touchSnapshot,
  type FileRecord,
  type StorageSnapshot,
} from '../storage/domain.js'
import type { AppSettings } from '../storage/localSettings.js'
import { ensureMistRuntimeInitialized, loadMistModule, saveEncryptedFileToMist } from '../storage/mistStorage.js'
import type { SharedRecord } from '../storage/sharedBus.js'
import { describeError } from '../util/errors.js'
import { debugWarn } from '../util/logging.js'
import { sanitizeNoteFileBaseName } from './appNoteDocInbox.js'

const vrsns2SpaceInboxTopic = 'vrsns2-space-inbox'
const inboxFolderName = 'TC Space'
const importedStateKey = 'tc-storage-vrsns2-space-imported-v1'
const maxImportedEntries = 1000
/** Matches tc-vrsns2's MAX_SPACE_ITEMS (interop/tcSpace.ts). */
const maxSpaceItems = 300

/** One item in tc-vrsns2's published catalog snapshot. Mirrors tc-vrsns2's SpaceInboxItem (interop/tcSpace.ts). */
export interface SpaceInboxItem {
  /** Stable dedupe key — the item's content cid (see module header). */
  id: string
  name: string
  category: 'avatar' | 'world' | 'object'
  /** mistlib storage_add CID of the plaintext bytes. */
  cid: string
  /** Filing hint (model/vrm, model/gltf-binary, image/webp, …). */
  mimeType: string
  updatedAt: string
}

/** Tracks the last-imported cid and the resulting local fileId for one item id. */
interface ImportedSpaceEntry {
  cid: string
  fileId: string
}

interface Vrsns2SpaceInboxOptions {
  snapshotRef: MutableRef<StorageSnapshot>
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  folderKeysRef: MutableRef<Record<string, string>>
  setFolderKeys: SetState<Record<string, string>>
  setFileContentCache: SetState<Record<string, string>>
  /** Overridable for tests; defaults to the real mistlib-backed resolver. */
  resolveItem?: (cid: string, nodeId: string) => Promise<ResolveSpaceResult>
}

/** Outcome of resolving an item: usable plaintext bytes, or a transient failure worth retrying later. There is no permanent-failure kind: unlike town-backup there is no checksum to verify after a successful fetch. */
export type ResolveSpaceResult =
  | { kind: 'resolved'; bytes: Uint8Array }
  | { kind: 'transient' }

/** Parses and validates the `items` array out of a vrsns2-space-inbox record's meta, capping at 300 entries. */
export function parseSpaceItems(meta: Record<string, unknown>): SpaceInboxItem[] {
  const rawItems = (meta as { items?: unknown }).items
  if (!Array.isArray(rawItems)) return []
  const items: SpaceInboxItem[] = []
  for (const raw of rawItems) {
    if (items.length >= maxSpaceItems) break
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id) continue
    if (typeof item.name !== 'string') continue
    if (item.category !== 'avatar' && item.category !== 'world' && item.category !== 'object') continue
    if (typeof item.cid !== 'string' || !item.cid) continue
    if (typeof item.mimeType !== 'string' || !item.mimeType) continue
    if (typeof item.updatedAt !== 'string' || !item.updatedAt) continue
    items.push({
      id: item.id,
      name: item.name,
      category: item.category,
      cid: item.cid,
      mimeType: item.mimeType,
      updatedAt: item.updatedAt,
    })
  }
  return items
}

/** Loads the persisted `{ id: { cid, fileId } }` import state. Tolerates missing/corrupt JSON. */
export function loadImportedSpaceState(): Map<string, ImportedSpaceEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(importedStateKey) ?? '') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    const record = parsed as Record<string, unknown>
    if (record.v !== 1) return new Map()
    const rawEntries = record.entries
    if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) return new Map()
    const map = new Map<string, ImportedSpaceEntry>()
    for (const [id, value] of Object.entries(rawEntries as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      if (typeof entry.cid !== 'string' || !entry.cid) continue
      if (typeof entry.fileId !== 'string' || !entry.fileId) continue
      map.set(id, { cid: entry.cid, fileId: entry.fileId })
    }
    return map
  } catch {
    return new Map()
  }
}

/** Persists the import state, keeping only the most recently touched 1000 entries. */
export function saveImportedSpaceState(state: Map<string, ImportedSpaceEntry>): void {
  const capped = [...state.entries()].slice(-maxImportedEntries)
  const entries: Record<string, ImportedSpaceEntry> = {}
  for (const [id, entry] of capped) entries[id] = entry
  try {
    localStorage.setItem(importedStateKey, JSON.stringify({ v: 1, entries }))
  } catch (error) {
    debugWarn('vrsns2-space-inbox', 'failed to persist imported space state', { error: describeError(error, 'unknown error') })
  }
}

const MIME_EXTENSIONS: Record<string, string> = {
  'model/vrm': 'vrm',
  'model/gltf-binary': 'glb',
  'model/gltf+json': 'gltf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/webm': 'weba',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/pdf': 'pdf',
}

/**
 * Best-effort file extension for a wire mimeType. Empty when there is no
 * confident mapping. For the sender's `application/octet-stream` splat worlds
 * (ply/ksplat carry no registered IANA type) it sniffs the magic bytes when
 * available, so those import with a usable extension instead of none.
 * Pure and independently testable — no I/O.
 */
export function extensionForMime(mime: string, bytes?: Uint8Array): string {
  const known = MIME_EXTENSIONS[mime]
  if (known) return known
  if (/^(image|video|audio)\//.test(mime)) {
    const subtype = mime.slice(mime.indexOf('/') + 1).replace(/\+.*$/, '')
    if (/^[a-z0-9]{1,8}$/i.test(subtype)) return subtype
  }
  if (mime === 'application/octet-stream' && bytes) {
    // PLY magic: "ply\n"
    if (bytes.length >= 4 && bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79 && bytes[3] === 0x0a) return 'ply'
    // ksplat magic: "ksplat"
    if (bytes.length >= 6 && bytes[0] === 0x6b && bytes[1] === 0x73 && bytes[2] === 0x70 && bytes[3] === 0x6c && bytes[4] === 0x61 && bytes[5] === 0x74) return 'ksplat'
  }
  return ''
}

/** Builds the imported file name: sanitized base + derived extension, never doubling an extension the base already carries. */
export function spaceFileName(item: SpaceInboxItem, bytes?: Uint8Array): string {
  const base = sanitizeNoteFileBaseName(item.name)
  const ext = extensionForMime(item.mimeType, bytes)
  if (!ext) return base
  if (base.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return base
  return `${base}.${ext}`
}

/** Fetches an item's plaintext bytes from mistlib. Transient failures (module load / storage_get) return { kind: 'transient' } so the caller retries on the next event. */
async function resolveSpaceItem(cid: string, nodeId: string): Promise<ResolveSpaceResult> {
  try {
    const mist = await loadMistModule()
    ensureMistRuntimeInitialized(mist, { nodeId })
    const bytes = await mist.storage_get(cid)
    return { kind: 'resolved', bytes }
  } catch (error) {
    debugWarn('vrsns2-space-inbox', 'transient failure resolving item; will retry on the next event', { cid, error: describeError(error, 'unknown error') })
    return { kind: 'transient' }
  }
}

export function createVrsns2SpaceInboxActions(options: Vrsns2SpaceInboxOptions) {
  const { snapshotRef, setSnapshot, settingsRef, folderKeysRef, setFolderKeys, setFileContentCache, resolveItem = resolveSpaceItem } = options
  // Serialize imports: several bus channels can fire for one update, and
  // storage_get/mist storage_add are async, so we must not process the same
  // item concurrently.
  let inFlight: Promise<void> = Promise.resolve()

  function ensureFolderId(): string {
    const now = new Date().toISOString()
    const settings = settingsRef.current
    let folderId = ''
    setSnapshot((current) => {
      const existing = current.folders.find(
        (folder) => !folder.deletedAt && folder.parentId === null && folder.name === inboxFolderName,
      )
      if (existing) {
        folderId = existing.id
        return current
      }
      const folder = makeFolder({ name: inboxFolderName, parentId: null, color: 'teal', roomId: settings.roomId, now, nodeId: settings.nodeId })
      folderId = folder.id
      const next = touchSnapshot(
        addActivity(
          { ...current, folders: [...current.folders, folder] },
          { actorNodeId: settings.nodeId, folderId: folder.id, action: 'folder.create', detail: `${folder.name} を作成` },
          now,
        ),
        settings.nodeId,
      )
      // Update the ref synchronously so subsequent lookups in this same
      // import pass see the folder before React has committed setSnapshot.
      snapshotRef.current = next
      return next
    })
    return folderId
  }

  function folderPassphrase(folderId: string): string {
    const existing = folderKeysRef.current[folderId]
    if (existing) return existing
    const passphrase = generateFolderKey()
    folderKeysRef.current = { ...folderKeysRef.current, [folderId]: passphrase }
    setFolderKeys((current) => (current[folderId] ? current : { ...current, [folderId]: passphrase }))
    return passphrase
  }

  function addFileToSnapshot(file: FileRecord, folderId: string): void {
    const settings = settingsRef.current
    setSnapshot((current) => {
      const next = touchSnapshot(
        addActivity(
          { ...current, files: [...current.files, file] },
          { actorNodeId: settings.nodeId, fileId: file.id, folderId, action: 'file.upload', detail: `${file.name} を取り込み` },
          file.updatedAt,
        ),
        settings.nodeId,
      )
      snapshotRef.current = next
      return next
    })
  }

  function patchFileInSnapshot(fileId: string, patch: Partial<FileRecord>, now: string): FileRecord | undefined {
    const settings = settingsRef.current
    let patched: FileRecord | undefined
    setSnapshot((current) => {
      patched = undefined
      const files = current.files.map((file) => {
        if (file.id !== fileId) return file
        patched = stampFilePatch(file, patch, now, settings.nodeId)
        return patched
      })
      if (!patched) return current
      const next = touchSnapshot({ ...current, files }, settings.nodeId)
      snapshotRef.current = next
      return next
    })
    return patched
  }

  /** Best-effort background durability: stores the file's content to mistlib and patches in the resulting lastCid. Failures are logged and simply leave the file without a lastCid, same as normal uploads. */
  async function storeFileInMistBackground(file: FileRecord, folderId: string): Promise<void> {
    const folder = snapshotRef.current.folders.find((item) => item.id === folderId)
    if (!folder) return
    const passphrase = folderPassphrase(folderId)
    const settings = settingsRef.current
    try {
      const cid = await saveEncryptedFileToMist({ folder, file, passphrase, originNode: settings.nodeId, runtimeNodeId: settings.nodeId })
      patchFileInSnapshot(file.id, { lastCid: cid }, new Date().toISOString())
    } catch (error) {
      debugWarn('vrsns2-space-inbox', 'background mist storage failed for imported file', { fileId: file.id, error: describeError(error, 'unknown error') })
    }
  }

  async function importItem(item: SpaceInboxItem, bytes: Uint8Array, folderId: string): Promise<string> {
    const settings = settingsRef.current
    const now = new Date().toISOString()
    const checksum = await sha256Hex(bytes)
    const dataUrl = `data:${item.mimeType};base64,${bytesToBase64(bytes)}`
    const file = makeFileFromDataUrl({
      id: makeId('file'),
      folderId,
      name: spaceFileName(item, bytes),
      mimeType: item.mimeType,
      size: bytes.byteLength,
      dataUrl,
      checksum,
      now,
      nodeId: settings.nodeId,
    })
    setFileContentCache((current) => ({ ...current, [file.id]: dataUrl }))
    addFileToSnapshot(stripFileContent(file), folderId)
    void storeFileInMistBackground(file, folderId)
    return file.id
  }

  async function runImport(record: SharedRecord): Promise<void> {
    const items = parseSpaceItems(record.meta)
    if (!items.length) return
    const state = loadImportedSpaceState()
    const nodeId = settingsRef.current.nodeId
    let folderId: string | undefined
    let dirty = false
    for (const item of items) {
      // Seen id: nothing changed. Since id === cid on this wire, a same-id
      // republish means the same bytes — already imported, or deleted by the
      // user and not to be resurrected until the item is edited again (a
      // fresh cid is the "re-import" signal, as deletion doesn't propagate).
      if (state.has(item.id)) continue
      const result = await resolveItem(item.cid, nodeId)
      if (result.kind === 'transient') continue // transient failure: leave untouched, retry next event/mount
      folderId ??= ensureFolderId()
      const fileId = await importItem(item, result.bytes, folderId)
      state.set(item.id, { cid: item.cid, fileId })
      dirty = true
    }
    if (dirty) saveImportedSpaceState(state)
  }

  /** Imports any new items from a vrsns2-space-inbox record. Safe to call repeatedly. */
  function importFromSpaceInbox(record: SharedRecord): void {
    inFlight = inFlight.then(() => runImport(record)).catch(() => {})
  }

  return { importFromSpaceInbox }
}

export { vrsns2SpaceInboxTopic }
