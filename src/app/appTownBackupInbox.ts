// Consumes the shared `town-backup` topic (published by tc-town on the same
// origin) and mirrors it as a single auto-updating file
// `tc-town-backup.json` in a dedicated "TC Town" folder.
//
// tc-town auto-publishes its full data bundle (characters/worlds/settings)
// on every change, but only republishes when the content actually changed
// (see the contract doc). The record's `cid` is always "" and the payload
// lives entirely in `meta.item`, which points at an AES-256-GCM-encrypted
// blob via mistlib's storage_get/storage_add, mirroring the encryption model
// of `storage-drive-inbox` (appDriveInbox.ts): fetch ciphertext with
// `storage_get(cid)`, decrypt with the item's own key/iv, then verify the
// plaintext's SHA-256 checksum before trusting it.
//
// Unlike storage-drive-inbox (many items, deduped by stable id) this topic
// carries exactly one logical file, but the same "exactly one live file"
// bookkeeping as note-doc-index (appNoteDocInbox.ts) applies: state is keyed
// by the item's stable `id` and tracks the last-imported plaintext
// `checksum` (NOT the cid, which is meaningless across re-encryptions of
// identical content) plus the resulting local fileId.
//  - unseen id, or seen id with the same checksum -> nothing to do (this also
//    means a file the user deleted in tc-storage stays deleted until
//    tc-town's data actually changes again).
//  - seen id, new checksum, previously-imported file still live -> patch its
//    content in place (same fileId, bumped version/checksum/size, name/
//    mimeType refreshed, lastCid cleared and re-stored to mist in the
//    background) — mirrors appNoteDocInbox's replaceNoteContent.
//  - seen id, new checksum, previous file missing/deleted -> treat like a
//    brand-new import instead (mirrors appNoteDocInbox/importNote).
//
// Failure classification mirrors appDriveInbox: mist module load /
// storage_get failures are TRANSIENT (leave state untouched, retry next bus
// event or mount); decrypt failure or checksum mismatch are PERMANENT (the
// ciphertext is immutable for that cid, so retrying can never succeed) — the
// checksum is recorded with an empty fileId (a tombstone: "seen, but nothing
// live to reuse") so it is never retried, yet a later checksum change still
// resolves as a fresh import rather than an in-place patch.
//
// Contract: topic `town-backup` (v1); item shape is published by tc-town.
// See protocol/docs/data-contracts/docs/SHARED_BUS.md.

import type { MutableRef, SetState } from './appControllerTypes.js'
import { sha256Hex } from '../crypto/crypto.js'
import { base64ToBytes, bytesToBase64, toArrayBuffer } from '../crypto/cryptoEncoding.js'
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

const townBackupTopic = 'town-backup'
const inboxFolderName = 'TC Town'
const importedStateKey = 'tc-storage-town-backup-imported-v1'
const maxImportedEntries = 1000

/** One item published on the town-backup topic. Mirrors tc-town's publisher. */
export interface TownBackupItem {
  id: string
  name: string
  mimeType: string
  size: number
  checksum: string
  cid: string
  key: string
  iv: string
  updatedAt: string
}

/** Tracks the last-imported plaintext checksum and the resulting local fileId for one item id. An empty fileId is a tombstone: seen (and permanently unresolvable at that checksum), but nothing live to reuse. */
interface ImportedTownBackupEntry {
  checksum: string
  fileId: string
}

interface TownBackupInboxOptions {
  snapshotRef: MutableRef<StorageSnapshot>
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  folderKeysRef: MutableRef<Record<string, string>>
  setFolderKeys: SetState<Record<string, string>>
  setFileContentCache: SetState<Record<string, string>>
  /** Overridable for tests; defaults to the real mistlib-backed resolver. */
  resolveItem?: (item: TownBackupItem, nodeId: string) => Promise<ResolveTownBackupResult>
}

