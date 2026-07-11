import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failedThumbnailRetryPeerKey, immediateConnectionAnnounceKey, pendingShareRetryIntervalMs, retryablePendingShares, sharedFolderReannounceIntervalMs, shouldPreloadProfileAvatar, shouldRequestFolderAccessForPendingShare, shouldRetryFileContentFailureAfterPeerConnection, shouldRunSharedFolderReannounce } from '../src/app/appEffectUtils.js'
import { ownerDid, requesterDid } from './accessApprovalHelpers.js'

test('immediateConnectionAnnounceKey waits for stable mist peers and keys off the whole joined-room set', () => {
  // The engine now joins every room in `joinedRooms` simultaneously (see p2p.ts) -- there is no
  // single "active" room to rotate through, so the key is derived from the full room set instead
  // of one `networkRoomId`.
  const base = {
    autoConnect: true,
    networkMode: 'mistlib',
    networkNodeId: 'node-a',
    joinedRooms: ['tc-storage-main'],
    nodeId: 'node-a',
    stablePeerCount: 0,
    stablePeerKey: '',
  }

  assert.equal(immediateConnectionAnnounceKey(base), '')
  assert.equal(immediateConnectionAnnounceKey({ ...base, stablePeerCount: 1, stablePeerKey: 'node-b' }), 'tc-storage-main:node-a:node-b')
  // Multiple simultaneously-joined rooms fold into the key together -- no single room to pick.
  assert.equal(
    immediateConnectionAnnounceKey({ ...base, joinedRooms: ['tc-storage-main', 'joined-room'], stablePeerCount: 1, stablePeerKey: 'node-b' }),
    'tc-storage-main,joined-room:node-a:node-b',
  )
  // An empty joined-room set (e.g. briefly between connect cycles) still produces a key as long as
  // nodeId matches and there are stable peers -- there is no per-room gate on this key anymore.
  assert.equal(immediateConnectionAnnounceKey({ ...base, joinedRooms: [], stablePeerCount: 1, stablePeerKey: 'node-b' }), ':node-a:node-b')
  assert.equal(immediateConnectionAnnounceKey({ ...base, networkNodeId: 'old-node', stablePeerCount: 1, stablePeerKey: 'node-b' }), '')
})

test('immediateConnectionAnnounceKey does not fire while disabled or outside mistlib', () => {
  const base = {
    autoConnect: true,
    networkMode: 'local-gossip',
    networkNodeId: 'node-a',
    joinedRooms: ['tc-storage-main'],
    nodeId: 'node-a',
    stablePeerCount: 1,
    stablePeerKey: 'node-b',
  }

  assert.equal(immediateConnectionAnnounceKey(base), '')
  assert.equal(immediateConnectionAnnounceKey({ ...base, autoConnect: false, networkMode: 'mistlib' }), '')
})

test('periodic shared-folder reannounce runs only as a slow reconciliation path', () => {
  // shouldRunSharedFolderReannounce no longer takes a room at all: with the app joined to every
  // room simultaneously, "are we connected" reduces to "does the live connection's nodeId match
  // ours", with no single room to gate on.
  const base = {
    autoConnect: true,
    networkMode: 'mistlib',
    networkNodeId: 'node-a',
    nodeId: 'node-a',
    stablePeerCount: 1,
  }

  assert.equal(sharedFolderReannounceIntervalMs, 60_000)
  assert.equal(shouldRunSharedFolderReannounce({ ...base, autoConnect: false }), false)
  assert.equal(shouldRunSharedFolderReannounce({ ...base, stablePeerCount: 0 }), false)
  assert.equal(shouldRunSharedFolderReannounce(base), true)
  assert.equal(shouldRunSharedFolderReannounce({ ...base, networkMode: 'local-gossip', stablePeerCount: 0 }), true)
  assert.equal(shouldRunSharedFolderReannounce({ ...base, networkMode: 'offline', stablePeerCount: 0 }), false)
  assert.equal(shouldRunSharedFolderReannounce({ ...base, networkNodeId: 'old-node' }), false)
})

