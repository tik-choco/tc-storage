import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configureMistRoom, dropFailedMistPeers, joinMistRoom, leaveMistRoomId, observeStableMistPeers, peerIdFromMistConnectionTimeout, peerIdsForMistSend, positionForSharedRoom, sendMistPayloadToPeers } from '../src/p2p/p2p.js'
import { parseEnvelope } from '../src/p2p/p2pEnvelope.js'
import { shouldCleanupMistOnPageHide } from '../src/p2p/p2pMist.js'

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
      send_message_in_room(roomId, target) {
        calls.push(`${roomId}:${target}`)
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
      send_message_in_room(roomId, target) {
        calls.push(`${roomId}:${target}`)
      },
    },
    new Uint8Array([4, 5, 6]),
    ['node-ok', 'node-stale'],
    'node-local',
  )

  assert.deepEqual(calls, ['node-ok', 'node-stale'])
  assert.deepEqual(result, { attempted: 2, failed: 1, failedTargets: ['node-stale'] })
})

test('sendMistPayloadToPeers routes through send_message_in_room when a roomId is given, scoping delivery to that room session', () => {
  const calls: string[] = []
  const result = sendMistPayloadToPeers(
    {
      send_message(target) {
        calls.push(`global:${target}`)
      },
      send_message_in_room(roomId, target) {
        calls.push(`${roomId}:${target}`)
        if (target === 'node-stale') throw new Error('Internal("Not connected")')
      },
    },
    new Uint8Array([7, 8, 9]),
    ['node-ok', 'node-stale'],
    'node-local',
    'tc-storage-shared',
  )

  assert.deepEqual(calls, ['tc-storage-shared:node-ok', 'tc-storage-shared:node-stale'])
  assert.deepEqual(result, { attempted: 2, failed: 1, failedTargets: ['node-stale'] })
})

test('dropFailedMistPeers removes failed peers so Not connected targets are not retried immediately', () => {
  assert.deepEqual(dropFailedMistPeers(['node-ok', ' node-stale ', 'node-local'], ['node-stale']), ['node-ok', 'node-local'])
})


test('peerIdFromMistConnectionTimeout extracts timed out peer ids from mist events', () => {
  const peerId = 'did:key:z6MkvTZ4FTCtXPiZ7M6MQoFNGgXYhEyX65Y5C6HQ8GFsv24w'

  assert.equal(peerIdFromMistConnectionTimeout(['WARN Connection timeout to ' + peerId + '. fail-fast cleanup (attempt_id=4).']), peerId)
  assert.equal(peerIdFromMistConnectionTimeout([{ message: 'Connection timeout to ' + peerId + '. fail-fast cleanup' }]), peerId)
  assert.equal(peerIdFromMistConnectionTimeout(['Received Request from: did:key:z6Mkuz5hJQDzvus1dckEAeKX3VEb1pa8FYEXb8KrfvNN2oev']), undefined)
})

test('configureMistRoom registers the event callback and initializes the mistlib runtime, without joining any particular room', () => {
  const calls: string[] = []
  const settings = {
    autoConnect: true,
    avatarUrl: '',
    nodeId: 'node-local',
    profileName: 'Local',
    roomId: 'tc-storage-main',
  }
  const mist = {
    init_with_config(id: string, _config: string): boolean {
      calls.push(`init:${id}`)
      return true
    },
    register_event_callback() {
      calls.push('register')
    },
  }

  configureMistRoom(mist, settings, () => undefined)

  assert.deepEqual(calls, ['register', 'init:node-local'])
})

test('joinMistRoom awaits join_room_async then places the node at the room-derived position via update_position_in_room', async () => {
  const calls: string[] = []
  const mist = {
    async join_room_async(roomId: string) {
      calls.push(`join:${roomId}`)
    },
    update_position_in_room(roomId: string, x: number, y: number, z: number) {
      calls.push(`position:${roomId}:${x}:${y}:${z}`)
    },
  }

  const result = await joinMistRoom(mist, 'tc-storage-main', 'node-local')

  assert.equal(calls[0], 'join:tc-storage-main')
  assert.match(calls[1] ?? '', /^position:tc-storage-main:/)
  assert.deepEqual(result.position, positionForSharedRoom('tc-storage-main', 'node-local'))
})

test('leaveMistRoomId leaves only the given room and swallows teardown errors', () => {
  const calls: string[] = []
  leaveMistRoomId(
    {
      leave_room_id(roomId: string) {
        calls.push(roomId)
      },
    },
    'tc-storage-shared',
  )
  assert.deepEqual(calls, ['tc-storage-shared'])

  assert.doesNotThrow(() =>
    leaveMistRoomId(
      {
        leave_room_id() {
          throw new Error('Room not joined')
        },
      },
      'tc-storage-shared',
    ),
  )
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

test('pagehide cleanup releases mist rooms for reloads without breaking bfcache restores', () => {
  assert.equal(shouldCleanupMistOnPageHide({ persisted: false }), true)
  assert.equal(shouldCleanupMistOnPageHide({ persisted: true }), false)
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
  assert.equal(parseEnvelope({ ...base, type: 'folder-access-denied', targetNodeId: 'node-b' })?.type, 'folder-access-denied')
  assert.equal(parseEnvelope({ ...base, type: 'file-content-repair-request', fileId: 'file-a', cid: 'cid-file' })?.type, 'file-content-repair-request')
})
