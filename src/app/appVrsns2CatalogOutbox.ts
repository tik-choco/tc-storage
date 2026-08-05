// Publishes this app's "TC Space" folder as a rolling, encrypted catalog on
// the shared bus's `vrsns2-catalog-inbox` topic, so tc-vrsns2 can pull
// whatever the user has placed there into its own object catalog. This is
// the reverse direction of appVrsns2SpaceInbox.ts (tc-vrsns2 -> tc-storage,
// plaintext, already implemented): here it is tc-storage -> tc-vrsns2. See
// protocol/docs/data-contracts/docs/SHARED_BUS.md for the wire contract.
//
// Why this side encrypts and vrsns2-space-inbox does not: tc-vrsns2 already
// publishes its catalog bytes to the shared, potentially P2P-visible mistlib
// content store before appVrsns2SpaceInbox.ts ever sees them -- importing
// them here adds no new exposure. This app's own files are the opposite:
// they live in an encrypted vault whose folder keys never leave this app.
// Publishing one here to a shared, cross-app content store would be a brand
// new plaintext exposure, so -- exactly like storage-drive-inbox's publisher
// (tc-note/src/lib/storageDriveInbox.ts) and town-backup -- every item gets
// its own disposable, single-use AES-256-GCM key generated just for this
// publish. The raw key and IV travel only on the shared bus record itself
// (same-origin localStorage + BroadcastChannel, never the content store), so
// the only thing that ever reaches the shared mistlib content store is
// ciphertext.
//
// Echo-loop prevention (two independent defenses; see SPEC-SPACE, both are
// required): the "TC Space" folder already contains files that arrived FROM
// tc-vrsns2 via vrsns2-space-inbox (appVrsns2SpaceInbox.ts). Publishing
// those straight back would round-trip forever, so any file whose id shows
// up as an `entry.fileId` in that module's own import state
// (tc-storage-vrsns2-space-imported-v1) is excluded below -- "what came from
// vrsns2 does not go back to vrsns2". tc-vrsns2 carries its own, independent
// half of this defense on its side (foreign-origin catalog items are
// excluded from its outbound snapshot), so a bug in either half alone still
// cannot produce an infinite loop.
//
// Re-encryption cache: a fresh key + IV is generated on every encryption by
// construction, so ciphertext (and therefore its cid) is never stable across
// runs of this module even when the plaintext hasn't changed one bit.
// Without a cache, every debounced publish would mint a brand-new cid for
// every file, and the consumer (which decides "is this a new item?" by
// id+cid, same as every other inbox-family topic) would re-import the same
// bytes as a "new" catalog entry forever. `publishedStateKey` remembers the
// last published {checksum, cid, key, iv} per local fileId and reuses it
// verbatim whenever the plaintext checksum (FileRecord#checksum, which this
// app already keeps in sync with content on every edit) hasn't changed --
// this is the load-bearing piece of this module; do not skip it.
//
// Never throws: a publish failure (mist not initialized, storage_add/quota,
// Web Crypto unavailable, ...) is logged via debugWarn and otherwise
// swallowed. This is a best-effort side channel to a sibling app -- it must
// never block or fail a normal drive operation in this one.

import type { MutableRef } from './appControllerTypes.js'
import { sha256Hex } from '../crypto/crypto.js'
import { bytesToBase64 } from '../crypto/cryptoEncoding.js'
import { filesInFolder, type FileRecord, type StorageSnapshot } from '../storage/domain.js'
import type { AppSettings } from '../storage/localSettings.js'
import { assertMistStorageAvailable, ensureMistRuntimeInitialized, loadMistModule } from '../storage/mistStorage.js'
import { publishShared } from '../storage/sharedBus.js'
import { dataUrlToBytes } from '../util/zip.js'
import { describeError } from '../util/errors.js'
import { debugWarn } from '../util/logging.js'
import { loadImportedSpaceState } from './appVrsns2SpaceInbox.js'

const vrsns2CatalogOutboxTopic = 'vrsns2-catalog-inbox'

