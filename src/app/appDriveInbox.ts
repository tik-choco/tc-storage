// Consumes the shared `storage-drive-inbox` topic (published by tc-note on
// the same origin) and imports each new file into a dedicated
// "tc-noteから追加" folder, reusing the normal upload flow so files are
// checksummed, added to the drive, and stored to mistlib in the background.
//
// Each item's bytes live behind mistlib's storage_add, encrypted client-side
// by tc-note with a fresh AES-256-GCM key carried alongside the CID in the
// item itself (same-origin localStorage is the trust boundary for this bus,
// same as everywhere else — see protocol/docs/data-contracts/docs/
// SHARED_BUS.md). This module fetches the ciphertext via storage_get,
// decrypts it, and verifies the SHA-256 checksum before handing the
// plaintext to the normal upload pipeline — it never touches
// tc-storage-snapshot-v1 directly.
//
// Items are deduped by their stable `id` (persisted in localStorage), so a
// republished list never creates duplicates and user deletions are
// respected. Items that fail to decrypt/verify are unrecoverable (the
// ciphertext and checksum are fixed at publish time), so they're marked
// imported too rather than retried forever on every republish. Items that
// fail to *resolve* for a transient reason (the mistlib module failed to
// load, or storage_get itself failed — e.g. a network hiccup or the block
// simply isn't replicated yet) are a different story: retrying can succeed
// later, so those ids are deliberately left out of the imported set and
// get another attempt on the next republish/subscription tick or mount.
//
// Contract: topic `storage-drive-inbox` (v1); item shape is published by
// tc-note (src/lib/storageDriveInbox.ts). See
// protocol/docs/data-contracts/docs/SHARED_BUS.md.

import type { MutableRef, SetState } from './appControllerTypes.js'
import { addActivity, makeFolder, touchSnapshot, type StorageSnapshot } from '../storage/domain.js'
import type { AppSettings } from '../storage/localSettings.js'
import type { SharedRecord } from '../storage/sharedBus.js'
import { ensureMistRuntimeInitialized, loadMistModule } from '../storage/mistStorage.js'
import { base64ToBytes, toArrayBuffer } from '../crypto/cryptoEncoding.js'
import { describeError } from '../util/errors.js'
import { debugInfo, debugWarn } from '../util/logging.js'

const driveInboxTopic = 'storage-drive-inbox'
const inboxFolderName = 'tc-noteから追加'
const importedIdsKey = 'tc-storage-drive-inbox-imported-v1'
const maxImportedIds = 1000

/** One file to materialize as an upload. Mirrors tc-note's storageDriveInbox.ts. */
export interface DriveInboxItem {
  id: string
  name: string
  mimeType: string
  size: number
  checksum: string
  cid: string
  key: string
  iv: string
  addedAt: string
}

interface DriveInboxOptions {
  snapshotRef: MutableRef<StorageSnapshot>
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  uploadFilesRef: MutableRef<(fileList: FileList | null, targetFolderId?: string | null) => Promise<void>>
  /** Overridable for tests; defaults to the real mistlib-backed resolver. */
  resolveItemFile?: (item: DriveInboxItem, nodeId: string) => Promise<ResolveItemResult>
}

function parseInboxItems(meta: Record<string, unknown>): DriveInboxItem[] {
  const rawItems = (meta as { items?: unknown }).items
  if (!Array.isArray(rawItems)) return []
  const items: DriveInboxItem[] = []
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id) continue
    if (typeof item.name !== 'string' || !item.name) continue
    if (typeof item.mimeType !== 'string' || !item.mimeType) continue
    if (typeof item.size !== 'number') continue
    if (typeof item.checksum !== 'string' || !item.checksum) continue
    if (typeof item.cid !== 'string' || !item.cid) continue
    if (typeof item.key !== 'string' || !item.key) continue
    if (typeof item.iv !== 'string' || !item.iv) continue
    if (typeof item.addedAt !== 'string') continue
    items.push({
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      checksum: item.checksum,
      cid: item.cid,
      key: item.key,
      iv: item.iv,
      addedAt: item.addedAt,
    })
  }
  return items
}

