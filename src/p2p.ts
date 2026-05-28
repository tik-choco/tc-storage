import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { isEd25519DidKey } from './didIdentity.js'
import { describeError } from './errors.js'
import type { AppSettings } from './localSettings.js'
import { loadMistModule } from './mistStorage.js'
import { envelopeLogDetails, parseEnvelope, parseMistEvent, shareLabel, shortLogValue, signShareEnvelope, verifyShareEnvelope } from './p2pEnvelope.js'
import { cleanupMist, configureMistRoom, dropFailedMistPeers, observeStableMistPeers, peerIdsForMistSend, readPeers, samePeerList, sendMistPayloadToPeers } from './p2pMist.js'
import { createOutgoingShareEnvelope, initialNetworkState, p2pLog, p2pWarn, queueMistHello } from './p2pSupport.js'
import type { BroadcastSharePayload, MistModule, NetworkState, ShareEnvelope } from './p2pTypes.js'

export type { NetworkState, ShareEnvelope, ShareProfile } from './p2pTypes.js'
export { configureMistRoom, dropFailedMistPeers, observeStableMistPeers, peerIdsForMistSend, positionForSharedRoom, sendMistPayloadToPeers } from './p2pMist.js'
export { signShareEnvelope, verifyShareEnvelope } from './p2pEnvelope.js'

const encoder = new TextEncoder()
const stablePeerDelayMs = 1000
const peerRefreshIntervalMs = 1000

