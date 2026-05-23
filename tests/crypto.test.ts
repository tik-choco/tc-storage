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

test('encryptJson rejects tampered ciphertext', async () => {
  const encrypted = await encryptJson({ body: 'do not alter' }, 'folder secret')
  const tampered = {
    ...encrypted,
    cipherText: replaceLastBase64Char(encrypted.cipherText),
  }

  await assert.rejects(() => decryptJson(tampered, 'folder secret'))
})

test('decryptJson rejects unsafe encryption parameters before key derivation', async () => {
  const encrypted = await encryptJson({ body: 'bounded work' }, 'folder secret')

  await assert.rejects(() => decryptJson({ ...encrypted, iterations: 1 }, 'folder secret'), /暗号化パラメーター/)
  await assert.rejects(() => decryptJson({ ...encrypted, iterations: 1000001 }, 'folder secret'), /暗号化パラメーター/)
  await assert.rejects(() => decryptJson({ ...encrypted, kdf: 'PBKDF2-SHA1' as 'PBKDF2-SHA256' }, 'folder secret'), /未対応の暗号化形式/)
  await assert.rejects(() => decryptJson({ ...encrypted, iv: encrypted.salt }, 'folder secret'), /暗号化パラメーター/)
})

test('encryptJson requires Web Crypto subtle', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
  })
  try {
    await assert.rejects(() => encryptJson({ name: 'lan-upload.txt' }, 'folder secret'), /Web Crypto/)
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

function replaceLastBase64Char(value: string): string {
  const replacement = value.endsWith('A') ? 'B' : 'A'
  return `${value.slice(0, -1)}${replacement}`
}
