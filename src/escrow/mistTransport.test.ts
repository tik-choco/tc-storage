import { describe, expect, it } from 'vitest'
import { createMistEscrowTransport } from './mistTransport'
import { folderSyncOwner, mistRuntime } from '../p2p/mistRuntime'
import type { MistModule } from '../p2p/p2pTypes'
import { MAX_MESSAGE_BYTES } from './protocol'

function fixture() {
  let callback: (...events: unknown[]) => void = () => {},
    registrations = 0
  const joined: string[] = [],
    left: string[] = [],
    sent: {
      room: string
      to: string
      bytes: Uint8Array
    }[] = [],
    unpinned: string[] = []
  let reads = 0
  const api = {
    init_with_config: () => true,
    register_event_callback(cb: typeof callback) {
      registrations++
      callback = cb
    },
    async join_room_async(id: string) {
      joined.push(id)
    },
    leave_room_id(id: string) {
      left.push(id)
    },
    get_neighbors_in_room: () => JSON.stringify(['peer-a', 'provider']),
    send_message_in_room(room: string, to: string, bytes: Uint8Array) {
      sent.push({ room, to, bytes })
    },
    async storage_add_pinned() {
      return 'cid'
    },
    async storage_unpin(cid: string) {
      unpinned.push(cid)
    },
    async storage_get() {
      reads++
      await new Promise((r) => setTimeout(r, 10))
      return new Uint8Array([9])
    },
  } as unknown as MistModule
  return {
    api,
    joined,
    left,
    sent,
    unpinned,
    emit: (...args: unknown[]) => callback(...args),
    get registrations() {
      return registrations
    },
    get reads() {
      return reads
    },
  }
}
describe('storage mist transport', () => {
  it('shares callback and rooms without injecting escrow messages into folder sync', async () => {
    const f = fixture(),
      broker = mistRuntime(f.api),
      app: unknown[][] = []
    broker.subscribe(folderSyncOwner, (...events) => {
      if (events[3] === 'app-room') app.push(events)
    })
    await broker.acquire('app-room', folderSyncOwner)
    const transport = createMistEscrowTransport('node-a', undefined, async () => f.api),
      messages: string[] = [],
      peers: string[] = []
    transport.onMessage('escrow-room', (id) => messages.push(id))
    transport.onPeer('escrow-room', (id, joined) => {
      if (joined) peers.push(id)
    })
    await transport.join('escrow-room')
    f.emit(0, 'provider', new Uint8Array([1]), 'escrow-room')
    f.emit(0, 'peer-a', new Uint8Array([1]), 'app-room')
    f.emit(5, 'late-provider', new Uint8Array(), 'escrow-room')
    expect(messages).toEqual(['provider'])
    expect(peers).toContain('late-provider')
    expect(app).toHaveLength(1)
    expect(f.registrations).toBe(1)
    transport.leave('escrow-room')
    expect(f.left).toEqual(['escrow-room'])
    broker.releaseOwner(folderSyncOwner)
    expect(f.left).toEqual(['escrow-room', 'app-room'])
  })
  it('filters all control messages and sends to a pinned provider; provider loss aborts', async () => {
    const f = fixture(),
      t = createMistEscrowTransport('node-a', 'provider', async () => f.api),
      messages: string[] = []
    t.onMessage('escrow', (id) => messages.push(id))
    await t.join('escrow')
    f.emit(0, 'other', new Uint8Array([1]), 'escrow')
    f.emit(0, 'provider', new Uint8Array([1]), 'wrong')
    f.emit(0, 'provider', new Uint8Array([1]), 'escrow')
    expect(messages).toEqual(['provider'])
    t.send('escrow', null, new Uint8Array([1]))
    expect(f.sent.at(-1)?.to).toBe('provider')
    f.emit(6, 'provider', new Uint8Array(), 'escrow')
    expect(() => t.assertProvider()).toThrow('disconnected')
    expect(() => t.send('escrow', 'other', new Uint8Array())).toThrow('disconnected')
    t.leave('escrow')
  })
  it('bounds control messages and queues and releases temporary pins', async () => {
    const f = fixture(),
      t = createMistEscrowTransport('node-a', undefined, async () => f.api)
    const ready = t.join('escrow')
    expect(() => t.send('escrow', null, new Uint8Array(MAX_MESSAGE_BYTES + 1))).toThrow()
    for (let i = 0; i < 64; i++) t.send('escrow', null, new Uint8Array([1]))
    expect(() => t.send('escrow', null, new Uint8Array([1]))).toThrow('queue full')
    await ready
    expect(f.sent).toHaveLength(64)
    await t.storageAdd('tc-escrow.bin', new Uint8Array([1]))
    await t.releasePins()
    expect(f.unpinned).toEqual(['cid'])
    t.leave('escrow')
  })
  it('deduplicates storage reads by CID across transports', async () => {
    const f = fixture(),
      a = createMistEscrowTransport('node-a', undefined, async () => f.api),
      b = createMistEscrowTransport('node-a', undefined, async () => f.api)
    expect(await Promise.all([a.storageGet('same'), b.storageGet('same')])).toEqual([
      new Uint8Array([9]),
      new Uint8Array([9]),
    ])
    expect(f.reads).toBe(1)
  })
})
