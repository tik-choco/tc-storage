import { expect, it, vi } from 'vitest'
import { EscrowClient, type EscrowTransport } from './client'
import { deleteSigningPayload, headHash, signHead, type EscrowHead } from './head'
import { deriveEscrowKeys, fromBase64url } from './crypto'
import { encodeEscrowMessage, parseEscrowMessage, type EscrowMessage } from './protocol'
import { vector } from './vectors.fixture'

async function providerModel() {
  const keys = await deriveEscrowKeys(vector.input.app, vector.input.roomId)
  const { sig: _sig, ...unsigned } = vector.head_signed
  const current = await signHead({ ...unsigned, cid: 'bafyreifrf6h4mdpcb26qnfe5rnbmf77yugounz4ul4dfpkctbxc5q7t5uy' }, keys)
  let peer!: (id: string, joined: boolean) => void
  let receive!: (from: string, bytes: Uint8Array) => void
  let respondToDelete = true
  const losePutAck = new Set<string>()
  const throwAfterPut = new Set<string>()
  const loseDeleteAck = new Set<string>()
  const deleteRequests = new Map<string, Extract<EscrowMessage, { type: 'escrow_delete' }>>()
  const stored = new Map<string, EscrowHead | null>([['a-small', null], ['b-large', null]])
  const sent: { to: string | null; type: string }[] = []
  const emit = (from: string, message: EscrowMessage) => receive(from, encodeEscrowMessage(message))
  const transport: EscrowTransport = {
    join: async () => {}, leave: () => {},
    onMessage: (_room, cb) => { receive = cb; return () => {} },
    onPeer: (_room, cb) => { peer = cb; return () => {} },
    storageAdd: async () => 'checkpoint',
    storageGet: async () => { throw new Error('not used') },
    send: (_room, to, bytes) => {
      const message = parseEscrowMessage(bytes)!
      sent.push({ to, type: message.type })
      if (message.type === 'escrow_delete') deleteRequests.set(to!, message)
      if (message.type === 'escrow_hello') {
        emit('a-small', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 28, features: ['delete'] })
        emit('b-large', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
      } else if (message.type === 'escrow_put') {
        stored.set(to!, message.head)
        if (throwAfterPut.has(to!)) throw new Error('send outcome unknown')
        if (losePutAck.has(to!)) { queueMicrotask(() => peer(to!, false)); return }
        void headHash(message.head).then(hash => emit(to!, {
          v: 1, type: 'escrow_ack', id: message.id, slot: message.head.slot, seq: message.head.seq, hash,
        }))
      } else if (message.type === 'escrow_get') {
        emit(to!, { v: 1, type: 'escrow_head', id: message.id, slot: message.slot, head: stored.get(to!) ?? null })
      } else if (message.type === 'escrow_delete' && respondToDelete && !loseDeleteAck.has(to!)) {
        void (async () => {
          const head = stored.get(to!)!
          if (head && (head.seq !== message.seq || await headHash(head) !== message.head)) {
            emit(to!, { v: 1, type: 'escrow_error', id: message.id, code: 'conflict', message: 'stale', head })
            return
          }
          if (head) {
            const key = await crypto.subtle.importKey('raw', fromBase64url(head.writer), 'Ed25519', false, ['verify'])
            if (!await crypto.subtle.verify('Ed25519', key, fromBase64url(message.sig), deleteSigningPayload(message))) {
              emit(to!, { v: 1, type: 'escrow_error', id: message.id, code: 'bad_signature', message: 'signature' })
              return
            }
          }
          stored.set(to!, null)
          emit(to!, { v: 1, type: 'escrow_deleted', id: message.id, slot: message.slot })
        })()
      }
    },
  }
  const client = new EscrowClient(transport, 'escrow', { putTimeoutMs: 100 })
  await client.join()
  return { client, current, stored, sent, emit, peer, losePutAck, throwAfterPut, loseDeleteAck, deleteRequests, holdDeletes: () => { respondToDelete = false }, resumeDeletes: () => { respondToDelete = true } }
}

