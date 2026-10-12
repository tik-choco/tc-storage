import { describe, expect, it, vi } from 'vitest'
import { EscrowClient, EscrowRequestError } from './client'
import type { EscrowTransport } from './client'
import { deriveEscrowKeys, fromHex, utf8 } from './crypto'
import { headHash } from './head'
import type { EscrowHead } from './head'
import { encodeEscrowMessage, parseEscrowMessage } from './protocol'
import type { EscrowMessage } from './protocol'
import { vector, deleteVector } from './vectors.fixture'

class FakeTransport implements EscrowTransport {
  joined = new Set<string>()
  messages = new Set<(id: string, bytes: Uint8Array) => void>()
  peers = new Set<(id: string, joined: boolean) => void>()
  sent: { to: string | null; message: EscrowMessage }[] = []
  blobs = new Map<string, Uint8Array>()
  head: EscrowHead | null = null
  advertise = true
  respond = true
  putMode: 'ack' | 'conflict' | 'error' = 'ack'
  features?: string[]
  maxBlob = 32 * 1024 * 1024
  async join(room: string) { this.joined.add(room) }
  leave(room: string) { this.joined.delete(room) }
  onMessage(_room: string, cb: (id: string, bytes: Uint8Array) => void) { this.messages.add(cb); return () => { this.messages.delete(cb) } }
  onPeer(_room: string, cb: (id: string, joined: boolean) => void) { this.peers.add(cb); return () => { this.peers.delete(cb) } }
  emit(message: EscrowMessage, id = 'provider') {
    for (const cb of this.messages) cb(id, encodeEscrowMessage(message))
  }
  provider(id = 'provider') { this.emit({ v: 1, type: 'escrow_provider', version: 1, maxBlob: this.maxBlob, ...(this.features ? { features: this.features } : {}) }, id) }
  send(_room: string, to: string | null, bytes: Uint8Array) {
    const message = parseEscrowMessage(bytes)!
    this.sent.push({ to, message })
    queueMicrotask(() => { void this.reply(message) })
  }
  async reply(message: EscrowMessage) {
    if (message.type === 'escrow_hello') { if (this.advertise) this.provider(); return }
    if (!this.respond) return
    if (message.type === 'escrow_get') this.emit({ v: 1, type: 'escrow_head', id: message.id, slot: message.slot, head: this.head })
    if (message.type === 'escrow_delete') {
      if (this.putMode === 'conflict') this.emit({ v: 1, type: 'escrow_error', id: message.id, code: 'conflict', message: 'stale', head: this.head })
      else if (this.putMode === 'error') this.emit({ v: 1, type: 'escrow_error', id: message.id, code: 'bad_signature', message: 'signature' })
      else { this.head = null; this.emit({ v: 1, type: 'escrow_deleted', id: message.id, slot: message.slot }) }
    }
    if (message.type === 'escrow_put') {
      if (this.putMode === 'conflict') this.emit({ v: 1, type: 'escrow_error', id: message.id, code: 'conflict', message: 'stale', head: this.head })
      else if (this.putMode === 'error') this.emit({ v: 1, type: 'escrow_error', id: message.id, code: 'quota', message: 'full' })
      else {
        this.head = message.head
        this.emit({ v: 1, type: 'escrow_ack', id: message.id, slot: message.head.slot, seq: message.head.seq, hash: await headHash(message.head) })
      }
    }
  }
  async storageAdd(name: string, bytes: Uint8Array) {
    expect(name).toBe('tc-escrow.bin')
    const cid = 'cid-' + this.blobs.size
    this.blobs.set(cid, bytes.slice())
    return cid
  }
  async storageGet(cid: string) {
    const blob = this.blobs.get(cid)
    if (!blob) throw new Error('missing blob')
    return blob.slice()
  }
}
const fixture = () => ({ ...vector.head_signed })
describe('EscrowClient', () => {
  it('discovers providers, gets heads and tracks peer departures', async () => {
    const transport = new FakeTransport()
    const client = new EscrowClient(transport, 'escrow-room')
    try {
      expect(await client.getHead(vector.slot)).toBeNull()
      expect(client.providers.get('provider')).toEqual({ maxBlob: transport.maxBlob })
      expect(transport.sent[0].message.type).toBe('escrow_hello')
      transport.head = fixture()
      expect(await client.getHead(vector.slot)).toEqual(fixture())
      const requests = transport.sent.filter(s => s.message.type === 'escrow_get')
      expect(new Set(requests.map(s => 'id' in s.message && s.message.id)).size).toBe(2)
      for (const cb of transport.peers) cb('provider', false)
      expect(client.providers.size).toBe(0)
      transport.provider()
      expect(client.providers.size).toBe(1)
    } finally { client.dispose() }
    expect(transport.messages.size).toBe(0)
    expect(transport.peers.size).toBe(0)
    expect(transport.joined.size).toBe(0)
  })
  it('sends a waiting request when a provider arrives after hello', async () => {
    const transport = new FakeTransport(); transport.advertise = false
    const client = new EscrowClient(transport, 'escrow')
    try {
      await client.join()
      const pending = client.getHead(vector.slot)
      expect(transport.sent.some(s => s.message.type === 'escrow_get')).toBe(false)
      transport.provider()
      expect(await pending).toBeNull()
    } finally { client.dispose() }
  })
  it('returns ack, verified conflict and provider error', async () => {
    const transport = new FakeTransport()
    const client = new EscrowClient(transport, 'escrow')
    try {
      expect(await client.put(fixture())).toEqual({ type: 'ack', slot: vector.slot, seq: 1, hash: vector.head_hash_hex, head: fixture() })
      transport.putMode = 'conflict'
      expect(await client.put(fixture())).toEqual({ type: 'conflict', head: fixture() })
      transport.putMode = 'error'
      expect(await client.put(fixture())).toEqual({ type: 'error', code: 'quota', message: 'full' })
    } finally { client.dispose() }
  })
  it('times out discovery and provider responses', async () => {
    const transport = new FakeTransport(); transport.advertise = false
    const client = new EscrowClient(transport, 'escrow')
    try {
      await expect(client.getHead(vector.slot, 10)).rejects.toMatchObject({ code: 'timeout' })
      transport.provider(); transport.respond = false
      expect(await client.put(fixture(), 10)).toMatchObject({ type: 'error', code: 'timeout' })
    } finally { client.dispose() }
  })
  it('ignores non-provider peers, wrong request ids, wrong targets, wrong slots and wrong response types', async () => {
    const transport = new FakeTransport(); transport.respond = false
    const client = new EscrowClient(transport, 'escrow')
    try {
      let settled = false
      const pending = client.getHead(vector.slot).then(head => { settled = true; return head })
      await vi.waitFor(() => expect(transport.sent.some(s => s.message.type === 'escrow_get')).toBe(true))
      const request = transport.sent.find(s => s.message.type === 'escrow_get')!.message
      if (request.type !== 'escrow_get') throw new Error('not get')
      const reply = { v: 1 as const, type: 'escrow_head' as const, id: request.id, slot: request.slot, head: null }
      transport.emit(reply, 'stranger')
      transport.provider('other-provider'); transport.emit(reply, 'other-provider')
      transport.emit({ ...reply, id: 'wrong' })
      transport.emit({ ...reply, slot: '0'.repeat(32) })
      transport.emit({ v: 1, type: 'escrow_ack', id: request.id, slot: request.slot, seq: 1, hash: vector.head_hash_hex })
      await Promise.resolve()
      expect(settled).toBe(false)
      transport.emit(reply)
      expect(await pending).toBeNull()
    } finally { client.dispose() }
  })
  it('ignores incorrect ack hashes and invalid conflict signatures', async () => {
    const transport = new FakeTransport(); transport.respond = false
    const client = new EscrowClient(transport, 'escrow')
    try {
      let settled = false
      const pending = client.put(fixture()).then(result => { settled = true; return result })
      await vi.waitFor(() => expect(transport.sent.some(s => s.message.type === 'escrow_put')).toBe(true))
      const request = transport.sent.find(s => s.message.type === 'escrow_put')!.message
      if (request.type !== 'escrow_put') throw new Error('not put')
      const ack = { v: 1 as const, type: 'escrow_ack' as const, id: request.id, slot: vector.slot, seq: 1, hash: vector.head_hash_hex }
      transport.emit({ ...ack, hash: '0'.repeat(64) })
      transport.emit({ ...ack, seq: 2 })
      transport.emit({ v: 1, type: 'escrow_error', id: request.id, code: 'conflict', message: '', head: { ...fixture(), seq: 2 } })
      await Promise.resolve()
      expect(settled).toBe(false)
      transport.emit(ack)
      expect(await pending).toMatchObject({ type: 'ack' })
    } finally { client.dispose() }
  })
  it('honors provider maxBlob before PUT', async () => {
    const transport = new FakeTransport(); transport.maxBlob = 28
    const client = new EscrowClient(transport, 'escrow')
    try {
      expect(await client.put(fixture())).toMatchObject({ type: 'error', code: 'too_large' })
      expect(transport.sent.some(s => s.message.type === 'escrow_put')).toBe(false)
    } finally { client.dispose() }
  })
  it('resolves/rejects pending work on dispose and handles join failure', async () => {
    const transport = new FakeTransport(); transport.respond = false
    const client = new EscrowClient(transport, 'escrow')
    await client.join()
    const get = client.getHead(vector.slot)
    const rejection = expect(get).rejects.toBeInstanceOf(EscrowRequestError)
    client.dispose()
    await rejection
    expect(await client.put(fixture())).toMatchObject({ type: 'error', code: 'closed' })
    const broken = new FakeTransport()
    broken.join = async () => { throw new Error('join failed') }
    const other = new EscrowClient(broken, 'escrow')
    await expect(other.getHead(vector.slot)).rejects.toMatchObject({ code: 'transport' })
    expect(broken.messages.size).toBe(0)
    other.dispose()
  })
  it('saves compressed checkpoints, restores plaintext and exposes parent hash', async () => {
    const transport = new FakeTransport()
    const client = new EscrowClient(transport, 'escrow')
    try {
      const plaintext = utf8('{"checkpoint":true}')
      const first = await client.saveCheckpoint(vector.input.app, vector.input.roomId, plaintext, { schema: 'test/1', parent: null, seq: 1 })
      expect(first.type).toBe('ack')
      if (first.type !== 'ack') throw new Error('not ack')
      expect(first.head.comp).toBe('gzip')
      expect(await client.fetchLatest(vector.input.app, vector.input.roomId)).toEqual({ head: first.head, plaintext })
      const second = await client.saveCheckpoint(vector.input.app, vector.input.roomId, plaintext, { schema: 'test/1', parent: first.hash, seq: 2, comp: 'none' })
      expect(second).toMatchObject({ type: 'ack', seq: 2, head: { parent: first.hash, comp: 'none' } })
    } finally { client.dispose() }
  })
  it('falls back to comp none when compression is unavailable', async () => {
    const transport = new FakeTransport()
    const client = new EscrowClient(transport, 'escrow')
    vi.stubGlobal('CompressionStream', undefined)
    try {
      const result = await client.saveCheckpoint(vector.input.app, vector.input.roomId, utf8('payload'), { schema: 'test/1', seq: 1, parent: null })
      expect(result).toMatchObject({ type: 'ack', head: { comp: 'none' } })
    } finally { vi.unstubAllGlobals(); client.dispose() }
  })
  it('validates size, hash, expected writer and signature before restore', async () => {
    const transport = new FakeTransport(); transport.head = fixture()
    transport.blobs.set(vector.head_signed.cid, fromHex(vector.blob_hex))
    const client = new EscrowClient(transport, 'escrow')
    try {
      expect((await client.fetchLatest(vector.input.app, vector.input.roomId))?.plaintext).toEqual(utf8(vector.plaintext_utf8))
      const corrupt = fromHex(vector.blob_hex); corrupt[15] ^= 1
      transport.blobs.set(vector.head_signed.cid, corrupt)
      await expect(client.fetchLatest(vector.input.app, vector.input.roomId)).rejects.toThrow('hash or size')
      transport.blobs.set(vector.head_signed.cid, corrupt.slice(1))
      await expect(client.fetchLatest(vector.input.app, vector.input.roomId)).rejects.toThrow('hash or size')
      transport.head = { ...fixture(), at: fixture().at + 1 }
      await expect(client.fetchLatest(vector.input.app, vector.input.roomId)).rejects.toThrow('head verification')
      transport.head = fixture()
      const keys = await deriveEscrowKeys('other-app', vector.input.roomId)
      const { buildHead } = await import('./head')
      transport.head = await buildHead({ ...keys, slot: vector.slot }, {
        seq: 1, parent: null, cid: vector.head_signed.cid, size: 46, sha256: fixture().sha256, comp: 'none', schema: 'test/1',
      })
      await expect(client.fetchLatest(vector.input.app, vector.input.roomId)).rejects.toThrow('head verification')
    } finally { client.dispose() }
  })
  it('bounds plaintext and validates metadata before uploading', async () => {
    const transport = new FakeTransport()
    const client = new EscrowClient(transport, 'escrow', { maxPlaintext: 10 })
    try {
      await expect(client.saveCheckpoint('test', 'metadata', utf8('11 characters'), { schema: 'test/1', seq: 1, parent: null })).rejects.toThrow('limit')
      await expect(client.saveCheckpoint('test', 'metadata', utf8('ok'), { schema: '', seq: 1, parent: null })).rejects.toThrow('head')
      expect(transport.blobs.size).toBe(0)
    } finally { client.dispose() }
  })
})

