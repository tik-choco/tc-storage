import type { AppSettings } from './localSettings.js'
import { ensureMistRuntimeInitialized } from './mistStorage.js'
import type { MistModule, MistRoomController } from './p2pTypes.js'

export function configureMistRoom(
  mist: MistRoomController,
  settings: Pick<AppSettings, 'nodeId' | 'roomId'>,
  onEvent: (...events: unknown[]) => void,
): { position: { x: number; y: number; z: number } } {
  mist.register_event_callback(onEvent)
  ensureMistRuntimeInitialized(mist, settings, { force: true, reason: 'p2p' })
  mist.join_room(settings.roomId)
  const position = positionForSharedRoom(settings.roomId, settings.nodeId)
  mist.update_position(position.x, position.y, position.z)
  return { position }
}

export function cleanupMist(mist: MistModule | null, timer: number | undefined): void {
  if (timer !== undefined) window.clearInterval(timer)
  try {
    mist?.leave_room()
  } catch {
    // Ignore teardown races while the page is closing.
  }
}

export function readPeers(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    return peerIdsFromValue(value)
  } catch {
    if (raw.trim()) return raw.split(',').map((item) => item.trim())
  }
  return []
}

export function peerIdsForMistSend(peers: string[], localNodeId: string): string[] {
  const targets = new Set<string>()
  for (const peer of peers) {
    const id = peer.trim()
    if (id && id !== localNodeId) targets.add(id)
  }
  return [...targets]
}

export function sendMistPayloadToPeers(mist: Pick<MistModule, 'send_message'>, payload: Uint8Array, peers: string[], localNodeId: string): { attempted: number; failed: number; failedTargets: string[] } {
  const targets = peerIdsForMistSend(peers, localNodeId)
  const failedTargets: string[] = []
  for (const target of targets) {
    try {
      mist.send_message(target, payload, 0)
    } catch {
      failedTargets.push(target)
    }
  }
  return { attempted: targets.length, failed: failedTargets.length, failedTargets }
}

export function dropFailedMistPeers(peers: string[], failedTargets: string[]): string[] {
  const failed = new Set(failedTargets.map((target) => target.trim()).filter(Boolean))
  return peers.filter((peer) => !failed.has(peer.trim()))
}

export function observeStableMistPeers(
  previousFirstSeenAt: Record<string, number>,
  observedPeers: string[],
  now: number,
  stableAfterMs: number,
): { firstSeenAt: Record<string, number>; stablePeers: string[] } {
  const firstSeenAt: Record<string, number> = {}
  const stablePeers: string[] = []
  for (const peer of peerIdsForMistSend(observedPeers, '')) {
    firstSeenAt[peer] = previousFirstSeenAt[peer] ?? now
    if (now - firstSeenAt[peer] >= stableAfterMs) stablePeers.push(peer)
  }
  return { firstSeenAt, stablePeers }
}

export function positionForSharedRoom(roomId: string, nodeId = ''): { x: number; y: number; z: number } {
  const normalized = roomId.trim() || 'tc-storage-main'
  const node = nodeId.trim()
  return {
    x: coordinateFromHash(hashString(`${normalized}:x`), node ? hashString(`${node}:x`) : undefined),
    y: coordinateFromHash(hashString(`${normalized}:y`), node ? hashString(`${node}:y`) : undefined),
    z: coordinateFromHash(hashString(`${normalized}:z`), node ? hashString(`${node}:z`) : undefined),
  }
}

function samePeerList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const leftSorted = [...left].sort()
  const rightSorted = [...right].sort()
  return leftSorted.every((peer, index) => peer === rightSorted[index])
}

export { samePeerList }

function coordinateFromHash(roomHash: number, nodeHash?: number): number {
  const base = roomHash % 1000
  const offset = nodeHash === undefined ? 0 : ((nodeHash % 2001) - 1000) / 10000
  return Math.min(999.999, Math.max(0, base + offset))
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function peerIdsFromValue(value: unknown, ids = new Set<string>(), depth = 0): string[] {
  if (typeof value === 'string') {
    const id = value.trim()
    if (id) ids.add(id)
    return [...ids]
  }
  if (!value || typeof value !== 'object' || depth > 5) return [...ids]
  if (Array.isArray(value)) {
    for (const item of value) peerIdsFromValue(item, ids, depth + 1)
    return [...ids]
  }

  const record = value as Record<string, unknown>
  for (const key of ['id', 'node_id', 'nodeId', 'peer_id', 'peerId']) {
    if (typeof record[key] === 'string' && record[key].trim()) ids.add(record[key].trim())
  }
  for (const [key, nested] of Object.entries(record)) {
    if (looksLikePeerId(key)) ids.add(key)
    peerIdsFromValue(nested, ids, depth + 1)
  }
  return [...ids]
}

function looksLikePeerId(value: string): boolean {
  return value.startsWith('did:key:') || /^node[-_]/.test(value) || /^peer[-_]/.test(value)
}
