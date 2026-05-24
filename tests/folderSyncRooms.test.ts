import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFolderSyncActions } from '../src/appFolderSyncActions.js'
import { createInitialSnapshot, makeFolder, type StorageSnapshot } from '../src/domain.js'
import type { NetworkState } from '../src/p2p.js'

test('shared folder announcements only broadcast folders in the connected room', () => {
  const now = '2026-05-25T00:00:00.000Z'
  const local = { ...makeFolder({ id: 'folder-local', name: 'Local room', parentId: null, color: 'teal', roomId: 'room-local', now, nodeId: 'node-a' }), shareEnabled: true, sharedRoomId: 'room-local', lastCid: 'cid-local', lastSharedAt: now }
  const remote = { ...makeFolder({ id: 'folder-remote', name: 'Remote room', parentId: null, color: 'blue', roomId: 'room-remote', now, nodeId: 'node-a' }), shareEnabled: true, sharedRoomId: 'room-remote', lastCid: 'cid-remote', lastSharedAt: now }
  const snapshot: StorageSnapshot = { ...createInitialSnapshot('node-a'), folders: [local, remote], files: [], activity: [], clock: 5 }
  const broadcasts: unknown[] = []
  const state: NetworkState = { mode: 'mistlib', roomId: 'room-local', nodeId: 'node-a', peers: [], stablePeers: ['node-b'], lastEvent: '', messagesSent: 0, messagesReceived: 0 }
  const actions = createFolderSyncActions({
    ensureFolderFilesStored: async (_folder, files) => files,
    hasUntrustedFolderContent: () => false,
    folderKeysRef: { current: { 'folder-local': 'key-local', 'folder-remote': 'key-remote' } },
    folderStateAnnouncementsRef: { current: {} },
    networkRef: { current: { state, connect: async () => {}, disconnect: () => {}, broadcastShare: (payload: unknown) => broadcasts.push(payload) } },
    setNotice: () => {},
    setSnapshot: () => {},
    settingsRef: { current: { roomId: 'room-local', signalingUrl: 'wss://rtc.example.test/signaling', nodeId: 'node-a', identity: null, autoConnect: true, profileName: 'Test user', avatarUrl: '', avatarFileId: '' } },
    snapshotRef: { current: snapshot },
    syncInFlightRef: { current: new Set<string>() },
    syncSignaturesRef: { current: {} },
    syncTimersRef: { current: {} },
  })

  actions.announceSharedFolders()

  assert.equal(broadcasts.length, 1)
  assert.equal((broadcasts[0] as { folderId?: string }).folderId, 'folder-local')
})
