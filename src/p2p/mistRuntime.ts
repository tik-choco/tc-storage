import { readPeers } from './p2pMist.js'
import type { MistModule } from './p2pTypes.js'

type Bridge = Pick<MistModule, 'register_event_callback' | 'join_room_async' | 'leave_room_id'> & Partial<Pick<MistModule, 'get_neighbors_in_room'>>
export type MistEventListener = (...events: unknown[]) => void
interface Room {
  owners: Set<unknown>
  pending?: Promise<void>
  joined: boolean
  retiringEscrow?: boolean
}
/** One callback and reference-counted room membership for all page consumers. */
export class MistRuntimeBroker {
  private listeners = new Map<unknown, MistEventListener>()
  private rooms = new Map<string, Room>()
  private peers = new Map<string, Set<string>>()
  private escrowLeases = new Map<string, Map<unknown, () => void>>()
  private appReservations = new Set<string>()
  private appTransitions = new Map<string, Promise<void>>()
  private escrowPeers = new Map<string, Set<string>>()
  private appPeerPurgeListeners = new Map<unknown, (room: string, peers: string[]) => void>()
  private mist: Bridge
  constructor(mist: Bridge) {
    this.mist = mist
    mist.register_event_callback((...events: unknown[]) => {
      const [event, from, , room] = events
      if (typeof room === 'string' && typeof from === 'string' && (this.rooms.get(room)?.owners.size || this.rooms.get(room)?.retiringEscrow)) {
        let seen = this.peers.get(room)
        if (!seen) {
          seen = new Set()
          this.peers.set(room, seen)
        }
        if (event === 5 || event === 0) {
          seen.add(from)
          if ((this.escrowLeases.get(room)?.size || this.rooms.get(room)?.retiringEscrow) && !this.owns(room, folderSyncOwner))
            this.rememberEscrowPeers(room, [from])
        }
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
  /** Escrow cannot retain a room that the app owns or is about to acquire. */
  acquireEscrow(roomId: string, owner: unknown, collision: () => void): Promise<void> {
    if (this.appReservations.has(roomId) || this.owns(roomId, folderSyncOwner)) {
      collision()
      return Promise.reject(new Error('Escrow room conflicts with an app room'))
    }
    let leases = this.escrowLeases.get(roomId)
    if (!leases) this.escrowLeases.set(roomId, leases = new Map())
    leases.set(owner, collision)
    return this.acquireLease(roomId, owner)
  }
  acquire(roomId: string, owner: unknown): Promise<void> {
    if (owner !== folderSyncOwner) return this.acquireLease(roomId, owner)
    this.appReservations.add(roomId)
    const pending = this.appTransitions.get(roomId)
    if (pending) return pending
    const leases = this.escrowLeases.get(roomId)
    if (!leases?.size && !this.rooms.get(roomId)?.retiringEscrow && !this.escrowPeers.has(roomId)) return this.acquireLease(roomId, owner)
    // Release ALL escrow owners, then notify controllers, before adding the app owner.
    const oldRoom = this.rooms.get(roomId)
    this.retireEscrowPeers(roomId)
    const callbacks = [...(leases?.values() ?? [])]
    for (const escrowOwner of [...(leases?.keys() ?? [])]) this.release(roomId, escrowOwner)
    for (const callback of callbacks) callback()
    const transition = (async () => {
      // A pending escrow join must finish and leave before the fresh app join.
      await oldRoom?.pending?.catch(() => {})
      if (!this.appReservations.has(roomId)) throw new Error('App room acquisition cancelled')
      this.purgeEscrowPeers(roomId)
      await this.acquireLease(roomId, owner)
    })().finally(() => {
      if (this.appTransitions.get(roomId) === transition) this.appTransitions.delete(roomId)
    })
    this.appTransitions.set(roomId, transition)
    return transition
  }
  owns(roomId: string, owner: unknown): boolean {
    return this.rooms.get(roomId)?.owners.has(owner) ?? false
  }
  /** Local bookkeeping only: no membership probes or persistent admission rules. */
  subscribeAppPeerPurge(owner: unknown, listener: (room: string, peers: string[]) => void): void {
    this.appPeerPurgeListeners.set(owner, listener)
  }
  rememberEscrowPeers(roomId: string, peers: string[]): void {
    if (!this.escrowLeases.get(roomId)?.size && !this.rooms.get(roomId)?.retiringEscrow) return
    let seen = this.escrowPeers.get(roomId)
    if (!seen) this.escrowPeers.set(roomId, seen = new Set())
    for (const peer of peers) seen.add(peer)
  }
  /** Preserve known escrow peers until the one-time app acquisition purge. */
  retireEscrowPeers(roomId: string): void {
    const room = this.rooms.get(roomId)
    if (!room || this.owns(roomId, folderSyncOwner)) return
    room.retiringEscrow = true
    this.captureEscrowNeighbors(roomId)
    this.rememberEscrowPeers(roomId, [...(this.peers.get(roomId) ?? [])])
  }
  private purgeEscrowPeers(roomId: string): void {
    const peers = [...(this.escrowPeers.get(roomId) ?? [])]
    this.escrowPeers.delete(roomId)
    for (const peer of peers) this.peers.get(roomId)?.delete(peer)
    for (const listener of this.appPeerPurgeListeners.values()) listener(roomId, peers)
  }
  private captureEscrowNeighbors(id: string): void {
    try {
      this.rememberEscrowPeers(id, readPeers(this.mist.get_neighbors_in_room?.(id) ?? '[]'))
    } catch {
      // Purge the peers already known from escrow events if polling is unavailable.
    }
  }
  private acquireLease(roomId: string, owner: unknown): Promise<void> {
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
        if (room.retiringEscrow) this.captureEscrowNeighbors(id)
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
    if (owner === folderSyncOwner) {
      this.appReservations.delete(id)
    }
    const leases = this.escrowLeases.get(id)
    leases?.delete(owner)
    if (!leases?.size) this.escrowLeases.delete(id)
    const room = this.rooms.get(id)
    if (!room) return
    room.owners.delete(owner)
    if (!room.owners.size && !room.retiringEscrow) this.escrowPeers.delete(id)
    if (!room.owners.size && !room.pending) {
      if (room.joined) this.mist.leave_room_id(id)
      this.rooms.delete(id)
      this.peers.delete(id)
    }
  }
  releaseOwner(owner: unknown): void {
    this.listeners.delete(owner)
    this.appPeerPurgeListeners.delete(owner)
    if (owner === folderSyncOwner) this.appReservations.clear()
    for (const id of [...this.rooms.keys()]) this.release(id, owner)
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
