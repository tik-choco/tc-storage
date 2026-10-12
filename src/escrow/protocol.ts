import { utf8 } from './crypto'
import { boundedText, DEFAULT_MAX_BLOB, HASH_RE, isRecord, parseHead, safeInt, SLOT_RE } from './head'
import type { EscrowHead } from './head'

export const MAX_MESSAGE_BYTES = 16 * 1024
export const ERROR_CODES = ['conflict', 'bad_request', 'bad_sig', 'writer_mismatch', 'too_large', 'fetch_failed', 'hash_mismatch', 'quota', 'busy'] as const
export type EscrowErrorCode = typeof ERROR_CODES[number]
export interface EscrowHello { v: 1; type: 'escrow_hello' }
export interface EscrowProvider { v: 1; type: 'escrow_provider'; maxBlob: number; version: 1 }
export interface EscrowGet { v: 1; type: 'escrow_get'; id: string; slot: string }
export interface EscrowHeadMessage { v: 1; type: 'escrow_head'; id: string; slot: string; head: EscrowHead | null }
export interface EscrowPut { v: 1; type: 'escrow_put'; id: string; head: EscrowHead }
export interface EscrowAck { v: 1; type: 'escrow_ack'; id: string; slot: string; seq: number; hash: string }
export type EscrowError = { v: 1; type: 'escrow_error'; id: string; message: string } & (
  { code: 'conflict'; head: EscrowHead | null } | { code: Exclude<EscrowErrorCode, 'conflict'> })
export type EscrowMessage = EscrowHello | EscrowProvider | EscrowGet | EscrowHeadMessage | EscrowPut | EscrowAck | EscrowError
export interface ProtocolLimits { maxBlob?: number }
const isSlot = (value: unknown): value is string => typeof value === 'string' && SLOT_RE.test(value)
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH_RE.test(value)

function parseObject(value: unknown, limits: ProtocolLimits): EscrowMessage | null {
  if (!isRecord(value) || value.v !== 1) return null
  if (value.type === 'escrow_hello') return { v: 1, type: value.type }
  if (value.type === 'escrow_provider') return safeInt(value.maxBlob, 28) && value.version === 1 ?
    { v: 1, type: value.type, maxBlob: value.maxBlob, version: 1 } : null
  if (!boundedText(value.id, 64)) return null
  const base = { v: 1 as const, id: value.id }
  switch (value.type) {
    case 'escrow_get':
      return isSlot(value.slot) ? { ...base, type: value.type, slot: value.slot } : null
    case 'escrow_head': {
      if (!isSlot(value.slot)) return null
      const head = value.head === null ? null : parseHead(value.head, { ...limits, slot: value.slot })
      return head || value.head === null ? { ...base, type: value.type, slot: value.slot, head } : null
    }
    case 'escrow_put': {
      const head = parseHead(value.head, limits)
      return head ? { ...base, type: value.type, head } : null
    }
    case 'escrow_ack':
      return isSlot(value.slot) && safeInt(value.seq, 1) && isHash(value.hash) ?
        { ...base, type: value.type, slot: value.slot, seq: value.seq, hash: value.hash } : null
    case 'escrow_error': {
      if (!ERROR_CODES.includes(value.code as EscrowErrorCode) ||
        typeof value.message !== 'string' || value.message.length > 1024 || utf8(value.message).length > 1024) return null
      if (value.code === 'conflict') {
        const head = value.head === null ? null : parseHead(value.head, limits)
        return head || value.head === null ? { ...base, type: value.type, code: 'conflict', message: value.message, head } : null
      }
      return { ...base, type: value.type, code: value.code as Exclude<EscrowErrorCode, 'conflict'>, message: value.message }
    }
    default: return null
  }
}
/** Unknown wire fields are ignored; signed heads retain their exact field set. */
export function parseEscrowMessage(input: unknown, limits: ProtocolLimits = {}): EscrowMessage | null {
  try {
    let value = input
    if (input instanceof Uint8Array) {
      if (input.byteLength > MAX_MESSAGE_BYTES) return null
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input))
    } else if (typeof input === 'string') {
      if (input.length > MAX_MESSAGE_BYTES || utf8(input).length > MAX_MESSAGE_BYTES) return null
      value = JSON.parse(input)
    } else {
      const encoded = JSON.stringify(input)
      if (!encoded || encoded.length > MAX_MESSAGE_BYTES || utf8(encoded).length > MAX_MESSAGE_BYTES) return null
    }
    return parseObject(value, { maxBlob: limits.maxBlob ?? DEFAULT_MAX_BLOB })
  } catch { return null }
}
export function encodeEscrowMessage(message: EscrowMessage, limits: ProtocolLimits = {}): Uint8Array<ArrayBuffer> {
  const parsed = parseEscrowMessage(message, limits)
  if (!parsed) throw new Error('Invalid escrow message')
  return utf8(JSON.stringify(parsed))
}
