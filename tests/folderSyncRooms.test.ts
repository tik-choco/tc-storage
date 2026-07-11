import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFolderSyncActions } from '../src/app/appFolderSyncActions.js'
import { createInitialSnapshot, makeFolder, type StorageSnapshot } from '../src/storage/domain.js'
import type { NetworkState } from '../src/p2p/p2p.js'

function makeAnnouncementHarness(state: NetworkState, previousAnnouncements: Record<string, { audienceKey: string; cid: string; sentAt: number; signature: string }> = {}) {
  const now = '2026-05-25T00:00:00.000Z'
  const folder = { ...makeFolder({ id: 'folder-local', name: 'Local room', parentId: null, color: 'teal', roomId: 'room-local', now, nodeId: 'node-a' }), shareEnabled: true, sharedRoomId: 'room-local', lastCid: 'cid-local', lastSharedAt: now }
  const snapshot: StorageSnapshot = { ...createInitialSnapshot('node-a'), folders: [folder], files: [], activity: [], clock: 5 }
  const broadcasts: unknown[] = []
  const folderStateAnnouncementsRef = { current: previousAnnouncements }
  const actions = createFolderSyncActions({
    ensureFolderFilesStored: async (_folder, files) => files,
    hasUntrustedFolderContent: () => false,
    folderKeysRef: { current: { 'folder-local': 'key-local' } },
    folderStateAnnouncementsRef,
    // `requestRoom` is gone: the engine joins every room in `roomIds` at once (see p2p.ts), so
    // there is nothing to request -- broadcastShare's second argument names the target room.
    networkRef: { current: { state, connect: async () => {}, disconnect: () => {}, broadcastShare: (payload: unknown) => broadcasts.push(payload) } },
    setNotice: () => {},
    setSnapshot: () => {},
    settingsRef: { current: { roomId: 'room-local', nodeId: 'node-a', identity: null, autoConnect: true, profileName: 'Test user', avatarUrl: '', avatarFileId: '' } },
    snapshotRef: { current: snapshot },
    syncInFlightRef: { current: new Set<string>() },
    syncSignaturesRef: { current: {} },
    syncTimersRef: { current: {} },
  })
  return { actions, broadcasts, folderStateAnnouncementsRef }
}

test('shared folder announcement rebroadcasts when a stable peer appears after an empty audience', () => {
  const state: NetworkState = { mode: 'mistlib', roomId: 'room-local', rooms: ['room-local'], nodeId: 'node-a', peers: ['node-b'], stablePeers: ['node-b'], peersByRoom: { 'room-local': ['node-b'] }, stablePeersByRoom: { 'room-local': ['node-b'] }, lastEvent: '', messagesSent: 0, messagesReceived: 0 }
  const previous = {
    'folder-local': {
      audienceKey: 'mistlib:room-local:node-a:',
      cid: 'cid-local',
      sentAt: Date.now(),
      signature: '[]',
    },
  }
  const { actions, broadcasts } = makeAnnouncementHarness(state, previous)

  actions.announceSharedFolders()

  assert.equal(broadcasts.length, 1)
  assert.equal((broadcasts[0] as { type?: string }).type, 'folder-state')
})