it('deleteSlot must remove the head previously ACKed by put', async () => {
  const { client, current, stored, sent } = await providerModel()
  try {
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(stored.get('b-large'), JSON.stringify(sent)).toBeNull()
  } finally { client.dispose() }
})

it.each(['put', 'get'] as const)('keeps the %s provider when a new earlier provider arrives', async source => {
  const { client, current, stored, sent, emit, peer } = await providerModel()
  try {
    peer('a-small', false)
    if (source === 'put') expect(await client.put(current)).toMatchObject({ type: 'ack' })
    else {
      stored.set('b-large', current)
      expect(await client.getHead(current.slot)).toEqual(current)
    }
    emit('a-new', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, { ...current })).toEqual({ type: 'deleted' })
    expect(sent.at(-1)).toEqual({ to: 'b-large', type: 'escrow_delete' })
    expect(stored.get('b-large')).toBeNull()
  } finally { client.dispose() }
})

it('broadcasts deletion of an unknown head to every known delete-capable provider', async () => {
  const { client, current, stored, sent, emit } = await providerModel()
  try {
    stored.set('b-large', current)
    emit('c-absent', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    emit('d-legacy', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024 })
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(sent.filter(s => s.type === 'escrow_delete').map(s => s.to).sort()).toEqual(['a-small', 'b-large', 'c-absent'])
    expect(stored.get('b-large')).toBeNull()
  } finally { client.dispose() }
})

it.each(['absent', 'legacy'] as const)('does not confirm unknown-head deletion with only %s providers', async state => {
  const { client, current, sent, emit, peer } = await providerModel()
  try {
    peer('a-small', false); peer('b-large', false)
    if (state === 'legacy') emit('legacy', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024 })
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toMatchObject({ type: state === 'legacy' ? 'unsupported' : 'error' })
    expect(sent.some(s => s.type === 'escrow_delete')).toBe(false)
  } finally { client.dispose() }
})

