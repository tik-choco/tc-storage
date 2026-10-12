import { describe, expect, it, vi } from 'vitest'
import { base64url, blobAAD, decryptBlob, deriveAutoRoom, deriveEscrowKeys, encryptBlob, fromHex, gunzip, gzip, hex, sha256, utf8 } from './crypto'
import { buildHead, headHash, parseHead, signHead, signingPayload, stableStringify, verifyHead } from './head'
import { vector } from './vectors.fixture'

describe('escrow vectors and cryptography', () => {
  it('reproduces every derivation, fixed-IV blob, signing payload, signature, and head hash byte-exactly', async () => {
    const deriveBits = crypto.subtle.deriveBits.bind(crypto.subtle)
    const traces: string[] = []
    const spy = vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation(async (algorithm, key, length) => {
      const result = await deriveBits(algorithm, key, length)
      traces.push(hex(new Uint8Array(result)))
      return result
    })
    try {
      const keys = await deriveEscrowKeys(vector.input.app, vector.input.roomId)
      expect(traces).toEqual([vector.master_hex, vector.slot, vector.encKey_hex, vector.writeSeed_hex])
      expect(keys.slot).toBe(vector.slot)
      expect(keys.writer).toBe(vector.writer_b64u)
      expect(keys.encKey.extractable).toBe(false)
      expect(await deriveEscrowKeys(vector.input.app, vector.input.roomId)).toBe(keys)
      expect(new TextDecoder().decode(blobAAD(keys.slot, 1))).toBe(vector.aad_utf8)
      const blob = fromHex(vector.blob_hex)
      expect(new TextDecoder().decode(await decryptBlob(keys.encKey, keys.slot, 1, blob))).toBe(vector.plaintext_utf8)
      const fixed = new Uint8Array(await crypto.subtle.encrypt({
        name: 'AES-GCM', iv: fromHex(vector.iv_hex), additionalData: utf8(vector.aad_utf8), tagLength: 128,
      }, keys.encKey, utf8(vector.plaintext_utf8)))
      expect(vector.iv_hex + hex(fixed)).toBe(vector.blob_hex)
      expect(await sha256(blob)).toBe(vector.head_signed.sha256)
      const head = { ...vector.head_signed }
      expect(new TextDecoder().decode(signingPayload(head))).toBe(vector.signing_payload_utf8)
      expect(base64url(await keys.sign(signingPayload(head)))).toBe(head.sig)
      const { sig: _sig, ...unsigned } = head
      expect(await signHead(unsigned, keys)).toEqual(head)
      expect(await verifyHead(head, keys)).toBe(true)
      expect(await headHash(head)).toBe(vector.head_hash_hex)
    } finally { spy.mockRestore() }
  })
  it('pins autoRoom from the vector master and shares the cached master with escrow keys', async () => {
    const master = await crypto.subtle.importKey('raw', fromHex(vector.master_hex), 'HKDF', false, ['deriveBits'])
    const room = 'tce-' + hex(new Uint8Array(await crypto.subtle.deriveBits({
      name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: utf8('tc-escrow/v1/room'),
    }, master, 96)))
    expect(room).toBe(vector.autoRoom)
    const spy = vi.spyOn(crypto.subtle, 'deriveBits')
    expect(await deriveAutoRoom(vector.input.app, vector.input.roomId)).toBe(room)
    expect(spy.mock.calls.filter(([algorithm]) => (algorithm as Algorithm).name === 'PBKDF2')).toHaveLength(0)
    spy.mockRestore()
    const count = vi.spyOn(crypto.subtle, 'deriveBits')
    await Promise.all([deriveAutoRoom('cache-test', 'room'), deriveEscrowKeys('cache-test', 'room'), deriveAutoRoom('cache-test', 'room')])
    expect(count.mock.calls.filter(([algorithm]) => (algorithm as Algorithm).name === 'PBKDF2')).toHaveLength(1)
    count.mockRestore()
    expect(await deriveAutoRoom('cache-test', 'Room')).not.toBe(await deriveAutoRoom('cache-test', 'room'))
  })
  it('caches concurrent derivation and preserves case', async () => {
    const first = deriveEscrowKeys('test', 'case')
    expect(deriveEscrowKeys('test', 'case')).toBe(first)
    expect((await first).slot).not.toBe((await deriveEscrowKeys('test', 'Case')).slot)
  })
  it('round-trips with fresh random IVs including empty plaintext', async () => {
    const keys = await deriveEscrowKeys(vector.input.app, vector.input.roomId)
    for (const plaintext of [new Uint8Array(), utf8('checkpoint'), Uint8Array.from([0, 255, 0, 128])]) {
      const a = await encryptBlob(keys.encKey, keys.slot, 2, plaintext)
      const b = await encryptBlob(keys.encKey, keys.slot, 2, plaintext)
      expect(a.slice(0, 12)).not.toEqual(b.slice(0, 12))
      expect(await decryptBlob(keys.encKey, keys.slot, 2, a)).toEqual(plaintext)
    }
  })
  it('rejects tampered ciphertext, IV, tag, wrong AAD and truncated blobs', async () => {
    const keys = await deriveEscrowKeys(vector.input.app, vector.input.roomId)
    const blob = fromHex(vector.blob_hex)
    for (const index of [0, 12, blob.length - 1]) {
      const corrupt = blob.slice(); corrupt[index] ^= 1
      await expect(decryptBlob(keys.encKey, keys.slot, 1, corrupt)).rejects.toThrow()
    }
    await expect(decryptBlob(keys.encKey, keys.slot, 2, blob)).rejects.toThrow()
    await expect(decryptBlob(keys.encKey, '0'.repeat(32), 1, blob)).rejects.toThrow()
    await expect(decryptBlob(keys.encKey, keys.slot, 1, blob.slice(0, 27))).rejects.toThrow()
  })
  it('rejects bad signatures, field tampering, wrong writer and wrong slot', async () => {
    const keys = await deriveEscrowKeys(vector.input.app, vector.input.roomId)
    const head = { ...vector.head_signed }
    expect(await verifyHead({ ...head, seq: 2 }, keys)).toBe(false)
    expect(await verifyHead({ ...head, sig: 'A' + head.sig.slice(1) }, keys)).toBe(false)
    expect(await verifyHead(head, { slot: keys.slot, writer: base64url(new Uint8Array(32)) })).toBe(false)
    expect(await verifyHead(head, { writer: keys.writer, slot: '0'.repeat(32) })).toBe(false)
  })
  it('builds heads and strictly bounds every signed field', async () => {
    const keys = await deriveEscrowKeys(vector.input.app, vector.input.roomId)
    const { v: _v, type: _type, slot: _slot, writer: _writer, sig: _sig, ...fields } = vector.head_signed
    expect(await buildHead(keys, fields)).toEqual(vector.head_signed)
    for (const patch of [
      { extra: true }, { seq: 0 }, { seq: 1.1 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { size: 27 },
      { size: 32 * 1024 * 1024 + 1 }, { sha256: 'A'.repeat(64) }, { slot: 'A'.repeat(32) },
      { parent: '' }, { cid: 'x'.repeat(1025) }, { cid: 'bad cid' }, { schema: 'é'.repeat(129) },
      { at: -1 }, { at: Infinity }, { comp: 'zip' }, { writer: 'A'.repeat(42) }, { writer: 'B'.repeat(43) },
      { sig: 'B'.repeat(86) }, { v: 2 }, { type: 'other' },
    ]) expect(parseHead({ ...vector.head_signed, ...patch })).toBeNull()
    const missing = { ...vector.head_signed } as Record<string, unknown>
    delete missing.parent
    expect(parseHead(missing)).toBeNull()
  })
  it('uses recursive code-unit order, drops undefined, and preserves array nulls', () => {
    expect(stableStringify({ z: 2, a: { z: undefined, B: 1, a: 3 }, A: 4, arr: [undefined, { b: 1, A: 2 }] }))
      .toBe('{"A":4,"a":{"B":1,"a":3},"arr":[null,{"A":2,"b":1}],"z":2}')
    expect(stableStringify({ '2': 'b', '10': 'a' })).toBe('{"10":"a","2":"b"}')
  })
  it('gzip round-trips, rejects damaged gzip and caps decompression', async () => {
    const bytes = utf8('checkpoint'.repeat(1000))
    const compressed = await gzip(bytes)
    expect(await gunzip(compressed)).toEqual(bytes)
    await expect(gunzip(compressed, bytes.length - 1)).rejects.toThrow('limit')
    await expect(gunzip(utf8('invalid gzip'))).rejects.toThrow()
    await expect(gzip(bytes, 1)).rejects.toThrow('limit')
  })
})
