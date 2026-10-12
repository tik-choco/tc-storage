import { afterEach, expect, it, vi } from 'vitest'
import { useDriveIndexPublishEffect } from '../app/useDriveIndexPublishEffect'
import { buildDriveIndex } from '../storage/driveIndex'
import { decryptJson } from '../crypto/crypto'
import { createInitialSnapshot, makeFileFromDataUrl, makeFolder } from '../storage/domain'

const h = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[],
  add: vi.fn(async (_name: string, _bytes: Uint8Array) => 'encrypted-index-cid'),
  unpin: vi.fn(async () => {}), publish: vi.fn() }))
vi.mock('preact/hooks', () => ({ useEffect: (effect: () => void) => { h.effects.push(effect) } }))
vi.mock('../storage/mistStorage', () => ({
  assertMistStorageAvailable: () => {}, ensureMistRuntimeInitialized: () => {},
  loadMistModule: async () => ({ storage_add_pinned: h.add, storage_unpin: h.unpin }),
}))
vi.mock('../storage/sharedBus', () => ({ publishShared: h.publish, readShared: () => null }))
afterEach(() => { h.effects = []; vi.clearAllMocks(); vi.useRealTimers() })

it('never publishes file keys in CID bytes and keeps the decrypted legacy index shape', async () => {
  vi.useFakeTimers()
  const now = '2026-10-12T00:00:00.000Z'
  const folder = makeFolder({ id: 'root', name: 'Secret folder', parentId: null, color: 'teal', roomId: 'app', now, nodeId: 'a' })
  const file = { ...makeFileFromDataUrl({ id: 'file', folderId: 'root', name: 'Secret.txt', mimeType: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,YQ==', checksum: 'a', now, nodeId: 'a' }), lastCid: 'file-cid' }
  const snapshot = { ...createInitialSnapshot('a'), folders: [folder], files: [file] }
  const folderKeys = { root: 'secret-decryption-passphrase' }
  const settings = { nodeId: 'a', roomId: 'app', autoConnect: false, profileName: '', avatarUrl: '', avatarFileId: '', identity: null }
  useDriveIndexPublishEffect({ snapshot, folderKeys, settingsRef: { current: settings } })
  h.effects[0]()
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalled())
  const stored = new TextDecoder().decode(h.add.mock.calls[0][1])
  expect(stored).not.toContain(folderKeys.root)
  expect(stored).not.toContain('passphrase')
  expect(stored).not.toContain(file.name)
  const [topic, cid, meta] = h.publish.mock.calls.at(-1)!
  expect(topic).toBe('drive-index')
  expect(cid).toBe('encrypted-index-cid')
  expect(meta.format).toBe('tc-storage/drive-index/encrypted/1')
  expect(typeof meta.indexKey).toBe('string')
  expect(stored).not.toContain(meta.indexKey)
  const restored = await decryptJson(JSON.parse(stored), meta.indexKey)
  expect(restored).toEqual(buildDriveIndex(snapshot, folderKeys, meta.updatedAt))
  // The new reader only decrypts before the existing wrapped/bare-array parser.
  expect((restored as { files: unknown[] }).files).toHaveLength(1)
  await expect(decryptJson(JSON.parse(stored), 'wrong-key')).rejects.toThrow()
})

it('does not fall back to plaintext or inline secrets after storage failure', async () => {
  vi.useFakeTimers()
  h.add.mockRejectedValueOnce(new Error('offline'))
  useDriveIndexPublishEffect({ snapshot: createInitialSnapshot('a'), folderKeys: {},
    settingsRef: { current: { nodeId: 'a', roomId: 'app', autoConnect: false, profileName: '', avatarUrl: '', avatarFileId: '', identity: null } } })
  h.effects[0]()
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(h.add).toHaveBeenCalled())
  expect(JSON.parse(new TextDecoder().decode(h.add.mock.calls[0][1])).algorithm).toBe('AES-GCM')
  expect(h.publish).not.toHaveBeenCalled()
})
