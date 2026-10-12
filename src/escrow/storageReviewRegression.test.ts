import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFileEditActions } from '../app/appFileEditActions'
import { createVrsns2CatalogOutboxActions } from '../app/appVrsns2CatalogOutbox'
import { createMoveActions } from '../app/appMoveActions'
import {
  makeFolder, makeFileFromDataUrl, stripFileContent, fileContentIdentity,
} from '../storage/domain'
import type { StorageSnapshot } from '../storage/domain'
import {
  projectFolder, mergeFolderCheckpoint, encodeCheckpoint, validateCheckpoint,
} from '../folder/folderCheckpoint'
import { mergeSnapshots, stampFilePatch } from '../storage/crdt'
import { sha256Hex } from '../crypto/crypto'
import { readShared } from '../storage/sharedBus'

const now = '2026-10-12T00:00:00.000Z'
const hello = 'data:text/plain;base64,aGVsbG8='
const checksum =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
const settings = {
  nodeId: 'node-a', roomId: 'app', autoConnect: false,
  profileName: 'A', avatarUrl: '', avatarFileId: '', identity: null,
}

function fixture(name = 'Root') {
  const root = {
    ...makeFolder({
      id: 'root', name, parentId: null, color: 'teal',
      roomId: 'app', now, nodeId: 'node-a',
    }),
    shareEnabled: true,
  }
  const destination = makeFolder({
    id: 'destination', name: 'Destination', parentId: null,
    color: 'blue', roomId: 'app', now, nodeId: 'node-a',
  })
  const child = makeFolder({
    id: 'child', name: 'Child', parentId: 'root',
    color: 'blue', roomId: 'app', now, nodeId: 'node-a',
  })
  const file = makeFileFromDataUrl({
    id: 'file', folderId: 'root', name: 'file.txt', mimeType: 'text/plain',
    size: 5, dataUrl: hello, checksum, now, nodeId: 'node-a',
  })
  const snapshotRef = {
    current: {
      folders: [root, destination], files: [stripFileContent(file)],
      activity: [], clock: 1, originNode: 'node-a',
    } as StorageSnapshot,
  }
  const cache = { current: {} as Record<string, string> }
  const keys = {
    current: { root: 'secret', destination: 'other-secret' } as Record<string, string>,
  }
  const setSnapshot = (u: any) => {
    snapshotRef.current =
      typeof u === 'function' ? u(snapshotRef.current) : u
  }
  const setFileContentCache = (u: any) => {
    cache.current = typeof u === 'function' ? u(cache.current) : u
  }
  const setFolderKeys = (u: any) => {
    keys.current = typeof u === 'function' ? u(keys.current) : u
  }
  return {
    root, child, file, snapshotRef, cache, keys,
    setSnapshot, setFileContentCache, setFolderKeys,
  }
}

