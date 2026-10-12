import { expect, it, vi } from 'vitest'
import { createFileContentActions } from '../app/appFileContentActions'
import { makeFileFromDataUrl, makeFolder, stripFileContent } from '../storage/domain'
import type { StorageSnapshot } from '../storage/domain'
import { sha256, utf8 } from './crypto'

it.each([false, true])(
  'publishes verified content after CID resolution (stale normal body: %s)',
  async stale => {
    const now = '2026-10-12T00:00:00.000Z'
    const folder = {
      ...makeFolder({ id: 'root', name: 'Root', parentId: null,
        color: 'teal', roomId: 'app-room', now, nodeId: 'a' }),
      shareEnabled: true,
    }
    const dataUrl = 'data:text/plain;base64,bmV3'
    const good = makeFileFromDataUrl({ id: 'file', folderId: 'root',
      name: 'file.txt', mimeType: 'text/plain', size: 3, dataUrl,
      checksum: await sha256(utf8('new')), now, nodeId: 'a' })
    const file = { ...stripFileContent(good), lastCid: 'normal-cid' }
    const snapshotRef = { current: {
      folders: [folder], files: [file], activity: [], clock: 1, originNode: 'a',
    } as StorageSnapshot }
    const cache = { current: {} as Record<string, string> }
    const proofs = { current: {} as Record<string, string> }
    const fallback = vi.fn(async () => dataUrl)
    const save = vi.fn(async () => 'fresh-cid')
    const actions = createFileContentActions({
      snapshotRef,
      settingsRef: { current: { nodeId: 'a', roomId: 'app-room',
        autoConnect: false, profileName: 'a', avatarUrl: '',
        avatarFileId: '', identity: null } },
      folderKeysRef: { current: { root: 'secret' } },
      fileShareKeysRef: { current: {} },
      fileContentCacheRef: cache,
      fileContentStorageRef: proofs,
      fileContentLoadsRef: { current: {} },
      setFileContentCache: update => {
        cache.current = typeof update === 'function' ? update(cache.current) : update
      },
      setSnapshot: update => {
        snapshotRef.current = typeof update === 'function'
          ? update(snapshotRef.current) : update
      },
      setNotice: () => {}, failDownloadProgress: () => {},
      failFileLoadProgress: () => {}, finishDownloadProgress: () => {},
      finishFileLoadProgress: () => {}, startDownloadProgress: () => 0,
      startFileLoadProgress: () => '', updateDownloadProgress: () => {},
      hasEscrowContent: () => true, loadEscrowContent: fallback,
      loadEncryptedFile: async () => ({
        version: 1, originNode: 'a', exportedAt: now, folder,
        file: stale ? { ...good, dataUrl: 'data:text/plain;base64,b2xk',
          checksum: await sha256(utf8('old')) } : good,
      }),
      saveEncryptedFile: save,
    })
    // The escrow integration correctly rejects the stale body and recovers 'new'.
    expect((await actions.ensureFileContent(file)).dataUrl).toBe(dataUrl)
    expect(fallback).toHaveBeenCalledTimes(stale ? 1 : 0)
    if (stale) expect(proofs.current).toEqual({})
    // Publishing the recovered file must store those bytes, not reuse rejected CID.
    const published = await actions.ensureFolderFilesStored(folder, [file], 'secret')
    expect.soft(published[0].lastCid).toBe(stale ? 'fresh-cid' : 'normal-cid')
    expect(save).toHaveBeenCalledTimes(stale ? 1 : 0)
    if (stale) expect(save).toHaveBeenCalledWith(expect.objectContaining({
      file: expect.objectContaining({ dataUrl, checksum: good.checksum }),
    }))
  },
)

