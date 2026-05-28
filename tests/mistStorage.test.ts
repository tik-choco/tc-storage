import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { makeFileFromDataUrl, makeFolder } from '../src/domain.js'
import { configureMistStorageCapacity, ensureMistRuntimeInitialized, mistStorageMaxCapacityMb, saveEncryptedFileToMist } from '../src/mistStorage.js'

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')

afterEach(() => {
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
  else Reflect.deleteProperty(globalThis, 'navigator')

  if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor)
  else Reflect.deleteProperty(globalThis, 'location')
})

test('saveEncryptedFileToMist reports OPFS requirements before loading mistlib', async () => {
  const now = '2026-05-17T00:00:00.000Z'
  const folder = makeFolder({
    id: 'folder-test',
    name: 'Test',
    parentId: null,
    color: 'teal',
    roomId: 'tc-storage-main',
    now,
    nodeId: 'node-test',
  })
  const file = makeFileFromDataUrl({
    id: 'file-test',
    folderId: folder.id,
    name: 'note.txt',
    mimeType: 'text/plain',
    size: 4,
    dataUrl: 'data:text/plain;base64,dGVzdA==',
    checksum: 'checksum',
    now,
    nodeId: 'node-test',
  })

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: {} },
  })
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: {
      protocol: 'http:',
      hostname: '133.37.59.27',
      port: '5178',
      pathname: '/',
      search: '',
      hash: '',
    },
  })

  await assert.rejects(
    () => saveEncryptedFileToMist({ folder, file, passphrase: 'secret', originNode: 'node-test' }),
    /http:\/\/localhost:5178\/.*HTTPS/,
  )
})

test('configureMistStorageCapacity sets mistlib storage capacity to 256 GiB', () => {
  let appliedConfig = ''
  const mist = {
    get_config() {
      return JSON.stringify({
        maxConnectionCount: 30,
        storageMaxCapacityMb: 8192,
      })
    },
    set_config(data: string) {
      appliedConfig = data
      return true
    },
  }

  assert.equal(configureMistStorageCapacity(mist), true)
  assert.deepEqual(JSON.parse(appliedConfig), {
    maxConnectionCount: 30,
    storageMaxCapacityMb: mistStorageMaxCapacityMb,
  })
})

test('ensureMistRuntimeInitialized initializes mistlib storage runtime once per node id', () => {
  const calls: string[] = []
  const mist = {
    init_with_config(id: string, _config: string): boolean {
      calls.push(id)
      return true
    },
  }

  ensureMistRuntimeInitialized(mist, { nodeId: 'node-storage-test-a' })
  ensureMistRuntimeInitialized(mist, { nodeId: 'node-storage-test-a' })
  ensureMistRuntimeInitialized(mist, { nodeId: 'node-storage-test-b' })

  assert.deepEqual(calls, ['node-storage-test-a', 'node-storage-test-b'])
})