describe('restore limits and authenticated context', () => {
  it('rejects signed heads whose blob authenticates a different sequence', async () => {
    const transport = new FakeTransport()
    const keys = await deriveEscrowKeys(vector.input.app, vector.input.roomId)
    const { sig: _sig, ...unsigned } = fixture()
    const { signHead } = await import('./head')
    transport.head = await signHead({ ...unsigned, seq: 2 }, keys)
    transport.blobs.set(vector.head_signed.cid, fromHex(vector.blob_hex))
    const client = new EscrowClient(transport, 'escrow')
    try {
      await expect(client.fetchLatest(vector.input.app, vector.input.roomId)).rejects.toThrow()
    } finally { client.dispose() }
  })
  it('caps both compressed and uncompressed restored plaintext', async () => {
    for (const comp of ['gzip', 'none'] as const) {
      const transport = new FakeTransport()
      const writer = new EscrowClient(transport, 'escrow')
      await writer.saveCheckpoint(vector.input.app, vector.input.roomId, utf8('payload'.repeat(100)), {
        schema: 'test/1', seq: 1, parent: null, comp,
      })
      writer.dispose()
      const reader = new EscrowClient(transport, 'escrow', { maxPlaintext: 20 })
      try {
        await expect(reader.fetchLatest(vector.input.app, vector.input.roomId)).rejects.toThrow('limit')
      } finally { reader.dispose() }
    }
  })
})

