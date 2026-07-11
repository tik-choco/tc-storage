import { useEffect } from 'preact/hooks'
import { buildDriveIndex, driveIndexTopic } from '../storage/driveIndex.js'
import { publishShared } from '../storage/sharedBus.js'
import type { StorageSnapshot } from '../storage/domain.js'

const publishDebounceMs = 1000

interface DriveIndexPublishEffectOptions {
  folderKeys: Record<string, string>
  snapshot: StorageSnapshot
}

/** Publishes this workspace's file index to the `drive-index` shared-bus
 * topic whenever the snapshot or folder keys change (debounced), and once
 * on startup. Lets other apps resolve files without reading this app's
 * internal snapshot/key storage. See docs/data-contracts/docs/SHARED_BUS.md
 * for the full contract. */
export function useDriveIndexPublishEffect(options: DriveIndexPublishEffectOptions): void {
  const { folderKeys, snapshot } = options

  useEffect(() => {
    const timer = setTimeout(() => {
      publishShared(driveIndexTopic, '', buildDriveIndex(snapshot, folderKeys) as unknown as Record<string, unknown>)
    }, publishDebounceMs)
    return () => clearTimeout(timer)
  }, [folderKeys, snapshot])
}
