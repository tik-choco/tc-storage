import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFolderActions } from '../src/appFolderActions.js'
import { createInitialSnapshot, makeFolder, type StorageSnapshot } from '../src/domain.js'
import type { AppSettings } from '../src/localSettings.js'

type StateUpdate<T> = T | ((current: T) => T)

test('enabling folder sharing also enables auto-connect for the owner', () => {
  const now = '2026-05-25T00:00:00.000Z'
  let settings = makeSettings({ roomId: 'shared-room', autoConnect: false })
  const folder = makeFolder({ id: 'folder-a', name: 'First share', parentId: null, color: 'teal', roomId: 'local-room', now, nodeId: settings.nodeId })
  let snapshot: StorageSnapshot = { ...createInitialSnapshot(settings.nodeId), folders: [folder], files: [], activity: [] }
  const actions = createFolderActions({
    announceFolderChange: () => {},
    clearFolderSyncTimer: () => {},
    currentFolder: folder,
    currentFolderId: folder.id,
    currentFolderKey: 'folder-secret',
    ensureFolderFilesStored: async (_folder, files) => files,
    folderAccessModes: {},
    folderKeysRef: { current: { [folder.id]: 'folder-secret' } },
    folderPanelFolder: folder,
    folderPanelFolderId: folder.id,
    folders: [folder],
    networkRef: { current: { state: { mode: 'idle', peers: [], stablePeers: [], lastEvent: '', messagesSent: 0, messagesReceived: 0 }, connect: async () => {}, disconnect: () => {}, broadcastShare: () => {} } },
    scheduleFolderSync: () => {},
    setBusy: () => {},
    setCurrentFolderId: () => {},
    setDeleteRequest: () => {},
    setDetailFileId: () => {},
    setExpandedPreviewOpen: () => {},
    setFolderKeys: () => {},
    setFolderNameDraft: () => {},
    setFolderPanelFolderId: () => {},
    setFolderPanelOpen: () => {},
    setNotice: () => {},
    setProfileOpen: () => {},
    setSelectedFileId: () => {},
    setSettings: (update) => { settings = applyStateUpdate(settings, update) },
    setSettingsOpen: () => {},
    setSnapshot: (update) => { snapshot = applyStateUpdate(snapshot, update) },
    settings,
    shareProfile: { name: 'Owner' },
    snapshot,
    snapshotRef: { current: snapshot },
    syncSignaturesRef: { current: {} },
  })

  actions.patchCurrentFolder({ shareEnabled: true })

  assert.equal(settings.autoConnect, true)
  assert.equal(snapshot.folders[0]?.shareEnabled, true)
  assert.equal(snapshot.folders[0]?.sharedRoomId, 'shared-room')
})

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    roomId: 'local-room',
    signalingUrl: 'wss://rtc.example.test/signaling',
    nodeId: 'node-a',
    identity: null,
    autoConnect: false,
    profileName: 'Test user',
    avatarUrl: '',
    avatarFileId: '',
    ...overrides,
  }
}

function applyStateUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update
}