describe('provider search and restore phases', () => {
  it('keeps listening after a 20-second search and accepts a late provider', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport(); transport.advertise = false
    const client = new EscrowClient(transport, 'escrow'), appeared = vi.fn(), off = client.onProvider(appeared)
    try {
      const search = client.waitForProvider()
      await vi.advanceTimersByTimeAsync(19999); expect(appeared).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1); expect(await search).toBe(false)
      expect(transport.joined.has('escrow')).toBe(true)
      await vi.advanceTimersByTimeAsync(2000); transport.provider()
      expect(appeared).toHaveBeenCalledOnce(); expect(await client.waitForProvider()).toBe(true)
      expect(await client.fetchLatest(vector.input.app, vector.input.roomId)).toBeNull()
    } finally { off(); client.dispose(); vi.useRealTimers() }
  })
  it('gives an answered GET and download a separate 60-second budget', async () => {
    await deriveEscrowKeys(vector.input.app, vector.input.roomId)
    vi.useFakeTimers()
    const transport = new FakeTransport(); transport.head = fixture()
    let complete!: (bytes: Uint8Array<ArrayBuffer>) => void
    const get = vi.spyOn(transport, 'storageGet').mockReturnValue(new Promise(resolve => { complete = resolve }))
    const client = new EscrowClient(transport, 'escrow')
    try {
      expect(await client.waitForProvider()).toBe(true)
      const fetching = client.fetchLatest(vector.input.app, vector.input.roomId), done = vi.fn()
      void fetching.then(done)
      await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(22000); expect(done).not.toHaveBeenCalled()
      complete(new Uint8Array(fromHex(vector.blob_hex)))
      expect(await fetching).toEqual({ head: fixture(), plaintext: utf8(vector.plaintext_utf8) })
    } finally { client.dispose(); vi.useRealTimers() }
  })
  it('bounds a stalled restore separately and cancels pending waits on disposal', async () => {
    await deriveEscrowKeys(vector.input.app, vector.input.roomId)
    vi.useFakeTimers()
    const transport = new FakeTransport(); transport.head = fixture()
    const get = vi.spyOn(transport, 'storageGet').mockReturnValue(new Promise(() => {}))
    const client = new EscrowClient(transport, 'escrow')
    try {
      await client.waitForProvider()
      const fetching = client.fetchLatest(vector.input.app, vector.input.roomId)
      const failure = expect(fetching).rejects.toMatchObject({ code: 'timeout' })
      await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(60000); await failure
    } finally { client.dispose(); vi.useRealTimers() }
    const absent = new FakeTransport(); absent.advertise = false
    const other = new EscrowClient(absent, 'escrow'), search = other.waitForProvider()
    const closed = expect(search).rejects.toMatchObject({ code: 'closed' })
    other.dispose(); await closed
    await expect(other.fetchLatest(vector.input.app, vector.input.roomId)).rejects.toMatchObject({ code: 'closed' })
  })
})

