import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPanelActions } from '../src/appPanelActions.js'
import type { Notice, PendingShare } from '../src/appTypes.js'
import type { AppSettings } from '../src/localSettings.js'

type StateUpdate<T> = T | ((current: T) => T)

test('acceptLinkedShare switches to the share room and starts auto-connect', () => {
  let settings = makeSettings({ roomId: 'local-room', autoConnect: false })
  let pendingShares: PendingShare[] = []
  let importKeys: Record<string, string> = {}
  let currentFolderId: string | null = 'folder-current'
  let notice: Notice = { tone: 'info', text: '' }
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
    },
  })

  assert.equal(settings.roomId, 'shared-room')
  assert.equal(settings.autoConnect, true)
  assert.equal(currentFolderId, null)
  assert.equal(importKeys['cid-file'], 'file-secret')
  assert.equal(pendingShares[0]?.autoImport, true)
  assert.match(notice.text, /共有ルームへ接続/)
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
