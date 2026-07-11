import { defaultRoomIdValue, type AppSettings } from '../storage/localSettings.js'
import { ensureMistRuntimeInitialized } from '../storage/mistStorage.js'
import type { MistModule } from './p2pTypes.js'
export type { MistRoomController } from './p2pTypes.js'

/** One-time-per-session runtime setup: registers the event callback and initializes mistlib for `settings.nodeId`. Room membership is handled separately by `joinMistRoom`/`leaveMistRoomId` -- this vendored mistlib build supports joining several rooms concurrently, so there's no single "the room" to join here. */
export function configureMistRoom(
  mist: Pick<MistModule, 'init_with_config' | 'register_event_callback'>,
  settings: Pick<AppSettings, 'nodeId'>,
  onEvent: (...events: unknown[]) => void,
): void {
  mist.register_event_callback(onEvent)
  ensureMistRuntimeInitialized(mist, settings, { force: true, reason: 'p2p' })
}

/** Joins a single room (concurrently safe with other joined rooms) and places this node at its room-derived position. Awaits `join_room_async` so the session is actually usable before we start reading its neighbors. */
export async function joinMistRoom(
  mist: Pick<MistModule, 'join_room_async' | 'update_position_in_room'>,
  roomId: string,
  nodeId: string,
): Promise<{ position: { x: number; y: number; z: number } }> {
  await mist.join_room_async(roomId)
  const position = positionForSharedRoom(roomId, nodeId)
  mist.update_position_in_room(roomId, position.x, position.y, position.z)
  return { position }
}

/** Leaves a single joined room without tearing down any other joined sessions. */
export function leaveMistRoomId(mist: Pick<MistModule, 'leave_room_id'>, roomId: string): void {
  try {
    mist.leave_room_id(roomId)
  } catch {
    // Ignore teardown races (e.g. the room was already left).
  }
}

export function cleanupMist(mist: MistModule | null, timer: number | undefined): void {
  if (timer !== undefined) window.clearInterval(timer)
  try {
    mist?.leave_room()
  } catch {
    // Ignore teardown races while the page is closing.
  }
}

export function shouldCleanupMistOnPageHide(event: Pick<PageTransitionEvent, 'persisted'>): boolean {
  return !event.persisted
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

/** Sends `payload` to each of `peers`. When `roomId` is given, routes through `send_message_in_room` so delivery is scoped to that room's session (the correct choice once a node may be joined to several rooms at once); otherwise falls back to the un-scoped `send_message`. */
export function sendMistPayloadToPeers(
  mist: Pick<MistModule, 'send_message' | 'send_message_in_room'>,
  payload: Uint8Array,
  peers: string[],
  localNodeId: string,
  roomId?: string,
): { attempted: number; failed: number; failedTargets: string[] } {
  const targets = peerIdsForMistSend(peers, localNodeId)
  const failedTargets: string[] = []
  for (const target of targets) {
    try {
      if (roomId) mist.send_message_in_room(roomId, target, payload, 0)
      else mist.send_message(target, payload, 0)
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

export function peerIdFromMistConnectionTimeout(events: unknown[]): string | undefined {
  for (const text of stringsFromMistEvents(events)) {
    const match = /Connection timeout to\s+([^\s.]+)/.exec(text)
    const peerId = match?.[1]?.trim()
    if (peerId) return peerId
  }
  return undefined
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
  const normalized = roomId.trim() || defaultRoomIdValue
  const node = nodeId.trim()
  return {
    x: coordinateFromHash(hashString(`${normalized}:x`), node ? hashString(`${node}:x`) : undefined),
    y: coordinateFromHash(hashString(`${normalized}:y`), node ? hashString(`${node}:y`) : undefined),
    z: coordinateFromHash(hashString(`${normalized}:z`), node ? hashString(`${node}:z`) : undefined),
  }
}

function stringsFromMistEvents(values: unknown[], seen = new Set<unknown>()): string[] {
  const strings: string[] = []
  for (const value of values) {
    if (typeof value === 'string') {
      strings.push(value)
      continue
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue
    seen.add(value)
    const record = value as Record<string, unknown>
    for (const key of ['message', 'error', 'reason', 'detail', 'data', 'payload']) {
      strings.push(...stringsFromMistEvents([record[key]], seen))
    }
  }
  return strings
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
