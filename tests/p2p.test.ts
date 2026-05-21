import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configureMistRoom, dropFailedMistPeers, observeStableMistPeers, peerIdsForMistSend, positionForSharedRoom, sendMistPayloadToPeers } from '../src/p2p.js'
import { parseEnvelope } from '../src/p2pEnvelope.js'

test('positionForSharedRoom keeps the same room at the same base coordinates', () => {
  assert.deepEqual(positionForSharedRoom('tc-storage-main'), positionForSharedRoom('tc-storage-main'))
  assert.deepEqual(positionForSharedRoom(' tc-storage-main '), positionForSharedRoom('tc-storage-main'))
})

test('positionForSharedRoom keeps different nodes in the same room nearby', () => {
  const left = positionForSharedRoom('tc-storage-main', 'node-a')
  const right = positionForSharedRoom('tc-storage-main', 'node-b')

  assert.notDeepEqual(left, right)
  assert.ok(Math.abs(left.x - right.x) < 0.25)
  assert.ok(Math.abs(left.y - right.y) < 0.25)
  assert.ok(Math.abs(left.z - right.z) < 0.25)
})

test('positionForSharedRoom returns bounded Mist coordinates', () => {
  const position = positionForSharedRoom('tc-storage-main', 'node-a')
  for (const coordinate of [position.x, position.y, position.z]) {
    assert.ok(coordinate >= 0)
    assert.ok(coordinate < 1000)
  }
})

test('peerIdsForMistSend drops empty, duplicate, and local peer ids', () => {
  assert.deepEqual(peerIdsForMistSend(['node-a', '', ' node-b ', 'node-a', 'node-local'], 'node-local'), ['node-a', 'node-b'])
})

test('peerIdsForMistSend does not create an empty broadcast target', () => {
  assert.deepEqual(peerIdsForMistSend([], 'node-local'), [])
  assert.deepEqual(peerIdsForMistSend(['', 'node-local'], 'node-local'), [])
})

test('sendMistPayloadToPeers does not call mistlib with an empty target when no peers are connected', () => {
  const calls: string[] = []
  const result = sendMistPayloadToPeers(
    {
      send_message(target) {
        calls.push(target)
      },
    },
    new Uint8Array([1, 2, 3]),
    [],
    'node-local',
  )

  assert.deepEqual(calls, [])
  assert.deepEqual(result, { attempted: 0, failed: 0, failedTargets: [] })
})

test('sendMistPayloadToPeers reports stale disconnected peers without blocking healthy peers', () => {
  const calls: string[] = []
  const result = sendMistPayloadToPeers(
    {
      send_message(target) {
        calls.push(target)
        if (target === 'node-stale') throw new Error('Internal("Not connected")')
      },
    },
    new Uint8Array([4, 5, 6]),
    ['node-ok', 'node-stale'],
    'node-local',
  )

  assert.deepEqual(calls, ['node-ok', 'node-stale'])
  assert.deepEqual(result, { attempted: 2, failed: 1, failedTargets: ['node-stale'] })
})

test('dropFailedMistPeers removes failed peers so Not connected targets are not retried immediately', () => {
  assert.deepEqual(dropFailedMistPeers(['node-ok', ' node-stale ', 'node-local'], ['node-stale']), ['node-ok', 'node-local'])
})

test('configureMistRoom joins with mistlib defaults and updates position', () => {
  const calls: string[] = []
  const settings = {
    autoConnect: true,
    avatarUrl: '',
    nodeId: 'node-local',
    profileName: 'Local',
    roomId: 'tc-storage-main',
    signalingUrl: 'wss://rtc.example/signaling',
  }
  const mist = {
    init(id: string, url: string) {
      calls.push(`init:${id}:${url}`)
    },
    join_room(roomId: string) {
      calls.push(`join:${roomId}`)
    },
    register_event_callback() {
      calls.push('register')
    },
    update_position(x: number, y: number, z: number) {
      calls.push(`position:${x}:${y}:${z}`)
    },
  }

  configureMistRoom(mist, settings, () => undefined)

  assert.deepEqual(calls.slice(0, 3), ['register', 'init:node-local:wss://rtc.example/signaling', 'join:tc-storage-main'])
  assert.match(calls[3] ?? '', /^position:/)
})

test('observeStableMistPeers withholds peers until they survive the warmup window', () => {
  const first = observeStableMistPeers({}, ['node-a'], 1000, 5000)
  assert.deepEqual(first.stablePeers, [])
  assert.deepEqual(first.firstSeenAt, { 'node-a': 1000 })

  const early = observeStableMistPeers(first.firstSeenAt, ['node-a'], 5999, 5000)
  assert.deepEqual(early.stablePeers, [])

  const stable = observeStableMistPeers(first.firstSeenAt, ['node-a'], 6000, 5000)
  assert.deepEqual(stable.stablePeers, ['node-a'])
})

test('observeStableMistPeers drops peers that disappear before becoming stable', () => {
  const first = observeStableMistPeers({}, ['node-a', 'node-b'], 1000, 5000)
  const next = observeStableMistPeers(first.firstSeenAt, ['node-b'], 7000, 5000)

  assert.deepEqual(next.firstSeenAt, { 'node-b': 1000 })
  assert.deepEqual(next.stablePeers, ['node-b'])
})

test('parseEnvelope accepts folder access request and grant envelopes', () => {
  const base = {
    from: 'node-a',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    clock: 0,
    folderId: 'folder-a',
    requestId: 'request-a',
  }

  assert.equal(parseEnvelope({ ...base, type: 'folder-access-request', accessPublicKey: 'pub-a' })?.type, 'folder-access-request')
  assert.equal(parseEnvelope({ ...base, type: 'folder-access-grant', targetNodeId: 'node-b', accessGrantPublicKey: 'pub-b', accessGrantIv: 'iv', accessGrantCipherText: 'cipher' })?.type, 'folder-access-grant')
})
