// Consumes the shared `note-doc-index` topic (published by tc-note on the
// same origin) and imports each note as a single Markdown file into a
// dedicated "tc-noteのノート" folder.
//
// Unlike storage-drive-inbox, the index is PLAINTEXT: each entry's `cid`
// points straight at the note's markdown bytes via mistlib's storage_get, no
// AES-GCM layer to unwrap. tc-note republishes its *entire* note index (max
// 500 entries) every time anything changes, and a note keeps its stable `id`
// across edits but gets a brand-new `cid` each time its content changes.
//
// This module keeps exactly one live file per note id, tracked in
// localStorage as `{ id: { cid, fileId } }`:
//  - unseen id -> fetch bytes, create a new file, remember {cid, fileId}.
//  - seen id, same cid -> nothing to do. This also means a file the user
//    deleted is never resurrected as long as the note hasn't changed again.
//  - seen id, new cid (the note was edited) -> if the previously-imported
//    file is still live, update its content in place (same fileId, bumped
//    version/checksum/size — the same kind of in-place content patch the
//    normal upload path performs, so nothing about the file's identity,
//    starred state, etc. is disturbed). If that file is missing or was
//    deleted by the user, treat it like a brand-new import instead: the old
//    row is already gone, so this can never leave two live copies, and it
//    lets the user re-pull a note they deleted, once they've edited it again
//    (a fresh cid is the "re-import" signal since deletion isn't itself
//    propagated on this bus).
//
// Fetching a note's bytes (mistlib module load / storage_get) can fail
// transiently; those ids are simply left out of the tracked state so the
// next bus event or mount retries them, mirroring the storage-drive-inbox
// fix in appDriveInbox.ts.
//
// Reliable file-id capture: the normal uploadFiles() pipeline
// (appFileActions.ts) does not return the id(s) it creates, and re-reading
// snapshotRef after awaiting it is not safe here — snapshotRef is only kept
// in sync with React state by a `useEffect` (see useAppEffects.ts), which
// flushes after paint, so it can still be stale immediately after uploadFiles
// resolves. Instead this module builds the FileRecord itself with
// makeFileFromDataUrl({ id: makeId('file'), ... }) — the same lower-level
// domain call the upload path uses internally — and merges it into the
// snapshot synchronously (the same snapshotRef.current = next; setSnapshot
// pattern ensureFolderId already uses below), so the id is known immediately
// and deterministically. Content durability across reloads is preserved the
// same way normal uploads get it: the file is (re)stored to mistlib in the
// background under the target folder's passphrase, which patches in a
// lastCid once that completes.
//
// Contract: topic `note-doc-index` (v1); entry shape is published by tc-note.
// See protocol/docs/data-contracts/docs/SHARED_BUS.md.

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

const noteDocIndexTopic = 'note-doc-index'
const inboxFolderName = 'tc-noteのノート'
const importedStateKey = 'tc-storage-note-doc-imported-v1'
const maxImportedEntries = 1000
const maxIndexEntries = 500
const defaultNoteTitle = '無題'
// eslint-disable-next-line no-control-regex -- deliberately matching literal Windows-invalid filename chars
const invalidFileNameChars = /[\\/:*?"<>|]/g

/** One entry in tc-note's published index. Mirrors tc-note's note-doc-index publisher. */
interface NoteDocIndexEntry {
  id: string
  title: string
  cid: string
  updatedAt: number
}

/** Tracks the last-imported cid and the resulting local fileId for one note id. */
interface ImportedNoteEntry {
  cid: string
  fileId: string
}

interface NoteDocInboxOptions {
  snapshotRef: MutableRef<StorageSnapshot>
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  folderKeysRef: MutableRef<Record<string, string>>
  setFolderKeys: SetState<Record<string, string>>
  setFileContentCache: SetState<Record<string, string>>
}

/** Strips characters that are invalid in Windows filenames and trims whitespace, falling back to a placeholder for an empty title. */
export function sanitizeNoteFileBaseName(title: string): string {
  const cleaned = title.replace(invalidFileNameChars, '').trim()
  return cleaned || defaultNoteTitle
}

function noteFileName(title: string): string {
  return `${sanitizeNoteFileBaseName(title)}.md`
}

/** Parses and validates the `notes` array out of a note-doc-index record's meta, capping at 500 entries. */
export function parseNoteDocEntries(meta: Record<string, unknown>): NoteDocIndexEntry[] {
  const rawNotes = (meta as { notes?: unknown }).notes
  if (!Array.isArray(rawNotes)) return []
  const entries: NoteDocIndexEntry[] = []
  for (const raw of rawNotes) {
    if (entries.length >= maxIndexEntries) break
    if (raw === null || typeof raw !== 'object') continue
    const note = raw as Record<string, unknown>
    if (typeof note.id !== 'string' || !note.id) continue
    if (typeof note.title !== 'string') continue
    if (typeof note.cid !== 'string' || !note.cid) continue
    if (typeof note.updatedAt !== 'number' || !Number.isFinite(note.updatedAt)) continue
    entries.push({ id: note.id, title: note.title, cid: note.cid, updatedAt: note.updatedAt })
  }
  return entries
}

/** Loads the persisted `{ id: { cid, fileId } }` import state. Tolerates missing/corrupt JSON. */
export function loadImportedNoteState(): Map<string, ImportedNoteEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(importedStateKey) ?? '') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    const record = parsed as Record<string, unknown>
    if (record.v !== 1) return new Map()
    const rawEntries = record.entries
    if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) return new Map()
    const map = new Map<string, ImportedNoteEntry>()
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
export function saveImportedNoteState(state: Map<string, ImportedNoteEntry>): void {
  const capped = [...state.entries()].slice(-maxImportedEntries)
  const entries: Record<string, ImportedNoteEntry> = {}
  for (const [id, entry] of capped) entries[id] = entry
  try {
    localStorage.setItem(importedStateKey, JSON.stringify({ v: 1, entries }))
  } catch (error) {
    debugWarn('note-doc-inbox', 'failed to persist imported note state', { error: describeError(error, 'unknown error') })
  }
}

