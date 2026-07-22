import { base64ToBytes, bytesToBase64, hex, toArrayBuffer } from './cryptoEncoding.js'

export type AesGcmPayload = {
  version: 1
  algorithm: 'AES-GCM'
  kdf: 'PBKDF2-SHA256' | 'HKDF-SHA256'
  iterations: number
  salt: string
  iv: string
  cipherText: string
}

export type EncryptedPayload = AesGcmPayload
export { base64ToBytes, bytesToBase64 }

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const minWebCryptoIterations = 100000
const maxWebCryptoIterations = 1000000

export async function encryptJson(value: unknown, passphrase: string): Promise<EncryptedPayload> {
  const phrase = passphrase.trim()
  if (!phrase) throw new Error('暗号化キーが必要です')
  if (!hasSubtleCrypto()) throw new Error('暗号化にはHTTPSまたはlocalhostでWeb Crypto APIが必要です')
  const encoded = encoder.encode(JSON.stringify(value))
  return encryptAesGcm(encoded, phrase)
}

export async function decryptJson<T>(payload: EncryptedPayload, passphrase: string): Promise<T> {
  const phrase = passphrase.trim()
  if (!phrase) throw new Error('復号キーが必要です')
  validateAesGcmPayload(payload)
  const decrypted = await decryptAesGcm(payload, phrase)
  return JSON.parse(decoder.decode(decrypted)) as T
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await subtleCrypto().digest('SHA-256', toArrayBuffer(bytes))
  return hex(new Uint8Array(digest))
}

async function encryptAesGcm(data: Uint8Array, passphrase: string): Promise<AesGcmPayload> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  // Every passphrase this module ever sees is a 24-byte crypto.getRandomValues()
  // key (generateFolderKey/generateFileShareKey) -- there is no human-typed
  // password path anywhere upstream. PBKDF2's iteration stretching exists to
  // slow brute-force against low-entropy secrets, which buys nothing here and
  // costs a real ~100ms per file decrypt. HKDF is the standard fast construction
  // for deriving a symmetric key from already-high-entropy input keying material.
  const key = await deriveWebCryptoKey(passphrase, salt, 'HKDF-SHA256', 0)
  const encrypted = await subtleCrypto().encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(data))
  return {
    version: 1,
    algorithm: 'AES-GCM',
    kdf: 'HKDF-SHA256',
    iterations: 0,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    cipherText: bytesToBase64(new Uint8Array(encrypted)),
  }
}

async function decryptAesGcm(payload: AesGcmPayload, passphrase: string): Promise<Uint8Array> {
  if (!hasSubtleCrypto()) {
    throw new Error('このデータはAES-GCM形式です。復号にはHTTPSまたはlocalhostでWeb Crypto APIが必要です')
  }
  const salt = base64ToBytes(payload.salt)
  const iv = base64ToBytes(payload.iv)
  const cipherText = base64ToBytes(payload.cipherText)
  // kdf/iterations come from the payload (not a module constant) so data
  // encrypted before the HKDF switch keeps decrypting with its original PBKDF2
  // parameters -- old and new payloads coexist indefinitely.
  const key = await deriveWebCryptoKey(passphrase, salt, payload.kdf, payload.iterations)
  const decrypted = await subtleCrypto().decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(cipherText))
  return new Uint8Array(decrypted)
}

function validateAesGcmPayload(payload: unknown): asserts payload is AesGcmPayload {
  if (!payload || typeof payload !== 'object') throw new Error('未対応の暗号化形式です')
  const value = payload as Partial<AesGcmPayload>
  if (typeof value.salt !== 'string' || typeof value.iv !== 'string' || typeof value.cipherText !== 'string') {
    throw new Error('暗号化パラメーターが不正です')
  }
  if (value.version !== 1) throw new Error('未対応の暗号化形式です')
  if (value.algorithm !== 'AES-GCM') throw new Error('未対応の暗号化形式です')
  if (value.kdf !== 'PBKDF2-SHA256' && value.kdf !== 'HKDF-SHA256') throw new Error('未対応の暗号化形式です')
  const iterations = value.iterations
  if (typeof iterations !== 'number' || !Number.isInteger(iterations)) {
    throw new Error('暗号化パラメーターが不正です')
  }
  if (value.kdf === 'PBKDF2-SHA256') {
    if (iterations < minWebCryptoIterations || iterations > maxWebCryptoIterations) throw new Error('暗号化パラメーターが不正です')
  } else if (iterations !== 0) {
    throw new Error('暗号化パラメーターが不正です')
  }

  const salt = base64ToBytes(value.salt)
  const iv = base64ToBytes(value.iv)
  const cipherText = base64ToBytes(value.cipherText)
  if (salt.byteLength !== 16 || iv.byteLength !== 12 || cipherText.byteLength === 0) {
    throw new Error('暗号化パラメーターが不正です')
  }
}

async function deriveWebCryptoKey(passphrase: string, salt: Uint8Array, kdf: AesGcmPayload['kdf'], iterations: number): Promise<CryptoKey> {
  const passphraseBytes = encoder.encode(passphrase)
  if (kdf === 'HKDF-SHA256') {
    const baseKey = await subtleCrypto().importKey('raw', toArrayBuffer(passphraseBytes), 'HKDF', false, ['deriveKey'])
    return subtleCrypto().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(salt), info: new Uint8Array(0) },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  }
  const baseKey = await subtleCrypto().importKey('raw', toArrayBuffer(passphraseBytes), 'PBKDF2', false, ['deriveKey'])
  return subtleCrypto().deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function randomBytes(length: number): Uint8Array {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('暗号化に必要な安全な乱数生成が利用できません')
  }
  const bytes = new Uint8Array(length)
  cryptoApi.getRandomValues(bytes)
  return bytes
}

function hasSubtleCrypto(): boolean {
  return Boolean(globalThis.crypto?.subtle)
}

function subtleCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Web Crypto API が利用できません')
  return subtle
}
