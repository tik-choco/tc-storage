import { base64url, fromBase64url, sha256, utf8 } from './crypto'
import type { EscrowKeys } from './crypto'

export const DEFAULT_MAX_BLOB = 32 * 1024 * 1024
export const MAX_CID_BYTES = 1024
export const MAX_SCHEMA_BYTES = 256
export const SLOT_RE = /^[0-9a-f]{32}$/
export const HASH_RE = /^[0-9a-f]{64}$/
export interface UnsignedHead {
  v: 1
  type: 'tc-escrow-head'
  slot: string
  seq: number
  parent: string | null
  cid: string
  size: number
  sha256: string
  comp: 'gzip' | 'none'
  schema: string
  writer: string
  at: number
}
export interface EscrowHead extends UnsignedHead { sig: string }
export interface HeadValidation {
  slot?: string
  writer?: string
  maxBlob?: number
}
export function stableStringify(value: unknown): string {
  function stable(x: unknown, array = false): string | undefined {
    if (x === undefined || typeof x === 'function' || typeof x === 'symbol') return array ? 'null' : undefined
    if (x === null || typeof x !== 'object') return JSON.stringify(x)
    if (Array.isArray(x)) return '[' + Array.from(x, v => stable(v, true)).join(',') + ']'
    const record = x as Record<string, unknown>
    return '{' + Object.keys(record).sort().flatMap(key => {
      const encoded = stable(record[key])
      return encoded === undefined ? [] : [JSON.stringify(key) + ':' + encoded]
    }).join(',') + '}'
  }
  const result = stable(value)
  if (result === undefined) throw new Error('Not a JSON value')
  return result
}
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export const safeInt = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
export function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxBytes &&
    !/[\u0000-\u001f\u007f]/.test(value) && utf8(value).length <= maxBytes
}
function canonicalB64(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string' || value.length !== Math.ceil(bytes * 8 / 6)) return false
  try { return fromBase64url(value).length === bytes } catch { return false }
}
const fields = ['v', 'type', 'slot', 'seq', 'parent', 'cid', 'size', 'sha256', 'comp', 'schema', 'writer', 'at']
function parseUnsigned(value: unknown, options: HeadValidation, signed: boolean): UnsignedHead | null {
  if (!isRecord(value)) return null
  const keys = signed ? [...fields, 'sig'] : fields
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return null
  const maxBlob = options.maxBlob ?? DEFAULT_MAX_BLOB
  if (!safeInt(maxBlob, 28) || value.v !== 1 || value.type !== 'tc-escrow-head' ||
    typeof value.slot !== 'string' || !SLOT_RE.test(value.slot) ||
    !safeInt(value.seq, 1) || !(value.parent === null || typeof value.parent === 'string' && HASH_RE.test(value.parent)) ||
    !boundedText(value.cid, MAX_CID_BYTES) || !/^[\x21-\x7e]+$/.test(value.cid) ||
    !safeInt(value.size, 28, maxBlob) || typeof value.sha256 !== 'string' || !HASH_RE.test(value.sha256) ||
    !(value.comp === 'gzip' || value.comp === 'none') || !boundedText(value.schema, MAX_SCHEMA_BYTES) ||
    !canonicalB64(value.writer, 32) || !safeInt(value.at, 0) ||
    (options.slot !== undefined && value.slot !== options.slot) ||
    (options.writer !== undefined && value.writer !== options.writer)) return null
  return { v: 1, type: 'tc-escrow-head', slot: value.slot, seq: value.seq, parent: value.parent as string | null,
    cid: value.cid, size: value.size, sha256: value.sha256, comp: value.comp, schema: value.schema,
    writer: value.writer, at: value.at }
}
export function parseHead(value: unknown, options: HeadValidation = {}): EscrowHead | null {
  const unsigned = parseUnsigned(value, options, true)
  if (!unsigned || !isRecord(value) || !canonicalB64(value.sig, 64)) return null
  return { ...unsigned, sig: value.sig }
}
export function signingPayload(head: UnsignedHead | EscrowHead): Uint8Array<ArrayBuffer> {
  const { sig: _sig, ...unsigned } = head as EscrowHead
  return utf8('tc-escrow/v1/head\n' + stableStringify(unsigned))
}
export async function signHead(head: UnsignedHead, keys: Pick<EscrowKeys, 'slot' | 'writer' | 'sign'>, options: HeadValidation = {}): Promise<EscrowHead> {
  const parsed = parseUnsigned(head, { ...options, slot: keys.slot, writer: keys.writer }, false)
  if (!parsed) throw new Error('Invalid escrow head')
  const result = { ...parsed, sig: base64url(await keys.sign(signingPayload(parsed))) }
  if (!parseHead(result, options)) throw new Error('Invalid escrow signature')
  return result
}
export async function buildHead(
  keys: Pick<EscrowKeys, 'slot' | 'writer' | 'sign'>,
  fields: Omit<UnsignedHead, 'v' | 'type' | 'slot' | 'writer' | 'at'> & { at?: number },
  options: HeadValidation = {},
): Promise<EscrowHead> {
  return signHead({ ...fields, v: 1, type: 'tc-escrow-head', slot: keys.slot, writer: keys.writer, at: fields.at ?? Date.now() }, keys, options)
}
export async function verifyHead(value: unknown, options: HeadValidation & { slot: string; writer: string }): Promise<boolean> {
  const head = parseHead(value, options)
  if (!head) return false
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64url(head.writer), 'Ed25519', false, ['verify'])
    return await crypto.subtle.verify('Ed25519', key, fromBase64url(head.sig), signingPayload(head))
  } catch { return false }
}
export async function headHash(head: EscrowHead, options: HeadValidation = {}): Promise<string> {
  const parsed = parseHead(head, options)
  if (!parsed) throw new Error('Invalid escrow head')
  return sha256(utf8(stableStringify(parsed)))
}