test('shared folder announcements cover every shared folder at once, each targeted at its own room', () => {
  // OLD (rotation era): a folder was only announced while the single mist connection happened to
  // be sitting on that folder's sharedRoomId -- a folder imported from a different sharer's room
  // went unannounced until rotation happened to land there.
  // NEW: the engine joins every room in `roomIds` simultaneously (see p2p.ts), so
  // announceSharedFolders no longer filters by "the connected room" at all -- every shareEnabled
  // folder with a key is announced on every tick, each broadcastShare call targeted (2nd arg) at
  // that folder's own sharedRoomId. A single connection now covers both folders below in one pass.
  const now = '2026-05-25T00:00:00.000Z'
  const local = { ...makeFolder({ id: 'folder-local', name: 'Local room', parentId: null, color: 'teal', roomId: 'room-local', now, nodeId: 'node-a' }), shareEnabled: true, sharedRoomId: 'room-local', lastCid: 'cid-local', lastSharedAt: now }
  const remote = { ...makeFolder({ id: 'folder-remote', name: 'Remote room', parentId: null, color: 'blue', roomId: 'room-remote', now, nodeId: 'node-a' }), shareEnabled: true, sharedRoomId: 'room-remote', lastCid: 'cid-remote', lastSharedAt: now }
  const snapshot: StorageSnapshot = { ...createInitialSnapshot('node-a'), folders: [local, remote], files: [], activity: [], clock: 5 }
  const settingsRef = { current: { roomId: 'room-local', nodeId: 'node-a', identity: null, autoConnect: true, profileName: 'Test user', avatarUrl: '', avatarFileId: '' } }

  const sent: { payload: unknown; roomId?: string }[] = []
  const state: NetworkState = {
    mode: 'mistlib',
    roomId: 'room-local',
    rooms: ['room-local', 'room-remote'],
    nodeId: 'node-a',
    peers: [],
    stablePeers: ['node-b'],
    peersByRoom: {},
    stablePeersByRoom: { 'room-local': ['node-b'], 'room-remote': ['node-b'] },
    lastEvent: '',
    messagesSent: 0,
    messagesReceived: 0,
  }
  createFolderSyncActions({
    ensureFolderFilesStored: async (_folder, files) => files,
    hasUntrustedFolderContent: () => false,
    folderKeysRef: { current: { 'folder-local': 'key-local', 'folder-remote': 'key-remote' } },
    folderStateAnnouncementsRef: { current: {} },
    networkRef: { current: { state, connect: async () => {}, disconnect: () => {}, broadcastShare: (payload: unknown, roomId?: string) => { sent.push({ payload, roomId }) } } },
    setNotice: () => {},
    setSnapshot: () => {},
    settingsRef,
    snapshotRef: { current: snapshot },
    syncInFlightRef: { current: new Set<string>() },
    syncSignaturesRef: { current: {} },
    syncTimersRef: { current: {} },
  }).announceSharedFolders()

  assert.equal(sent.length, 2)
  const localSend = sent.find((entry) => (entry.payload as { folderId?: string }).folderId === 'folder-local')
  const remoteSend = sent.find((entry) => (entry.payload as { folderId?: string }).folderId === 'folder-remote')
  assert.equal(localSend?.roomId, 'room-local')
  assert.equal(remoteSend?.roomId, 'room-remote')
})

test('a folder missing sharedRoomId (persisted before the field existed) falls back to the home room', () => {
  const now = '2026-05-25T00:00:00.000Z'
  const legacyFolder = { ...makeFolder({ id: 'folder-legacy', name: 'Legacy folder', parentId: null, color: 'teal', roomId: 'room-local', now, nodeId: 'node-a' }), shareEnabled: true, sharedRoomId: undefined as unknown as string, lastCid: 'cid-legacy', lastSharedAt: now }
  const snapshot: StorageSnapshot = { ...createInitialSnapshot('node-a'), folders: [legacyFolder], files: [], activity: [], clock: 5 }
  const settingsRef = { current: { roomId: 'home-room', nodeId: 'node-a', identity: null, autoConnect: true, profileName: 'Test user', avatarUrl: '', avatarFileId: '' } }

  const sent: { payload: unknown; roomId?: string }[] = []
  const state: NetworkState = {
    mode: 'mistlib',
    roomId: 'home-room',
    rooms: ['home-room'],
    nodeId: 'node-a',
    peers: [],
    stablePeers: ['node-b'],
    peersByRoom: {},
    stablePeersByRoom: { 'home-room': ['node-b'] },
    lastEvent: '',
    messagesSent: 0,
    messagesReceived: 0,
  }
  createFolderSyncActions({
    ensureFolderFilesStored: async (_folder, files) => files,
    hasUntrustedFolderContent: () => false,
    folderKeysRef: { current: { 'folder-legacy': 'key-legacy' } },
    folderStateAnnouncementsRef: { current: {} },
    networkRef: { current: { state, connect: async () => {}, disconnect: () => {}, broadcastShare: (payload: unknown, roomId?: string) => { sent.push({ payload, roomId }) } } },
    setNotice: () => {},
    setSnapshot: () => {},
    settingsRef,
    snapshotRef: { current: snapshot },
    syncInFlightRef: { current: new Set<string>() },
    syncSignaturesRef: { current: {} },
    syncTimersRef: { current: {} },
  }).announceSharedFolders()

  assert.equal(sent.length, 1)
  assert.equal((sent[0]?.payload as { folderId?: string }).folderId, 'folder-legacy')
  assert.equal(sent[0]?.roomId, 'home-room')
})
