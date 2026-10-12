import type { EscrowTransport } from './client'
import { MAX_MESSAGE_BYTES } from './protocol'
import { loadMistModule, ensureMistRuntimeInitialized } from '../storage/mistStorage.js'
import { mistRuntime } from '../p2p/mistRuntime.js'
import { readPeers } from '../p2p/p2pMist.js'
import type { MistModule } from '../p2p/p2pTypes.js'

const reads = new Map<string, Promise<Uint8Array>>()
export interface StorageEscrowTransport extends EscrowTransport {
  excludeAppPeers?(room: string): void
  onRoomCollision?(callback: (room: string) => void): () => void
  assertProvider(): void
  releasePins(): Promise<void>
}
/** A transaction transport filters discovery and replies to one provider for its entire life. */
export function createMistEscrowTransport(
  nodeId: string,
  provider?: string,
  loadModule = loadMistModule,
): StorageEscrowTransport {
  const rooms = new Map<
    string,
    {
      owner: symbol
      ready: boolean
      promise: Promise<void>
      queue: {
        to: string | null
        bytes: Uint8Array
      }[]
      off?: () => void
    }
  >()
  const messages = new Map<string, Set<(id: string, bytes: Uint8Array) => void>>()
  const peers = new Map<string, Set<(id: string, joined: boolean) => void>>()
  const collisions = new Set<(room: string) => void>()
  const pins = new Set<string>()
  let mist: MistModule | undefined
  let lost = false
  const assertProvider = () => {
    if (lost) throw new Error('Escrow provider disconnected')
  }
  const load = async () => {
    mist = await loadModule()
    ensureMistRuntimeInitialized(mist, { nodeId })
    return mist
  }
  function subscribe<T>(map: Map<string, Set<T>>, room: string, cb: T) {
    let set = map.get(room)
    if (!set) {
      set = new Set()
      map.set(room, set)
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (!set.size) map.delete(room)
    }
  }
  return {
    assertProvider,
    excludeAppPeers(room) {
      if (mist) mistRuntime(mist).retireEscrowPeers(room)
    },
    onRoomCollision(callback) {
      collisions.add(callback)
      return () => { collisions.delete(callback) }
    },
    join(id) {
      const prior = rooms.get(id)
      if (prior) return prior.promise
      const room = {
        owner: Symbol('escrow room lease'),
        ready: false,
        promise: Promise.resolve(),
        queue: [] as {
          to: string | null
          bytes: Uint8Array
        }[],
        off: undefined as (() => void) | undefined,
      }
      rooms.set(id, room)
      room.promise = (async () => {
        const api = await load()
        if (rooms.get(id) !== room) return
        const broker = mistRuntime(api)
        room.off = broker.subscribe(room.owner, (event, from, payload, transportRoom) => {
          if (transportRoom !== id || typeof from !== 'string' || (provider && from !== provider)) return
          if (event === 5 || event === 6) {
            if (event === 6 && provider) lost = true
            for (const cb of peers.get(id) ?? []) cb(from, event === 5)
          } else if (event === 0 && payload instanceof Uint8Array && payload.length <= MAX_MESSAGE_BYTES) {
            for (const cb of messages.get(id) ?? []) cb(from, payload)
          }
        })
        await broker.acquireEscrow(id, room.owner, () => {
          lost = true
          for (const callback of collisions) callback(id)
        })
        if (rooms.get(id) !== room) {
          broker.release(id, room.owner)
          return
        }
        room.ready = true
        const neighbors = readPeers(api.get_neighbors_in_room(id))
        broker.rememberEscrowPeers(id, neighbors)
        for (const peer of neighbors) {
          if (!provider || peer === provider) for (const cb of peers.get(id) ?? []) cb(peer, true)
        }
        for (const msg of room.queue.splice(0)) api.send_message_in_room(id, msg.to ?? '', msg.bytes, 0)
      })().catch((error) => {
        room.off?.()
        if (rooms.get(id) === room) rooms.delete(id)
        if (mist) mistRuntime(mist).release(id, room.owner)
        throw error
      })
      return room.promise
    },
    leave(id) {
      const room = rooms.get(id)
      rooms.delete(id)
      room?.off?.()
      if (mist && room) mistRuntime(mist).release(id, room.owner)
    },
    send(id, to, bytes) {
      assertProvider()
      const room = rooms.get(id)
      if (!room || bytes.length > MAX_MESSAGE_BYTES) throw new Error('Invalid escrow send')
      if (provider) to = provider
      if (!room.ready) {
        if (room.queue.length >= 64) throw new Error('Escrow send queue full')
        room.queue.push({ to, bytes: new Uint8Array(bytes) })
      } else mist!.send_message_in_room(id, to ?? '', bytes, 0)
    },
    onMessage: (id, cb) => subscribe(messages, id, cb),
    onPeer: (id, cb) => subscribe(peers, id, cb),
    async storageAdd(name, bytes) {
      assertProvider()
      const cid = await (await load()).storage_add_pinned(name, bytes)
      pins.add(cid)
      assertProvider()
      return cid
    },
    storageGet(cid) {
      assertProvider()
      let pending = reads.get(cid)
      if (!pending) {
        pending = load()
          .then((api) => api.storage_get(cid))
          .finally(() => {
            reads.delete(cid)
          })
        reads.set(cid, pending)
      }
      return pending.then((bytes) => {
        assertProvider()
        return bytes
      })
    },
    async releasePins() {
      if (!mist) return
      for (const cid of pins) {
        await mist.storage_unpin(cid).catch(() => {})
        pins.delete(cid)
      }
    },
  }
}
