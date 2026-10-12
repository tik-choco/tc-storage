import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMistShare } from '../p2p/p2p'
import { createMistEscrowTransport } from '../escrow/mistTransport'
import { folderSyncOwner, mistRuntime } from '../p2p/mistRuntime'
import { createDidIdentity, type DidIdentity } from '../crypto/didIdentity'
import { useMistShare as useHeadMistShare } from './fixtures/headP2p'
import type { ShareEnvelope, MistModule } from '../p2p/p2pTypes'

const h = vi.hoisted(() => ({
  api: null as unknown as MistModule, states: [] as any[],
  realSetTimeout: globalThis.setTimeout,
  identities: new Map<string, DidIdentity>(), signingIdentity: null as DidIdentity | null,
}))
vi.mock('preact/hooks', () => ({
  useRef: (current: unknown) => ({ current }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useState: (initial: any) => {
    const state = { current: initial }
    h.states.push(state)
    return [initial, (next: any) => {
      state.current =
        typeof next === 'function' ? next(state.current) : next
    }]
  },
}))
vi.mock('../storage/mistStorage', () => ({
  loadMistModule: async () => h.api,
  ensureMistRuntimeInitialized: () => {},
}))
vi.mock('../p2p/p2pEnvelope', async original => {
  const actual = await original<any>()
  return { ...actual, signShareEnvelope: (value: any) => {
    h.signingIdentity = h.identities.get(value.from) ?? null
    return actual.signShareEnvelope(value)
  } }
})

const settings = {
  nodeId: 'did:key:z6MkvTZ4FTCtXPiZ7M6MQoFNGgXYhEyX65Y5C6HQ8GFsv24w',
  roomId: 'overlap', autoConnect: false, profileName: 'review',
  avatarUrl: '', avatarFileId: '', identity: null,
}
const cleanup: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    setTimeout, clearTimeout, setInterval, clearInterval,
  })
  vi.stubGlobal('BroadcastChannel', undefined)
  h.states = []
  h.identities.clear()
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(h.signingIdentity) })
})
afterEach(() => {
  cleanup.splice(0).forEach(fn => fn())
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function bridge(peer: string, pending = false) {
  let emit: (...e: unknown[]) => void = () => {}
  let finish = () => {}
  const sent: any[] = [], joins: string[] = []
  let deliver: ((to: string, bytes: Uint8Array) => void) | undefined
  const api = {
    register_event_callback: (cb: typeof emit) => { emit = cb },
    join_room_async: async (room: string) => {
      joins.push(room)
      if (pending && joins.length === 1)
        await new Promise<void>(resolve => { finish = resolve })
    },
    leave_room_id: () => {},
    update_position_in_room: () => {},
    get_neighbors_in_room: () => JSON.stringify([peer]),
    send_message_in_room: (
      room: string, to: string, bytes: Uint8Array,
    ) => {
      const wire = JSON.parse(new TextDecoder().decode(bytes))
      sent.push({ room, to, type: wire.type, wire, bytes })
      deliver?.(to, bytes)
    },
  } as unknown as MistModule
  return {
    api, sent, joins,
    emit: (...e: unknown[]) => emit(...e),
    finish: () => finish(),
    route: (fn: typeof deliver) => { deliver = fn },
  }
}


it.each([false, true])('pending escrow retirement purges once before app acquisition (early controller retirement: %s)', async early => {
  const b = bridge('mistl-daemon', true)
  h.api = b.api
  const transport = createMistEscrowTransport(settings.nodeId, undefined, async () => b.api)
  transport.onRoomCollision!(() => transport.leave('overlap'))
  cleanup.push(() => transport.leave('overlap'))
  const joining = transport.join('overlap')
  for (let i = 0; i < 10 && !b.joins.length; i++) await Promise.resolve()
  const broker = mistRuntime(b.api)
  const purges: string[][] = []
  broker.subscribeAppPeerPurge(Symbol(), (room, peers) => {
    expect(room).toBe('overlap')
    expect(broker.owns(room, folderSyncOwner)).toBe(false)
    purges.push(peers)
  })
  b.emit(5, 'event-only-provider', new Uint8Array(), 'overlap')
  if (early) {
    transport.excludeAppPeers!('overlap')
    transport.leave('overlap')
  }
  const network = useMistShare(settings, ['overlap'], () => {})
  cleanup.push(() => network.disconnect(true))
  const connected = network.connect()
  for (let i = 0; i < 20; i++) await Promise.resolve()
  b.finish()
  await Promise.all([joining, connected])
  expect(purges).toHaveLength(1)
  expect(purges[0]).toEqual(expect.arrayContaining(['event-only-provider', 'mistl-daemon']))
  // Replacement membership is ordinary app membership; the same raw peer can return.
  expect(h.states.at(-1).current.peers).toEqual(['mistl-daemon'])
  await vi.advanceTimersByTimeAsync(3000)
  expect(purges).toHaveLength(1)
})

it('app peer purge removes room bookkeeping once and preserves peers in other app rooms', async () => {
  const b = bridge('shared-peer')
  h.api = b.api
  const network = useMistShare(settings, ['overlap', 'other-app'], () => {})
  cleanup.push(() => network.disconnect(true))
  await network.connect()
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.states.at(-1).current.stablePeersByRoom.overlap).toEqual(['shared-peer'])
  const broker = mistRuntime(b.api)
  // Simulate retained peer bookkeeping while the room is replaced by an escrow lease.
  broker.release('overlap', folderSyncOwner)
  const escrow = Symbol()
  await broker.acquireEscrow('overlap', escrow, () => {})
  b.emit(5, 'shared-peer', new Uint8Array(), 'overlap')
  await broker.acquire('overlap', folderSyncOwner)
  expect(h.states.at(-1).current.peersByRoom.overlap).toEqual([])
  expect(h.states.at(-1).current.stablePeersByRoom.overlap).toEqual([])
  expect(h.states.at(-1).current.peersByRoom['other-app']).toEqual(['shared-peer'])
  expect(h.states.at(-1).current.peers).toEqual(['shared-peer'])
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.states.at(-1).current.peersByRoom.overlap).toEqual(['shared-peer'])
  expect(h.states.at(-1).current.stablePeersByRoom.overlap).toEqual([])
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.states.at(-1).current.stablePeersByRoom.overlap).toEqual(['shared-peer'])
})

