import { describe, expect, it } from 'vitest'
import { createFileContentActions } from '../app/appFileContentActions'
import { makeFileFromDataUrl, makeFolder } from '../storage/domain'
import type { StorageSnapshot } from '../storage/domain'
import { sha256, utf8 } from './crypto'
import { bytesToBase64 } from '../crypto/cryptoEncoding'

async function fixture() {
  const bytes = utf8('escrow body'),
    dataUrl = 'data:text/plain;base64,' + bytesToBase64(bytes),
    time = '2026-10-12T00:00:00.000Z'
  const file = makeFileFromDataUrl({
    id: 'file',
    folderId: 'root',
    name: 'file',
    mimeType: 'text/plain',
    size: bytes.length,
    dataUrl,
    checksum: await sha256(bytes),
    now: time,
    nodeId: 'a',
  })
  const { dataUrl: _url, ...metadata } = file
  const snapshot: StorageSnapshot = {
    folders: [
      {
        ...makeFolder({
          id: 'root',
          name: 'root',
          parentId: null,
          color: 'teal',
          roomId: 'app-room',
          now: time,
          nodeId: 'a',
        }),
        shareEnabled: true,
      },
    ],
    files: [metadata],
    activity: [],
    clock: 1,
    originNode: 'a',
  }
  const snapshotRef = { current: snapshot },
    cache = { current: {} as Record<string, string> },
    loads = { current: {} as Partial<Record<string, Promise<string>>> }
  let resolve: (data: string) => void = () => {},
    calls = 0,
    delay = false,
    corrupt = false
  const actions = createFileContentActions({
    snapshotRef,
    settingsRef: {
      current: {
        nodeId: 'a',
        roomId: 'app-room',
        autoConnect: false,
        profileName: 'a',
        avatarUrl: '',
        avatarFileId: '',
        identity: null,
      },
    },
    folderKeysRef: { current: { root: 'secret' } },
    fileShareKeysRef: { current: {} },
    fileContentCacheRef: cache,
    fileContentLoadsRef: loads,
    setFileContentCache: (action) => {
      cache.current = typeof action === 'function' ? action(cache.current) : action
    },
    setSnapshot: (action) => {
      snapshotRef.current = typeof action === 'function' ? action(snapshotRef.current) : action
    },
    setNotice: () => {},
    failDownloadProgress: () => {},
    failFileLoadProgress: () => {},
    finishDownloadProgress: () => {},
    finishFileLoadProgress: () => {},
    startDownloadProgress: () => 0,
    startFileLoadProgress: () => '',
    updateDownloadProgress: () => {},
    loadEncryptedFile: async () => {
      throw new Error('Block not found')
    },
    hasEscrowContent: (f) => f.id === metadata.id,
    loadEscrowContent: async () => {
      calls++
      return delay
        ? new Promise<string>((r) => {
            resolve = r
          })
        : corrupt
          ? 'data:text/plain;base64,YmFk'
          : dataUrl
    },
  })
  return {
    actions,
    metadata,
    dataUrl,
    cache,
    snapshotRef,
    loads,
    get calls() {
      return calls
    },
    set delay(v: boolean) {
      delay = v
    },
    set corrupt(v: boolean) {
      corrupt = v
    },
    resolve: (v: string) => resolve(v),
  }
}
describe('ensureFileContent escrow fallback', () => {
  it('is resolvable without a normal CID and verifies reconstructed bytes', async () => {
    const f = await fixture()
    expect(f.actions.canResolveFileContent(f.metadata)).toBe(true)
    expect((await f.actions.ensureFileContent(f.metadata)).dataUrl).toBe(f.dataUrl)
    expect(f.cache.current.file).toBe(f.dataUrl)
  })
  it('falls back after normal CID retrieval fails and rejects stale cached bytes', async () => {
    const f = await fixture()
    f.cache.current.file = 'data:text/plain;base64,b2xk'
    expect((await f.actions.ensureFileContent({ ...f.metadata, lastCid: 'unreachable' })).dataUrl).toBe(f.dataUrl)
    expect(f.calls).toBe(1)
  })
  it('deduplicates by content identity and refuses to cache a download after an edit', async () => {
    const f = await fixture()
    f.delay = true
    const one = f.actions.ensureFileContent(f.metadata)
    // Resolution starts through the ordinary CID promise before entering the fallback.
    await new Promise((r) => setTimeout(r, 0))
    const two = f.actions.ensureFileContent(f.metadata)
    expect(Object.keys(f.loads.current)[0]).toContain(f.metadata.checksum)
    f.snapshotRef.current = {
      ...f.snapshotRef.current,
      files: [{ ...f.metadata, checksum: await sha256(utf8('new')) }],
    }
    f.resolve(f.dataUrl)
    await expect(one).rejects.toThrow('changed')
    await expect(two).rejects.toThrow('changed')
    expect(f.calls).toBe(1)
    expect(f.cache.current.file).toBeUndefined()
  })
  it('never caches corrupted fallback bytes', async () => {
    const f = await fixture()
    f.corrupt = true
    await expect(f.actions.ensureFileContent(f.metadata)).rejects.toThrow('checksum')
    expect(f.cache.current.file).toBeUndefined()
  })
})
