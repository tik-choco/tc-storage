import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failedThumbnailRetryPeerKey, immediateConnectionAnnounceKey, sharedFolderReannounceIntervalMs, shouldPreloadProfileAvatar, shouldRetryFileContentFailureAfterPeerConnection, shouldRunSharedFolderReannounce } from '../src/useAppEffects.js'

test('immediateConnectionAnnounceKey waits for stable mist peers', () => {
  const base = {
    autoConnect: true,
    networkMode: 'mistlib',
    nodeId: 'node-a',
    roomId: 'tc-storage-main',
    stablePeerCount: 0,
    stablePeerKey: '',
  }

  assert.equal(immediateConnectionAnnounceKey(base), '')
  assert.equal(immediateConnectionAnnounceKey({ ...base, stablePeerCount: 1, stablePeerKey: 'node-b' }), 'tc-storage-main:node-a:node-b')
})

test('immediateConnectionAnnounceKey does not fire while disabled or outside mistlib', () => {
  const base = {
    autoConnect: true,
    networkMode: 'local-gossip',
    nodeId: 'node-a',
    roomId: 'tc-storage-main',
    stablePeerCount: 1,
    stablePeerKey: 'node-b',
  }

  assert.equal(immediateConnectionAnnounceKey(base), '')
  assert.equal(immediateConnectionAnnounceKey({ ...base, autoConnect: false, networkMode: 'mistlib' }), '')
})

test('periodic shared-folder reannounce runs only as a slow reconciliation path', () => {
  assert.equal(sharedFolderReannounceIntervalMs, 60_000)
  assert.equal(shouldRunSharedFolderReannounce({ autoConnect: false, networkMode: 'mistlib', stablePeerCount: 1 }), false)
  assert.equal(shouldRunSharedFolderReannounce({ autoConnect: true, networkMode: 'mistlib', stablePeerCount: 0 }), false)
  assert.equal(shouldRunSharedFolderReannounce({ autoConnect: true, networkMode: 'mistlib', stablePeerCount: 1 }), true)
  assert.equal(shouldRunSharedFolderReannounce({ autoConnect: true, networkMode: 'local-gossip', stablePeerCount: 0 }), true)
  assert.equal(shouldRunSharedFolderReannounce({ autoConnect: true, networkMode: 'offline', stablePeerCount: 0 }), false)
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

test('failed preview retry after peer connection is limited to transient failures', () => {
  const base = { retryAfter: Date.now() + 1000, signature: 'signature-a' }

  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'block-not-found' }), true)
  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'network' }), true)
  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'decrypt' }), false)
  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'parse' }), false)
  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'missing-data' }), false)
  assert.equal(shouldRetryFileContentFailureAfterPeerConnection({ ...base, kind: 'unknown' }), false)
})