describe('restore download retries', () => {
  it.each(['reject', 'corrupt', 'stall'] as const)('refetches the head after a first download %s', async failure => {
    await deriveEscrowKeys(vector.input.app, vector.input.roomId)
    vi.useFakeTimers()
    const transport = new FakeTransport(); transport.head = fixture()
    transport.blobs.set(vector.head_signed.cid, fromHex(vector.blob_hex))
    const get = vi.spyOn(transport, 'storageGet')
    if (failure === 'reject') get.mockRejectedValueOnce(new Error('transient stall'))
    else if (failure === 'stall') get.mockImplementationOnce(() => new Promise(() => {}))
    else get.mockResolvedValueOnce(new Uint8Array([0]))
    const client = new EscrowClient(transport, 'escrow')
    try {
      const fetching = client.fetchLatest(vector.input.app, vector.input.roomId)
      await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(failure === 'stall' ? 30500 : 500)
      expect(await fetching).toEqual({ head: fixture(), plaintext: utf8(vector.plaintext_utf8) })
      expect(get).toHaveBeenCalledTimes(2)
      expect(transport.sent.filter(s => s.message.type === 'escrow_get')).toHaveLength(2)
    } finally { client.dispose(); vi.useRealTimers() }
  })
  it('limits downloads to three attempts and cancels retries on disposal', async () => {
    await deriveEscrowKeys(vector.input.app, vector.input.roomId)
    vi.useFakeTimers()
    const transport = new FakeTransport(); transport.head = fixture()
    const get = vi.spyOn(transport, 'storageGet').mockRejectedValue(new Error('missing chunks'))
    const client = new EscrowClient(transport, 'escrow')
    try {
      const fetching = client.fetchLatest(vector.input.app, vector.input.roomId)
      const failed = expect(fetching).rejects.toThrow('missing chunks')
      await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3), { timeout: 2000 }); await failed
      expect(get).toHaveBeenCalledTimes(3)
      get.mockClear()
      const next = client.fetchLatest(vector.input.app, vector.input.roomId), closed = expect(next).rejects.toMatchObject({ code: 'closed' })
      await vi.waitFor(() => expect(get).toHaveBeenCalledOnce()); client.dispose()
      await closed; await vi.advanceTimersByTimeAsync(1000); expect(get).toHaveBeenCalledOnce()
    } finally { client.dispose(); vi.useRealTimers() }
  })
})

