import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MistRuntimeBroker } from '../src/p2p/mistRuntime.js'

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
