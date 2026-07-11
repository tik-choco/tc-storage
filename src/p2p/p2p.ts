import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { isEd25519DidKey } from '../crypto/didIdentity.js'
import { describeError } from '../util/errors.js'
import type { AppSettings } from '../storage/localSettings.js'
import { loadMistModule } from '../storage/mistStorage.js'
import { envelopeLogDetails, parseEnvelope, parseMistEvent, shareLabel, shortLogValue, signShareEnvelope, verifyShareEnvelope } from './p2pEnvelope.js'
import { cleanupMist, configureMistRoom, dropFailedMistPeers, joinMistRoom, leaveMistRoomId, observeStableMistPeers, peerIdFromMistConnectionTimeout, peerIdsForMistSend, readPeers, samePeerList, sendMistPayloadToPeers, shouldCleanupMistOnPageHide } from './p2pMist.js'
import { createOutgoingShareEnvelope, initialNetworkState, p2pLog, p2pWarn, queueMistHello } from './p2pSupport.js'
import type { BroadcastSharePayload, MistModule, NetworkState, ShareEnvelope } from './p2pTypes.js'

export type { NetworkState, ShareEnvelope, ShareProfile } from './p2pTypes.js'
export { configureMistRoom, dropFailedMistPeers, joinMistRoom, leaveMistRoomId, observeStableMistPeers, peerIdFromMistConnectionTimeout, peerIdsForMistSend, positionForSharedRoom, sendMistPayloadToPeers } from './p2pMist.js'
export { signShareEnvelope, verifyShareEnvelope } from './p2pEnvelope.js'

const encoder = new TextEncoder()
const stablePeerDelayMs = 1000
const peerRefreshIntervalMs = 1000

function unionPeerLists(byRoom: Record<string, string[]>): string[] {
  const ids = new Set<string>()
  for (const peers of Object.values(byRoom)) for (const peer of peers) ids.add(peer)
  return [...ids]
}