it('uses the newly fetched head when a provider advances during download retry', async () => {
  const transport = new FakeTransport(), client = new EscrowClient(transport, 'escrow')
  try {
    const first = await client.saveCheckpoint(vector.input.app, vector.input.roomId, utf8('first'), { schema: 'test/1', seq: 1, parent: null })
    if (first.type !== 'ack') throw new Error('not ack')
    const second = await client.saveCheckpoint(vector.input.app, vector.input.roomId, utf8('latest'), { schema: 'test/1', seq: 2, parent: first.hash })
    if (second.type !== 'ack') throw new Error('not ack')
    transport.head = first.head
    vi.spyOn(transport, 'storageGet').mockImplementationOnce(async () => { transport.head = second.head; throw new Error('lost chunks') })
    expect(await client.fetchLatest(vector.input.app, vector.input.roomId)).toEqual({ head: second.head, plaintext: utf8('latest') })
  } finally { client.dispose() }
})

describe('slot deletion', () => {
  it('does not send delete to the chosen legacy provider, even if another supports it', async () => {
    const transport = new FakeTransport(), client = new EscrowClient(transport, 'escrow')
    try {
      transport.head = fixture()
      await client.getHead(vector.slot)
      transport.features = ['delete']; transport.provider('z-supported')
      expect(await client.deleteSlot(vector.input.app, vector.input.roomId, fixture())).toMatchObject({ type: 'unsupported' })
      expect(transport.sent.some(s => s.message.type === 'escrow_delete')).toBe(false)
    } finally { client.dispose() }
  })
  it('signs deletion, accepts matching replies, conflicts and errors', async () => {
    const transport = new FakeTransport(); transport.features = ['delete']; transport.head = fixture()
    const client = new EscrowClient(transport, 'escrow')
    try {
      await client.getHead(vector.slot)
      expect(await client.deleteSlot(vector.input.app, vector.input.roomId, fixture())).toEqual({ type: 'deleted' })
      const sent = transport.sent.find(s => s.message.type === 'escrow_delete')!.message
      expect(sent).toEqual({ ...deleteVector.request, id: expect.any(String) })
      expect(await client.getHead(vector.slot)).toBeNull()
      transport.putMode = 'conflict'; transport.head = fixture()
      expect(await client.deleteSlot(vector.input.app, vector.input.roomId, fixture())).toEqual({ type: 'conflict', head: fixture() })
      transport.head = null
      expect(await client.deleteSlot(vector.input.app, vector.input.roomId, fixture())).toEqual({ type: 'conflict', head: null })
      transport.putMode = 'error'
      expect(await client.deleteSlot(vector.input.app, vector.input.roomId, fixture())).toMatchObject({ type: 'error', code: 'bad_signature' })
      expect(await client.deleteSlot('wrong-app', vector.input.roomId, fixture())).toMatchObject({ type: 'error', code: 'bad_sig' })
    } finally { client.dispose() }
  })
  it('ignores wrong sender/id/slot/type and unverified conflicts before a matching deleted reply', async () => {
    const transport = new FakeTransport(); transport.features = ['delete']; transport.respond = false
    const client = new EscrowClient(transport, 'escrow')
    try {
      transport.respond = true; transport.head = fixture()
      await client.getHead(vector.slot)
      transport.respond = false
      let settled = false
      const pending = client.deleteSlot(vector.input.app, vector.input.roomId, fixture()).then(r => { settled = true; return r })
      await vi.waitFor(() => expect(transport.sent.some(s => s.message.type === 'escrow_delete')).toBe(true))
      const request = transport.sent.find(s => s.message.type === 'escrow_delete')!.message
      if (request.type !== 'escrow_delete') throw new Error('not delete')
      const reply = { v: 1 as const, type: 'escrow_deleted' as const, id: request.id, slot: request.slot }
      transport.emit(reply, 'stranger')
      transport.provider('other'); transport.emit(reply, 'other')
      transport.emit({ ...reply, id: 'wrong' }); transport.emit({ ...reply, slot: '0'.repeat(32) })
      transport.emit({ v: 1, type: 'escrow_ack', id: request.id, slot: request.slot, seq: 1, hash: vector.head_hash_hex })
      transport.emit({ v: 1, type: 'escrow_error', id: request.id, code: 'conflict', message: '', head: { ...fixture(), seq: 2 } })
      await Promise.resolve(); expect(settled).toBe(false)
      transport.emit(reply); expect(await pending).toEqual({ type: 'deleted' })
    } finally { client.dispose() }
  })
  it('returns timeout and closed errors, waits for the original provider and keeps provider feature copies isolated', async () => {
    const transport = new FakeTransport(); transport.features = ['delete']; transport.respond = false
    const client = new EscrowClient(transport, 'escrow', { putTimeoutMs: 15 })
    try {
      transport.respond = true; transport.head = fixture()
      await client.getHead(vector.slot)
      transport.respond = false
      expect(await client.deleteSlot(vector.input.app, vector.input.roomId, fixture())).toMatchObject({ type: 'error', code: 'timeout' })
      client.providers.get('provider')!.features!.length = 0
      const pending = client.deleteSlot(vector.input.app, vector.input.roomId, fixture())
      await vi.waitFor(() => expect(transport.sent.filter(s => s.message.type === 'escrow_delete')).toHaveLength(2), { interval: 1 })
      transport.provider('z-other'); transport.respond = true
      for (const cb of transport.peers) cb('provider', false)
      // A different provider's absent-slot reply cannot complete this deletion.
      const retry = transport.sent.at(-1)!.message
      if (retry.type !== 'escrow_delete') throw new Error('not delete')
      transport.emit({ v: 1, type: 'escrow_deleted', id: retry.id, slot: retry.slot }, 'z-other')
      transport.provider()
      expect(await pending).toEqual({ type: 'deleted' })
      expect(transport.sent.filter(s => s.message.type === 'escrow_delete').every(s => s.to === 'provider')).toBe(true)
      client.dispose()
      expect(await client.deleteSlot(vector.input.app, vector.input.roomId, fixture())).toMatchObject({ type: 'error', code: 'closed' })
    } finally { client.dispose() }
  })
})


