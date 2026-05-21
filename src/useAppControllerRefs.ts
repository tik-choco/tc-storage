import { useRef } from 'preact/hooks'
import type { RequestKeyEntry } from './appAccessActions.js'
import type { BrowserDragItem, FolderAccessMode, PendingShare } from './appTypes.js'
import type { StorageSnapshot } from './domain.js'
import type { AppSettings } from './localSettings.js'

interface AppControllerRefsOptions<TNetwork> {
  fileContentCache: Record<string, string>
  fileShareKeys: Record<string, string>
  folderAccessModes: Record<string, FolderAccessMode>
  folderKeys: Record<string, string>
  importKeys: Record<string, string>
  network: TNetwork
  pendingShares: PendingShare[]
  settings: AppSettings
  snapshot: StorageSnapshot
}

export function useAppControllerRefs<TNetwork>(options: AppControllerRefsOptions<TNetwork>) {
  const snapshotRef = useRef(options.snapshot)
  const folderKeysRef = useRef(options.folderKeys)
  const folderAccessModesRef = useRef(options.folderAccessModes)
  const fileShareKeysRef = useRef(options.fileShareKeys)
  const fileContentCacheRef = useRef(options.fileContentCache)
  const fileContentFailuresRef = useRef<Record<string, { retryAfter: number; signature: string }>>({})
  const importKeysRef = useRef(options.importKeys)
  const pendingSharesRef = useRef(options.pendingShares)
  const fileContentLoadsRef = useRef<Record<string, Promise<string>>>({})
  const fileContentStorageRef = useRef<Record<string, string>>({})
  const settingsRef = useRef(options.settings)
  const networkRef = useRef(options.network)
  const autoImportFailuresRef = useRef<Record<string, { retryAfter: number; signature: string }>>({})
  const syncSignaturesRef = useRef<Record<string, string>>({})
  const syncTimersRef = useRef<Record<string, number>>({})
  const syncInFlightRef = useRef<Set<string>>(new Set())
  const autoImportCidsRef = useRef<Set<string>>(new Set())
  const autoImportInFlightRef = useRef<Set<string>>(new Set())
  const helloResponseAtRef = useRef<Record<string, number>>({})
  const accessRequestKeysRef = useRef<Record<string, RequestKeyEntry>>({})
  const dragItemRef = useRef<BrowserDragItem | null>(null)
  const dragItemsRef = useRef<BrowserDragItem[]>([])

  return {
    accessRequestKeysRef, autoImportCidsRef, autoImportFailuresRef, autoImportInFlightRef, dragItemRef, dragItemsRef,
    fileContentCacheRef, fileContentFailuresRef, fileContentLoadsRef, fileContentStorageRef, fileShareKeysRef, folderAccessModesRef, folderKeysRef,
    helloResponseAtRef, importKeysRef, networkRef, pendingSharesRef, settingsRef, snapshotRef,
    syncInFlightRef, syncSignaturesRef, syncTimersRef,
  }
}