test('pending folder access requests fire once the share room is joined and has a stable peer there', () => {
  // NEW: gating is per-room (joinedRooms.includes(share.roomId) + stablePeersByRoom[share.roomId]),
  // not "is this the one room we're currently connected to". A pending share for a room we've
  // joined fires as soon as that specific room has a stable peer, independent of any other room's
  // peer state.
  const share = {
    type: 'folder-share' as const,
    from: 'share-url',
    roomId: 'shared-room',
    sentAt: '2026-05-25T00:00:00.000Z',
    receivedAt: '2026-05-25T00:00:01.000Z',
    clock: 0,
    folderId: 'folder-a',
    folderName: 'Shared folder',
    ownerNodeId: ownerDid,
    folderKeyHash: 'folder-key-hash',
    autoImport: true,
  }
  const base = {
    networkMode: 'mistlib',
    networkNodeId: requesterDid,
    joinedRooms: ['home-room', 'shared-room'],
    nodeId: requesterDid,
    share,
    stablePeersByRoom: { 'shared-room': ['peer-a'] } as Record<string, string[]>,
  }

  assert.equal(shouldRequestFolderAccessForPendingShare(base), true)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, stablePeersByRoom: {} }), false)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, stablePeersByRoom: { 'shared-room': [] } }), false)
  // A stable peer in some *other* joined room doesn't help -- must be in the share's own room.
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, stablePeersByRoom: { 'home-room': ['peer-a'] } }), false)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, networkMode: 'local-gossip' }), false)
  // Not joined to the share's room at all yet (e.g. still mid-join) -- no longer "wrong active
  // room", just genuinely absent from the joined-room set.
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, joinedRooms: ['home-room'] }), false)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, networkNodeId: ownerDid }), false)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, nodeId: 'node-temporary', networkNodeId: 'node-temporary' }), false)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, share: { ...share, cid: 'cid-folder' } }), false)
})

test('approved pending shares remain eligible for periodic import retries', () => {
  const approved = {
    type: 'folder-share' as const,
    from: 'share-url',
    roomId: 'shared-room',
    sentAt: '2026-05-25T00:00:00.000Z',
    receivedAt: '2026-05-25T00:00:01.000Z',
    clock: 0,
    cid: 'cid-folder',
    folderId: 'folder-a',
    autoImport: true,
  }

  assert.equal(pendingShareRetryIntervalMs, 30_000)
  assert.deepEqual(retryablePendingShares([approved], { 'cid-folder': 'folder-secret' }), [approved])
  assert.deepEqual(retryablePendingShares([{ ...approved, cid: undefined }], {}), [])
  assert.deepEqual(retryablePendingShares([{ ...approved, autoImport: false }], { 'cid-folder': 'folder-secret' }), [])
  assert.deepEqual(retryablePendingShares([approved], { 'cid-folder': ' ' }), [])
})

test('profile avatar preload is gated behind the profile panel', () => {
  assert.equal(shouldPreloadProfileAvatar({ avatarFileId: 'file-a', hasDataUrl: false, profileOpen: false }), false)
  assert.equal(shouldPreloadProfileAvatar({ avatarFileId: '', hasDataUrl: false, profileOpen: true }), false)
  assert.equal(shouldPreloadProfileAvatar({ avatarFileId: 'file-a', hasDataUrl: true, profileOpen: true }), false)
  assert.equal(shouldPreloadProfileAvatar({ avatarFileId: 'file-a', hasDataUrl: false, profileOpen: true }), true)
})

test('failed thumbnail retry key advances only for stable mist peers', () => {
  assert.equal(failedThumbnailRetryPeerKey({ networkMode: 'mistlib', stablePeerCount: 1, stablePeerKey: 'node-b' }), 'node-b')
  assert.equal(failedThumbnailRetryPeerKey({ networkMode: 'mistlib', stablePeerCount: 0, stablePeerKey: '' }), '')
  assert.equal(failedThumbnailRetryPeerKey({ networkMode: 'local-gossip', stablePeerCount: 1, stablePeerKey: 'node-b' }), '')
})

test('failed preview retry after peer connection includes corrupt retrieval failures', () => {
  const base = { retryAfter: Date.now() + 1000, signature: 'signature-a' }

  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'block-not-found' }), true)
  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'network' }), true)
  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'decrypt' }), true)
  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'parse' }), true)
  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'missing-data' }), false)
  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'unknown' }), false)
})