it.each([false, true])('signed HELLO and bidirectional sync match HEAD (collision: %s)', async collision => {
  const identityA = await createDidIdentity(), identityB = await createDidIdentity()
  for (const identity of [identityA, identityB]) h.identities.set(identity.did, identity)
  async function exchange(clientA: typeof useMistShare, clientB: typeof useMistShare) {
    const a = bridge(identityB.did), b = bridge(identityA.did)
    a.route((to, bytes) => { if (to === identityB.did) b.emit(0, identityA.did, bytes, 'overlap') })
    b.route((to, bytes) => { if (to === identityA.did) a.emit(0, identityB.did, bytes, 'overlap') })
    const receivedA: ShareEnvelope[] = [], receivedB: ShareEnvelope[] = []
    const clients = []
    for (const [side, identity, client, received] of [
      [a, identityA, clientA, receivedA], [b, identityB, clientB, receivedB],
    ] as const) {
      h.api = side.api
      if (collision) {
        const broker = mistRuntime(side.api), escrow = Symbol()
        await broker.acquireEscrow('overlap', escrow, () => {})
        broker.rememberEscrowPeers('overlap', [side === a ? identityB.did : identityA.did])
      }
      const network = client({ ...settings, nodeId: identity.did }, ['overlap'], envelope => received.push(envelope))
      cleanup.push(() => network.disconnect(true))
      clients.push(network)
      await network.connect()
    }
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      await new Promise<void>(resolve => h.realSetTimeout(resolve, 20))
    }
    expect(receivedA.some(w => w.type === 'hello' && w.from === identityB.did)).toBe(true)
    expect(receivedB.some(w => w.type === 'hello' && w.from === identityA.did)).toBe(true)
    clients[0].broadcastShare({ type: 'folder-state', folderId: 'from-a', cid: 'state-a', clock: 7 })
    clients[1].broadcastShare({ type: 'folder-state', folderId: 'from-b', cid: 'state-b', clock: 9 })
    for (let i = 0; i < 20 && (!receivedA.some(w => w.type === 'folder-state') || !receivedB.some(w => w.type === 'folder-state')); i++)
      await new Promise<void>(resolve => h.realSetTimeout(resolve, 10))
    expect(receivedA.some(w => w.type === 'folder-state' && w.cid === 'state-b')).toBe(true)
    expect(receivedB.some(w => w.type === 'folder-state' && w.cid === 'state-a')).toBe(true)
    for (const side of [a, b]) expect(side.sent.map(s => s.type)).toEqual(['hello', 'folder-state'])
    const transcript = [a, b].map(side => side.sent.map(({ wire, to, room }) => {
      const { signature, sentAt, ...payload } = wire
      expect(signature).toBeTruthy()
      return { to, room, payload }
    }))
    clients.forEach(client => client.disconnect(true))
    return transcript
  }
  const baseline = await exchange(useHeadMistShare, useHeadMistShare)
  expect(await exchange(useMistShare, useHeadMistShare)).toEqual(baseline)
  expect(await exchange(useMistShare, useMistShare)).toEqual(baseline)
})

it('a peer first visible during replacement app join uses ordinary HELLO without a probe', async () => {
  const identity = await createDidIdentity()
  h.identities.set(identity.did, identity)
  const b = bridge('late-peer')
  let neighbors: string[] = []
  b.api.get_neighbors_in_room = () => JSON.stringify(neighbors)
  b.api.join_room_async = async room => {
    b.joins.push(room)
    if (b.joins.length === 2) {
      neighbors = ['late-peer']
      b.emit(5, 'late-peer', new Uint8Array(), room)
    }
  }
  h.api = b.api
  const broker = mistRuntime(b.api), escrow = Symbol()
  await broker.acquireEscrow('overlap', escrow, () => {})
  const network = useMistShare({ ...settings, nodeId: identity.did }, ['overlap'], () => {})
  cleanup.push(() => network.disconnect(true))
  await network.connect()
  await vi.advanceTimersByTimeAsync(3000)
  for (let i = 0; i < 20 && !b.sent.length; i++)
    await new Promise<void>(resolve => h.realSetTimeout(resolve, 10))
  expect(h.states.at(-1).current.peers).toEqual(['late-peer'])
  expect(b.sent.map(s => s.type)).toEqual(['hello'])
  expect(b.sent[0].to).toBe('late-peer')
})
