import assert from 'node:assert/strict'
import { test } from 'node:test'
import { folderSyncOwner, MistRuntimeBroker } from '../src/p2p/mistRuntime.js'

function bridge() {
  let callback: (...events: unknown[]) => void = () => {}
  const joins: string[] = [],
    leaves: string[] = []
  let registrations = 0
  const api = {
    register_event_callback(cb: Function) {
      callback = cb as (...events: unknown[]) => void
      registrations++
    },
    async join_room_async(id: string) {
      joins.push(id)
    },
    leave_room_id(id: string) {
      leaves.push(id)
    },
  }
  return {
    api,
    joins,
    leaves,
    get registrations() {
      return registrations
    },
    emit: (...events: unknown[]) => callback(...events),
  }
}
test('broker shares one callback and refcounts folder/escrow leases', async () => {
  const b = bridge(),
    broker = new MistRuntimeBroker(b.api),
    folder = Symbol(),
    escrow = Symbol(),
    events: unknown[][] = []
  broker.subscribe(folder, (...e) => events.push(e))
  broker.subscribe(escrow, (...e) => events.push(e))
  await broker.acquire('same', folder)
  await broker.acquire('same', escrow)
  b.emit(0, 'peer', new Uint8Array([1]), 'same')
  assert.equal(b.registrations, 1)
  assert.equal(events.length, 2)
  assert.deepEqual(b.joins, ['same'])
  broker.releaseOwner(folder)
  assert.deepEqual(b.leaves, [])
  broker.releaseOwner(escrow)
  assert.deepEqual(b.leaves, ['same'])
})
test('release while joining does not leave a reacquired lease', async () => {
  const b = bridge()
  let finish = () => {}
  b.api.join_room_async = async (id) => {
    b.joins.push(id)
    await new Promise<void>((resolve) => {
      finish = resolve
    })
  }
  const broker = new MistRuntimeBroker(b.api),
    a = Symbol(),
    c = Symbol()
  const joining = broker.acquire('room', a)
  broker.release('room', a)
  const reacquired = broker.acquire('room', c)
  finish()
  await Promise.all([joining, reacquired])
  assert.deepEqual(b.joins, ['room'])
  assert.deepEqual(b.leaves, [])
  broker.release('room', c)
  assert.deepEqual(b.leaves, ['room'])
})
test('release while joining eventually tears down an unowned room', async () => {
  const b = bridge()
  let finish = () => {}
  b.api.join_room_async = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
  }
  const broker = new MistRuntimeBroker(b.api),
    owner = Symbol()
  const pending = broker.acquire('room', owner)
  broker.releaseOwner(owner)
  finish()
  await pending
  assert.deepEqual(b.leaves, ['room'])
})
test('runtime recovery reacquires retained rooms and invalidates provider sessions', async () => {
  const b = bridge(),
    broker = new MistRuntimeBroker(b.api),
    owner = Symbol(),
    events: unknown[][] = []
  broker.subscribe(owner, (...event) => events.push(event))
  await broker.acquire('escrow', owner)
  b.emit(5, 'provider', new Uint8Array(), 'escrow')
  broker.recover()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(b.joins, ['escrow', 'escrow'])
  assert.equal(events[1][0], 6)
  assert.equal(events[1][1], 'provider')
  assert.equal(b.registrations, 1)
})

test('app acquisition releases every escrow lease and errors controllers before joining', async () => {
  const b = bridge(), broker = new MistRuntimeBroker(b.api)
  const discovery = Symbol(), transaction = Symbol()
  let errors = 0, purges = 0
  let appPeers = ['escrow-only', 'app-peer']
  broker.subscribeAppPeerPurge(folderSyncOwner, (room, peers) => {
    purges++
    assert.equal(room, 'overlap')
    assert.equal(errors, 2)
    assert.equal(broker.owns(room, folderSyncOwner), false)
    appPeers = appPeers.filter(peer => !peers.includes(peer))
  })
  const collision = () => {
    errors++
    assert.equal(broker.owns('overlap', discovery), false)
    assert.equal(broker.owns('overlap', transaction), false)
    assert.equal(broker.owns('overlap', folderSyncOwner), false)
  }
  await broker.acquireEscrow('overlap', discovery, collision)
  await broker.acquireEscrow('overlap', transaction, collision)
  b.emit(5, 'escrow-only', new Uint8Array(), 'overlap')
  await broker.acquire('overlap', folderSyncOwner)
  assert.equal(errors, 2)
  assert.equal(purges, 1)
  assert.deepEqual(appPeers, ['app-peer'])
  appPeers.push('escrow-only') // Ordinary app rediscovery is permitted after the purge.
  await broker.acquire('overlap', folderSyncOwner)
  assert.equal(purges, 1)
  assert.deepEqual(appPeers, ['app-peer', 'escrow-only'])
  assert.deepEqual(b.leaves, ['overlap'])
  assert.deepEqual(b.joins, ['overlap', 'overlap'])
  broker.releaseOwner(folderSyncOwner)
})

