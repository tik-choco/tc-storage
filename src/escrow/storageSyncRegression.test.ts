import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFileContentActions } from '../app/appFileContentActions'
import { createFileEditActions } from '../app/appFileEditActions'
import { createFolderSyncActions } from '../app/appFolderSyncActions'
import { createFolderActions } from '../app/appFolderActions'
import { createMoveActions } from '../app/appMoveActions'
import { makeFileFromDataUrl, makeFolder, stripFileContent } from '../storage/domain'
import type { FileRecord, StorageSnapshot } from '../storage/domain'
import { mergeSnapshots, stampFilePatch, stampFolderPatch } from '../storage/crdt'
import { folderFilesForSync, foldersForSync } from '../folder/folderSync'
import { mergeFolderCheckpoint, projectFolder } from '../folder/folderCheckpoint'
import { sha256Hex } from '../crypto/crypto'

const storageMock = vi.hoisted(() => ({
  folder: (..._args: unknown[]) => Promise.resolve('default-folder-cid'),
  file: (..._args: unknown[]) => Promise.resolve('default-file-cid'),
}))
vi.mock('../storage/mistStorage', async original => ({
  ...await original<typeof import('../storage/mistStorage')>(),
  saveEncryptedFolderToMist: (...args: unknown[]) => storageMock.folder(...args),
  saveEncryptedFileToMist: (...args: unknown[]) => storageMock.file(...args),
}))
const fileContentIdentity = (file: Pick<FileRecord, 'id' | 'checksum' | 'size'>) => JSON.stringify([file.id, file.checksum, file.size])
const now = '2026-10-12T00:00:00.000Z'
const later = '2026-10-12T00:00:01.000Z'
const hello = 'data:text/plain;base64,aGVsbG8='
const newBody = 'data:text/plain;base64,bmV3'
const settings = { nodeId: 'node-a', roomId: 'app-room', autoConnect: false,
  profileName: 'A', avatarUrl: '', avatarFileId: '', identity: null }
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function until(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await new Promise(r => setTimeout(r, 5))
  expect(done()).toBe(true)
}
function fixture() {
  const root = { ...makeFolder({ id: 'root', name: 'Root', parentId: null, color: 'teal', roomId: 'app-room', now, nodeId: 'node-a' }), shareEnabled: true }
  const destination = makeFolder({ id: 'destination', name: 'Destination', parentId: null, color: 'blue', roomId: 'app-room', now, nodeId: 'node-a' })
  const file = makeFileFromDataUrl({ id: 'file', folderId: root.id, name: 'file.txt', mimeType: 'text/plain', size: 5,
    dataUrl: hello, checksum: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', now, nodeId: 'node-a' })
  const snapshotRef = { current: { folders: [root, destination], files: [stripFileContent(file)], activity: [], clock: 1, originNode: 'node-a' } as StorageSnapshot }
  const cache = { current: {} as Record<string, string> }
  const keys = { current: { root: 'secret', destination: 'destination-secret' } as Record<string, string> }
  const setSnapshot = (update: StorageSnapshot | ((s: StorageSnapshot) => StorageSnapshot)) => { snapshotRef.current = typeof update === 'function' ? update(snapshotRef.current) : update }
  const setFileContentCache = (update: Record<string, string> | ((s: Record<string, string>) => Record<string, string>)) => { cache.current = typeof update === 'function' ? update(cache.current) : update }
  const setFolderKeys = (update: Record<string, string> | ((s: Record<string, string>) => Record<string, string>)) => { keys.current = typeof update === 'function' ? update(keys.current) : update }
  const broadcast = vi.fn(), announce = vi.fn(), schedule = vi.fn()
  const networkRef = { current: { broadcastShare: broadcast } as unknown as Parameters<typeof createFolderSyncActions>[0]['networkRef']['current'] }
  return { root, destination, file, snapshotRef, cache, keys, setSnapshot, setFileContentCache, setFolderKeys, networkRef, broadcast, announce, schedule,
    mutate: (patch: Partial<FileRecord>) => setSnapshot(s => ({ ...s, files: s.files.map(f => stampFilePatch(f, patch, later, 'node-b')) })) }
}
function content(f: ReturnType<typeof fixture>, overrides: Partial<Parameters<typeof createFileContentActions>[0]> = {}) {
  return createFileContentActions({ snapshotRef: f.snapshotRef, settingsRef: { current: settings }, folderKeysRef: f.keys,
    fileShareKeysRef: { current: {} }, fileContentCacheRef: f.cache, fileContentLoadsRef: { current: {} }, fileContentStorageRef: { current: {} },
    setSnapshot: f.setSnapshot, setFileContentCache: f.setFileContentCache, setNotice: () => {},
    startDownloadProgress: () => 0, startFileLoadProgress: () => '', finishDownloadProgress: () => {}, finishFileLoadProgress: () => {},
    failDownloadProgress: () => {}, failFileLoadProgress: () => {}, updateDownloadProgress: () => {}, networkRef: f.networkRef, ...overrides })
}
beforeEach(() => vi.stubGlobal('window', { setTimeout: () => 1, clearTimeout: () => {} }))
afterEach(() => vi.unstubAllGlobals())

it.each(['rename', 'edit', 'delete', 'move'] as const)('folder publication preserves a concurrent %s and suppresses stale folder broadcast', async kind => {
  const f = fixture(), upload = deferred<string>()
  const save = vi.fn(() => upload.promise)
  storageMock.folder = save; storageMock.file = save
  const actions = createFolderSyncActions({ snapshotRef: f.snapshotRef, settingsRef: { current: settings }, folderKeysRef: f.keys,
    networkRef: f.networkRef, setSnapshot: f.setSnapshot, setNotice: () => {}, syncInFlightRef: { current: new Set() },
    syncSignaturesRef: { current: {} }, syncTimersRef: { current: {} }, folderStateAnnouncementsRef: { current: {} },
    ensureFolderFilesStored: async (_root, files) => files.map(file => ({ ...file, lastCid: 'uploaded-file' })),
    hasUntrustedFolderContent: () => false, saveEncryptedFolder: save })
  const publishing = actions.publishSharedFolder('root')
  await until(() => save.mock.calls.length === 1)
  const patch = kind === 'rename' ? { name: 'renamed.txt', starred: true } : kind === 'edit' ? { checksum: 'f'.repeat(64), version: 2 } : kind === 'delete' ? { deletedAt: later } : { folderId: 'destination' }
  f.mutate(patch)
  const before = f.snapshotRef.current.files[0]
  upload.resolve('uploaded-folder')
  await publishing
  const after = f.snapshotRef.current.files[0]
  const { updatedAt: _time, fieldVersions: _stamps, ...unchanged } = before
  expect(after).toMatchObject(unchanged)
  for (const [field, stamp] of Object.entries(before.fieldVersions ?? {})) if (field !== 'lastCid') expect(after.fieldVersions?.[field]).toEqual(stamp)
  expect(after.lastCid).toBe(kind === 'rename' ? 'uploaded-file' : undefined)
  expect(f.snapshotRef.current.folders[0].lastCid).toBeUndefined()
  expect(f.broadcast).not.toHaveBeenCalled()
})

it('manual folder save patches only CIDs after a concurrent rename', async () => {
  const f = fixture(), upload = deferred<string>(), save = vi.fn(() => upload.promise)
  storageMock.folder = save; storageMock.file = save
  const noop = () => {}
  const actions = createFolderActions({ snapshotRef: f.snapshotRef, snapshot: f.snapshotRef.current,
    settings, shareProfile: { name: 'A' }, currentFolder: f.root, currentFolderId: 'root', currentFolderKey: 'secret',
    folderPanelFolder: f.root, folderPanelFolderId: 'root', folderKeysRef: f.keys, folderAccessModes: {}, folders: f.snapshotRef.current.folders,
    networkRef: f.networkRef, syncSignaturesRef: { current: {} }, announceFolderChange: f.announce, clearFolderSyncTimer: noop,
    scheduleFolderSync: f.schedule, setSnapshot: f.setSnapshot, setFolderKeys: f.setFolderKeys, setBusy: noop, setNotice: noop,
    setCurrentFolderId: noop, setDeleteRequest: noop, setDetailFileId: noop, setExpandedPreviewOpen: noop, setFolderNameDraft: noop,
    setFolderPanelFolderId: noop, setFolderPanelOpen: noop, setProfileOpen: noop, setSelectedFileId: noop, setSettings: noop, setSettingsOpen: noop,
    ensureFolderFilesStored: async (_root, files) => files.map(file => ({ ...file, lastCid: 'uploaded-file' })), saveEncryptedFolder: save })
  const saving = actions.saveFolderToMist(false)
  await until(() => save.mock.calls.length === 1)
  f.mutate({ name: 'renamed.txt', starred: true })
  upload.resolve('uploaded-folder')
  await saving
  expect(f.snapshotRef.current.files[0]).toMatchObject({ name: 'renamed.txt', starred: true, lastCid: 'uploaded-file' })
  expect(f.snapshotRef.current.folders[0].lastCid).toBeUndefined()
  expect(f.broadcast).not.toHaveBeenCalled()
})

it.each(['rename', 'edit', 'delete', 'move'] as const)('background edit completion preserves a concurrent %s without a stale announcement', async kind => {
  const f = fixture(), upload = deferred<string>(), save = vi.fn(() => upload.promise)
  storageMock.folder = save; storageMock.file = save
  const actions = createFileEditActions({ snapshotRef: f.snapshotRef, settingsRef: { current: settings }, folderKeysRef: f.keys,
    setSnapshot: f.setSnapshot, setFolderKeys: f.setFolderKeys, setFileContentCache: f.setFileContentCache,
    setNotice: () => {}, announceFolderChange: f.announce, scheduleFolderSync: f.schedule, saveEncryptedFile: save })
  await actions.saveTextFileContent(f.file, 'new')
  f.mutate(kind === 'rename' ? { name: 'renamed.txt' } : kind === 'edit' ? { checksum: 'f'.repeat(64), version: 3 } : kind === 'delete' ? { deletedAt: later } : { folderId: 'destination' })
  upload.resolve('edited-cid')
  await new Promise(r => setTimeout(r, 10))
  expect(f.snapshotRef.current.files[0].lastCid).toBe(kind === 'rename' ? 'edited-cid' : undefined)
  expect(f.announce.mock.calls.length).toBe(kind === 'rename' ? 1 : 0)
  if (kind === 'rename') expect(f.announce.mock.calls[0][2].name).toBe('renamed.txt')
})

it('verifies identity-keyed cached bytes and never reuses stale file-id bytes', async () => {
  const f = fixture(), get = vi.fn(async () => ({ version: 1 as const, originNode: 'node-a', exportedAt: now, folder: f.root, file: f.file }))
  f.mutate({ lastCid: 'cid' })
  const file = f.snapshotRef.current.files[0]
  f.cache.current[file.id] = newBody
  const actions = content(f, { loadEncryptedFile: get })
  expect((await actions.ensureFileContent(file)).dataUrl).toBe(hello)
  expect(f.cache.current[fileContentIdentity(file)]).toBe(hello)
  await actions.ensureFileContent(file)
  expect(get).toHaveBeenCalledTimes(1)
})

it.each([newBody, 'data:text/plain;base64,aGVsbG8h'])('rejects fetched checksum or size mismatch without a trusted storage proof (%s)', async bad => {
  const f = fixture(), proofs = { current: {} as Record<string, string> }
  f.mutate({ lastCid: 'bad-cid' })
  const actions = content(f, { fileContentStorageRef: proofs,
    loadEncryptedFile: async () => ({ version: 1, originNode: 'node-a', exportedAt: now, folder: f.root, file: { ...f.file, dataUrl: bad } }) })
  await expect(actions.ensureFileContent(f.snapshotRef.current.files[0])).rejects.toThrow('checksum')
  expect(proofs.current).toEqual({})
  expect(f.cache.current).toEqual({})
})

it('a rejected normal body followed by escrow recovery cannot reuse the rejected CID', async () => {
  const f = fixture(), save = vi.fn(async () => 'fresh-cid')
  f.mutate({ lastCid: 'bad-cid' })
  const file = f.snapshotRef.current.files[0]
  const actions = content(f, { saveEncryptedFile: save, hasEscrowContent: () => true, loadEscrowContent: async () => hello,
    loadEncryptedFile: async () => ({ version: 1, originNode: 'node-a', exportedAt: now, folder: f.root, file: { ...f.file, dataUrl: newBody } }) })
  await actions.ensureFileContent(file)
  const published = await actions.ensureFolderFilesStored(f.root, [file], 'secret')
  expect(published[0].lastCid).toBe('fresh-cid')
  expect(save).toHaveBeenCalledTimes(1)
})

it('in-flight loads are shared only by the same content identity and reject a changed record', async () => {
  const f = fixture(), oldLoad = deferred<Awaited<ReturnType<NonNullable<Parameters<typeof createFileContentActions>[0]['loadEncryptedFile']>>>>()
  f.mutate({ lastCid: 'old-cid' })
  const oldFile = f.snapshotRef.current.files[0]
  const newFile = { ...f.file, checksum: await sha256Hex(new TextEncoder().encode('new')), size: 3, version: 2, dataUrl: newBody }
  const get = vi.fn((cid: string) => cid === 'old-cid' ? oldLoad.promise : Promise.resolve({ version: 1 as const, originNode: 'node-a', exportedAt: now, folder: f.root, file: newFile }))
  const actions = content(f, { loadEncryptedFile: get })
  const old = actions.ensureFileContent(oldFile).catch(error => error)
  f.mutate({ checksum: newFile.checksum, size: 3, version: 2, lastCid: 'new-cid' })
  const latestLoad = actions.ensureFileContent(f.snapshotRef.current.files[0])
  void latestLoad.catch(() => {})
  expect(get).toHaveBeenCalledTimes(2)
  expect((await latestLoad).dataUrl).toBe(newBody)
  oldLoad.resolve({ version: 1, originNode: 'node-a', exportedAt: now, folder: f.root, file: f.file })
  expect(await old).toBeInstanceOf(Error)
  expect(get).toHaveBeenCalledTimes(2)
  expect(f.cache.current[fileContentIdentity(oldFile)]).toBeUndefined()
})

it.each(['rename', 'delete', 'move'] as const)('repair completion preserves a concurrent %s', async kind => {
  const f = fixture(), upload = deferred<string>(), save = vi.fn(() => upload.promise)
  storageMock.folder = save; storageMock.file = save
  f.mutate({ lastCid: 'old-cid' })
  f.cache.current[fileContentIdentity(f.file)] = hello
  f.cache.current[f.file.id] = hello // Legacy ingress also reaches the original repair implementation.
  const actions = content(f, { saveEncryptedFile: save })
  actions.handleFileContentRepairRequest({ fileId: 'file', folderId: 'root', cid: 'old-cid', from: 'node-b' })
  await until(() => save.mock.calls.length === 1)
  f.mutate(kind === 'rename' ? { name: 'renamed.txt' } : kind === 'delete' ? { deletedAt: later } : { folderId: 'destination' })
  upload.resolve('repair-cid')
  await new Promise(r => setTimeout(r, 10))
  expect(f.snapshotRef.current.files[0].lastCid).toBe(kind === 'rename' ? 'repair-cid' : 'old-cid')
  expect(f.broadcast.mock.calls.length).toBe(kind === 'rename' ? 1 : 0)
  if (kind === 'rename') expect(f.broadcast.mock.calls[0][0].file.name).toBe('renamed.txt')
})

it('persists file move-out before upload, projects it for offline peers, and preserves destination', async () => {
  const f = fixture(), upload = deferred<string>(), save = vi.fn(() => upload.promise)
  storageMock.folder = save; storageMock.file = save
  const actions = createMoveActions({ snapshotRef: f.snapshotRef, settings, folderKeysRef: f.keys, setSnapshot: f.setSnapshot,
    setFolderKeys: f.setFolderKeys, setFileContentCache: f.setFileContentCache, setBusy: () => {}, setNotice: () => {},
    announceFolderChange: f.announce, scheduleFolderSync: f.schedule, ensureFileContent: async () => f.file, saveEncryptedFile: save })
  const before = structuredClone(f.snapshotRef.current)
  await actions.moveDraggedItem({ type: 'file', id: 'file' }, 'destination')
  const projection = projectFolder(f.snapshotRef.current, 'root')
  expect(projection.files[0].deletedAt).toBeDefined()
  expect(Date.parse(projection.files[0].deletedAt!)).toBe(Date.parse(f.snapshotRef.current.files[0].fieldVersions!.folderId.updatedAt) - 1)
  const checkpoint = { v: 1 as const, rootFolderId: 'root', appRoomId: 'app-room', snapshot: projection, contents: [], packs: [] }
  expect(mergeFolderCheckpoint(before, checkpoint).files[0].deletedAt).toBeDefined()
  expect(mergeFolderCheckpoint(f.snapshotRef.current, checkpoint).files[0].deletedAt).toBeUndefined()
  expect(mergeSnapshots(f.snapshotRef.current, projection).files[0].deletedAt).toBeUndefined()
  expect(mergeSnapshots(projection, f.snapshotRef.current).files[0].deletedAt).toBeUndefined()
  f.mutate({ deletedAt: later })
  upload.resolve('move-cid')
  await new Promise(r => setTimeout(r, 10))
  expect(f.snapshotRef.current.files[0].lastCid).toBeUndefined()
})

it('folder exits keep former subtree placement, exclude destination content, and allow a later return', async () => {
  const f = fixture()
  const child = makeFolder({ id: 'child', name: 'Child', parentId: 'root', color: 'teal', roomId: 'app-room', now, nodeId: 'node-a' })
  f.snapshotRef.current.folders.push(child)
  f.mutate({ folderId: 'child' })
  const before = structuredClone(f.snapshotRef.current)
  const actions = createMoveActions({ snapshotRef: f.snapshotRef, settings, folderKeysRef: f.keys, setSnapshot: f.setSnapshot,
    setFolderKeys: f.setFolderKeys, setFileContentCache: f.setFileContentCache, setBusy: () => {}, setNotice: () => {},
    announceFolderChange: f.announce, scheduleFolderSync: f.schedule, ensureFileContent: async () => f.file })
  await actions.moveDraggedItem({ type: 'folder', id: 'child' }, 'destination')
  f.mutate({ name: 'private-destination-name.txt', checksum: 'f'.repeat(64) })
  const projected = projectFolder(f.snapshotRef.current, 'root')
  expect(projected.files[0].name).toBe(before.files[0].name)
  expect(projected.files[0].checksum).toBe(before.files[0].checksum)
  expect(projected.files[0].deletedAt).toBeDefined()
  expect(projected.folders.find(f => f.id === 'child')!.parentId).toBe('root')
  expect(mergeSnapshots(f.snapshotRef.current, projected).files[0].deletedAt).toBeUndefined()
  expect(mergeSnapshots(projected, f.snapshotRef.current).files[0].deletedAt).toBeUndefined()
  const removedAt = projected.files[0].deletedAt!
  f.setSnapshot(s => ({ ...s, folders: s.folders.map(folder => folder.id === 'child' ? stampFolderPatch(folder, { parentId: 'root' }, new Date(Date.parse(removedAt) + 1000).toISOString(), 'node-a') : folder) }))
  expect(folderFilesForSync(f.snapshotRef.current, 'root')[0].deletedAt).toBeUndefined()
  expect(foldersForSync(f.snapshotRef.current, 'root').find(f => f.id === 'child')!.deletedAt).toBeUndefined()
})

it('same-identity concurrent loads coalesce and return only verified bytes', async () => {
  const f = fixture(), pending = deferred<{ version: 1; originNode: string; exportedAt: string; folder: typeof f.root; file: FileRecord }>()
  f.mutate({ lastCid: 'cid' })
  const get = vi.fn(() => pending.promise), actions = content(f, { loadEncryptedFile: get })
  const first = actions.ensureFileContent(f.snapshotRef.current.files[0])
  const second = actions.ensureFileContent(f.snapshotRef.current.files[0])
  pending.resolve({ version: 1, originNode: 'node-a', exportedAt: now, folder: f.root, file: f.file })
  expect((await first).dataUrl).toBe(hello)
  expect((await second).dataUrl).toBe(hello)
  expect(get).toHaveBeenCalledTimes(1)
})

it('a concurrent rename during the edit checksum await survives the local edit', async () => {
  const f = fixture()
  const actions = createFileEditActions({ snapshotRef: f.snapshotRef, settingsRef: { current: settings }, folderKeysRef: f.keys,
    setSnapshot: f.setSnapshot, setFolderKeys: f.setFolderKeys, setFileContentCache: f.setFileContentCache,
    setNotice: () => {}, announceFolderChange: f.announce, scheduleFolderSync: f.schedule, saveEncryptedFile: async () => 'cid' })
  const editing = actions.saveTextFileContent(f.file, 'new')
  f.mutate({ name: 'renamed.txt' })
  await editing
  expect(f.snapshotRef.current.files[0].name).toBe('renamed.txt')
  expect(f.snapshotRef.current.files[0].size).toBe(3)
})

it('metadata changes select a new cache identity even when older bytes remain cached', async () => {
  const f = fixture()
  f.cache.current[fileContentIdentity(f.file)] = hello
  f.mutate({ checksum: await sha256Hex(new TextEncoder().encode('new')), size: 3, version: 2 })
  const actions = content(f, { hasEscrowContent: () => true, loadEscrowContent: async () => newBody })
  const latest = f.snapshotRef.current.files[0]
  expect((await actions.ensureFileContent(latest)).dataUrl).toBe(newBody)
  expect(f.cache.current[fileContentIdentity(latest)]).toBe(newBody)
  expect(f.cache.current[fileContentIdentity(f.file)]).toBe(hello)
})
