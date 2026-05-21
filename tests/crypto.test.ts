import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { createAccessRequestKey, decryptFolderKeyGrant, encryptFolderKeyForRequest } from '../src/accessGrantCrypto.js'
import { decryptJson, encryptJson } from '../src/crypto.js'

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

test('encryptJson keeps payload opaque and decrypts with the folder key', async () => {
  const payload = { folder: 'Product', files: [{ name: 'roadmap.md', body: 'launch notes' }] }
  const encrypted = await encryptJson(payload, 'folder secret')

  assert.equal(encrypted.algorithm, 'AES-GCM')
  assert.equal(JSON.stringify(encrypted).includes('launch notes'), false)
  await assert.rejects(() => decryptJson(encrypted, 'wrong secret'))
  assert.deepEqual(await decryptJson(encrypted, 'folder secret'), payload)
})

test('encryptJson falls back when crypto.subtle is unavailable', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
  })
  try {
    const payload = { name: 'lan-upload.txt', body: 'works over http ip' }
    const encrypted = await encryptJson(payload, 'folder secret')
    assert.equal(encrypted.algorithm, 'CHACHA20-HMAC-SHA256')
    assert.equal(JSON.stringify(encrypted).includes('works over http ip'), false)
    assert.deepEqual(await decryptJson(encrypted, 'folder secret'), payload)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
  }
})

test('folder access grant encrypts the folder key for the requesting public key', async () => {
  const requestKey = await createAccessRequestKey()
  const otherRequestKey = await createAccessRequestKey()
  const grant = await encryptFolderKeyForRequest('folder-secret', requestKey.publicKey)

  assert.equal(JSON.stringify(grant).includes('folder-secret'), false)
  assert.equal(await decryptFolderKeyGrant({ ...grant, privateKey: requestKey.privateKey }), 'folder-secret')
  await assert.rejects(() => decryptFolderKeyGrant({ ...grant, privateKey: otherRequestKey.privateKey }))
})