test('a pending escrow join finishes and leaves before the app can acquire the room', async () => {
  const b = bridge(), broker = new MistRuntimeBroker(b.api), escrow = Symbol()
  let finish = () => {}, errors = 0
  const order: string[] = []
  b.api.join_room_async = async id => {
    order.push('join')
    b.joins.push(id)
    if (b.joins.length === 1) await new Promise<void>(resolve => { finish = resolve })
    else assert.equal(errors, 1)
  }
  b.api.leave_room_id = id => { b.leaves.push(id); order.push('leave') }
  const joining = broker.acquireEscrow('overlap', escrow, () => { errors++; order.push('error') })
  const app = broker.acquire('overlap', folderSyncOwner)
  assert.equal(errors, 1)
  assert.equal(broker.owns('overlap', folderSyncOwner), false)
  finish()
  await Promise.all([joining, app])
  assert.deepEqual(order, ['join', 'error', 'leave', 'join'])
  broker.releaseOwner(folderSyncOwner)
})

test('escrow admission is rejected while an app acquisition is reserved', async () => {
  const b = bridge(), broker = new MistRuntimeBroker(b.api), escrow = Symbol()
  let finish = () => {}, collisions = 0
  b.api.join_room_async = async () => { await new Promise<void>(resolve => { finish = resolve }) }
  const app = broker.acquire('app', folderSyncOwner)
  await assert.rejects(broker.acquireEscrow('app', escrow, () => { collisions++ }), /conflicts/)
  assert.equal(collisions, 1)
  assert.equal(broker.owns('app', escrow), false)
  finish()
  await app
  broker.releaseOwner(folderSyncOwner)
})

test('early controller retirement retains known peers for one acquisition purge', async () => {
  const b = bridge(), broker = new MistRuntimeBroker(b.api), escrow = Symbol()
  const purges: string[][] = []
  broker.subscribeAppPeerPurge(folderSyncOwner, (_, peers) => purges.push(peers))
  await broker.acquireEscrow('room', escrow, () => {})
  b.emit(0, 'provider', new Uint8Array(), 'room')
  broker.retireEscrowPeers('room')
  broker.releaseOwner(escrow)
  await broker.acquire('room', folderSyncOwner)
  assert.deepEqual(purges, [['provider']])
  broker.release('room', folderSyncOwner)
  await broker.acquire('room', folderSyncOwner)
  assert.deepEqual(purges, [['provider']])
  broker.releaseOwner(folderSyncOwner)
})

test('removing a reserved app room cancels its pending escrow-to-app transition', async () => {
  const b = bridge(), broker = new MistRuntimeBroker(b.api), escrow = Symbol()
  let finish = () => {}
  b.api.join_room_async = async id => {
    b.joins.push(id)
    await new Promise<void>(resolve => { finish = resolve })
  }
  const joining = broker.acquireEscrow('overlap', escrow, () => {})
  const app = broker.acquire('overlap', folderSyncOwner)
  const rejected = assert.rejects(app, /cancelled/)
  broker.release('overlap', folderSyncOwner)
  finish()
  await joining
  await rejected
  assert.equal(broker.owns('overlap', folderSyncOwner), false)
  assert.deepEqual(b.joins, ['overlap'])
  assert.deepEqual(b.leaves, ['overlap'])
})

test('unavailable retirement polling purges known event peers without quarantining unknown neighbors', async () => {
  const b = bridge()
  const api = { ...b.api, get_neighbors_in_room: () => { throw new Error('pending neighbors') } }
  const broker = new MistRuntimeBroker(api), escrow = Symbol()
  const purges: string[][] = []
  broker.subscribeAppPeerPurge(folderSyncOwner, (_, peers) => purges.push(peers))
  await broker.acquireEscrow('room', escrow, () => {})
  b.emit(5, 'known-provider', new Uint8Array(), 'room')
  await broker.acquire('room', folderSyncOwner)
  assert.deepEqual(purges, [['known-provider']])
  await broker.acquire('room', folderSyncOwner)
  assert.equal(purges.length, 1)
  broker.releaseOwner(folderSyncOwner)
})

test('app cleanup preserves event-only peers on an unrelated active escrow lease until collision purge', async () => {
  const b = bridge(), broker = new MistRuntimeBroker(b.api), escrow = Symbol()
  await broker.acquire('app', folderSyncOwner)
  await broker.acquireEscrow('escrow', escrow, () => {})
  b.emit(5, 'event-only-provider', new Uint8Array(), 'escrow')
  broker.releaseOwner(folderSyncOwner)
  const purges: string[][] = []
  broker.subscribeAppPeerPurge(folderSyncOwner, (_, peers) => purges.push(peers))
  await broker.acquire('escrow', folderSyncOwner)
  assert.deepEqual(purges, [['event-only-provider']])
  broker.releaseOwner(folderSyncOwner)
})
