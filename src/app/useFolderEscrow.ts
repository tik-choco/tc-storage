import { useEffect, useRef, useState } from 'preact/hooks'
import { FolderEscrowController } from './folderEscrowController.js'
import type { FolderEscrowView } from './folderEscrowController.js'
import type { FileRecord, FolderRecord, StorageSnapshot } from '../storage/domain.js'
import type { PendingShare } from './appTypes.js'
import type { SetState } from './appControllerTypes.js'
import { mergeFolderCheckpoint, validSetting } from '../folder/folderCheckpoint.js'
import { dataUrlToBytes } from '../util/zip.js'
import { stampFolderPatch } from '../storage/crdt.js'
import { customEscrowRoomError, escrowAppRooms } from '../escrow/appRooms.js'

interface Options {
  snapshot: StorageSnapshot
  folderKeys: Record<string, string>
  pendingShares: PendingShare[]
  roomIds: string[]
  nodeId: string
  connected: boolean
  setSnapshot: SetState<StorageSnapshot>
  ensureFileContent(file: FileRecord): Promise<FileRecord>
}
export function useFolderEscrow(options: Options) {
  const appRoomIds = escrowAppRooms(options.roomIds, options.snapshot.folders)
  const latest = useRef(options)
  latest.current = options
  const controllers = useRef(
    new Map<
      string,
      {
        signature: string
        controller: FolderEscrowController
        room: string
      }
    >(),
  )
  const [views, setViews] = useState<Record<string, FolderEscrowView>>({})
  const flush = async (room?: string) => {
    for (const entry of controllers.current.values()) if (!room || entry.room === room) await entry.controller.flush()
  }
  useEffect(() => {
    const roots = new Map<
      string,
      {
        id: string
        room: string
        setting?: FolderRecord['escrow']
      }
    >()
    for (const folder of options.snapshot.folders) {
      if (!folder.shareEnabled) continue
      let parent = folder.parentId
      const seen = new Set<string>()
      let nested = false
      while (parent && !seen.has(parent)) {
        seen.add(parent)
        const f = options.snapshot.folders.find((p) => p.id === parent)
        if (f?.shareEnabled) {
          nested = true
          break
        }
        parent = f?.parentId ?? null
      }
      if (!nested)
        roots.set(folder.id, { id: folder.id, room: folder.sharedRoomId || options.roomIds[0], setting: folder.escrow })
    }
    // Approved members can restore metadata without waiting for a browser's folder CID.
    for (const share of options.pendingShares)
      if (
        share.type === 'folder-share' &&
        share.autoImport &&
        share.folderId &&
        !roots.has(share.folderId) &&
        !options.snapshot.folders.some((f) => f.id === share.folderId)
      ) {
        roots.set(share.folderId, {
          id: share.folderId,
          room: share.roomId,
          setting:
            share.mistl === 'off'
              ? { mode: 'off', room: '' }
              : share.mistl
                ? { mode: 'custom', room: share.mistl }
                : undefined,
        })
      }
    const wanted = new Set<string>()
    for (const root of roots.values()) {
      const key = options.folderKeys[root.id]
      if (!key) continue
      wanted.add(root.id)
      const enabled = options.connected && options.roomIds.includes(root.room)
      const signature = JSON.stringify([
        key.trim(),
        root.room,
        root.setting ?? { mode: 'auto', room: '' },
        options.nodeId,
        enabled,
        appRoomIds,
      ])
      let entry = controllers.current.get(root.id)
      if (entry?.signature !== signature) {
        entry?.controller.dispose()
        const controller = new FolderEscrowController({
          folderId: root.id,
          key,
          appRoom: root.room,
          appRoomIds: () => escrowAppRooms(latest.current.roomIds, latest.current.snapshot.folders),
          nodeId: options.nodeId,
          setting: root.setting,
          enabled,
          snapshot: () => latest.current.snapshot,
          merge: (checkpoint) => latest.current.setSnapshot((current) => mergeFolderCheckpoint(current, checkpoint)),
          readFile: async (file) => {
            const loaded = await latest.current.ensureFileContent(file)
            if (!loaded.dataUrl) throw new Error('Missing source bytes: ' + file.name)
            return dataUrlToBytes(loaded.dataUrl)
          },
          changed: (view) => setViews((current) => ({ ...current, [root.id]: view })),
        })
        entry = { signature, controller, room: root.room }
        controllers.current.set(root.id, entry)
        void controller.start()
      }
      entry.controller.observe()
    }
    for (const [id, entry] of controllers.current)
      if (!wanted.has(id)) {
        entry.controller.dispose()
        controllers.current.delete(id)
      }
  }, [options.snapshot, options.folderKeys, options.pendingShares, options.roomIds, options.nodeId, options.connected])
  useEffect(() => {
    const hide = () => {
      void flush()
    }
    window.addEventListener('pagehide', hide)
    return () => {
      window.removeEventListener('pagehide', hide)
      for (const e of controllers.current.values()) e.controller.dispose()
      controllers.current.clear()
    }
  }, [])
  const configure = (id: string, setting: NonNullable<FolderRecord['escrow']>) => {
    if (!validSetting(setting)) return
    if (setting.mode === 'custom' && customEscrowRoomError(setting.room, escrowAppRooms(latest.current.roomIds, latest.current.snapshot.folders))) return
    latest.current.setSnapshot((current) => ({
      ...current,
      clock: current.clock + 1,
      folders: current.folders.map((f) =>
        f.id === id ? stampFolderPatch(f, { escrow: setting }, new Date().toISOString(), latest.current.nodeId) : f,
      ),
    }))
  }
  const hasContent = (file: FileRecord) => [...controllers.current.values()].some((e) => e.controller.hasContent(file))
  const loadContent = (file: FileRecord) => {
    const entry = [...controllers.current.values()].find((e) => e.controller.hasContent(file))
    return entry ? entry.controller.loadContent(file) : Promise.reject(new Error('Escrow content unavailable'))
  }
  return { views, configure, hasContent, loadContent, flush, appRoomIds }
}
