import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPanelActions } from '../src/app/appPanelActions.js'
import type { Notice, PendingShare } from '../src/app/appTypes.js'
import type { AppSettings } from '../src/storage/localSettings.js'
import type { JoinedRoom } from '../src/storage/joinedRooms.js'

type StateUpdate<T> = T | ((current: T) => T)

test('acceptLinkedShare joins the share room without disturbing the home room, and starts auto-connect', () => {
  let settings = makeSettings({ roomId: 'local-room', autoConnect: false })
  let pendingShares: PendingShare[] = []
  let importKeys: Record<string, string> = {}
  let joinedRooms: JoinedRoom[] = []
  let currentFolderId: string | null = 'folder-current'
  let notice: Notice = { tone: 'info', text: '' }
  // `requestRoom` is gone from the network hook: the engine now joins every room in
  // joinedRooms/roomIds simultaneously (see p2p.ts), so acceptLinkedShare only needs to push the
  // shared room into `joinedRooms` -- that alone drives the engine to join it. No `networkRef` is
  // passed to createPanelActions anymore either (PanelOptions no longer has that field).
  const actions = createPanelActions({
    previewFiles: [],
    profileImageFiles: [],
    selectedFileId: null,
    setCurrentFolderId: (update) => { currentFolderId = applyStateUpdate(currentFolderId, update) },
    setDetailFileId: () => {},
    setExpandedPreviewOpen: () => {},
    setFolderNameDraft: () => {},
    setFolderPanelFolderId: () => {},
    setFolderPanelMode: () => {},
    setFolderPanelOpen: () => {},
    setImportKeys: (update) => { importKeys = applyStateUpdate(importKeys, update) },
    setJoinedRooms: (update) => { joinedRooms = applyStateUpdate(joinedRooms, update) },
    setNotice: (update) => { notice = applyStateUpdate(notice, update) },
    setPendingShares: (update) => { pendingShares = applyStateUpdate(pendingShares, update) },
    setPopoverPositions: () => {},
    setProfileOpen: () => {},
    setSelectedFileId: () => {},
    setSettings: (update) => { settings = applyStateUpdate(settings, update) },
    setSettingsOpen: () => {},
    settings,
    settingsDraft: settings,
  })

  actions.acceptLinkedShare({
    key: 'file-secret',
    share: {
      type: 'file-share',
      from: 'share-url',
      roomId: 'shared-room',
      sentAt: '2026-05-25T00:00:00.000Z',
      receivedAt: '2026-05-25T00:00:00.000Z',
      clock: 1,
      folderId: 'folder-a',
      fileId: 'file-a',
      cid: 'cid-file',
      senderProfile: { name: 'Alice' },
    },
  })

  assert.equal(settings.roomId, 'local-room', 'home room must stay stable')
  assert.equal(settings.autoConnect, true)
  assert.equal(currentFolderId, null)
  assert.equal(importKeys['cid-file'], 'file-secret')
  assert.equal(pendingShares[0]?.autoImport, true)
  assert.deepEqual(joinedRooms.map((room) => room.roomId), ['shared-room'])
  assert.equal(joinedRooms[0]?.label, 'Alice')
  assert.match(notice.text, /共有ルームへ接続/)
})

test('acceptLinkedShare does not add a joined room when the share is already for the home room', () => {
  let settings = makeSettings({ roomId: 'local-room', autoConnect: false })
  let joinedRooms: JoinedRoom[] = []
  const actions = createPanelActions({
    previewFiles: [],
    profileImageFiles: [],
    selectedFileId: null,
    setCurrentFolderId: () => {},
    setDetailFileId: () => {},
    setExpandedPreviewOpen: () => {},
    setFolderNameDraft: () => {},
    setFolderPanelFolderId: () => {},
    setFolderPanelMode: () => {},
    setFolderPanelOpen: () => {},
    setImportKeys: () => {},
    setJoinedRooms: (update) => { joinedRooms = applyStateUpdate(joinedRooms, update) },
    setNotice: () => {},
    setPendingShares: () => {},
    setPopoverPositions: () => {},
    setProfileOpen: () => {},
    setSelectedFileId: () => {},
    setSettings: (update) => { settings = applyStateUpdate(settings, update) },
    setSettingsOpen: () => {},
    settings,
    settingsDraft: settings,
  })

  actions.acceptLinkedShare({
    key: 'file-secret',
    share: {
      type: 'file-share',
      from: 'share-url',
      roomId: 'local-room',
      sentAt: '2026-05-25T00:00:00.000Z',
      receivedAt: '2026-05-25T00:00:00.000Z',
      clock: 1,
      folderId: 'folder-a',
      fileId: 'file-a',
      cid: 'cid-file',
    },
  })

  assert.equal(settings.roomId, 'local-room')
  assert.deepEqual(joinedRooms, [])
})

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    roomId: 'local-room',
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
