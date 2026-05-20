import { base64ToBytes, bytesToBase64, concatBytes, hex, toArrayBuffer } from './cryptoEncoding.js'
import { chacha20, constantTimeEqual, hmacSha256, pbkdf2Sha256, sha256 } from './cryptoFallback.js'

export type AesGcmPayload = {
  version: 1
  algorithm: 'AES-GCM'
  kdf: 'PBKDF2-SHA256'
  iterations: number
  salt: string
  iv: string
  cipherText: string
}

export type ChachaPayload = {
  version: 1
  algorithm: 'CHACHA20-HMAC-SHA256'
  kdf: 'PBKDF2-SHA256-JS'
  iterations: number
  salt: string
  iv: string
  cipherText: string
  authTag: string
}

export type EncryptedPayload = AesGcmPayload | ChachaPayload
export { base64ToBytes, bytesToBase64 }

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const webCryptoIterations = 210000
const fallbackIterations = 20000

export async function encryptJson(value: unknown, passphrase: string): Promise<EncryptedPayload> {
  const phrase = passphrase.trim()
  if (!phrase) throw new Error('暗号化キーが必要です')
  const encoded = encoder.encode(JSON.stringify(value))
  return hasSubtleCrypto() ? encryptAesGcm(encoded, phrase) : encryptChacha(encoded, phrase)
}

export async function decryptJson<T>(payload: EncryptedPayload, passphrase: string): Promise<T> {
  const phrase = passphrase.trim()
  if (!phrase) throw new Error('復号キーが必要です')
  if (payload.version !== 1) throw new Error('未対応の暗号化形式です')
  const decrypted =
    payload.algorithm === 'AES-GCM' ? await decryptAesGcm(payload, phrase) : decryptChacha(payload, phrase)
  return JSON.parse(decoder.decode(decrypted)) as T
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (hasSubtleCrypto()) {
    const digest = await subtleCrypto().digest('SHA-256', toArrayBuffer(bytes))
    return hex(new Uint8Array(digest))
  }
  return hex(sha256(bytes))
}

async function encryptAesGcm(data: Uint8Array, passphrase: string): Promise<AesGcmPayload> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveWebCryptoKey(passphrase, salt)
  const encrypted = await subtleCrypto().encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(data))
  return {
    version: 1,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: webCryptoIterations,
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
  const key = await deriveWebCryptoKey(passphrase, salt, payload.iterations)
  const decrypted = await subtleCrypto().decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(cipherText))
  return new Uint8Array(decrypted)
}

function encryptChacha(data: Uint8Array, passphrase: string): ChachaPayload {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const keyMaterial = pbkdf2Sha256(encoder.encode(passphrase), salt, fallbackIterations, 64)
  const cipherText = chacha20(data, keyMaterial.slice(0, 32), iv)
  const authTag = hmacSha256(keyMaterial.slice(32, 64), concatBytes(iv, cipherText))
  return {
    version: 1,
    algorithm: 'CHACHA20-HMAC-SHA256',
    kdf: 'PBKDF2-SHA256-JS',
    iterations: fallbackIterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    cipherText: bytesToBase64(cipherText),
    authTag: bytesToBase64(authTag),
  }
}

function decryptChacha(payload: ChachaPayload, passphrase: string): Uint8Array {
  const salt = base64ToBytes(payload.salt)
  const iv = base64ToBytes(payload.iv)
  const cipherText = base64ToBytes(payload.cipherText)
  const keyMaterial = pbkdf2Sha256(encoder.encode(passphrase), salt, payload.iterations, 64)
  const expectedTag = hmacSha256(keyMaterial.slice(32, 64), concatBytes(iv, cipherText))
  if (!constantTimeEqual(expectedTag, base64ToBytes(payload.authTag))) throw new Error('復号キーが正しくありません')
  return chacha20(cipherText, keyMaterial.slice(0, 32), iv)
}

async function deriveWebCryptoKey(passphrase: string, salt: Uint8Array, iterationCount = webCryptoIterations): Promise<CryptoKey> {
  const passphraseBytes = encoder.encode(passphrase)
  const baseKey = await subtleCrypto().importKey('raw', toArrayBuffer(passphraseBytes), 'PBKDF2', false, ['deriveKey'])
  return subtleCrypto().deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: iterationCount, hash: 'SHA-256' },
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
