import { webcrypto } from 'node:crypto'
import type { StateUpdater } from 'preact/hooks'
import { didKeyFromEd25519PublicKey } from '../src/didIdentity.js'
import { folderKeyHash } from '../src/folderKeyProof.js'
import type { NetworkState } from '../src/p2p.js'

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

export function networkStub(broadcasts: unknown[] = []) {
  const state: NetworkState = {
    mode: 'mistlib',
    peers: [],
    stablePeers: [],
    lastEvent: '',
    messagesSent: 0,
    messagesReceived: 0,
  }
  return { state, connect: async () => {}, disconnect: () => {}, broadcastShare: (payload: unknown) => broadcasts.push(payload) }
}

export function settingsStub(nodeId: string) {
  return {
    roomId: 'tc-storage-main',
    signalingUrl: 'https://rtc.example.test/signaling',
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