function loadImportedIds(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(importedIdsKey) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveImportedIds(ids: Set<string>): void {
  // Keep only the most recent ids so the dedupe set can't grow unbounded.
  const list = [...ids].slice(-maxImportedIds)
  try {
    localStorage.setItem(importedIdsKey, JSON.stringify(list))
  } catch (error) {
    debugWarn('storage-drive-inbox', 'failed to persist imported ids', { error: describeError(error, 'unknown error') })
  }
}

function toFileList(files: File[]): FileList {
  try {
    const transfer = new DataTransfer()
    for (const file of files) transfer.items.add(file)
    return transfer.files
  } catch {
    return files as unknown as FileList
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Outcome of resolving one item: a usable file, a permanent (unrecoverable) failure, or a transient one worth retrying later. */
export type ResolveItemResult =
  | { kind: 'resolved'; file: File }
  | { kind: 'permanent' }
  | { kind: 'transient' }

/** Fetches, decrypts, and checksum-verifies one item's ciphertext. Distinguishes unrecoverable failures (checksum mismatch, decrypt failure) from transient ones (mist module load / storage_get failures) so callers can retry only the latter. */
async function resolveItemFile(item: DriveInboxItem, nodeId: string): Promise<ResolveItemResult> {
  let cipherText: Uint8Array
  try {
    const mist = await loadMistModule()
    ensureMistRuntimeInitialized(mist, { nodeId })
    cipherText = await mist.storage_get(item.cid)
  } catch (error) {
    debugWarn('storage-drive-inbox', 'transient failure resolving item; will retry later', { id: item.id, name: item.name, error: describeError(error, 'unknown error') })
    return { kind: 'transient' }
  }
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(base64ToBytes(item.key)), 'AES-GCM', false, ['decrypt'])
    const iv = base64ToBytes(item.iv)
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, cryptoKey, toArrayBuffer(cipherText))
    const plainBytes = new Uint8Array(plainBuffer)
    const checksum = await sha256Hex(plainBytes)
    if (checksum !== item.checksum) {
      debugWarn('storage-drive-inbox', 'checksum mismatch, skipping item', { id: item.id, name: item.name })
      return { kind: 'permanent' }
    }
    return { kind: 'resolved', file: new File([plainBytes], item.name, { type: item.mimeType }) }
  } catch (error) {
    debugWarn('storage-drive-inbox', 'failed to decrypt item, skipping', { id: item.id, name: item.name, error: describeError(error, 'unknown error') })
    return { kind: 'permanent' }
  }
}

export function createDriveInboxActions(options: DriveInboxOptions) {
  const { snapshotRef, setSnapshot, settingsRef, uploadFilesRef, resolveItemFile: resolveItem = resolveItemFile } = options
  // Serialize imports: several bus channels can fire for one update, and
  // storage_get/uploadFiles are async, so we must not process the same items
  // concurrently.
  let inFlight: Promise<void> = Promise.resolve()

  function ensureFolderId(): string {
    const snapshot = snapshotRef.current
    const existing = snapshot.folders.find(
      (folder) => !folder.deletedAt && folder.parentId === null && folder.name === inboxFolderName,
    )
    if (existing) return existing.id
    const now = new Date().toISOString()
    const settings = settingsRef.current
    const folder = makeFolder({ name: inboxFolderName, parentId: null, color: 'teal', roomId: settings.roomId, now, nodeId: settings.nodeId })
    const next = touchSnapshot(
      addActivity(
        { ...snapshot, folders: [...snapshot.folders, folder] },
        { actorNodeId: settings.nodeId, folderId: folder.id, action: 'folder.create', detail: `${folder.name} を作成` },
        now,
      ),
      settings.nodeId,
    )
    // Update the ref synchronously so the upcoming uploadFiles call finds the
    // folder before React has committed the setSnapshot below.
    snapshotRef.current = next
    setSnapshot(next)
    return folder.id
  }

  async function runImport(record: SharedRecord): Promise<void> {
    const items = parseInboxItems(record.meta)
    if (!items.length) return
    const imported = loadImportedIds()
    const fresh = items.filter((item) => !imported.has(item.id))
    if (!fresh.length) return

    const nodeId = settingsRef.current.nodeId
    const files: File[] = []
    const resolvedIds: string[] = []
    for (const item of fresh) {
      const result = await resolveItem(item, nodeId)
      if (result.kind === 'resolved') {
        files.push(result.file)
        resolvedIds.push(item.id)
      } else if (result.kind === 'permanent') {
        imported.add(item.id)
      }
      // 'transient': leave out of `imported` entirely so the next
      // republish/subscription tick or mount retries it.
    }
    if (!files.length) {
      saveImportedIds(imported)
      return
    }

    const folderId = ensureFolderId()
    try {
      await uploadFilesRef.current(toFileList(files), folderId)
      for (const id of resolvedIds) imported.add(id)
      saveImportedIds(imported)
      debugInfo('storage-drive-inbox', 'imported files from tc-note', { count: files.length, folderId })
    } catch (error) {
      // Persist the permanently-unresolvable ids even though the upload
      // itself failed; resolvable-but-unuploaded ids stay out of the set so
      // the next republish/subscription tick retries them.
      saveImportedIds(imported)
      debugWarn('storage-drive-inbox', 'import failed', { error: describeError(error, 'unknown error') })
    }
  }

  /** Imports any not-yet-seen items from an inbox record. Safe to call repeatedly. */
  function importFromInbox(record: SharedRecord): void {
    inFlight = inFlight.then(() => runImport(record)).catch(() => {})
  }

  return { importFromInbox }
}

export { driveInboxTopic }