it('saves 5000 sequential checkpoint generations without deletion bookkeeping returning busy', async () => {
  const transport = new FakeTransport(), client = new EscrowClient(transport, 'escrow')
  const reply = transport.reply.bind(transport)
  vi.spyOn(transport, 'reply').mockImplementation(async message => {
    if (message.type === 'escrow_put') {
      const previous = transport.head
      if (message.head.parent !== (previous ? await headHash(previous) : null) || message.head.seq !== (previous?.seq ?? 0) + 1) {
        transport.emit({ v: 1, type: 'escrow_error', id: message.id, code: 'conflict', message: 'CAS mismatch', head: previous })
        return
      }
    }
    await reply(message)
  })
  try {
    let parent: string | null = null
    for (let seq = 1; seq <= 5000; seq++) {
      const result = await client.saveCheckpoint(vector.input.app, vector.input.roomId, utf8('checkpoint-' + seq), {
        schema: 'test/1', parent, seq, comp: 'none',
      })
      expect(result).toMatchObject({ type: 'ack', seq })
      if (result.type !== 'ack') throw new Error('Checkpoint not acknowledged: ' + JSON.stringify(result))
      parent = result.hash
    }
    expect(transport.sent.filter(s => s.message.type === 'escrow_put')).toHaveLength(5000)
    expect(transport.head?.seq).toBe(5000)
    expect((Reflect.get(client, 'headProviders') as Map<string, unknown>).size).toBe(1024)
    expect(await client.fetchLatest(vector.input.app, vector.input.roomId)).toMatchObject({ plaintext: utf8('checkpoint-5000') })
  } finally { client.dispose() }
}, 120000)