// Mirrors appVrsns2SpaceInbox.ts's own (unexported) `inboxFolderName`.
// Duplicated rather than imported only because that module doesn't export
// it; the two MUST stay equal, since both read/write the same physical "TC
// Space" folder in this app's own snapshot -- one drops files into it, the
// other reads whatever is sitting in it (minus what the first one put
// there, see the echo-loop guard below).
const inboxFolderName = 'TC Space'

const publishedStateKey = 'tc-storage-vrsns2-catalog-published-v1'
/** Same cap and rationale as storage-drive-inbox's MAX_INBOX_ITEMS: a rolling shared-bus record has to stay well under the localStorage quota. Exported for tests. */
export const maxOutboxItems = 50
/** Same cap style as appVrsns2SpaceInbox's maxImportedEntries -- the published-item cache can outlive individual outbox rounds (a file dropped, then removed from the folder, still leaves a cache entry), so it needs its own independent ceiling. */
const maxCachedEntries = 1000
/**
 * Upload cap for one catalog item, matching tc-vrsns2's own placement cap
 * (MAX_PLACEABLE_BYTES, tc-vrsns2's src/world/mediaFormat.ts, currently 64 MB)
 * so this app never spends a storage_add + AES-GCM pass on something the far
 * side would just reject on arrival. Duplicated by value, not imported --
 * tc-vrsns2 is a separate repository/deploy -- so keep this in sync by hand
 * if that constant ever changes. Exported for tests.
 */
export const maxItemBytes = 64 * 1024 * 1024

/** One item in the `vrsns2-catalog-inbox` topic's `meta.items` list. Mirrors tc-vrsns2's CatalogInboxItem -- see protocol/docs/data-contracts/docs/SHARED_BUS.md. */
export interface CatalogOutboxItem {
  /** This app's own (stable) fileId. Not a cid: the cid changes on every re-encryption, the fileId never does. */
  id: string
  name: string
  /** mistlib storage_add cid of the AES-GCM-encrypted bytes. */
  cid: string
  /** Base64 raw AES-256-GCM key material, unique to this item. */
  key: string
  /** Base64 96-bit AES-GCM IV. */
  iv: string
  mimeType: string
  size: number
  /** SHA-256 hex digest of the plaintext bytes, for the consumer to verify after it decrypts. */
  checksum: string
  updatedAt: string
}

/** Tracks the last-published {checksum, cid, key, iv} for one local fileId, so an unchanged file is never re-encrypted. */
interface PublishedCatalogEntry {
  checksum: string
  cid: string
  key: string
  iv: string
}

/** Loads the persisted `{ fileId: { checksum, cid, key, iv } }` publish cache. Tolerates missing/corrupt JSON, mirroring appVrsns2SpaceInbox's loadImportedSpaceState. */
export function loadPublishedCatalogState(): Map<string, PublishedCatalogEntry> {
  try {
    const parsed = JSON.parse(localStorage.getItem(publishedStateKey) ?? '') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
    const record = parsed as Record<string, unknown>
    if (record.v !== 1) return new Map()
    const rawEntries = record.entries
    if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) return new Map()
    const map = new Map<string, PublishedCatalogEntry>()
    for (const [fileId, value] of Object.entries(rawEntries as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      if (typeof entry.checksum !== 'string' || !entry.checksum) continue
      if (typeof entry.cid !== 'string' || !entry.cid) continue
      if (typeof entry.key !== 'string' || !entry.key) continue
      if (typeof entry.iv !== 'string' || !entry.iv) continue
      map.set(fileId, { checksum: entry.checksum, cid: entry.cid, key: entry.key, iv: entry.iv })
    }
    return map
  } catch {
    return new Map()
  }
}