export function useMistShare(settings: AppSettings, onEnvelope: (envelope: ShareEnvelope) => void) {
  const settingsRef = useRef(settings)
  const callbackRef = useRef(onEnvelope)
  const channelRef = useRef<BroadcastChannel | null>(null)
  const mistRef = useRef<MistModule | null>(null)
  const peerTimerRef = useRef<number | undefined>(undefined)
  const reconnectTimerRef = useRef<number | undefined>(undefined)
  const helloTimerRef = useRef<number | undefined>(undefined)
  const connectionSeqRef = useRef(0)
  const peerReadFailuresRef = useRef(0)
  const lastHelloAtRef = useRef(0)
  const peersRef = useRef<string[]>([])
  const peerFirstSeenAtRef = useRef<Record<string, number>>({})
  const stablePeersRef = useRef<string[]>([])
  const [state, setState] = useState<NetworkState>(initialNetworkState)

  function clearMistSession(mist = mistRef.current) {
    cleanupMist(mist, peerTimerRef.current)
    mistRef.current = null
    peerTimerRef.current = undefined
    peersRef.current = []
    stablePeersRef.current = []
    peerFirstSeenAtRef.current = {}
    peerReadFailuresRef.current = 0
  }

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    callbackRef.current = onEnvelope
  }, [onEnvelope])

  const handleEnvelope = useCallback(
    (envelope: ShareEnvelope, source: string) => {
      if (envelope.from === settingsRef.current.nodeId) {
        p2pLog('ignored envelope from self', envelopeLogDetails(envelope, source))
        return
      }
      if (envelope.roomId !== settingsRef.current.roomId) {
        p2pLog('ignored envelope for different room', envelopeLogDetails(envelope, source))
        return
      }
      p2pLog('accepted envelope', envelopeLogDetails(envelope, source))
      setState((current) => ({
        ...current,
        messagesReceived: current.messagesReceived + 1,
        lastSyncAt: envelope.sentAt,
        lastEvent: `${source} から ${shareLabel(envelope.type)} を受信`,
      }))
      callbackRef.current(envelope)
    },
    [],
  )

  const receiveEnvelope = useCallback((envelope: ShareEnvelope, source: string) => {
    p2pLog('verifying envelope signature', envelopeLogDetails(envelope, source))
    void verifyShareEnvelope(envelope).then((verified) => {
      if (!verified) {
        p2pWarn('rejected envelope: signature verification failed', envelopeLogDetails(envelope, source))
        setState((current) => ({ ...current, lastEvent: `${source} のDID署名を検証できませんでした` }))
        return
      }
      handleEnvelope(envelope, source)
    }).catch((error) => {
      p2pWarn('signature verification threw', { ...envelopeLogDetails(envelope, source), error: describeError(error, 'unknown error') })
      setState((current) => ({ ...current, lastEvent: describeError(error, `${source} のDID署名検証に失敗しました`) }))
    })
  }, [handleEnvelope])

  const transmitEnvelope = useCallback((envelope: ShareEnvelope) => {
    let sendError = ''
    p2pLog('broadcast envelope requested', envelopeLogDetails(envelope))
    try {
      channelRef.current?.postMessage(envelope)
      p2pLog('posted envelope to local gossip', envelopeLogDetails(envelope))
    } catch (error) {
      sendError = describeError(error, 'local gossip送信に失敗しました')
      p2pWarn('local gossip post failed', { ...envelopeLogDetails(envelope), error: sendError })
    }
    const mist = mistRef.current
    if (mist) {
      p2pLog('sending envelope to mist peers', {
        ...envelopeLogDetails(envelope),
        stablePeerCount: stablePeersRef.current.length,
        stablePeers: stablePeersRef.current.map(shortLogValue),
      })
      const result = sendMistPayloadToPeers(mist, encoder.encode(JSON.stringify(envelope)), stablePeersRef.current, settingsRef.current.nodeId)
      p2pLog('mist send result', { ...envelopeLogDetails(envelope), ...result, failedTargets: result.failedTargets.map(shortLogValue) })
      if (result.failedTargets.length > 0) {
        peersRef.current = dropFailedMistPeers(peersRef.current, result.failedTargets)
        stablePeersRef.current = dropFailedMistPeers(stablePeersRef.current, result.failedTargets)
        for (const target of result.failedTargets) delete peerFirstSeenAtRef.current[target]
        sendError = `${result.failed}/${result.attempted} peerへのmistlib通知に失敗しました`
      }
    }
    setState((current) => ({
      ...current,
      messagesSent: current.messagesSent + 1,
      lastSyncAt: envelope.sentAt,
      lastEvent: sendError && envelope.type !== 'hello' ? `${shareLabel(envelope.type)}はURLで共有可能（P2P通知は未送信）` : `${shareLabel(envelope.type)}を送信`,
    }))
  }, [])

  const broadcast = useCallback((envelope: ShareEnvelope) => {
    p2pLog('signing envelope before broadcast', envelopeLogDetails(envelope))
    void signShareEnvelope(envelope).then(transmitEnvelope).catch((error) => {
      p2pWarn('failed to sign envelope', { ...envelopeLogDetails(envelope), error: describeError(error, 'unknown error') })
      setState((current) => ({ ...current, lastEvent: describeError(error, `${shareLabel(envelope.type)}のDID署名に失敗しました`) }))
    })
  }, [transmitEnvelope])

  const queueHello = useCallback((delay = 900) => {
    queueMistHello({ broadcast, delay, helloTimerRef, lastHelloAtRef, mistRef, settingsRef, stablePeersRef })
  }, [broadcast])

  const connect = useCallback(async () => {
    const connectionSeq = connectionSeqRef.current + 1
    connectionSeqRef.current = connectionSeq
    p2pLog('connect start', {
      connectionSeq,
      nodeId: shortLogValue(settingsRef.current.nodeId),
      roomId: settingsRef.current.roomId,
    })
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = undefined
    }
    if (helloTimerRef.current !== undefined) {
      window.clearTimeout(helloTimerRef.current)
      helloTimerRef.current = undefined
    }
    clearMistSession()
    const settingsValue = settingsRef.current
    setState((current) => ({ ...current, mode: 'connecting', roomId: settingsValue.roomId, nodeId: settingsValue.nodeId, peers: [], stablePeers: [], lastEvent: 'mistlib 接続中' }))

    const channelName = `tc-storage-${settingsValue.roomId}`
    channelRef.current?.close()
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(channelName) : null
    channelRef.current = channel
    channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
      const envelope = parseEnvelope(event.data)
      if (envelope) receiveEnvelope(envelope, 'local gossip')
    })

    try {
      const mist = await loadMistModule()
      if (connectionSeqRef.current !== connectionSeq) return
      mistRef.current = mist
      p2pLog('mist module loaded; configuring room', { connectionSeq, roomId: settingsValue.roomId, nodeId: shortLogValue(settingsValue.nodeId) })
      configureMistRoom(mist, settingsValue, (...events: unknown[]) => {
        if (connectionSeqRef.current !== connectionSeq || mistRef.current !== mist) return
        const envelope = parseMistEvent(events)
        if (envelope) receiveEnvelope(envelope, 'mistlib')
      })

      const refreshPeers = () => {
        if (connectionSeqRef.current !== connectionSeq || mistRef.current !== mist) return
        try {
          const peers = peerIdsForMistSend(readPeers(mist.get_neighbors()), settingsValue.nodeId)
          const hadPeers = peersRef.current.length > 0
          if (hadPeers && peers.length === 0) {
            p2pWarn('mist peers dropped to zero; keeping room open for peer return')
          }
          const changed = !samePeerList(peersRef.current, peers)
          const previousStablePeers = stablePeersRef.current
          const peerObservation = observeStableMistPeers(peerFirstSeenAtRef.current, peers, Date.now(), stablePeerDelayMs)
          const stableChanged = !samePeerList(previousStablePeers, peerObservation.stablePeers)
          peerFirstSeenAtRef.current = peerObservation.firstSeenAt
          stablePeersRef.current = peerObservation.stablePeers
          peersRef.current = peers
          peerReadFailuresRef.current = 0
          if (changed || stableChanged || (!hadPeers && peers.length > 0)) {
            p2pLog('peer refresh', {
              peers: peers.map(shortLogValue),
              stablePeers: peerObservation.stablePeers.map(shortLogValue),
              rawPeerCount: peers.length,
              stablePeerCount: peerObservation.stablePeers.length,
            })
          }
          setState((current) => ({
            ...current,
            mode: 'mistlib',
            roomId: settingsValue.roomId,
            nodeId: settingsValue.nodeId,
            peers,
            stablePeers: peerObservation.stablePeers,
            lastEvent: peers.length > 0 ? 'mistlib 共有ルーム接続中' : 'mistlib 共有ルーム待機中',
          }))
          if (peerObservation.stablePeers.length > 0 && (!hadPeers || changed || stableChanged)) queueHello()
        } catch (error) {
          peerReadFailuresRef.current += 1
          p2pWarn('peer refresh failed', { failures: peerReadFailuresRef.current, error: describeError(error, 'unknown error') })
          if (peerReadFailuresRef.current < 3) {
            setState((current) => ({
              ...current,
              mode: 'mistlib',
              roomId: settingsValue.roomId,
              nodeId: settingsValue.nodeId,
              lastEvent: `mistlib peer確認中: ${describeError(error, 'unknown error')}`,
            }))
            return
          }
          clearMistSession(mist)
          p2pWarn('mist cleanup after repeated peer refresh failures')
          setState((current) => ({
            ...current,
            mode: channel ? 'local-gossip' : 'offline',
            roomId: settingsValue.roomId,
            nodeId: settingsValue.nodeId,
            peers: [],
            stablePeers: [],
            lastEvent: `mistlib再接続待機中: ${describeError(error, 'unknown error')}`,
          }))
        }
      }
      refreshPeers()
      peerTimerRef.current = window.setInterval(refreshPeers, peerRefreshIntervalMs)
    } catch (error) {
      if (connectionSeqRef.current !== connectionSeq) return
      p2pWarn('connect failed', { connectionSeq, error: describeError(error, 'unknown error') })
      setState((current) => ({
        ...current,
        mode: channel ? 'local-gossip' : 'offline',
        roomId: settingsValue.roomId,
        nodeId: settingsValue.nodeId,
        peers: [],
        stablePeers: [],
        lastEvent: `mistlib未接続: ${describeError(error, 'unknown error')}`,
      }))
    }
  }, [queueHello, receiveEnvelope])

  const disconnect = useCallback(() => {
    p2pLog('disconnect requested', { nodeId: shortLogValue(settingsRef.current.nodeId), roomId: settingsRef.current.roomId })
    connectionSeqRef.current += 1
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = undefined
    }
    if (helloTimerRef.current !== undefined) {
      window.clearTimeout(helloTimerRef.current)
      helloTimerRef.current = undefined
    }
    clearMistSession()
    channelRef.current?.close()
    channelRef.current = null
    setState((current) => ({ ...current, mode: 'idle', roomId: undefined, nodeId: undefined, peers: [], stablePeers: [], lastEvent: '切断しました' }))
  }, [])

  useEffect(() => {
    if (settings.autoConnect && isEd25519DidKey(settings.nodeId)) {
      void connect()
    } else if (settings.autoConnect) {
      setState((current) => ({ ...current, mode: 'idle', roomId: undefined, nodeId: undefined, peers: [], stablePeers: [], lastEvent: 'DID生成待ち' }))
    }
    return () => disconnect()
  }, [connect, disconnect, settings.autoConnect, settings.nodeId, settings.roomId])

  useEffect(() => {
    if (!settings.autoConnect || (state.mode !== 'offline' && state.mode !== 'local-gossip')) return
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = undefined
      void connect()
    }, 5000)
    return () => {
      if (reconnectTimerRef.current !== undefined) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = undefined
      }
    }
  }, [connect, settings.autoConnect, state.mode])

  return {
    state,
    connect,
    disconnect,
    broadcastShare: (envelope: BroadcastSharePayload) => {
      p2pLog('broadcastShare called', {
        type: envelope.type ?? 'folder-share',
        folderId: envelope.folderId,
        fileId: envelope.fileId,
        cid: shortLogValue(envelope.cid),
      })
      broadcast(createOutgoingShareEnvelope(envelope, settingsRef.current))
    },
  }
}
