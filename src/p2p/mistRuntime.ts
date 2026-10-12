import type { MistModule } from './p2pTypes.js'

type Bridge = Pick<MistModule, 'register_event_callback' | 'join_room_async' | 'leave_room_id'>
export type MistEventListener = (...events: unknown[]) => void
interface Room {
  owners: Set<unknown>
  pending?: Promise<void>
  joined: boolean
}
/** One callback and reference-counted room membership for all page consumers. */
export class MistRuntimeBroker {
  private listeners = new Map<unknown, MistEventListener>()
  private rooms = new Map<string, Room>()
  private peers = new Map<string, Set<string>>()
  private mist: Bridge
  constructor(mist: Bridge) {
    this.mist = mist
    mist.register_event_callback((...events: unknown[]) => {
      const [event, from, , room] = events
      if (typeof room === 'string' && typeof from === 'string' && this.rooms.get(room)?.owners.size) {
        let seen = this.peers.get(room)
        if (!seen) {
          seen = new Set()
          this.peers.set(room, seen)
        }
        if (event === 5 || event === 0) seen.add(from)
        if (event === 6) seen.delete(from)
      }
      for (const listener of this.listeners.values()) listener(...events)
    })
  }
  subscribe(owner: unknown, listener: MistEventListener): () => void {
    this.listeners.set(owner, listener)
    return () => {
      if (this.listeners.get(owner) === listener) this.listeners.delete(owner)
    }
  }
  acquire(roomId: string, owner: unknown): Promise<void> {
    let room = this.rooms.get(roomId)
    if (!room) {
      room = { owners: new Set(), joined: false }
      this.rooms.set(roomId, room)
    }
    room.owners.add(owner)
    return this.join(roomId, room)
  }
  private join(id: string, room: Room): Promise<void> {
    if (room.pending) return room.pending
    if (room.joined) return Promise.resolve()
    room.pending = this.mist
      .join_room_async(id)
      .then(() => {
        room.joined = true
        if (!room.owners.size) {
          this.mist.leave_room_id(id)
          this.rooms.delete(id)
          this.peers.delete(id)
        }
      })
      .finally(() => {
        room.pending = undefined
        // A failed join can also finish after its last owner has released it.
        if (!room.owners.size) {
          this.rooms.delete(id)
          this.peers.delete(id)
        }
      })
    return room.pending
  }
  release(id: string, owner: unknown): void {
    const room = this.rooms.get(id)
    if (!room) return
    room.owners.delete(owner)
    if (!room.owners.size && !room.pending) {
      if (room.joined) this.mist.leave_room_id(id)
      this.rooms.delete(id)
      this.peers.delete(id)
    }
  }
  releaseOwner(owner: unknown): void {
    this.listeners.delete(owner)
    for (const id of this.rooms.keys()) this.release(id, owner)
  }
  /** Runtime reinit destroys sessions; retained escrow leases must join again. */
  recover(): void {
    for (const [id, room] of this.rooms) {
      for (const peer of this.peers.get(id) ?? [])
        for (const listener of this.listeners.values()) listener(6, peer, new Uint8Array(), id)
      this.peers.delete(id)
      room.joined = false
      void (room.pending ?? Promise.resolve())
        .catch(() => {})
        .then(() => {
          room.joined = false
          if (room.owners.size) return this.join(id, room)
        })
        .catch(() => {})
    }
  }
}
const brokers = new WeakMap<object, MistRuntimeBroker>()
export const folderSyncOwner = Symbol('folder sync')
export function mistRuntime(mist: Bridge): MistRuntimeBroker {
  let broker = brokers.get(mist)
  if (!broker) {
    broker = new MistRuntimeBroker(mist)
    brokers.set(mist, broker)
  }
  return broker
}
