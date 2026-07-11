// Consumes the shared `translations-inbox` topic (published by tc-translate on
// the same origin) and materializes each new translation as a Markdown file in
// a dedicated "TC Translate" folder, reusing the normal upload flow so files
// are checksummed, added to the drive, and stored to mistlib in the background.
//
// Items are deduped by their stable `id` (persisted in localStorage), so a
// republished index never creates duplicates and user deletions are respected.
//
// Contract: topic `translations-inbox` (v1); item shape mirrors tc-translate
// (src/lib/shareToStorage.ts). See
// protocol/docs/data-contracts/docs/SHARED_BUS.md.

import type { MutableRef, SetState } from './appControllerTypes.js'
import { addActivity, makeFolder, touchSnapshot, type StorageSnapshot } from '../storage/domain.js'
import type { AppSettings } from '../storage/localSettings.js'
import type { SharedRecord } from '../storage/sharedBus.js'
import { describeError } from '../util/errors.js'
import { debugInfo, debugWarn } from '../util/logging.js'

const translationsInboxTopic = 'translations-inbox'
const inboxFolderName = 'TC Translate'
const importedIdsKey = 'tc-storage-translate-imported-v1'
const maxImportedIds = 1000

/** One translation to materialize as a file. Mirrors tc-translate. */
interface TranslationInboxItem {
  id: string
  fileName: string
  mimeType: string
  text: string
}

interface TranslationsInboxOptions {
  snapshotRef: MutableRef<StorageSnapshot>
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  uploadFilesRef: MutableRef<(fileList: FileList | null, targetFolderId?: string | null) => Promise<void>>
}

function parseInboxItems(meta: Record<string, unknown>): TranslationInboxItem[] {
  const rawItems = (meta as { items?: unknown }).items
  if (!Array.isArray(rawItems)) return []
  const items: TranslationInboxItem[] = []
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id) continue
    if (typeof item.text !== 'string') continue
    const fileName = typeof item.fileName === 'string' && item.fileName ? item.fileName : `${item.id}.md`
    const mimeType = typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : 'text/markdown'
    items.push({ id: item.id, fileName, mimeType, text: item.text })
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
    debugWarn('translations-inbox', 'failed to persist imported ids', { error: describeError(error, 'unknown error') })
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

export function createTranslationsInboxActions(options: TranslationsInboxOptions) {
  const { snapshotRef, setSnapshot, settingsRef, uploadFilesRef } = options
  // Serialize imports: several bus channels can fire for one update, and
  // uploadFiles is async, so we must not process the same items concurrently.
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
    const folderId = ensureFolderId()
    const files = fresh.map((item) => new File([item.text], item.fileName, { type: item.mimeType }))
    try {
      await uploadFilesRef.current(toFileList(files), folderId)
      for (const item of fresh) imported.add(item.id)
      saveImportedIds(imported)
      debugInfo('translations-inbox', 'imported translations', { count: fresh.length, folderId })
    } catch (error) {
      debugWarn('translations-inbox', 'import failed', { error: describeError(error, 'unknown error') })
    }
  }

  /** Imports any not-yet-seen items from an inbox record. Safe to call repeatedly. */
  function importFromInbox(record: SharedRecord): void {
    inFlight = inFlight.then(() => runImport(record)).catch(() => {})
  }

  return { importFromInbox }
}

export { translationsInboxTopic }