/** Outcome of resolving the item: usable plaintext bytes, a permanent (unrecoverable) failure, or a transient one worth retrying later. */
export type ResolveTownBackupResult =
  | { kind: 'resolved'; bytes: Uint8Array }
  | { kind: 'permanent' }
  | { kind: 'transient' }

/** Parses and validates `meta.item` from a town-backup record. Returns undefined on any malformed field; never throws. */
export function parseTownBackupItem(meta: Record<string, unknown>): TownBackupItem | undefined {
  if (meta.v !== 1) return undefined
  const rawItem = (meta as { item?: unknown }).item
  if (rawItem === null || typeof rawItem !== 'object') return undefined
  const item = rawItem as Record<string, unknown>
  if (typeof item.id !== 'string' || !item.id) return undefined
  if (typeof item.name !== 'string' || !item.name) return undefined
  if (typeof item.mimeType !== 'string' || !item.mimeType) return undefined
  if (typeof item.size !== 'number' || !Number.isFinite(item.size) || item.size < 0) return undefined
  if (typeof item.checksum !== 'string' || !item.checksum) return undefined
  if (typeof item.cid !== 'string' || !item.cid) return undefined
  if (typeof item.key !== 'string' || !item.key) return undefined
  if (typeof item.iv !== 'string' || !item.iv) return undefined
  if (typeof item.updatedAt !== 'string' || !item.updatedAt) return undefined
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    checksum: item.checksum,
    cid: item.cid,
    key: item.key,
    iv: item.iv,
    updatedAt: item.updatedAt,
  }
}

/** Loads the persisted `{ id: { checksum, fileId } }` import state. Tolerates missing/corrupt JSON. */
export function loadImportedTownBackupState(): Map<string, ImportedTownBackupEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(importedStateKey) ?? '') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    const record = parsed as Record<string, unknown>
    if (record.v !== 1) return new Map()
    const rawEntries = record.entries
    if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) return new Map()
    const map = new Map<string, ImportedTownBackupEntry>()
    for (const [id, value] of Object.entries(rawEntries as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      if (typeof entry.checksum !== 'string' || !entry.checksum) continue
      if (typeof entry.fileId !== 'string') continue
      map.set(id, { checksum: entry.checksum, fileId: entry.fileId })
    }
    return map
  } catch {
    return new Map()
  }
}

/** Persists the import state, keeping only the most recently touched entries. */
export function saveImportedTownBackupState(state: Map<string, ImportedTownBackupEntry>): void {
  const capped = [...state.entries()].slice(-maxImportedEntries)
  const entries: Record<string, ImportedTownBackupEntry> = {}
  for (const [id, entry] of capped) entries[id] = entry
  try {
    localStorage.setItem(importedStateKey, JSON.stringify({ v: 1, entries }))
  } catch (error) {
    debugWarn('town-backup-inbox', 'failed to persist imported state', { error: describeError(error, 'unknown error') })
  }
}

/** Fetches, decrypts, and checksum-verifies the item's ciphertext. Distinguishes unrecoverable failures (checksum mismatch, decrypt failure) from transient ones (mist module load / storage_get failures) so callers can retry only the latter. */
async function resolveTownBackupItem(item: TownBackupItem, nodeId: string): Promise<ResolveTownBackupResult> {
  let cipherText: Uint8Array
  try {
    const mist = await loadMistModule()
    ensureMistRuntimeInitialized(mist, { nodeId })
    cipherText = await mist.storage_get(item.cid)
  } catch (error) {
    debugWarn('town-backup-inbox', 'transient failure resolving item; will retry later', { id: item.id, cid: item.cid, error: describeError(error, 'unknown error') })
    return { kind: 'transient' }
  }
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(base64ToBytes(item.key)), 'AES-GCM', false, ['decrypt'])
    const iv = base64ToBytes(item.iv)
    const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, cryptoKey, toArrayBuffer(cipherText))
    const plainBytes = new Uint8Array(plainBuffer)
    const checksum = await sha256Hex(plainBytes)
    if (checksum !== item.checksum) {
      debugWarn('town-backup-inbox', 'checksum mismatch, marking permanent', { id: item.id, cid: item.cid })
      return { kind: 'permanent' }
    }
    return { kind: 'resolved', bytes: plainBytes }
  } catch (error) {
    debugWarn('town-backup-inbox', 'failed to decrypt item, marking permanent', { id: item.id, cid: item.cid, error: describeError(error, 'unknown error') })
    return { kind: 'permanent' }
  }
}

