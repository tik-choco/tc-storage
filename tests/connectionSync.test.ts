import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failedThumbnailRetryPeerKey, immediateConnectionAnnounceKey, sharedFolderReannounceIntervalMs, shouldPreloadProfileAvatar, shouldRequestFolderAccessForPendingShare, shouldRetryFileContentFailureAfterPeerConnection, shouldRunSharedFolderReannounce } from '../src/useAppEffects.js'
import { ownerDid, requesterDid } from './accessApprovalHelpers.js'

test('immediateConnectionAnnounceKey waits for stable mist peers in the current connection', () => {
  const base = {
    autoConnect: true,
    networkMode: 'mistlib',
    networkNodeId: 'node-a',
    networkRoomId: 'tc-storage-main',
    nodeId: 'node-a',
    roomId: 'tc-storage-main',
    stablePeerCount: 0,
    stablePeerKey: '',
  }

  assert.equal(immediateConnectionAnnounceKey(base), '')
  assert.equal(immediateConnectionAnnounceKey({ ...base, stablePeerCount: 1, stablePeerKey: 'node-b' }), 'tc-storage-main:node-a:node-b')
  assert.equal(immediateConnectionAnnounceKey({ ...base, networkRoomId: 'old-room', stablePeerCount: 1, stablePeerKey: 'node-b' }), '')
  assert.equal(immediateConnectionAnnounceKey({ ...base, networkNodeId: 'old-node', stablePeerCount: 1, stablePeerKey: 'node-b' }), '')
})

test('immediateConnectionAnnounceKey does not fire while disabled or outside mistlib', () => {
  const base = {
    autoConnect: true,
    networkMode: 'local-gossip',
    networkNodeId: 'node-a',
    networkRoomId: 'tc-storage-main',
    nodeId: 'node-a',
    roomId: 'tc-storage-main',
    stablePeerCount: 1,
    stablePeerKey: 'node-b',
  }

  assert.equal(immediateConnectionAnnounceKey(base), '')
  assert.equal(immediateConnectionAnnounceKey({ ...base, autoConnect: false, networkMode: 'mistlib' }), '')
})

test('periodic shared-folder reannounce runs only as a slow reconciliation path', () => {
  const base = {
    autoConnect: true,
    networkMode: 'mistlib',
    networkNodeId: 'node-a',
    networkRoomId: 'tc-storage-main',
    nodeId: 'node-a',
    roomId: 'tc-storage-main',
    stablePeerCount: 1,
  }

  assert.equal(sharedFolderReannounceIntervalMs, 60_000)
  assert.equal(shouldRunSharedFolderReannounce({ ...base, autoConnect: false }), false)
  assert.equal(shouldRunSharedFolderReannounce({ ...base, stablePeerCount: 0 }), false)
  assert.equal(shouldRunSharedFolderReannounce(base), true)
  assert.equal(shouldRunSharedFolderReannounce({ ...base, networkMode: 'local-gossip', stablePeerCount: 0 }), true)
  assert.equal(shouldRunSharedFolderReannounce({ ...base, networkMode: 'offline', stablePeerCount: 0 }), false)
  assert.equal(shouldRunSharedFolderReannounce({ ...base, networkRoomId: 'old-room' }), false)
  assert.equal(shouldRunSharedFolderReannounce({ ...base, networkNodeId: 'old-node' }), false)
})

test('pending folder access requests wait for the current shared room connection', () => {
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
    networkRoomId: 'shared-room',
    nodeId: requesterDid,
    settingsRoomId: 'shared-room',
    share,
    stablePeerCount: 1,
  }

  assert.equal(shouldRequestFolderAccessForPendingShare(base), true)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, stablePeerCount: 0 }), false)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, networkMode: 'local-gossip' }), false)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, networkRoomId: 'old-room' }), false)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, networkNodeId: ownerDid }), false)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, nodeId: 'node-temporary', networkNodeId: 'node-temporary' }), false)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, settingsRoomId: 'local-room' }), false)
  assert.equal(shouldRequestFolderAccessForPendingShare({ ...base, share: { ...share, cid: 'cid-folder' } }), false)
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