/** Persists the publish cache, keeping only the most recently touched maxCachedEntries entries. */
export function savePublishedCatalogState(state: Map<string, PublishedCatalogEntry>): void {
  const capped = [...state.entries()].slice(-maxCachedEntries)
  const entries: Record<string, PublishedCatalogEntry> = {}
  for (const [fileId, entry] of capped) entries[fileId] = entry
  try {
    localStorage.setItem(publishedStateKey, JSON.stringify({ v: 1, entries }))
  } catch (error) {
    debugWarn('vrsns2-catalog-outbox', 'failed to persist published catalog state', { error: describeError(error, 'unknown error') })
  }
}

/**
 * Local fileIds that were themselves imported FROM tc-vrsns2 (see
 * appVrsns2SpaceInbox.ts's loadImportedSpaceState: its entries are keyed by
 * the vrsns2-side item id and each carries the resulting local fileId).
 * Excluding these is half of the echo-loop defense -- see this module's
 * header.
 */
function importedFileIds(): Set<string> {
  const ids = new Set<string>()
  for (const entry of loadImportedSpaceState().values()) ids.add(entry.fileId)
  return ids
}

/**
 * Picks which files in the "TC Space" folder are eligible to publish this
 * round: not something that came from tc-vrsns2 in the first place, not
 * bigger than tc-vrsns2 could ever place, then the most recently updated
 * maxOutboxItems of what's left (filtering before capping, so an old but
 * still-eligible file never displaces a newer one just because of sort
 * order). Pure and independently testable -- no I/O.
 */
export function selectOutboxCandidates(files: FileRecord[], excludedFileIds: ReadonlySet<string>): FileRecord[] {
  return files
    .filter((file) => !excludedFileIds.has(file.id) && file.size <= maxItemBytes)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, maxOutboxItems)
}

function toWireItem(file: FileRecord, entry: PublishedCatalogEntry): CatalogOutboxItem {
  return {
    id: file.id,
    name: file.name,
    cid: entry.cid,
    key: entry.key,
    iv: entry.iv,
    mimeType: file.mimeType,
    size: file.size,
    checksum: entry.checksum,
    updatedAt: file.updatedAt,
  }
}

async function encryptItemBytes(bytes: Uint8Array): Promise<{ ciphertext: Uint8Array; key: string; iv: string }> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, cryptoKey, bytes as BufferSource))
  return { ciphertext, key: bytesToBase64(keyBytes), iv: bytesToBase64(iv) }
}

async function defaultUploadCiphertext(name: string, ciphertext: Uint8Array, nodeId: string): Promise<string> {
  assertMistStorageAvailable()
  const mist = await loadMistModule()
  ensureMistRuntimeInitialized(mist, { nodeId })
  return mist.storage_add_pinned(name, ciphertext)
}

async function defaultUnpinCid(cid: string, nodeId: string): Promise<void> {
  const mist = await loadMistModule()
  ensureMistRuntimeInitialized(mist, { nodeId })
  await mist.storage_unpin(cid)
}

interface Vrsns2CatalogOutboxOptions {
  snapshotRef: MutableRef<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
  /** Same cache the rest of the app keeps for previews (see useAppController's fileDataUrls): dataUrl by fileId. This module never fetches content on its own -- a file with nothing cached here is simply skipped this round (see the module header on why: `本文…取得を試みるのではなく単にスキップ`). */
  fileContentCacheRef: MutableRef<Record<string, string>>
  /** Overridable for tests; defaults to a real mistlib storage_add_pinned. */
  uploadCiphertext?: (name: string, ciphertext: Uint8Array, nodeId: string) => Promise<string>
  /** Overridable for tests; defaults to a real mistlib storage_unpin. Best-effort: a failure here only leaves a superseded cid pinned, it does not fail the publish. */
  unpinCid?: (cid: string, nodeId: string) => Promise<void>
}

