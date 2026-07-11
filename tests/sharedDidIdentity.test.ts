import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { createDidIdentity, type DidIdentity } from '../src/crypto/didIdentity.js'
import { reconcileSharedDidIdentity, sharedDidIdentityCidKey, type SharedStorageBackend } from '../src/crypto/sharedDidIdentity.js'

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    dump: () => Object.fromEntries(map),
  }
}

function fakeBackend(initial: Record<string, Uint8Array> = {}) {
  const blocks = new Map(Object.entries(initial))
  let nextCid = 0
  const backend: SharedStorageBackend = {
    async retrieve(cid: string) {
      return blocks.get(cid)
    },
    async store(bytes: Uint8Array) {
      const cid = `cid-${nextCid += 1}`
      blocks.set(cid, bytes)
      return cid
    },
  }
  return { backend, blocks }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

test('reconcileSharedDidIdentity: local identity wins and is written back when shared store disagrees', async () => {
  const local = await createDidIdentity()
  const other = await createDidIdentity()
  const { backend, blocks } = fakeBackend({ 'cid-existing': encoder.encode(JSON.stringify(other)) })
  const storage = fakeStorage({ [sharedDidIdentityCidKey]: 'cid-existing' })

  const result = await reconcileSharedDidIdentity({ localIdentity: local, backend, storage })

  assert.equal(result?.did, local.did)
  const newCid = storage.getItem(sharedDidIdentityCidKey)
  assert.ok(newCid && newCid !== 'cid-existing')
  assert.deepEqual(JSON.parse(decoder.decode(blocks.get(newCid!))), local)
})

test('reconcileSharedDidIdentity: local identity is written when shared store is empty', async () => {
  const local = await createDidIdentity()
  const { backend, blocks } = fakeBackend()
  const storage = fakeStorage()

  const result = await reconcileSharedDidIdentity({ localIdentity: local, backend, storage })

  assert.equal(result?.did, local.did)
  const cid = storage.getItem(sharedDidIdentityCidKey)
  assert.ok(cid)
  assert.deepEqual(JSON.parse(decoder.decode(blocks.get(cid!))), local)
})

test('reconcileSharedDidIdentity: does not write back when shared store already agrees', async () => {
  const local = await createDidIdentity()
  const { backend, blocks } = fakeBackend({ 'cid-current': encoder.encode(JSON.stringify(local)) })
  const storage = fakeStorage({ [sharedDidIdentityCidKey]: 'cid-current' })

  const result = await reconcileSharedDidIdentity({ localIdentity: local, backend, storage })

  assert.equal(result?.did, local.did)
  assert.equal(storage.getItem(sharedDidIdentityCidKey), 'cid-current')
  assert.equal(blocks.size, 1)
})

test('reconcileSharedDidIdentity: adopts shared identity when local mirror is missing', async () => {
  const shared: DidIdentity = await createDidIdentity()
  const { backend } = fakeBackend({ 'cid-shared': encoder.encode(JSON.stringify(shared)) })
  const storage = fakeStorage({ [sharedDidIdentityCidKey]: 'cid-shared' })

  const result = await reconcileSharedDidIdentity({ localIdentity: undefined, backend, storage })

  assert.equal(result?.did, shared.did)
  assert.deepEqual(JSON.parse(storage.getItem('tc-storage-did-identity-v1')!), shared)
})

test('reconcileSharedDidIdentity: returns undefined when neither local nor shared identity exist', async () => {
  const { backend } = fakeBackend()
  const storage = fakeStorage()

  const result = await reconcileSharedDidIdentity({ localIdentity: undefined, backend, storage })

  assert.equal(result, undefined)
})

test('reconcileSharedDidIdentity: swallows backend failures and returns local identity', async () => {
  const local = await createDidIdentity()
  const storage = fakeStorage({ [sharedDidIdentityCidKey]: 'cid-broken' })
  const backend: SharedStorageBackend = {
    retrieve: async () => { throw new Error('network down') },
    store: async () => { throw new Error('network down') },
  }

  const result = await reconcileSharedDidIdentity({ localIdentity: local, backend, storage })

  assert.equal(result?.did, local.did)
})
