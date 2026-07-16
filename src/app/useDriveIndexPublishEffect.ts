import { useEffect } from 'preact/hooks'
import type { MutableRef } from './appControllerTypes.js'
import { buildDriveIndex, driveIndexTopic } from '../storage/driveIndex.js'
import { publishShared } from '../storage/sharedBus.js'
import { assertMistStorageAvailable, ensureMistRuntimeInitialized, loadMistModule } from '../storage/mistStorage.js'
import type { AppSettings } from '../storage/localSettings.js'
import type { StorageSnapshot } from '../storage/domain.js'
import { debugWarn } from '../util/logging.js'

const publishDebounceMs = 1000
const encoder = new TextEncoder()
let lastPinnedDriveIndexCid = ''

interface DriveIndexPublishEffectOptions {
  folderKeys: Record<string, string>
  settingsRef: MutableRef<AppSettings>
  snapshot: StorageSnapshot
}

/** Publishes this workspace's file index to the `drive-index` shared-bus
 * topic whenever the snapshot or folder keys change (debounced), and once
 * on startup. Lets other apps resolve files without reading this app's
 * internal snapshot/key storage.
 *
 * The index (which can grow without bound as the drive fills up) is
 * content-addressed via `storage_add` rather than inlined in `meta`, so this
 * key doesn't blow the shared localStorage quota; `meta` only carries a small
 * `{count, updatedAt}` summary. See
 * docs/data-contracts/docs/SHARED_BUS.md for the full contract. */
export function useDriveIndexPublishEffect(options: DriveIndexPublishEffectOptions): void {
  const { folderKeys, settingsRef, snapshot } = options

  useEffect(() => {
    const timer = setTimeout(() => {
      void publishDriveIndex(snapshot, folderKeys, settingsRef.current.nodeId)
    }, publishDebounceMs)
    return () => clearTimeout(timer)
  }, [folderKeys, snapshot])
}

async function publishDriveIndex(snapshot: StorageSnapshot, folderKeys: Record<string, string>, nodeId: string): Promise<void> {
  const index = buildDriveIndex(snapshot, folderKeys)
  try {
    assertMistStorageAvailable()
    const mist = await loadMistModule()
    ensureMistRuntimeInitialized(mist, { nodeId })
    const bytes = encoder.encode(JSON.stringify(index))
    const cid = await mist.storage_add_pinned('drive-index.json', bytes)
    publishShared(driveIndexTopic, cid, { count: index.files.length, updatedAt: index.updatedAt })
    const previousPinnedCid = lastPinnedDriveIndexCid
    if (previousPinnedCid && previousPinnedCid !== cid) {
      try {
        await mist.storage_unpin(previousPinnedCid)
      } catch (error) {
        debugWarn('drive-index-publish', 'storage_unpin failed for superseded drive-index cid', { cid: previousPinnedCid, error: error instanceof Error ? error.message : String(error) })
      }
    }
    lastPinnedDriveIndexCid = cid
  } catch (error) {
    // Best-effort: skip this publish rather than falling back to inlining the
    // (potentially large) index in localStorage `meta`. The previous
    // published cid (if any) simply stays stale until the next successful
    // debounce.
    debugWarn('drive-index-publish', 'storage_add failed; skipping publish', { error: error instanceof Error ? error.message : String(error) })
  }
}
