import { isEd25519DidKey, loadStoredDidIdentity, signStringWithDidIdentity, verifyStringWithDid } from './didIdentity.js'
import type { ShareEnvelope } from './p2pTypes.js'

const decoder = new TextDecoder()

export function parseMistEvent(event: unknown): ShareEnvelope | undefined {
  return parseEnvelopeDeep(event)
}

export function parseEnvelopeDeep(value: unknown, depth = 0, seen = new Set<unknown>()): ShareEnvelope | undefined {
  if (value instanceof Uint8Array) return parseJsonBytes(value)
  if (value instanceof ArrayBuffer) return parseJsonBytes(new Uint8Array(value))
  if (typeof value === 'string') return parseJsonString(value)
  if (!value || typeof value !== 'object' || depth > 4 || seen.has(value)) return undefined
  seen.add(value)

  const direct = parseEnvelope(value)
  if (direct) return direct

  const record = value as Record<string, unknown>
  for (const key of ['data', 'payload', 'message', 'body']) {
    const nested = parseEnvelopeDeep(record[key], depth + 1, seen)
    if (nested) return nested
  }
  for (const nestedValue of Object.values(record)) {
    const nested = parseEnvelopeDeep(nestedValue, depth + 1, seen)
    if (nested) return nested
  }
  return undefined
}

export function parseEnvelope(value: unknown): ShareEnvelope | undefined {
  if (!value || typeof value !== 'object') return undefined
  const envelope = value as Partial<ShareEnvelope>
  if (
    (envelope.type === 'hello' || envelope.type === 'folder-share' || envelope.type === 'file-share' || envelope.type === 'folder-state' || envelope.type === 'folder-change' || envelope.type === 'folder-access-request' || envelope.type === 'folder-access-grant') &&
    typeof envelope.from === 'string' &&
    typeof envelope.roomId === 'string' &&
    typeof envelope.sentAt === 'string' &&
    typeof envelope.clock === 'number'
  ) {
    return envelope as ShareEnvelope
  }
  return undefined
}

export async function signShareEnvelope(envelope: ShareEnvelope): Promise<ShareEnvelope> {
  if (!envelope.from.startsWith('did:key:')) return envelope
  if (!isEd25519DidKey(envelope.from)) throw new Error('DID must be an Ed25519 did:key')
  const identity = loadStoredDidIdentity()
  if (!identity || identity.did !== envelope.from) throw new Error('DID private key is missing')
  return { ...envelope, signature: await signStringWithDidIdentity(identity, envelopeSigningPayload(envelope)) }
}

export async function verifyShareEnvelope(envelope: ShareEnvelope): Promise<boolean> {
  if (!envelope.from.startsWith('did:key:')) return true
  if (!isEd25519DidKey(envelope.from)) return false
  if (!envelope.signature) return false
  return verifyStringWithDid(envelope.from, envelopeSigningPayload(envelope), envelope.signature)
}

export function shareLabel(type: ShareEnvelope['type']): string {
  if (type === 'folder-share') return 'フォルダー共有'
  if (type === 'folder-state') return 'フォルダー状態'
  if (type === 'folder-change') return 'フォルダー変更'
  if (type === 'folder-access-request') return 'アクセスリクエスト'
  if (type === 'folder-access-grant') return 'アクセス承認'
  if (type === 'file-share') return 'ファイル共有'
  return 'HELLO'
}

export function envelopeLogDetails(envelope: ShareEnvelope, source?: string): Record<string, unknown> {
  return {
    source,
    type: envelope.type,
    from: shortLogValue(envelope.from),
    roomId: envelope.roomId,
    folderId: envelope.folderId,
    changeType: envelope.changeType,
    fileId: envelope.fileId,
    cid: shortLogValue(envelope.cid),
    clock: envelope.clock,
    sentAt: envelope.sentAt,
    hasSignature: Boolean(envelope.signature),
  }
}

export function shortLogValue(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length > 28 ? `${value.slice(0, 14)}...${value.slice(-8)}` : value
}

function parseJsonBytes(bytes: Uint8Array): ShareEnvelope | undefined {
  return parseJsonString(decoder.decode(bytes))
}

function parseJsonString(raw: string): ShareEnvelope | undefined {
  try {
    return parseEnvelopeDeep(JSON.parse(raw))
  } catch {
    return undefined
  }
}

function envelopeSigningPayload(envelope: ShareEnvelope): string {
  const unsigned: Record<string, unknown> = { ...envelope }
  delete unsigned.signature
  return stableStringify(unsigned)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}