export function useMistShare(settings: AppSettings, roomIds: string[], onEnvelope: (envelope: ShareEnvelope) => void) {
  const settingsRef = useRef(settings)
  const callbackRef = useRef(onEnvelope)
  const channelsRef = useRef<Record<string, BroadcastChannel>>({})
  const mistRef = useRef<MistModule | null>(null)
  const peerTimerRef = useRef<number | undefined>(undefined)
  const reconnectTimerRef = useRef<number | undefined>(undefined)
  const helloTimersRef = useRef<Record<string, number>>({})
  const connectionSeqRef = useRef(0)
  const peerReadFailuresRef = useRef(0)
  const lastHelloAtRef = useRef<Record<string, number>>({})
  const peersByRoomRef = useRef<Record<string, string[]>>({})
  const peerFirstSeenAtByRoomRef = useRef<Record<string, Record<string, number>>>({})
  const stablePeersByRoomRef = useRef<Record<string, string[]>>({})
  const joinedRoomsRef = useRef<Set<string>>(new Set())
  const initialRoomIds = roomIds.length > 0 ? roomIds : [settings.roomId]
  const roomIdsRef = useRef<string[]>(initialRoomIds)
  const [state, setState] = useState<NetworkState>(initialNetworkState)

  function openChannelForRoom(roomId: string) {
    if (channelsRef.current[roomId]) return
    if (!('BroadcastChannel' in window)) return
    const channel = new BroadcastChannel(`tc-storage-${roomId}`)
    channel.addEventListener('message', (event: MessageEvent<unknown>) => {
      const envelope = parseEnvelope(event.data)
      if (envelope) receiveEnvelope(envelope, 'local gossip')
    })
    channelsRef.current[roomId] = channel
  }

  function closeChannelForRoom(roomId: string) {
    channelsRef.current[roomId]?.close()
    delete channelsRef.current[roomId]
  }

  function closeAllChannels() {
    for (const roomId of Object.keys(channelsRef.current)) closeChannelForRoom(roomId)
  }

  function clearHelloTimer(roomId: string) {
    const timer = helloTimersRef.current[roomId]
    if (timer !== undefined) {
      window.clearTimeout(timer)
      delete helloTimersRef.current[roomId]
    }
  }

  function clearAllHelloTimers() {
    for (const roomId of Object.keys(helloTimersRef.current)) clearHelloTimer(roomId)
  }

  function clearMistSession(mist = mistRef.current) {
    cleanupMist(mist, peerTimerRef.current)
    mistRef.current = null
    peerTimerRef.current = undefined
    joinedRoomsRef.current = new Set()
    peersByRoomRef.current = {}
    stablePeersByRoomRef.current = {}
    peerFirstSeenAtByRoomRef.current = {}
    peerReadFailuresRef.current = 0
  }

  /** Publishes the current per-room refs into React state as the union `peers`/`stablePeers` plus the per-room breakdowns. */
  function publishPeerState(extra: Partial<NetworkState> = {}) {
    const peersByRoom = { ...peersByRoomRef.current }
    const stablePeersByRoom = { ...stablePeersByRoomRef.current }
    setState((current) => ({
      ...current,
      rooms: [...roomIdsRef.current],
      peers: unionPeerLists(peersByRoom),
      stablePeers: unionPeerLists(stablePeersByRoom),
      peersByRoom,
      stablePeersByRoom,
      ...extra,
    }))
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
      if (!roomIdsRef.current.includes(envelope.roomId)) {
        p2pLog('ignored envelope for unjoined room', envelopeLogDetails(envelope, source))
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

  /** Drops `failedTargets` from `roomId`'s peer bookkeeping only -- a send failure in one room says nothing about a peer's reachability in another joined room. */
  function dropPeersFromRoom(roomId: string, failedTargets: string[]) {
    peersByRoomRef.current[roomId] = dropFailedMistPeers(peersByRoomRef.current[roomId] ?? [], failedTargets)
    stablePeersByRoomRef.current[roomId] = dropFailedMistPeers(stablePeersByRoomRef.current[roomId] ?? [], failedTargets)
    const firstSeenAt = { ...(peerFirstSeenAtByRoomRef.current[roomId] ?? {}) }
    for (const target of failedTargets) delete firstSeenAt[target]
    peerFirstSeenAtByRoomRef.current[roomId] = firstSeenAt
  }

  /** Drops a peer from every joined room's bookkeeping -- used for mist-level events (e.g. connection timeout) that aren't scoped to a single room. */
  function dropPeerFromAllRooms(peerId: string) {
    for (const roomId of Object.keys(peersByRoomRef.current)) dropPeersFromRoom(roomId, [peerId])
  }

  const transmitEnvelope = useCallback((envelope: ShareEnvelope) => {
    let sendError = ''
    p2pLog('broadcast envelope requested', envelopeLogDetails(envelope))
    try {
      channelsRef.current[envelope.roomId]?.postMessage(envelope)
      p2pLog('posted envelope to local gossip', envelopeLogDetails(envelope))
    } catch (error) {
      sendError = describeError(error, 'local gossip送信に失敗しました')
      p2pWarn('local gossip post failed', { ...envelopeLogDetails(envelope), error: sendError })
    }
    const mist = mistRef.current
    if (mist && joinedRoomsRef.current.has(envelope.roomId)) {
      const roomStablePeers = stablePeersByRoomRef.current[envelope.roomId] ?? []
      p2pLog('sending envelope to mist peers', {
        ...envelopeLogDetails(envelope),
        stablePeerCount: roomStablePeers.length,
        stablePeers: roomStablePeers.map(shortLogValue),
      })
      const result = sendMistPayloadToPeers(mist, encoder.encode(JSON.stringify(envelope)), roomStablePeers, settingsRef.current.nodeId, envelope.roomId)
      p2pLog('mist send result', { ...envelopeLogDetails(envelope), ...result, failedTargets: result.failedTargets.map(shortLogValue) })
      if (result.failedTargets.length > 0) {
        dropPeersFromRoom(envelope.roomId, result.failedTargets)
        publishPeerState()
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

  const queueHelloForRoom = useCallback((roomId: string) => {
    queueMistHello({ roomId, broadcast, delay: 900, helloTimersRef, lastHelloAtRef, mistRef, settingsRef, stablePeersByRoomRef })
  }, [broadcast])

  const connect = useCallback(async () => {
    const connectionSeq = connectionSeqRef.current + 1
    connectionSeqRef.current = connectionSeq
    const settingsValue = settingsRef.current
    const homeRoomId = settingsValue.roomId
    const rooms = roomIdsRef.current.length > 0 ? roomIdsRef.current : [homeRoomId]
    roomIdsRef.current = rooms
    p2pLog('connect start', {
      connectionSeq,
      nodeId: shortLogValue(settingsValue.nodeId),
      rooms,
    })
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = undefined
    }
    clearAllHelloTimers()
    clearMistSession()
    closeAllChannels()
    setState((current) => ({
      ...current,
      mode: 'connecting',
      roomId: homeRoomId,
      rooms,
      nodeId: settingsValue.nodeId,
      peers: [],
      stablePeers: [],
      peersByRoom: {},
      stablePeersByRoom: {},
      lastEvent: 'mistlib 接続中',
    }))

    for (const roomId of rooms) openChannelForRoom(roomId)
    const anyChannelOpen = Object.keys(channelsRef.current).length > 0

    try {
      const mist = await loadMistModule()
      if (connectionSeqRef.current !== connectionSeq) return
      mistRef.current = mist
      p2pLog('mist module loaded; configuring runtime', { connectionSeq, rooms, nodeId: shortLogValue(settingsValue.nodeId) })
      configureMistRoom(mist, { nodeId: settingsValue.nodeId }, (...events: unknown[]) => {
        if (connectionSeqRef.current !== connectionSeq || mistRef.current !== mist) return
        const timedOutPeer = peerIdFromMistConnectionTimeout(events)
        if (timedOutPeer) {
          p2pWarn('mist peer connection timeout', { peerId: shortLogValue(timedOutPeer) })
          dropPeerFromAllRooms(timedOutPeer)
          publishPeerState({ lastEvent: 'mistlib peer timeout; 再接続待機中' })
          return
        }
        const envelope = parseMistEvent(events)
        if (envelope) receiveEnvelope(envelope, 'mistlib')
      })

      const joinOutcomes = await Promise.allSettled(rooms.map((roomId) => joinMistRoom(mist, roomId, settingsValue.nodeId)))
      if (connectionSeqRef.current !== connectionSeq || mistRef.current !== mist) return
      rooms.forEach((roomId, index) => {
        const outcome = joinOutcomes[index]
        if (outcome.status === 'fulfilled') {
          joinedRoomsRef.current.add(roomId)
          peersByRoomRef.current[roomId] = []
          stablePeersByRoomRef.current[roomId] = []
          peerFirstSeenAtByRoomRef.current[roomId] = {}
        } else {
          p2pWarn('failed to join room', { roomId, error: describeError(outcome.reason, 'unknown error') })
        }
      })
      p2pLog('joined rooms', { connectionSeq, joinedRooms: [...joinedRoomsRef.current] })

      const refreshPeers = () => {
        if (connectionSeqRef.current !== connectionSeq || mistRef.current !== mist) return
        const now = Date.now()
        let anySuccess = false
        let anyChanged = false
        for (const roomId of joinedRoomsRef.current) {
          try {
            const peers = peerIdsForMistSend(readPeers(mist.get_neighbors_in_room(roomId)), settingsValue.nodeId)
            anySuccess = true
            const previousPeers = peersByRoomRef.current[roomId] ?? []
            const hadPeers = previousPeers.length > 0
            const changed = !samePeerList(previousPeers, peers)
            const previousStablePeers = stablePeersByRoomRef.current[roomId] ?? []
            const peerObservation = observeStableMistPeers(peerFirstSeenAtByRoomRef.current[roomId] ?? {}, peers, now, stablePeerDelayMs)
            const stableChanged = !samePeerList(previousStablePeers, peerObservation.stablePeers)
            peerFirstSeenAtByRoomRef.current[roomId] = peerObservation.firstSeenAt
            stablePeersByRoomRef.current[roomId] = peerObservation.stablePeers
            peersByRoomRef.current[roomId] = peers
            if (changed || stableChanged) anyChanged = true
            if (hadPeers && peers.length === 0) {
              p2pWarn('mist peers dropped to zero in room; keeping room open for peer return', { roomId })
            }
            if (changed || stableChanged || (!hadPeers && peers.length > 0)) {
              p2pLog('peer refresh', {
                roomId,
                peers: peers.map(shortLogValue),
                stablePeers: peerObservation.stablePeers.map(shortLogValue),
                rawPeerCount: peers.length,
                stablePeerCount: peerObservation.stablePeers.length,
              })
            }
            if (peerObservation.stablePeers.length > 0 && (!hadPeers || changed || stableChanged)) queueHelloForRoom(roomId)
          } catch (error) {
            p2pWarn('peer refresh failed for room', { roomId, error: describeError(error, 'unknown error') })
          }
        }
        if (!anySuccess && joinedRoomsRef.current.size > 0) {
          peerReadFailuresRef.current += 1
          p2pWarn('peer refresh failed for all rooms', { failures: peerReadFailuresRef.current })
          if (peerReadFailuresRef.current < 3) {
            publishPeerState({ mode: 'mistlib', roomId: homeRoomId, nodeId: settingsValue.nodeId, lastEvent: 'mistlib peer確認中' })
            return
          }
          clearMistSession(mist)
          p2pWarn('mist cleanup after repeated peer refresh failures')
          setState((current) => ({
            ...current,
            mode: anyChannelOpen ? 'local-gossip' : 'offline',
            roomId: homeRoomId,
            rooms,
            nodeId: settingsValue.nodeId,
            peers: [],
            stablePeers: [],
            peersByRoom: {},
            stablePeersByRoom: {},
            lastEvent: 'mistlib再接続待機中',
          }))
          return
        }
        peerReadFailuresRef.current = 0
        publishPeerState({
          mode: 'mistlib',
          roomId: homeRoomId,
          nodeId: settingsValue.nodeId,
          lastEvent: unionPeerLists(peersByRoomRef.current).length > 0 ? 'mistlib 共有ルーム接続中' : 'mistlib 共有ルーム待機中',
        })
        if (anyChanged) p2pLog('peer refresh summary', { joinedRooms: [...joinedRoomsRef.current], peerCount: unionPeerLists(peersByRoomRef.current).length })
      }
      refreshPeers()
      peerTimerRef.current = window.setInterval(refreshPeers, peerRefreshIntervalMs)
    } catch (error) {
      if (connectionSeqRef.current !== connectionSeq) return
      p2pWarn('connect failed', { connectionSeq, error: describeError(error, 'unknown error') })
      setState((current) => ({
        ...current,
        mode: anyChannelOpen ? 'local-gossip' : 'offline',
        roomId: homeRoomId,
        rooms,
        nodeId: settingsValue.nodeId,
        peers: [],
        stablePeers: [],
        peersByRoom: {},
        stablePeersByRoom: {},
        lastEvent: `mistlib未接続: ${describeError(error, 'unknown error')}`,
      }))
    }
  }, [queueHelloForRoom, receiveEnvelope])

  const disconnect = useCallback(() => {
    p2pLog('disconnect requested', { nodeId: shortLogValue(settingsRef.current.nodeId), rooms: roomIdsRef.current })
    connectionSeqRef.current += 1
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = undefined
    }
    clearAllHelloTimers()
    clearMistSession()
    closeAllChannels()
    setState((current) => ({
      ...current,
      mode: 'idle',
      roomId: undefined,
      rooms: [],
      nodeId: undefined,
      peers: [],
      stablePeers: [],
      peersByRoom: {},
      stablePeersByRoom: {},
      lastEvent: '切断しました',
    }))
  }, [])

  /** Joins each newly-added room (concurrently safe with rooms already joined) once mistlib is connected; a no-op while still connecting or offline since `connect()` itself joins every room in `roomIdsRef.current`. */
  const applyRoomAdditions = useCallback(async (added: string[]) => {
    const connectionSeq = connectionSeqRef.current
    const mist = mistRef.current
    for (const roomId of added) openChannelForRoom(roomId)
    if (!mist) return
    const settingsValue = settingsRef.current
    const outcomes = await Promise.allSettled(added.map((roomId) => joinMistRoom(mist, roomId, settingsValue.nodeId)))
    if (connectionSeqRef.current !== connectionSeq || mistRef.current !== mist) return
    added.forEach((roomId, index) => {
      const outcome = outcomes[index]
      if (outcome.status === 'fulfilled') {
        joinedRoomsRef.current.add(roomId)
        peersByRoomRef.current[roomId] = []
        stablePeersByRoomRef.current[roomId] = []
        peerFirstSeenAtByRoomRef.current[roomId] = {}
        p2pLog('joined additional room', { roomId })
      } else {
        p2pWarn('failed to join additional room', { roomId, error: describeError(outcome.reason, 'unknown error') })
      }
    })
    publishPeerState()
  }, [])

  /** Leaves each removed room's mist session (if joined) and drops its local bookkeeping/channel/hello timer, without disturbing any other joined room. */
  const applyRoomRemovals = useCallback((removed: string[]) => {
    const mist = mistRef.current
    for (const roomId of removed) {
      if (mist && joinedRoomsRef.current.has(roomId)) leaveMistRoomId(mist, roomId)
      joinedRoomsRef.current.delete(roomId)
      delete peersByRoomRef.current[roomId]
      delete stablePeersByRoomRef.current[roomId]
      delete peerFirstSeenAtByRoomRef.current[roomId]
      delete lastHelloAtRef.current[roomId]
      clearHelloTimer(roomId)
      closeChannelForRoom(roomId)
    }
    publishPeerState()
  }, [])

  useEffect(() => {
    const handlePageHide = (event: PageTransitionEvent) => {
      if (!shouldCleanupMistOnPageHide(event)) return
      p2pLog('page hidden permanently; disconnecting mist session')
      disconnect()
    }
    window.addEventListener('pagehide', handlePageHide)
    return () => window.removeEventListener('pagehide', handlePageHide)
  }, [disconnect])

  useEffect(() => {
    // An explicit home-room change (edited and saved in Settings) always takes priority: sync
    // roomIdsRef synchronously so `connect()` below (and the "joined room set changed" effect
    // that runs right after, in the same commit) both see the up-to-date room list instead of a
    // stale one from before the home room changed.
    roomIdsRef.current = roomIds.length > 0 ? roomIds : [settings.roomId]
    if (settings.autoConnect && isEd25519DidKey(settings.nodeId)) {
      void connect()
    } else if (settings.autoConnect) {
      setState((current) => ({
        ...current,
        mode: 'idle',
        roomId: undefined,
        rooms: [],
        nodeId: undefined,
        peers: [],
        stablePeers: [],
        peersByRoom: {},
        stablePeersByRoom: {},
        lastEvent: 'DID生成待ち',
      }))
    }
    return () => disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roomIds intentionally excluded: this effect only needs the latest value when settings.roomId/nodeId/autoConnect force a full reconnect, not on every joined-room change (the effect below handles those incrementally)
  }, [connect, disconnect, settings.autoConnect, settings.nodeId, settings.roomId])

  useEffect(() => {
    const nextRoomIds = roomIds.length > 0 ? roomIds : [settings.roomId]
    const previousRoomIds = roomIdsRef.current
    roomIdsRef.current = nextRoomIds
    const added = nextRoomIds.filter((roomId) => !previousRoomIds.includes(roomId))
    const removed = previousRoomIds.filter((roomId) => !nextRoomIds.includes(roomId))
    if (added.length === 0 && removed.length === 0) return
    p2pLog('joined room set changed', { added, removed, rooms: nextRoomIds })
    if (removed.length > 0) applyRoomRemovals(removed)
    if (added.length > 0) void applyRoomAdditions(added)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roomIds compared by content via roomIdsKey
  }, [roomIds.join(','), settings.roomId, applyRoomAdditions, applyRoomRemovals])

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
    broadcastShare: (payload: BroadcastSharePayload, roomId?: string) => {
      const targetRoomId = roomId ?? settingsRef.current.roomId
      p2pLog('broadcastShare called', {
        type: payload.type ?? 'folder-share',
        folderId: payload.folderId,
        fileId: payload.fileId,
        cid: shortLogValue(payload.cid),
        roomId: targetRoomId,
      })
      broadcast(createOutgoingShareEnvelope(payload, settingsRef.current, targetRoomId))
    },
  }
}
