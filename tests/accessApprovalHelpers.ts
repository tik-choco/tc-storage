import { webcrypto } from 'node:crypto'
import type { StateUpdater } from 'preact/hooks'
import { didKeyFromEd25519PublicKey } from '../src/crypto/didIdentity.js'
import { folderKeyHash } from '../src/crypto/folderKeyProof.js'
import type { NetworkState } from '../src/p2p/p2p.js'

if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto })
}

export const ownerDid = didFromSeed(1)
export const requesterDid = didFromSeed(2)
export const attackerDid = didFromSeed(3)
export const otherDid = didFromSeed(4)
export const fixedFolderId = 'folder-fixed'
export const folderSecret = 'folder-secret'
export const expectedFolderKeyHash = folderKeyHash(fixedFolderId, folderSecret)

export function applyStateUpdate<T>(current: T, update: StateUpdater<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update
}

// `requestRoom` is gone: the engine now joins every room in `rooms` at once (see p2p.ts), so
// there is no "priority room switch" to request -- callers just broadcast to whichever room the
// payload targets and presence is already guaranteed as long as that room is in `rooms`.
export function networkStub(broadcasts: unknown[] = [], roomId = 'tc-storage-main') {
  const state: NetworkState = {
    mode: 'mistlib',
    roomId,
    rooms: [roomId],
    peers: [],
    stablePeers: [],
    peersByRoom: {},
    stablePeersByRoom: {},
    lastEvent: '',
    messagesSent: 0,
    messagesReceived: 0,
  }
  return {
    state,
    connect: async () => {},
    disconnect: () => {},
    // Records the payload only, for callers that don't care which room it targeted. Use
    // `networkStubWithRoomTargets` below when a test needs to assert the target room too.
    broadcastShare: (payload: unknown, _roomId?: string) => broadcasts.push(payload),
  }
}

/** Like `networkStub`, but records `{ payload, roomId }` tuples so tests can assert which room
 * each broadcast was targeted at -- needed now that a single connection can announce to several
 * rooms at once (no more single "connected room" to infer the target from). */
export function networkStubWithRoomTargets(sent: { payload: unknown; roomId?: string }[] = [], rooms: string[] = ['tc-storage-main']) {
  const state: NetworkState = {
    mode: 'mistlib',
    roomId: rooms[0],
    rooms,
    peers: [],
    stablePeers: [],
    peersByRoom: {},
    stablePeersByRoom: {},
    lastEvent: '',
    messagesSent: 0,
    messagesReceived: 0,
  }
  return {
    state,
    connect: async () => {},
    disconnect: () => {},
    broadcastShare: (payload: unknown, roomId?: string) => { sent.push({ payload, roomId }) },
  }
}

export function settingsStub(nodeId: string) {
  return {
    roomId: 'tc-storage-main',
    nodeId,
    identity: null,
    autoConnect: false,
    profileName: 'Test user',
    avatarUrl: '',
    avatarFileId: '',
  }
}

function didFromSeed(seed: number): string {
  const bytes = new Uint8Array(32)
  bytes.fill(seed)
  return didKeyFromEd25519PublicKey(bytes)
}