export function createTownBackupInboxActions(options: TownBackupInboxOptions) {
  const { snapshotRef, setSnapshot, settingsRef, folderKeysRef, setFolderKeys, setFileContentCache, resolveItem = resolveTownBackupItem } = options
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
      // Update the ref synchronously so subsequent lookups in this same import
      // pass see the folder before React has committed setSnapshot.
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
      debugWarn('town-backup-inbox', 'background mist storage failed for town backup file', { fileId: file.id, error: describeError(error, 'unknown error') })
    }
  }

  async function importBackup(item: TownBackupItem, bytes: Uint8Array, folderId: string): Promise<string> {
    const settings = settingsRef.current
    const now = new Date().toISOString()
    const dataUrl = `data:${item.mimeType};base64,${bytesToBase64(bytes)}`
    const file = makeFileFromDataUrl({
      id: makeId('file'),
      folderId,
      name: item.name,
      mimeType: item.mimeType,
      size: bytes.byteLength,
      dataUrl,
      checksum: item.checksum,
      now,
      nodeId: settings.nodeId,
    })
    setFileContentCache((current) => ({ ...current, [file.id]: dataUrl }))
    addFileToSnapshot(stripFileContent(file), folderId)
    void storeFileInMistBackground(file, folderId)
    return file.id
  }

  async function replaceBackupContent(item: TownBackupItem, bytes: Uint8Array, previousFile: FileRecord, folderId: string): Promise<string> {
    const now = new Date().toISOString()
    const dataUrl = `data:${item.mimeType};base64,${bytesToBase64(bytes)}`
    setFileContentCache((current) => ({ ...current, [previousFile.id]: dataUrl }))
    const patched = patchFileInSnapshot(previousFile.id, {
      name: item.name,
      mimeType: item.mimeType,
      size: bytes.byteLength,
      checksum: item.checksum,
      version: previousFile.version + 1,
      lastCid: undefined,
    }, now)
    if (patched) void storeFileInMistBackground({ ...patched, dataUrl }, folderId)
    return previousFile.id
  }

  async function runImport(record: SharedRecord): Promise<void> {
    const item = parseTownBackupItem(record.meta)
    if (!item) return
    const state = loadImportedTownBackupState()
    const existing = state.get(item.id)
    // Same checksum as last time: nothing changed. This also means a file
    // the user deleted stays deleted until tc-town's data actually changes
    // again. This also covers previously-permanent failures at this exact
    // checksum (tombstoned with an empty fileId), so they are never retried.
    if (existing && existing.checksum === item.checksum) return

    const nodeId = settingsRef.current.nodeId
    const result = await resolveItem(item, nodeId)
    if (result.kind === 'transient') return // leave state untouched; retry next event/mount
    if (result.kind === 'permanent') {
      state.set(item.id, { checksum: item.checksum, fileId: '' })
      saveImportedTownBackupState(state)
      return
    }

    const folderId = ensureFolderId()
    const previousFile = existing?.fileId ? snapshotRef.current.files.find((file) => file.id === existing.fileId) : undefined
    const fileId = previousFile && !previousFile.deletedAt
      ? await replaceBackupContent(item, result.bytes, previousFile, folderId)
      : await importBackup(item, result.bytes, folderId)
    state.set(item.id, { checksum: item.checksum, fileId })
    saveImportedTownBackupState(state)
  }

  /** Imports the town backup from a town-backup record if its checksum changed. Safe to call repeatedly. */
  function importFromBackup(record: SharedRecord): void {
    inFlight = inFlight.then(() => runImport(record)).catch(() => {})
  }

  return { importFromBackup }
}

export { townBackupTopic }
