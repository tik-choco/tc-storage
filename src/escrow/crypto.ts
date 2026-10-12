export const utf8 = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value)
export const hex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
export const fromHex = (value: string): Uint8Array<ArrayBuffer> => {
  if (!/^(?:[0-9a-f]{2})*$/.test(value)) throw new Error('Invalid hex')
  return Uint8Array.from(value.match(/../g) ?? [], b => parseInt(b, 16))
}
export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url')
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  if (base64url(bytes) !== value) throw new Error('Noncanonical base64url')
  return bytes
}
export const sha256 = async (bytes: Uint8Array): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))))

export interface EscrowKeys {
  readonly slot: string
  readonly encKey: CryptoKey
  readonly writer: string
  sign(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
}
const masterCache = new Map<string, Promise<CryptoKey>>()
const keyCache = new Map<string, Promise<EscrowKeys>>()

export function deriveEscrowKeys(app: string, roomId: string): Promise<EscrowKeys> {
  if (typeof app !== 'string' || typeof roomId !== 'string') throw new Error('Invalid escrow key inputs')
  const cacheId = JSON.stringify([app, roomId])
  let pending = keyCache.get(cacheId)
  if (!pending) {
    pending = derive(app, roomId)
    keyCache.set(cacheId, pending)
    void pending.catch(() => { if (keyCache.get(cacheId) === pending) keyCache.delete(cacheId) })
  }
  return pending
}
function cachedMaster(app: string, roomId: string): Promise<CryptoKey> {
  if (typeof app !== 'string' || typeof roomId !== 'string') throw new Error('Invalid escrow key inputs')
  const id = JSON.stringify([app, roomId])
  let pending = masterCache.get(id)
  if (!pending) {
    pending = deriveMaster(app, roomId)
    masterCache.set(id, pending)
    void pending.catch(() => { if (masterCache.get(id) === pending) masterCache.delete(id) })
  }
  return pending
}
async function deriveMaster(app: string, roomId: string): Promise<CryptoKey> {
  const password = await crypto.subtle.importKey('raw', utf8('tc-escrow/v1\n' + app + '\n' + roomId), 'PBKDF2', false, ['deriveBits'])
  const master = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: utf8('tc-escrow/v1/salt'), iterations: 200000,
  }, password, 256))
  const ikm = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits'])
  master.fill(0)
  return ikm
}
async function hkdf(ikm: CryptoKey, name: string, bits: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: utf8('tc-escrow/v1/' + name),
  }, ikm, bits))
}
export async function deriveAutoRoom(app: string, roomId: string): Promise<string> {
  return 'tce-' + hex(await hkdf(await cachedMaster(app, roomId), 'room', 96))
}
async function derive(app: string, roomId: string): Promise<EscrowKeys> {
  const ikm = await cachedMaster(app, roomId)
  const slot = hex(await hkdf(ikm, 'slot', 128))
  const enc = await hkdf(ikm, 'enc', 256)
  const seed = await hkdf(ikm, 'write', 256)
  const pkcs8 = new Uint8Array(48)
  pkcs8.set(fromHex('302e020100300506032b657004220420'))
  pkcs8.set(seed, 16)
  // Export only long enough to obtain the public component, then reimport nonextractable.
  const pair = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign'])
  const jwk = await crypto.subtle.exportKey('jwk', pair)
  const writer = jwk.x!
  const signingKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign'])
  const encKey = await crypto.subtle.importKey('raw', enc, 'AES-GCM', false, ['encrypt', 'decrypt'])
  enc.fill(0); seed.fill(0); pkcs8.fill(0)
  return Object.freeze({ slot, encKey, writer, sign: async (bytes: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign('Ed25519', signingKey, new Uint8Array(bytes))) })
}
export function blobAAD(slot: string, seq: number): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{32}$/.test(slot) || !Number.isSafeInteger(seq) || seq < 1) throw new Error('Invalid blob context')
  return utf8('tc-escrow/v1|' + slot + '|' + seq)
}
export async function encryptBlob(encKey: CryptoKey, slot: string, seq: number, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: blobAAD(slot, seq), tagLength: 128,
  }, encKey, new Uint8Array(plaintext)))
  const blob = new Uint8Array(12 + ciphertext.length)
  blob.set(iv); blob.set(ciphertext, 12)
  return blob
}
export async function decryptBlob(encKey: CryptoKey, slot: string, seq: number, blob: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (blob.length < 28) throw new Error('Truncated escrow blob')
  return new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: new Uint8Array(blob.subarray(0, 12)), additionalData: blobAAD(slot, seq), tagLength: 128,
  }, encKey, new Uint8Array(blob.subarray(12))))
}
export const DEFAULT_MAX_PLAINTEXT = 128 * 1024 * 1024
async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Invalid output limit')
  const reader = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream).getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new Error('Escrow output exceeds limit')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}
export const supportsGzip = (): boolean => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'
export function gzip(bytes: Uint8Array, maxBytes = DEFAULT_MAX_PLAINTEXT): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof CompressionStream === 'undefined') throw new Error('Gzip compression unavailable')
  return transform(bytes, new CompressionStream('gzip'), maxBytes)
}
export function gunzip(bytes: Uint8Array, maxBytes = DEFAULT_MAX_PLAINTEXT): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream === 'undefined') throw new Error('Gzip decompression unavailable')
  return transform(bytes, new DecompressionStream('gzip'), maxBytes)
}
