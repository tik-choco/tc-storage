import { base64ToBytes, bytesToBase64, toArrayBuffer } from './cryptoEncoding.js'

type AccessGrantPayload = {
  key: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const ecdhAlgorithm = { name: 'ECDH', namedCurve: 'P-256' } as const

export type AccessRequestKey = {
  privateKey: CryptoKey
  publicKey: string
}

export type EncryptedAccessGrant = {
  cipherText: string
  iv: string
  publicKey: string
}

export async function createAccessRequestKey(): Promise<AccessRequestKey> {
  const pair = await globalThis.crypto.subtle.generateKey(ecdhAlgorithm, true, ['deriveKey']) as CryptoKeyPair
  const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: toBase64Url(bytesToBase64(publicKey)) }
}

export async function encryptFolderKeyForRequest(folderKey: string, requestPublicKey: string): Promise<EncryptedAccessGrant> {
  const pair = await globalThis.crypto.subtle.generateKey(ecdhAlgorithm, true, ['deriveKey']) as CryptoKeyPair
  const peerPublicKey = await importPublicKey(requestPublicKey)
  const key = await deriveGrantKey(pair.privateKey, peerPublicKey)
  const iv = randomBytes(12)
  const payload: AccessGrantPayload = { key: folderKey }
  const encrypted = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, encoder.encode(JSON.stringify(payload)))
  const publicKey = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))
  return {
    cipherText: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
    publicKey: toBase64Url(bytesToBase64(publicKey)),
  }
}

export async function decryptFolderKeyGrant(options: {
  cipherText: string
  iv: string
  privateKey: CryptoKey
  publicKey: string
}): Promise<string> {
  const peerPublicKey = await importPublicKey(options.publicKey)
  const key = await deriveGrantKey(options.privateKey, peerPublicKey)
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(base64ToBytes(options.iv)) },
    key,
    toArrayBuffer(base64ToBytes(options.cipherText)),
  )
  const payload = JSON.parse(decoder.decode(decrypted)) as Partial<AccessGrantPayload>
  if (!payload.key) throw new Error('共有キーが承認レスポンスに含まれていません')
  return payload.key
}

async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', toArrayBuffer(base64ToBytes(fromBase64Url(publicKey))), ecdhAlgorithm, false, [])
}

function deriveGrantKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return globalThis.crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

function toBase64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
}