export function createVrsns2CatalogOutboxActions(options: Vrsns2CatalogOutboxOptions) {
  const { snapshotRef, settingsRef, fileContentCacheRef, uploadCiphertext = defaultUploadCiphertext, unpinCid = defaultUnpinCid } = options
  // Serialize publishes for the same reason appVrsns2SpaceInbox serializes
  // imports: several triggers can overlap (a burst of snapshot changes each
  // scheduling their own debounced publish), and encrypt/storage_add are
  // async, so two runs must never race on the same cache read-modify-write.
  let inFlight: Promise<void> = Promise.resolve()

  async function runPublish(): Promise<void> {
    const snapshotValue = snapshotRef.current
    const nodeId = settingsRef.current.nodeId
    const folder = snapshotValue.folders.find((entry) => !entry.deletedAt && entry.parentId === null && entry.name === inboxFolderName)
    if (!folder) {
      // Nothing to publish yet (the folder is created lazily by
      // appVrsns2SpaceInbox on its first import, or by the user dropping a
      // file into a folder with this name). Still publish the empty list so
      // a consumer that already has a stale non-empty record from a folder
      // that was since emptied/deleted converges to "nothing here".
      publishShared(vrsns2CatalogOutboxTopic, '', { v: 1, items: [] })
      return
    }
    const excluded = importedFileIds()
    const candidates = selectOutboxCandidates(filesInFolder(snapshotValue, folder.id), excluded)
    const publishedState = loadPublishedCatalogState()
    const items: CatalogOutboxItem[] = []
    let stateDirty = false
    for (const file of candidates) {
      const cached = publishedState.get(file.id)
      if (cached && cached.checksum === file.checksum) {
        // Unchanged since the last publish: reuse the cid/key/iv verbatim
        // rather than re-encrypting (see module header -- this is the
        // load-bearing cache hit).
        items.push(toWireItem(file, cached))
        continue
      }
      const dataUrl = file.dataUrl ?? fileContentCacheRef.current[file.id]
      if (!dataUrl) continue // no plaintext locally right now -- skip, retry on the next publish
      try {
        const bytes = dataUrlToBytes(dataUrl)
        const checksum = await sha256Hex(bytes)
        const { ciphertext, key, iv } = await encryptItemBytes(bytes)
        const cid = await uploadCiphertext(`${file.id}.tc-vrsns2-catalog.enc`, ciphertext, nodeId)
        if (cached && cached.cid && cached.cid !== cid) {
          try {
            await unpinCid(cached.cid, nodeId)
          } catch (error) {
            debugWarn('vrsns2-catalog-outbox', 'failed to unpin superseded catalog cid (non-fatal, leaves it pinned)', { fileId: file.id, cid: cached.cid, error: describeError(error, 'unknown error') })
          }
        }
        const entry: PublishedCatalogEntry = { checksum, cid, key, iv }
        publishedState.set(file.id, entry)
        stateDirty = true
        items.push(toWireItem(file, entry))
      } catch (error) {
        // storage_add failure, quota, Web Crypto unavailable, malformed
        // dataUrl, mist not initialized, ... -- whatever it is, this one
        // item just doesn't make it into this round; nothing here is fatal
        // to the rest of the publish (see module header: never throw).
        debugWarn('vrsns2-catalog-outbox', 'failed to encrypt/publish item; skipping it this round', { fileId: file.id, error: describeError(error, 'unknown error') })
      }
    }
    if (stateDirty) savePublishedCatalogState(publishedState)
    publishShared(vrsns2CatalogOutboxTopic, '', { v: 1, items })
  }

  /**
   * Recomputes and republishes the full catalog snapshot from the current
   * "TC Space" folder. Safe to call repeatedly -- overlapping calls are
   * serialized on `inFlight` rather than racing. Never throws; the returned
   * promise always resolves (never rejects), so callers that don't care
   * about completion (e.g. the debounced effect in useAppController.tsx)
   * can call this and ignore the result, while tests can `await` it for a
   * deterministic finish instead of guessing at a settle delay.
   */
  function publishCatalogOutbox(): Promise<void> {
    const run = inFlight.then(() => runPublish()).catch((error: unknown) => {
      debugWarn('vrsns2-catalog-outbox', 'publish failed', { error: describeError(error, 'unknown error') })
    })
    inFlight = run
    return run
  }

  return { publishCatalogOutbox }
}

export { vrsns2CatalogOutboxTopic }
