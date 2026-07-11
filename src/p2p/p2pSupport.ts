import type { AppSettings } from '../storage/localSettings.js'
import { debugInfo, debugWarn } from '../util/logging.js'
import type { BroadcastSharePayload, MistModule, NetworkState, ShareEnvelope, ShareProfile } from './p2pTypes.js'

export const initialNetworkState: NetworkState = {
  mode: 'idle',
  rooms: [],
  peers: [],
  stablePeers: [],
  peersByRoom: {},
  stablePeersByRoom: {},
  lastEvent: '設定待機中',
  messagesSent: 0,
  messagesReceived: 0,
}

export function p2pLog(message: string, details?: Record<string, unknown>): void {
  debugInfo('p2p', message, details)
}

export function p2pWarn(message: string, details?: Record<string, unknown>): void {
  debugWarn('p2p', message, details)
}

/**
 * `roomId` is the room the envelope should be stamped for and sent to -- the
 * caller picks it (defaulting to `settings.roomId`, the user's own home room)
 * since mistlib now joins every room in `roomIds` simultaneously rather than
 * rotating through them one at a time.
 */
export function createOutgoingShareEnvelope(payload: BroadcastSharePayload, settings: AppSettings, roomId: string): ShareEnvelope {
  return {
    ...payload,
    type: payload.type ?? 'folder-share',
    from: settings.nodeId,
    roomId,
    sentAt: new Date().toISOString(),
    senderProfile: profileFromSettings(settings),
  }
}

/**
 * Queues a `hello` into a single room, throttled per-room (once per `roomId`
 * every 5s, plus the `delay` debounce) so a node joined to several rooms at
 * once sends an independent hello into each room it has stable peers in,
 * instead of one hello for a single "active" room.
 */
export function queueMistHello(options: {
  roomId: string
  broadcast: (envelope: ShareEnvelope) => void
  delay: number
  helloTimersRef: { current: Record<string, number> }
  lastHelloAtRef: { current: Record<string, number> }
  mistRef: { current: MistModule | null }
  settingsRef: { current: AppSettings }
  stablePeersByRoomRef: { current: Record<string, string[]> }
}): void {
  const { roomId } = options
  const now = Date.now()
  if (options.helloTimersRef.current[roomId] !== undefined || now - (options.lastHelloAtRef.current[roomId] ?? 0) < 5000) return
  p2pLog('queued hello', { roomId, delay: options.delay, stablePeerCount: (options.stablePeersByRoomRef.current[roomId] ?? []).length })
  options.helloTimersRef.current[roomId] = window.setTimeout(() => {
    delete options.helloTimersRef.current[roomId]
    const stablePeers = options.stablePeersByRoomRef.current[roomId] ?? []
    if (!options.mistRef.current || stablePeers.length === 0) {
      p2pLog('skipped hello: no stable mist peers', { roomId, hasMist: Boolean(options.mistRef.current), stablePeerCount: stablePeers.length })
      return
    }
    options.lastHelloAtRef.current[roomId] = Date.now()
    options.broadcast({
      type: 'hello',
      from: options.settingsRef.current.nodeId,
      roomId,
      sentAt: new Date().toISOString(),
      clock: 0,
    })
  }, options.delay)
}

function profileFromSettings(settings: AppSettings): ShareProfile {
  return {
    name: settings.profileName.trim() || settings.nodeId,
  }
}
