// Sends a single drive file to a sibling family app (tc-pdf-viewer / tc-note)
// via the shared bus — the reverse direction of tc-note's storage-drive-inbox
// and the same wire shape: each file is encrypted with a fresh throwaway
// AES-256-GCM key (the mistlib block store may be P2P-visible), the ciphertext
// is uploaded via storage_add, and the CID plus key/iv/checksum/metadata are
// appended to a rolling per-topic item list republished wholesale. The
// consumer decrypts after storage_get and verifies the checksum before
// importing. See tc-docs/integrations.md.
import { sha256Hex } from '../crypto/crypto.js'
import { bytesToBase64, toArrayBuffer } from '../crypto/cryptoEncoding.js'
import { assertMistStorageAvailable, ensureMistRuntimeInitialized, loadMistModule } from './mistStorage.js'
import { publishShared, readShared } from './sharedBus.js'

export type HandoffApp = 'tc-pdf-viewer' | 'tc-note'

export const handoffTopicByApp: Record<HandoffApp, string> = {
  'tc-pdf-viewer': 'pdf-viewer-inbox',
  'tc-note': 'note-inbox',
}

export const maxHandoffItems = 50
export const maxHandoffBytes = 50 * 1024 * 1024

/** One file entry in a handoff topic's `meta.items` list (same shape as
 * the storage-drive-inbox topic's DriveInboxItem). */
export interface FileHandoffItem {
  id: string
  name: string
  mimeType: string
  size: number
  /** SHA-256 hex digest of the plaintext bytes. */
  checksum: string
  /** mistlib storage_add CID of the AES-GCM-encrypted bytes. */
  cid: string
  /** Base64 raw AES-256-GCM key material. */
  key: string
  /** Base64 96-bit AES-GCM IV. */
  iv: string
  addedAt: string
}

/** Parses the current topic record's items, tolerating malformed/missing meta. */
export function parseHandoffItems(meta: Record<string, unknown> | undefined): FileHandoffItem[] {
  const rawItems = meta ? (meta as { items?: unknown }).items : undefined
  if (!Array.isArray(rawItems)) return []
  const items: FileHandoffItem[] = []
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (
      typeof item.id === 'string' && item.id &&
      typeof item.name === 'string' &&
      typeof item.mimeType === 'string' &&
      typeof item.size === 'number' &&
      typeof item.checksum === 'string' &&
      typeof item.cid === 'string' &&
      typeof item.key === 'string' &&
      typeof item.iv === 'string' &&
      typeof item.addedAt === 'string'
    ) {
      items.push({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
        checksum: item.checksum,
        cid: item.cid,
        key: item.key,
        iv: item.iv,
        addedAt: item.addedAt,
      })
    }
  }
  return items
}

/** Appends `item`, capping the rolling list at the most recent maxHandoffItems entries. */
export function appendHandoffItem(existing: FileHandoffItem[], item: FileHandoffItem): FileHandoffItem[] {
  return [...existing, item].slice(-maxHandoffItems)
}

async function mistStorageAddBytes(name: string, bytes: Uint8Array, nodeId: string): Promise<string> {
  assertMistStorageAvailable()
  const mist = await loadMistModule()
  ensureMistRuntimeInitialized(mist, { nodeId })
  return mist.storage_add_pinned(name, bytes)
}

/**
 * Encrypts `bytes` with a fresh AES-256-GCM key, uploads the ciphertext to
 * mistlib, and republishes the topic's full (capped) item list so the
 * consumer app can import the file (even if it is opened only later).
 */
export async function publishFileHandoff(options: {
  app: HandoffApp
  file: { name: string; mimeType: string }
  bytes: Uint8Array
  nodeId: string
  addBytes?: (name: string, bytes: Uint8Array, nodeId: string) => Promise<string>
  publish?: typeof publishShared
  readRecord?: typeof readShared
}): Promise<FileHandoffItem> {
  const { addBytes = mistStorageAddBytes, publish = publishShared, readRecord = readShared } = options
  if (options.bytes.byteLength > maxHandoffBytes) throw new Error(`${options.file.name} が大きすぎます (上限50MB)`)
  const topic = handoffTopicByApp[options.app]
  const checksum = await sha256Hex(options.bytes)
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(keyBytes), 'AES-GCM', false, ['encrypt'])
  const cipherText = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, cryptoKey, toArrayBuffer(options.bytes)),
  )
  const id = crypto.randomUUID()
  const cid = await addBytes(`${id}.tc-file-handoff.enc`, cipherText, options.nodeId)
  const item: FileHandoffItem = {
    id,
    name: options.file.name,
    mimeType: options.file.mimeType || 'application/octet-stream',
    size: options.bytes.byteLength,
    checksum,
    cid,
    key: bytesToBase64(keyBytes),
    iv: bytesToBase64(iv),
    addedAt: new Date().toISOString(),
  }
  const existing = parseHandoffItems(readRecord(topic)?.meta)
  publish(topic, '', { items: appendHandoffItem(existing, item) })
  return item
}