// Parent-folder fallback must validate before caching inline bytes, materializing
// legacy files, accepting bundled CIDs, or recording proofs from nested CID reads.
it.each([
  { source: 'inline-cid', stale: false },
  { source: 'inline-cid', stale: true },
  { source: 'inline-legacy', stale: false },
  { source: 'inline-legacy', stale: true },
  { source: 'file-cid', stale: false },
  { source: 'file-cid', stale: true },
])('validates bundled $source before bookkeeping (stale: $stale)', async ({ source, stale }) => {
  const now = '2026-10-12T00:00:00.000Z'
  const folder = {
    ...makeFolder({ id: 'root', name: 'Root', parentId: null,
      color: 'teal', roomId: 'app-room', now, nodeId: 'a' }),
    shareEnabled: true, lastCid: 'folder-cid',
  }
  const dataUrl = 'data:text/plain;base64,bmV3'
  const good = makeFileFromDataUrl({ id: 'file', folderId: 'root',
    name: 'file.txt', mimeType: 'text/plain', size: 3, dataUrl,
    checksum: await sha256(utf8('new')), now, nodeId: 'a' })
  const file = stripFileContent(good)
  const candidate = stale
    ? { ...good, dataUrl: 'data:text/plain;base64,b2xk', checksum: await sha256(utf8('old')) }
    : good
  const bundled = source === 'file-cid'
    ? { ...stripFileContent(candidate), lastCid: 'bundled-cid' }
    : source === 'inline-cid' ? { ...candidate, lastCid: 'bundled-cid' } : candidate
  const snapshot = {
    folders: [folder], files: [file], activity: [], clock: 1, originNode: 'a',
  } as StorageSnapshot
  const snapshotRef = { current: snapshot }
  const cache = { current: {} as Record<string, string> }
  const proofs = { current: {} as Record<string, string> }
  const fallback = vi.fn(async () => dataUrl)
  const save = vi.fn(async () => 'fresh-cid')
  const actions = createFileContentActions({
    snapshotRef,
    settingsRef: { current: { nodeId: 'a', roomId: 'app-room',
      autoConnect: false, profileName: 'a', avatarUrl: '',
      avatarFileId: '', identity: null } },
    folderKeysRef: { current: { root: 'secret' } },
    fileShareKeysRef: { current: {} },
    fileContentCacheRef: cache,
    fileContentStorageRef: proofs,
    fileContentLoadsRef: { current: {} },
    setFileContentCache: update => {
      cache.current = typeof update === 'function' ? update(cache.current) : update
    },
    setSnapshot: update => {
      snapshotRef.current = typeof update === 'function'
        ? update(snapshotRef.current) : update
    },
    setNotice: () => {}, failDownloadProgress: () => {},
    failFileLoadProgress: () => {}, finishDownloadProgress: () => {},
    finishFileLoadProgress: () => {}, startDownloadProgress: () => 0,
    startFileLoadProgress: () => '', updateDownloadProgress: () => {},
    hasEscrowContent: () => true, loadEscrowContent: fallback,
    loadEncryptedFolder: async () => ({ version: 1, originNode: 'a',
      exportedAt: now, folder, files: [bundled] }),
    loadEncryptedFile: async () => ({ version: 1, originNode: 'a',
      exportedAt: now, folder, file: candidate }),
    saveEncryptedFile: save,
  })
  expect((await actions.ensureFileContent(file)).dataUrl).toBe(dataUrl)
  expect(fallback).toHaveBeenCalledTimes(stale ? 1 : 0)
  if (stale) {
    expect(proofs.current).toEqual({})
    expect(snapshotRef.current).toBe(snapshot)
    // Rejected legacy inline content must not trigger a storage_add either.
    expect(save).not.toHaveBeenCalled()
    const published = await actions.ensureFolderFilesStored(folder, [file], 'secret')
    expect(published[0].lastCid).toBe('fresh-cid')
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      file: expect.objectContaining({ dataUrl, checksum: good.checksum }),
    }))
  } else {
    expect(snapshotRef.current.files[0].lastCid).toBe(
      source === 'inline-legacy' ? 'fresh-cid' : 'bundled-cid',
    )
    expect(save).toHaveBeenCalledTimes(source === 'inline-legacy' ? 1 : 0)
  }
})