it.each(['before', 'during'] as const)('waits for the same provider after departure %s DELETE', async when => {
  const { client, current, stored, sent, emit, peer, holdDeletes, resumeDeletes } = await providerModel()
  try {
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    if (when === 'before') peer('b-large', false)
    else holdDeletes()
    const deleting = client.deleteSlot(vector.input.app, vector.input.roomId, current)
    if (when === 'during') {
      await vi.waitFor(() => expect(sent.filter(s => s.type === 'escrow_delete')).toHaveLength(1), { interval: 1 })
      peer('b-large', false)
      expect(client.providers.has('a-small')).toBe(true)
    }
    await vi.waitFor(() => expect(sent.some(s => s.type === 'escrow_delete' && s.to === 'a-small')).toBe(false), { interval: 1 })
    expect(await deleting).toMatchObject({ type: 'error', code: 'timeout' })
    expect(stored.get('b-large')).toEqual(current)
    emit('b-large', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    resumeDeletes()
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(stored.get('b-large')).toBeNull()
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(sent.filter(s => s.type === 'escrow_delete').every(s => s.to === 'b-large')).toBe(true)
  } finally { client.dispose() }
})

it('deletes every ACKed copy after retrying a PUT on another provider', async () => {
  const { client, current, stored, sent, emit, peer } = await providerModel()
  try {
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    peer('b-large', false)
    emit('a-small', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    emit('b-large', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(sent.filter(s => s.type === 'escrow_delete').map(s => s.to).sort()).toEqual(['a-small', 'b-large'])
    expect(stored.get('a-small')).toBeNull()
    expect(stored.get('b-large')).toBeNull()
    peer('a-small', false)
    expect(await client.getHead(current.slot)).toBeNull()
  } finally { client.dispose() }
})

it('deletes the possibly stored copy after one PUT loses its ACK and fails over', async () => {
  const { client, current, stored, sent, emit, peer, losePutAck } = await providerModel()
  try {
    losePutAck.add('b-large')
    emit('c-fallback', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    expect(sent.filter(s => s.type === 'escrow_put').map(s => s.to)).toEqual(['b-large', 'c-fallback'])
    emit('b-large', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(sent.filter(s => s.type === 'escrow_delete').map(s => s.to).sort()).toEqual(['b-large', 'c-fallback'])
    expect(stored.get('b-large')).toBeNull()
    expect(stored.get('c-fallback')).toBeNull()
    peer('a-small', false)
    expect(await client.getHead(current.slot)).toBeNull()
  } finally { client.dispose() }
})

it('deletes reachable copies but returns an error until the unacknowledged provider rejoins', async () => {
  const { client, current, stored, sent, emit, peer, losePutAck } = await providerModel()
  try {
    losePutAck.add('b-large')
    emit('c-fallback', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toMatchObject({ type: 'error', code: 'timeout' })
    expect(stored.get('c-fallback')).toBeNull()
    expect(stored.get('b-large')).toEqual(current)
    expect(sent.filter(s => s.type === 'escrow_delete').map(s => s.to)).toEqual(['c-fallback'])
    emit('b-large', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(stored.get('b-large')).toBeNull()
    peer('a-small', false)
    expect(await client.getHead(current.slot)).toBeNull()
  } finally { client.dispose() }
})

it('retains a possible copy when the transport throws after submitting PUT', async () => {
  const { client, current, stored, sent, emit, peer, throwAfterPut } = await providerModel()
  try {
    throwAfterPut.add('b-large')
    expect(await client.put(current)).toMatchObject({ type: 'error', code: 'transport' })
    peer('b-large', false)
    emit('c-fallback', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    emit('b-large', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(sent.filter(s => s.type === 'escrow_delete').map(s => s.to).sort()).toEqual(['b-large', 'c-fallback'])
    expect(stored.get('b-large')).toBeNull()
    expect(stored.get('c-fallback')).toBeNull()
  } finally { client.dispose() }
})

it('retains the PUT provider when GET finds the same head on another provider', async () => {
  const { client, current, stored, sent } = await providerModel()
  try {
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    stored.set('a-small', current)
    expect(await client.getHead(current.slot)).toEqual(current)
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(sent.filter(s => s.type === 'escrow_delete').map(s => s.to).sort()).toEqual(['a-small', 'b-large'])
    expect(stored.get('a-small')).toBeNull()
    expect(stored.get('b-large')).toBeNull()
  } finally { client.dispose() }
})

it.each(['unsupported', 'conflict'] as const)('deletes other copies despite one provider returning %s', async failure => {
  const { client, current, stored, sent, emit, peer } = await providerModel()
  try {
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    peer('b-large', false)
    emit('c-fallback', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    emit('b-large', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, ...(failure === 'unsupported' ? {} : { features: ['delete'] }) })
    if (failure === 'conflict') {
      const keys = await deriveEscrowKeys(vector.input.app, vector.input.roomId)
      const { sig: _sig, ...unsigned } = current
      stored.set('b-large', await signHead({ ...unsigned, seq: current.seq + 1, parent: await headHash(current) }, keys))
    }
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toMatchObject({ type: failure })
    expect(stored.get('c-fallback')).toBeNull()
    expect(stored.get('b-large')).not.toBeNull()
    expect(sent.some(s => s.type === 'escrow_delete' && s.to === 'c-fallback')).toBe(true)
  } finally { client.dispose() }
})

it('refuses a concurrent PUT of the head during deletion', async () => {
  const { client, current, sent, holdDeletes } = await providerModel()
  try {
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    holdDeletes()
    const deleting = client.deleteSlot(vector.input.app, vector.input.roomId, current)
    await vi.waitFor(() => expect(sent.some(s => s.type === 'escrow_delete')).toBe(true), { interval: 1 })
    expect(await client.put(current)).toMatchObject({ type: 'error', code: 'busy' })
    expect(sent.filter(s => s.type === 'escrow_put')).toHaveLength(1)
    expect(await deleting).toMatchObject({ type: 'error', code: 'timeout' })
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
  } finally { client.dispose() }
})

async function rotateHeads(client: EscrowClient, current: EscrowHead, count = 1024) {
  const keys = await deriveEscrowKeys(vector.input.app, vector.input.roomId)
  const { sig: _sig, ...unsigned } = current
  for (let i = 1; i <= count; i++) {
    expect(await client.put(await signHead({ ...unsigned, at: current.at + i }, keys))).toMatchObject({ type: 'ack' })
  }
}

it.each(['evicted', 'rediscovered'] as const)('deletes every known copy of an %s head, including absent providers', async state => {
  const { client, current, stored, sent, emit } = await providerModel()
  try {
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    await rotateHeads(client, current)
    expect(sent.filter(s => s.type === 'escrow_put')).toHaveLength(1025)
    stored.set('a-small', current); stored.set('b-large', current)
    if (state === 'rediscovered') expect(await client.getHead(current.slot)).toEqual(current)
    emit('c-absent', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(stored.get('a-small')).toBeNull(); expect(stored.get('b-large')).toBeNull()
    expect(sent.filter(s => s.type === 'escrow_delete').map(s => s.to).sort()).toEqual(['a-small', 'b-large', 'c-absent'])
  } finally { client.dispose() }
}, 30000)

it.each(['conflict', 'timeout', 'error'] as const)('does not confirm evicted-head deletion when one provider returns %s', async failure => {
  const { client, current, stored, sent, emit, loseDeleteAck, deleteRequests } = await providerModel()
  try {
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    await rotateHeads(client, current)
    stored.set('a-small', current)
    if (failure === 'timeout') loseDeleteAck.add('b-large')
    if (failure === 'error') {
      loseDeleteAck.add('b-large')
      const deleting = client.deleteSlot(vector.input.app, vector.input.roomId, current)
      await vi.waitFor(() => expect(sent.filter(s => s.type === 'escrow_delete')).toHaveLength(2), { interval: 1 })
      const request = deleteRequests.get('b-large')!
      emit('b-large', { v: 1, type: 'escrow_error', id: request.id, code: 'busy', message: 'retry' })
      expect(await deleting).toMatchObject({ type: 'error', code: 'busy' })
    } else {
      expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toMatchObject(failure === 'conflict'
        ? { type: 'conflict' } : { type: 'error', code: 'timeout' })
    }
    expect(stored.get('a-small')).toBeNull()
    expect(stored.get('b-large')).not.toBeNull()
    expect(sent.filter(s => s.type === 'escrow_delete').map(s => s.to).sort()).toEqual(['a-small', 'b-large'])
  } finally { client.dispose() }
}, 30000)

it.each(['put', 'get'] as const)('preserves deletion provenance when per-head provider tracking overflows on %s', async source => {
  const { client, current, stored, sent, emit, peer } = await providerModel()
  try {
    peer('a-small', false)
    peer('b-large', false)
    const providers: string[] = []
    for (let i = 99; i >= 36; i--) {
      const id = 'provider-' + i
      providers.push(id)
      stored.set(id, current)
      emit(id, { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
      expect(await client.getHead(current.slot)).toEqual(current)
    }
    const overflow = 'provider-35'
    emit(overflow, { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    if (source === 'get') {
      stored.set(overflow, current)
      expect(await client.getHead(current.slot)).toEqual(current)
    } else {
      expect(await client.put(current)).toMatchObject({ type: 'ack' })
      expect(sent.some(s => s.type === 'escrow_put')).toBe(true)
    }
    const result = await client.deleteSlot(vector.input.app, vector.input.roomId, current)
    expect(result).toMatchObject({ type: 'error', code: 'transport' })
    expect(stored.get(overflow)).toBeNull()
    peer(overflow, false)
    // Rediscovering one known copy must never reset the incomplete-history flag.
    stored.set(providers.at(-1)!, current)
    expect(await client.getHead(current.slot)).toEqual(current)
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toMatchObject({ type: 'error', code: 'transport' })
    for (const id of providers) expect(stored.get(id)).toBeNull()
    expect(sent.some(s => s.type === 'escrow_delete' && s.to === overflow)).toBe(true)
  } finally { client.dispose() }
})

it('requires another deletion when GET discovers an additional copy during DELETE', async () => {
  const { client, current, stored, sent, emit, peer, holdDeletes, resumeDeletes } = await providerModel()
  try {
    peer('a-small', false)
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    holdDeletes()
    const deleting = client.deleteSlot(vector.input.app, vector.input.roomId, current)
    await vi.waitFor(() => expect(sent.some(s => s.type === 'escrow_delete')).toBe(true), { interval: 1 })
    stored.set('a-new', current)
    emit('a-new', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await client.getHead(current.slot)).toEqual(current)
    resumeDeletes()
    peer('b-large', false)
    emit('b-large', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    expect(await deleting).toMatchObject({ type: 'error', code: 'transport' })
    expect(stored.get('b-large')).toBeNull()
    expect(stored.get('a-new')).toEqual(current)
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(stored.get('a-new')).toBeNull()
  } finally { client.dispose() }
})


it('keeps the most recently accessed head when rotating a full slot history', async () => {
  const { client, current, stored, sent } = await providerModel()
  try {
    const keys = await deriveEscrowKeys(vector.input.app, vector.input.roomId)
    const { sig: _sig, ...unsigned } = current
    const oldest = await signHead({ ...unsigned, at: current.at - 1 }, keys)
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    expect(await client.put(oldest)).toMatchObject({ type: 'ack' })
    await rotateHeads(client, current, 1022)
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    expect(await client.put(await signHead({ ...unsigned, at: current.at + 1023 }, keys))).toMatchObject({ type: 'ack' })
    stored.set('b-large', current)
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(sent.filter(s => s.type === 'escrow_delete').map(s => s.to)).toEqual(['b-large'])
    stored.set('b-large', oldest)
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, oldest)).toEqual({ type: 'deleted' })
    expect(sent.filter(s => s.type === 'escrow_delete').slice(1).map(s => s.to).sort()).toEqual(['a-small', 'b-large'])
  } finally { client.dispose() }
}, 30000)

it("rotates a busy slot without evicting another slot's latest head", async () => {
  const { client, current, stored, sent } = await providerModel()
  try {
    const keys = await deriveEscrowKeys(vector.input.app, 'other-slot')
    const { sig: _sig, ...unsigned } = current
    const other = await signHead({ ...unsigned, slot: keys.slot, writer: keys.writer }, keys)
    expect(await client.put(other)).toMatchObject({ type: 'ack' })
    expect(await client.put(current)).toMatchObject({ type: 'ack' })
    await rotateHeads(client, current)
    stored.set('b-large', other)
    expect(await client.deleteSlot(vector.input.app, 'other-slot', other)).toEqual({ type: 'deleted' })
    expect(sent.filter(s => s.type === 'escrow_delete').map(s => s.to)).toEqual(['b-large'])
  } finally { client.dispose() }
}, 30000)

it('requires a retry if a new delete-capable provider arrives during unknown-head deletion', async () => {
  const { client, current, stored, sent, emit, peer, holdDeletes, resumeDeletes } = await providerModel()
  try {
    holdDeletes()
    const deleting = client.deleteSlot(vector.input.app, vector.input.roomId, current)
    await vi.waitFor(() => expect(sent.filter(s => s.type === 'escrow_delete')).toHaveLength(2), { interval: 1 })
    stored.set('c-new', current)
    emit('c-new', { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    resumeDeletes()
    for (const id of ['a-small', 'b-large']) {
      peer(id, false)
      emit(id, { v: 1, type: 'escrow_provider', version: 1, maxBlob: 1024, features: ['delete'] })
    }
    expect(await deleting).toMatchObject({ type: 'error', code: 'transport' })
    expect(stored.get('c-new')).toEqual(current)
    expect(await client.deleteSlot(vector.input.app, vector.input.roomId, current)).toEqual({ type: 'deleted' })
    expect(stored.get('c-new')).toBeNull()
  } finally { client.dispose() }
})
