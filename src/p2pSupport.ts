import type { AppSettings } from './localSettings.js'
import { debugInfo, debugWarn } from './logging.js'
import type { BroadcastSharePayload, MistModule, NetworkState, ShareEnvelope, ShareProfile } from './p2pTypes.js'

export const initialNetworkState: NetworkState = {
  mode: 'idle',
  peers: [],
  stablePeers: [],
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

export function createOutgoingShareEnvelope(payload: BroadcastSharePayload, settings: AppSettings): ShareEnvelope {
  return {
    ...payload,
    type: payload.type ?? 'folder-share',
    from: settings.nodeId,
    roomId: settings.roomId,
    sentAt: new Date().toISOString(),
    senderProfile: profileFromSettings(settings),
  }
}

export function queueMistHello(options: {
  broadcast: (envelope: ShareEnvelope) => void
  delay: number
  helloTimerRef: { current: number | undefined }
  lastHelloAtRef: { current: number }
  mistRef: { current: MistModule | null }
  settingsRef: { current: AppSettings }
  stablePeersRef: { current: string[] }
}): void {
  const now = Date.now()
  if (options.helloTimerRef.current !== undefined || now - options.lastHelloAtRef.current < 5000) return
  p2pLog('queued hello', { delay: options.delay, stablePeerCount: options.stablePeersRef.current.length })
  options.helloTimerRef.current = window.setTimeout(() => {
    options.helloTimerRef.current = undefined
    if (!options.mistRef.current || options.stablePeersRef.current.length === 0) {
      p2pLog('skipped hello: no stable mist peers', { hasMist: Boolean(options.mistRef.current), stablePeerCount: options.stablePeersRef.current.length })
      return
    }
    options.lastHelloAtRef.current = Date.now()
    options.broadcast({
      type: 'hello',
      from: options.settingsRef.current.nodeId,
      roomId: options.settingsRef.current.roomId,
      sentAt: new Date().toISOString(),
      clock: 0,
    })
  }, options.delay)
}

function profileFromSettings(settings: AppSettings): ShareProfile {
  return {
    name: settings.profileName.trim() || settings.nodeId,
    avatarUrl: settings.avatarUrl.trim() || undefined,
  }
}
