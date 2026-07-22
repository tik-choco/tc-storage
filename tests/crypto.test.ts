import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { test } from 'node:test'
import { createAccessRequestKey, decryptFolderKeyGrant, encryptFolderKeyForRequest } from '../src/crypto/accessGrantCrypto.js'
import { decryptJson, encryptJson, type AesGcmPayload } from '../src/crypto/crypto.js'

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

test('encryptJson uses the fast HKDF path (folder/file keys are already high-entropy, not human passwords)', async () => {
  const encrypted = await encryptJson({ body: 'fast path' }, 'folder secret')

  assert.equal(encrypted.kdf, 'HKDF-SHA256')
  assert.equal(encrypted.iterations, 0)
  assert.deepEqual(await decryptJson(encrypted, 'folder secret'), { body: 'fast path' })
})

test('decryptJson still decrypts data encrypted before the HKDF switch (PBKDF2-SHA256, 210000 iterations)', async () => {
  const passphrase = 'legacy-folder-key-abc123'
  const legacyPayload = await encryptWithLegacyPbkdf2({ body: 'stored under the old scheme' }, passphrase, 210000)

  assert.deepEqual(await decryptJson(legacyPayload, passphrase), { body: 'stored under the old scheme' })
  await assert.rejects(() => decryptJson(legacyPayload, 'wrong secret'))
})

test('decryptJson still enforces the PBKDF2 iteration bounds on legacy payloads', async () => {
  const passphrase = 'legacy-folder-key-abc123'
  const tooFewIterations = await encryptWithLegacyPbkdf2({ body: 'x' }, passphrase, 50000)
  const tooManyIterations = await encryptWithLegacyPbkdf2({ body: 'x' }, passphrase, 2000000)

  await assert.rejects(() => decryptJson(tooFewIterations, passphrase), /暗号化パラメーター/)
  await assert.rejects(() => decryptJson(tooManyIterations, passphrase), /暗号化パラメーター/)
})

test('HKDF is dramatically cheaper than the legacy PBKDF2 path (informational timing, no CI assertion)', async () => {
  const passphrase = 'folder secret'
  const legacyPayload = await encryptWithLegacyPbkdf2({ body: 'timing sample' }, passphrase, 210000)
  const fastPayload = await encryptJson({ body: 'timing sample' }, passphrase)

  const legacyStart = performance.now()
  await decryptJson(legacyPayload, passphrase)
  const legacyMs = performance.now() - legacyStart

  const fastStart = performance.now()
  await decryptJson(fastPayload, passphrase)
  const fastMs = performance.now() - fastStart

  console.log(`[crypto timing] PBKDF2-SHA256 (210000 iter): ${legacyMs.toFixed(1)}ms, HKDF-SHA256: ${fastMs.toFixed(1)}ms`)
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

/** Reproduces the pre-HKDF encryption scheme independently of src/crypto/crypto.ts,
 * so the backward-compat tests prove decryptJson still honors data written before
 * the HKDF switch rather than just round-tripping through the current encrypt path. */
async function encryptWithLegacyPbkdf2(value: unknown, passphrase: string, iterations: number): Promise<AesGcmPayload> {
  const encoder = new TextEncoder()
  const salt = webcrypto.getRandomValues(new Uint8Array(16))
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const baseKey = await webcrypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  const key = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const cipherText = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)))
  return {
    version: 1,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: Buffer.from(salt).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    cipherText: Buffer.from(cipherText).toString('base64'),
  }
}
