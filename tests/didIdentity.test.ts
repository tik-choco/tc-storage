import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import {
  createDidIdentity,
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyFromDidKey,
  isEd25519DidKey,
  signStringWithDidIdentity,
  verifyStringWithDid,
} from '../src/didIdentity.js'
import { signShareEnvelope, verifyShareEnvelope, type ShareEnvelope } from '../src/p2p.js'

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

test('did:key round-trips an Ed25519 public key', () => {
  const publicKey = new Uint8Array(32)
  publicKey[0] = 1
  publicKey[31] = 255

  const did = didKeyFromEd25519PublicKey(publicKey)

  assert.match(did, /^did:key:z/)
  assert.equal(isEd25519DidKey(did), true)
  assert.deepEqual(ed25519PublicKeyFromDidKey(did), publicKey)
})

test('Ed25519 DID identity signs and verifies payloads', async () => {
  const identity = await createDidIdentity()
  const signature = await signStringWithDidIdentity(identity, 'tc-storage payload')

  assert.equal(await verifyStringWithDid(identity.did, 'tc-storage payload', signature), true)
  assert.equal(await verifyStringWithDid(identity.did, 'tampered payload', signature), false)
})

test('P2P envelopes signed by did:key identities reject tampering', async () => {
  const identity = await createDidIdentity()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        return storage.get(key) ?? null
      },
      setItem(key: string, value: string) {
        storage.set(key, value)
      },
    },
  })
  localStorage.setItem('tc-storage-did-identity-v1', JSON.stringify(identity))

  try {
    const envelope: ShareEnvelope = {
      type: 'folder-share',
      from: identity.did,
      roomId: 'tc-storage-main',
      sentAt: new Date('2026-05-19T00:00:00.000Z').toISOString(),
      clock: 1,
      folderId: 'folder-a',
      folderName: 'Private notes',
      cid: 'cid-a',
    }

    const signed = await signShareEnvelope(envelope)

    assert.equal(typeof signed.signature, 'string')
    assert.equal(await verifyShareEnvelope(signed), true)
    assert.equal(await verifyShareEnvelope({ ...signed, cid: 'cid-b' }), false)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('P2P rejects malformed did:key senders', async () => {
  assert.equal(await verifyShareEnvelope({
    type: 'hello',
    from: 'did:key:not-ed25519',
    roomId: 'tc-storage-main',
    sentAt: new Date('2026-05-19T00:00:00.000Z').toISOString(),
    clock: 0,
  }), false)
})

test('P2P rejects unsigned legacy node senders', async () => {
  const envelope: ShareEnvelope = {
    type: 'folder-state',
    from: 'node-legacy',
    roomId: 'tc-storage-main',
    sentAt: new Date('2026-05-19T00:00:00.000Z').toISOString(),
    clock: 1,
    folderId: 'folder-a',
    cid: 'cid-a',
  }

  assert.equal(await verifyShareEnvelope(envelope), false)
  await assert.rejects(() => signShareEnvelope(envelope), /did:key/)
})
