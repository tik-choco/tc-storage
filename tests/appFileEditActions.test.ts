import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { createFileEditActions, type FileEditActions } from '../src/app/appFileEditActions.js'
import { sha256Hex } from '../src/crypto/crypto.js'
import { bytesToBase64 } from '../src/crypto/cryptoEncoding.js'
import { makeFileFromDataUrl, makeFolder, stripFileContent, type FileRecord, type FolderRecord, type StorageSnapshot } from '../src/storage/domain.js'
import type { Notice } from '../src/app/appTypes.js'

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

type StateUpdate<T> = T | ((current: T) => T)
type AnnounceCall = { changeType: 'file-upserted' | 'file-deleted'; file?: FileRecord; folderId: string }

test('saveTextFileContent updates the snapshot, caches the dataUrl and stores in the background', async () => {
  const harness = await createHarness()
  const updatedText = 'hello world'

  await harness.actions.saveTextFileContent(harness.file, updatedText)

  const expectedChecksum = await sha256Hex(new TextEncoder().encode(updatedText))
  const savedFile = harness.snapshot().files.find((item) => item.id === harness.file.id)
  assert.ok(savedFile)
  assert.equal(savedFile?.checksum, expectedChecksum)
  assert.notEqual(savedFile?.checksum, harness.file.checksum)
  assert.equal(savedFile?.version, harness.file.version + 1)
  assert.equal(savedFile?.dataUrl, undefined)
  assert.equal(harness.cache()[harness.file.id], `data:text/plain;base64,${bytesToBase64(new TextEncoder().encode(updatedText))}`)
  assert.equal(harness.notices.at(-1)?.tone, 'success')

  await settle()

  assert.equal(harness.saveCalls.length, 1)
  assert.equal(harness.saveCalls[0]?.file.checksum, expectedChecksum)
  assert.equal(harness.saveCalls[0]?.folder.id, harness.folder.id)
  const restoredFile = harness.snapshot().files.find((item) => item.id === harness.file.id)
  assert.equal(restoredFile?.lastCid, 'cid-1')
  assert.equal(harness.announceCalls.length, 1)
  assert.equal(harness.announceCalls[0]?.changeType, 'file-upserted')
  assert.equal(harness.announceCalls[0]?.file?.lastCid, 'cid-1')
})

test('saveTextFileContent is a no-op when the text checksum is unchanged', async () => {
  const harness = await createHarness()

  await harness.actions.saveTextFileContent(harness.file, harness.originalText)

  assert.deepEqual(harness.snapshot(), harness.initialSnapshot)
  assert.equal(Object.keys(harness.cache()).length, 0)
  assert.equal(harness.notices.length, 0)

  await settle()

  assert.equal(harness.saveCalls.length, 0)
  assert.equal(harness.announceCalls.length, 0)
})

test('saveTextFileContent rejects and reports an error notice when the file cannot be found', async () => {
  const harness = await createHarness()
  const missingFile: FileRecord = { ...harness.file, id: 'file-missing' }

  await assert.rejects(() => harness.actions.saveTextFileContent(missingFile, 'new text'), /見つかりません/)

  assert.equal(harness.notices.at(-1)?.tone, 'error')
  assert.equal(harness.saveCalls.length, 0)
  assert.deepEqual(harness.snapshot(), harness.initialSnapshot)
})

test('saveTextFileContent rejects for a file that has already been deleted', async () => {
  const harness = await createHarness()
  const deletedFile: FileRecord = { ...harness.file, deletedAt: '2026-05-23T00:00:05.000Z' }
  harness.setSnapshotDirect({
    ...harness.snapshot(),
    files: harness.snapshot().files.map((item) => (item.id === harness.file.id ? deletedFile : item)),
  })

  await assert.rejects(() => harness.actions.saveTextFileContent(harness.file, 'new text'), /見つかりません/)

  assert.equal(harness.notices.at(-1)?.tone, 'error')
  assert.equal(harness.saveCalls.length, 0)
})

async function createHarness() {
  const now = '2026-05-23T00:00:00.000Z'
  const originalText = 'hello'
  const originalBytes = new TextEncoder().encode(originalText)
  const checksum = await sha256Hex(originalBytes)
  const folder: FolderRecord = makeFolder({ id: 'folder-a', name: 'Docs', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const file: FileRecord = stripFileContent(makeFileFromDataUrl({
    id: 'file-a',
    folderId: folder.id,
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: originalBytes.length,
    dataUrl: `data:text/plain;base64,${bytesToBase64(originalBytes)}`,
    checksum,
    now,
    nodeId: 'node-a',
  }))
  const initialSnapshot: StorageSnapshot = {
    folders: [folder],
    files: [file],
    activity: [],
    clock: 1,
    originNode: 'node-a',
  }

  let snapshotValue = initialSnapshot
  let cacheValue: Record<string, string> = {}
  let folderKeysValue: Record<string, string> = {}
  const notices: Notice[] = []
  const saveCalls: { file: FileRecord; folder: FolderRecord; passphrase: string }[] = []
  const announceCalls: AnnounceCall[] = []

  const snapshotRef = { current: snapshotValue }
  const folderKeysRef = { current: folderKeysValue }
  const settingsRef = { current: { roomId: 'tc-storage-main', nodeId: 'node-a', identity: null, autoConnect: false, profileName: 'Test user', avatarUrl: '', avatarFileId: '' } }

  const setSnapshot = (update: StateUpdate<StorageSnapshot>) => {
    snapshotValue = applyStateUpdate(snapshotValue, update)
    snapshotRef.current = snapshotValue
  }
  const setFolderKeys = (update: StateUpdate<Record<string, string>>) => {
    folderKeysValue = applyStateUpdate(folderKeysValue, update)
    folderKeysRef.current = folderKeysValue
  }

  const actions: FileEditActions = createFileEditActions({
    announceFolderChange: (announcedFolder, changeType, announcedFile) => {
      announceCalls.push({ changeType, file: announcedFile, folderId: announcedFolder.id })
    },
    folderKeysRef,
    saveEncryptedFile: async (options) => {
      saveCalls.push({ file: options.file, folder: options.folder, passphrase: options.passphrase })
      return `cid-${saveCalls.length}`
    },
    scheduleFolderSync: () => {},
    setFileContentCache: (update) => {
      cacheValue = applyStateUpdate(cacheValue, update)
    },
    setFolderKeys,
    setNotice: (update) => {
      notices.push(applyStateUpdate(notices.at(-1) ?? { tone: 'success', text: '' }, update))
    },
    setSnapshot,
    settingsRef,
    snapshotRef,
  })

  return {
    actions,
    file,
    folder,
    originalText,
    initialSnapshot,
    cache: () => cacheValue,
    notices,
    saveCalls,
    announceCalls,
    snapshot: () => snapshotValue,
    setSnapshotDirect: (next: StorageSnapshot) => setSnapshot(next),
  }
}

function applyStateUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}