/** Fetches a note's plaintext markdown bytes from mistlib. Returns undefined (and warns) on any transient failure. */
async function fetchNoteBytes(cid: string, nodeId: string): Promise<Uint8Array | undefined> {
  try {
    const mist = await loadMistModule()
    ensureMistRuntimeInitialized(mist, { nodeId })
    return await mist.storage_get(cid)
  } catch (error) {
    debugWarn('note-doc-inbox', 'failed to fetch note bytes; will retry on the next event', { cid, error: describeError(error, 'unknown error') })
    return undefined
  }
}

export function createNoteDocInboxActions(options: NoteDocInboxOptions) {
  const { snapshotRef, setSnapshot, settingsRef, folderKeysRef, setFolderKeys, setFileContentCache } = options
  // Serialize imports: several bus channels can fire for one update, and
  // storage_get/mist storage_add are async, so we must not process the same
  // entries concurrently.
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
    // Update the ref synchronously so subsequent lookups in this same
    // import pass see the folder before React has committed setSnapshot.
    snapshotRef.current = next
    setSnapshot(next)
    return folder.id
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
    const next = touchSnapshot(
      addActivity(
        { ...snapshotRef.current, files: [...snapshotRef.current.files, file] },
        { actorNodeId: settings.nodeId, fileId: file.id, folderId, action: 'file.upload', detail: `${file.name} を取り込み` },
        file.updatedAt,
      ),
      settings.nodeId,
    )
    snapshotRef.current = next
    setSnapshot(next)
  }

  function patchFileInSnapshot(fileId: string, patch: Partial<FileRecord>, now: string): FileRecord | undefined {
    const settings = settingsRef.current
    let patched: FileRecord | undefined
    const files = snapshotRef.current.files.map((file) => {
      if (file.id !== fileId) return file
      patched = stampFilePatch(file, patch, now, settings.nodeId)
      return patched
    })
    if (!patched) return undefined
    const next = touchSnapshot({ ...snapshotRef.current, files }, settings.nodeId)
    snapshotRef.current = next
    setSnapshot(next)
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
      debugWarn('note-doc-inbox', 'background mist storage failed for note file', { fileId: file.id, error: describeError(error, 'unknown error') })
    }
  }

  async function importNote(entry: NoteDocIndexEntry, bytes: Uint8Array, folderId: string): Promise<string> {
    const settings = settingsRef.current
    const now = new Date().toISOString()
    const checksum = await sha256Hex(bytes)
    const dataUrl = `data:text/markdown;base64,${bytesToBase64(bytes)}`
    const file = makeFileFromDataUrl({
      id: makeId('file'),
      folderId,
      name: noteFileName(entry.title),
      mimeType: 'text/markdown',
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

  async function replaceNoteContent(entry: NoteDocIndexEntry, bytes: Uint8Array, previousFile: FileRecord, folderId: string): Promise<string> {
    const now = new Date().toISOString()
    const checksum = await sha256Hex(bytes)
    const dataUrl = `data:text/markdown;base64,${bytesToBase64(bytes)}`
    setFileContentCache((current) => ({ ...current, [previousFile.id]: dataUrl }))
    const patched = patchFileInSnapshot(previousFile.id, {
      name: noteFileName(entry.title),
      mimeType: 'text/markdown',
      size: bytes.byteLength,
      checksum,
      version: previousFile.version + 1,
      lastCid: undefined,
    }, now)
    if (patched) void storeFileInMistBackground({ ...patched, dataUrl }, folderId)
    return previousFile.id
  }

  async function runImport(record: SharedRecord): Promise<void> {
    const entries = parseNoteDocEntries(record.meta)
    if (!entries.length) return
    const state = loadImportedNoteState()
    const nodeId = settingsRef.current.nodeId
    let folderId: string | undefined
    let dirty = false
    for (const entry of entries) {
      const existing = state.get(entry.id)
      // Same cid as last time: nothing changed. This also means a file the
      // user deleted stays deleted until the note is edited again.
      if (existing && existing.cid === entry.cid) continue
      const bytes = await fetchNoteBytes(entry.cid, nodeId)
      if (!bytes) continue // transient failure: leave untouched, retry next event/mount
      folderId ??= ensureFolderId()
      const previousFile = existing ? snapshotRef.current.files.find((item) => item.id === existing.fileId) : undefined
      const fileId = existing && previousFile && !previousFile.deletedAt
        ? await replaceNoteContent(entry, bytes, previousFile, folderId)
        : await importNote(entry, bytes, folderId)
      state.set(entry.id, { cid: entry.cid, fileId })
      dirty = true
    }
    if (dirty) saveImportedNoteState(state)
  }

  /** Imports any new/changed notes from a note-doc-index record. Safe to call repeatedly. */
  function importFromIndex(record: SharedRecord): void {
    inFlight = inFlight.then(() => runImport(record)).catch(() => {})
  }

  return { importFromIndex }
}

export { noteDocIndexTopic }
