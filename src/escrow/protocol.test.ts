import { describe, expect, it } from 'vitest'
import { utf8 } from './crypto'
import { encodeEscrowMessage, ERROR_CODES, MAX_MESSAGE_BYTES, parseEscrowMessage } from './protocol'
import type { EscrowMessage } from './protocol'
import { vector } from './vectors.fixture'
const slot = vector.slot
const head = { ...vector.head_signed }
const messages: EscrowMessage[] = [
  { v: 1, type: 'escrow_hello' },
  { v: 1, type: 'escrow_provider', maxBlob: 32 * 1024 * 1024, version: 1 },
  { v: 1, type: 'escrow_get', id: '1', slot },
  { v: 1, type: 'escrow_head', id: '1', slot, head },
  { v: 1, type: 'escrow_head', id: '1', slot, head: null },
  { v: 1, type: 'escrow_put', id: '1', head },
  { v: 1, type: 'escrow_ack', id: '1', slot, seq: 1, hash: vector.head_hash_hex },
  ...ERROR_CODES.map(code => ({ v: 1 as const, type: 'escrow_error' as const, id: '1', code, message: '', ...(code === 'conflict' ? { head } : {}) }) as EscrowMessage),
]
describe('escrow protocol', () => {
  it.each(messages)('round-trips $type', message => {
    expect(parseEscrowMessage(encodeEscrowMessage(message))).toEqual(message)
    expect(parseEscrowMessage(JSON.stringify(message))).toEqual(message)
    expect(parseEscrowMessage({ ...message, future: 'ignored' })).toEqual(message)
  })
  it('ignores unknown types and non-conflict error head fields', () => {
    expect(parseEscrowMessage({ v: 1, type: 'future' })).toBeNull()
    expect(parseEscrowMessage({ v: 1, type: 'escrow_error', id: '1', code: 'busy', message: '', head: 42 }))
      .toEqual({ v: 1, type: 'escrow_error', id: '1', code: 'busy', message: '' })
  })
  it('rejects oversize messages, invalid UTF-8 and malformed JSON', () => {
    for (const input of [utf8('x'.repeat(MAX_MESSAGE_BYTES + 1)), 'é'.repeat(MAX_MESSAGE_BYTES / 2 + 1),
      Uint8Array.from([0xff]), '{', null, [], 42, { v: 2, type: 'escrow_hello' }]) expect(parseEscrowMessage(input)).toBeNull()
    expect(parseEscrowMessage({ v: 1, type: 'escrow_hello', future: 'x'.repeat(MAX_MESSAGE_BYTES) })).toBeNull()
  })
  it('checks all required fields and byte bounds', () => {
    for (const valid of messages.filter(m => m.type !== 'escrow_error')) {
      for (const field of Object.keys(valid)) {
        const missing = { ...valid } as Record<string, unknown>
        delete missing[field]
        expect(parseEscrowMessage(missing), valid.type + '.' + field).toBeNull()
      }
    }
    for (const input of [
      { v: 1, type: 'escrow_provider', maxBlob: -1, version: 1 },
      { v: 1, type: 'escrow_provider', maxBlob: Number.MAX_SAFE_INTEGER + 1, version: 1 },
      { v: 1, type: 'escrow_provider', maxBlob: 100, version: 2 },
      { v: 1, type: 'escrow_get', id: '', slot },
      { v: 1, type: 'escrow_get', id: 'é'.repeat(33), slot },
      { v: 1, type: 'escrow_get', id: '1', slot: 'A'.repeat(32) },
      { v: 1, type: 'escrow_head', id: '1', slot: '0'.repeat(32), head },
      { v: 1, type: 'escrow_put', id: '1', head: { ...head, sig: 'bad' } },
      { v: 1, type: 'escrow_ack', id: '1', slot, seq: 0, hash: vector.head_hash_hex },
      { v: 1, type: 'escrow_ack', id: '1', slot, seq: 1, hash: 'A'.repeat(64) },
      { v: 1, type: 'escrow_error', id: '1', code: 'other', message: '' },
      { v: 1, type: 'escrow_error', id: '1', code: 'busy', message: 'é'.repeat(513) },
      { v: 1, type: 'escrow_error', id: '1', code: 'conflict', message: '' },
    ]) expect(parseEscrowMessage(input)).toBeNull()
  })
})
