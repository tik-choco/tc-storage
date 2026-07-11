import { useEffect, useRef } from 'preact/hooks'
import type { MutableRef, SetState } from './appControllerTypes.js'
import type { Notice } from './appTypes.js'
import { remoteImportedFolderSnapshot } from './appHelpers.js'
import { shortLogValue } from './appUtils.js'
import { addActivity, type StorageSnapshot } from '../storage/domain.js'
import { mergeSnapshots } from '../storage/crdt.js'
import type { AppSettings } from '../storage/localSettings.js'
import { readShared, subscribeShared, type SharedRecord } from '../storage/sharedBus.js'
import {
  folderExportMeta,
  folderExportTopic,
  loadImportedFolderBundle,
  rememberImportedFolderCid,
  shouldImportFolderRecord,
} from '../storage/folderImport.js'
import { describeError } from '../util/errors.js'
import { debugInfo, debugWarn } from '../util/logging.js'

interface FolderImportEffectOptions {
  setFolderKeys: SetState<Record<string, string>>
  setNotice: SetState<Notice>
  setSnapshot: SetState<StorageSnapshot>
  settingsRef: MutableRef<AppSettings>
}

/** Subscribes to the `folder-export` shared-bus topic (on mount and on every
 * notification) and merges the exported folder into the workspace via the
 * existing CRDT merge machinery. See docs/data-contracts/docs/SHARED_BUS.md
 * for the full contract. */
export function useFolderImportEffect(options: FolderImportEffectOptions): void {
  const { setFolderKeys, setNotice, setSnapshot, settingsRef } = options
  const inFlightRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    function handleRecord(record: SharedRecord | null) {
      if (!record) return
      const meta = folderExportMeta(record)
      if (!meta || !shouldImportFolderRecord(record, meta) || inFlightRef.current.has(record.cid)) return
      const cid = record.cid
      inFlightRef.current.add(cid)
      void loadImportedFolderBundle(cid, meta.passphrase, settingsRef.current.nodeId)
        .then((bundle) => {
          setSnapshot((current) => addActivity(
            mergeSnapshots(current, remoteImportedFolderSnapshot(bundle, cid)),
            { actorNodeId: settingsRef.current.nodeId, folderId: bundle.folder.id, action: 'folder-import', detail: `${bundle.folder.name} をフォルダエクスポートから取り込み` },
          ))
          setFolderKeys((current) => ({ ...current, [meta.folderId]: meta.passphrase }))
          rememberImportedFolderCid(meta.folderId, cid)
          debugInfo('folder-import', 'imported folder-export record', { cid: shortLogValue(cid), folderId: bundle.folder.id, fileCount: bundle.files.length })
        })
        .catch((error) => {
          debugWarn('folder-import', 'folder-export import failed', { cid: shortLogValue(cid), error: describeError(error, 'unknown error') })
          setNotice({ tone: 'error', text: describeError(error, 'フォルダの取り込みに失敗しました') })
        })
        .finally(() => { inFlightRef.current.delete(cid) })
    }

    handleRecord(readShared(folderExportTopic))
    return subscribeShared(folderExportTopic, handleRecord)
  }, [])
}