beforeEach(() => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v),
  })
  vi.stubGlobal('window', {
    dispatchEvent: () => {}, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  vi.stubGlobal('BroadcastChannel', undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each([false, true])(
  'catalog exports the newly edited bytes (legacy file-ID cache: %s)',
  async legacy => {
    const f = fixture('TC Space')
    if (legacy) f.cache.current.file = hello
    const edit = createFileEditActions({
      snapshotRef: f.snapshotRef, settingsRef: { current: settings },
      folderKeysRef: f.keys, setSnapshot: f.setSnapshot,
      setFolderKeys: f.setFolderKeys, setFileContentCache: f.setFileContentCache,
      setNotice: () => {}, announceFolderChange: () => {},
      scheduleFolderSync: () => {}, saveEncryptedFile: async () => 'new-file-cid',
    })
    await edit.saveTextFileContent(f.file, 'new')
    const edited = f.snapshotRef.current.files[0]
    expect(f.cache.current[fileContentIdentity(edited)])
      .toBe('data:text/plain;base64,bmV3')

    const uploads: Uint8Array[] = []
    const outbox = createVrsns2CatalogOutboxActions({
      snapshotRef: f.snapshotRef, settingsRef: { current: settings },
      fileContentCacheRef: f.cache,
      uploadCiphertext: async (_name, bytes) => {
        uploads.push(bytes)
        return 'catalog-cid'
      },
      unpinCid: async () => {},
    })
    await outbox.publishCatalogOutbox()
    const items = readShared('vrsns2-catalog-inbox')!.meta.items as any[]
    expect(items.map(item => item.checksum))
      .toEqual([await sha256Hex(new TextEncoder().encode('new'))])
  },
)

it.each([false, true])(
  'returning a moved subtree restores descendants without reviving real deletions (deleted while away: %s)',
  async deletedWhileAway => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    const f = fixture()
    f.snapshotRef.current.folders.push(f.child, { ...f.child, id: 'grandchild', parentId: 'child' })
    Object.assign(f.snapshotRef.current.files[0], {
      folderId: 'grandchild', size: 0,
      checksum: await sha256Hex(new Uint8Array()),
    })
    const deleted = { ...f.snapshotRef.current.files[0], id: 'z-deleted' }
    f.snapshotRef.current.files.push(deletedWhileAway ? deleted : stampFilePatch(deleted, { deletedAt: now }, now, settings.nodeId))
    const peerBefore = structuredClone(f.snapshotRef.current)
    const moves = createMoveActions({
      snapshotRef: f.snapshotRef, settings, folderKeysRef: f.keys,
      setSnapshot: f.setSnapshot, setFolderKeys: f.setFolderKeys,
      setFileContentCache: f.setFileContentCache,
      setBusy: () => {}, setNotice: () => {},
      announceFolderChange: () => {}, scheduleFolderSync: () => {},
      ensureFileContent: async () => f.file,
    })
    const checkpoint = () => ({
      v: 1 as const, rootFolderId: 'root', appRoomId: 'app',
      snapshot: projectFolder(f.snapshotRef.current, 'root'),
      contents: projectFolder(f.snapshotRef.current, 'root').files
        .filter(file => !file.deletedAt)
        .map(file => ({
          fileId: file.id, checksum: file.checksum,
          size: file.size, segments: [],
        })),
      packs: [],
    })

    vi.setSystemTime(new Date(Date.parse(now) + 1000))
    await moves.moveDraggedItem(
      { type: 'folder', id: 'child' }, 'destination',
    )
    const peerAfterExit = mergeFolderCheckpoint(
      peerBefore,
      await validateCheckpoint(
        encodeCheckpoint(checkpoint()), 'root', 'secret', 'app',
      ),
    )
    expect(peerAfterExit.files[0].deletedAt).toBeDefined()

    if (deletedWhileAway) f.snapshotRef.current.files[1] = stampFilePatch(
      f.snapshotRef.current.files[1], { deletedAt: '2026-10-12T00:00:01.500Z' }, '2026-10-12T00:00:01.500Z', settings.nodeId)
    vi.setSystemTime(new Date(Date.parse(now) + 2000))
    await moves.moveDraggedItem({ type: 'folder', id: 'child' }, 'root')
    expect(projectFolder(f.snapshotRef.current, 'root').files[0].deletedAt)
      .toBeUndefined()
    const peerAfterReturn = mergeFolderCheckpoint(
      peerAfterExit,
      await validateCheckpoint(
        encodeCheckpoint(checkpoint()), 'root', 'secret', 'app',
      ),
    )
    expect.soft(peerAfterReturn.files[0].deletedAt).toBeUndefined()
    expect(peerAfterReturn.folders.find(folder => folder.id === 'grandchild')?.deletedAt).toBeUndefined()
    expect(peerAfterReturn.files.find(file => file.id === 'z-deleted')?.deletedAt).toBeDefined()
    // A subsequent sync back also spreads the obsolete exit tombstone.
    expect.soft(
      mergeSnapshots(f.snapshotRef.current, peerAfterReturn).files[0].deletedAt,
    ).toBeUndefined()
  },
)

it.each(['tuple-checksum', 'tuple-size', 'legacy-checksum', 'legacy-size', 'legacy-valid'])(
  'catalog verifies cached bytes before upload (%s)', async variant => {
    const f = fixture('TC Space')
    const file = f.snapshotRef.current.files[0]
    if (variant.endsWith('size')) file.size = 6
    const dataUrl = variant.endsWith('checksum') ? 'data:text/plain;base64,d29ybGQ=' : hello
    f.cache.current[variant.startsWith('tuple') ? fileContentIdentity(file) : file.id] = dataUrl
    const uploads: Uint8Array[] = []
    const outbox = createVrsns2CatalogOutboxActions({
      snapshotRef: f.snapshotRef, settingsRef: { current: settings }, fileContentCacheRef: f.cache,
      uploadCiphertext: async (_name, bytes) => { uploads.push(bytes); return 'catalog-cid' },
      unpinCid: async () => {},
    })
    await outbox.publishCatalogOutbox()
    expect(uploads).toHaveLength(variant === 'legacy-valid' ? 1 : 0)
    expect(readShared('vrsns2-catalog-inbox')!.meta.items).toHaveLength(uploads.length)
  },
)
