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
import type { Notice } from './appTypes.js'
import { addActivity, makeFolder, touchSnapshot, type StorageSnapshot } from '../storage/domain.js'
import type { AppSettings } from '../storage/localSettings.js'
import type { SharedRecord } from '../storage/sharedBus.js'
import { ensureMistRuntimeInitialized, loadMistModule } from '../storage/mistStorage.js'
import { describeError } from '../util/errors.js'
import { debugInfo, debugWarn } from '../util/logging.js'

const translationsInboxTopic = 'translations-inbox'
const inboxFolderName = 'TC Translate'
const importedIdsKey = 'tc-storage-translate-imported-v1'
const maxImportedIds = 1000
const textDecoder = new TextDecoder()

/** One translation to materialize as a file. Mirrors tc-translate.
 * `text` is the legacy inline body; new publishes carry `cid` (a plain,
 * unencrypted `storage_add` pointer to the Markdown body) instead. Dual-read:
 * prefer inline `text`, else fetch `cid`. */
interface TranslationInboxItem {
  id: string
  fileName: string
  mimeType: string
  text?: string
  cid?: string
}

interface TranslationsInboxOptions {
  snapshotRef: MutableRef<StorageSnapshot>
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  uploadFilesRef: MutableRef<(fileList: FileList | null, targetFolderId?: string | null) => Promise<void>>
  setNotice: SetState<Notice>
  /** Overridable for tests; defaults to the real mistlib-backed resolver. */
  resolveText?: (item: TranslationInboxItem, nodeId: string) => Promise<string | undefined>
}

function parseInboxItems(meta: Record<string, unknown>): TranslationInboxItem[] {
  const rawItems = (meta as { items?: unknown }).items
  if (!Array.isArray(rawItems)) return []
  const items: TranslationInboxItem[] = []
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id) continue
    const text = typeof item.text === 'string' ? item.text : undefined
    const cid = typeof item.cid === 'string' && item.cid ? item.cid : undefined
    if (text === undefined && !cid) continue
    const fileName = typeof item.fileName === 'string' && item.fileName ? item.fileName : `${item.id}.md`
    const mimeType = typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : 'text/markdown'
    items.push({ id: item.id, fileName, mimeType, text, cid })
  }
  return items
}

/** Resolves an inbox item's body: inline `text` if present (legacy publishes),
 * else `storage_get(cid)` (new publishes; the body is stored unencrypted, as
 * plain Markdown bytes). Returns undefined if neither is available. */
async function resolveItemText(item: TranslationInboxItem, nodeId: string): Promise<string | undefined> {
  if (item.text !== undefined) return item.text
  if (!item.cid) return undefined
  try {
    const mist = await loadMistModule()
    ensureMistRuntimeInitialized(mist, { nodeId })
    const bytes = await mist.storage_get(item.cid)
    return textDecoder.decode(bytes)
  } catch (error) {
    debugWarn('translations-inbox', 'storage_get failed for inbox item', { id: item.id, cid: item.cid, error: describeError(error, 'unknown error') })
    return undefined
  }
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
  const { snapshotRef, setSnapshot, settingsRef, uploadFilesRef, setNotice, resolveText = resolveItemText } = options
  // Serialize imports: several bus channels can fire for one update, and
  // uploadFiles is async, so we must not process the same items concurrently.
  let inFlight: Promise<void> = Promise.resolve()
  // Ids we've already surfaced a failure notice for, so a stable ongoing
  // failure (e.g. a CID that stays evicted across several retries) doesn't
  // re-notify on every mount/bus event. Cleared once an id resolves
  // successfully, so a later failure (e.g. after another eviction) notifies
  // again rather than going permanently silent.
  const noticedFailureIds = new Set<string>()

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
      // Update the ref synchronously so the upcoming uploadFiles call finds the
      // folder before React has committed the setSnapshot below.
      snapshotRef.current = next
      return next
    })
    return folderId
  }

  async function runImport(record: SharedRecord): Promise<void> {
    const items = parseInboxItems(record.meta)
    if (!items.length) return
    const imported = loadImportedIds()
    const fresh = items.filter((item) => !imported.has(item.id))
    if (!fresh.length) return
    const nodeId = settingsRef.current.nodeId
    const resolved: { item: TranslationInboxItem; text: string }[] = []
    const failedIds: string[] = []
    for (const item of fresh) {
      const text = await resolveText(item, nodeId)
      // Leave unresolved items out of `imported` so a later republish (or a
      // retry once mistlib/OPFS is available) can still pick them up.
      if (text !== undefined) {
        resolved.push({ item, text })
        noticedFailureIds.delete(item.id)
      } else {
        failedIds.push(item.id)
      }
    }
    // Surface a notice only when there's a failure we haven't already told
    // the user about, so a stable ongoing failure doesn't re-notify on every
    // retry (this function runs on every mount and shared-bus event).
    if (failedIds.some((id) => !noticedFailureIds.has(id))) {
      for (const id of failedIds) noticedFailureIds.add(id)
      setNotice({ tone: 'error', text: `翻訳の取り込みに失敗しました（${failedIds.length}件）。ストレージ同期後に自動で再試行します` })
    }
    if (!resolved.length) return
    const folderId = ensureFolderId()
    const files = resolved.map(({ item, text }) => new File([text], item.fileName, { type: item.mimeType }))
    try {
      await uploadFilesRef.current(toFileList(files), folderId)
      for (const { item } of resolved) imported.add(item.id)
      saveImportedIds(imported)
      debugInfo('translations-inbox', 'imported translations', { count: resolved.length, folderId })
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
