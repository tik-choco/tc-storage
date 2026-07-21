import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { createPanelActions } from '../src/app/appPanelActions.js'
import type { Notice, PendingShare } from '../src/app/appTypes.js'
import type { AppSettings } from '../src/storage/localSettings.js'
import type { JoinedRoom } from '../src/storage/joinedRooms.js'
import { loadImportKeys, loadPendingShares } from '../src/share/pendingShares.js'

type StateUpdate<T> = T | ((current: T) => T)

class MemoryStorage implements Storage {
  private values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

let originalLocalStorage: Storage | undefined

beforeEach(() => {
  originalLocalStorage = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: originalLocalStorage,
    configurable: true,
  })
})

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

test('acceptLinkedShare persists the linked share and import key synchronously, before the URL hash is removed', () => {
  const actions = createPanelActions(makePanelOptions())

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

  // useShareLinkImport strips #tc-share from the URL as soon as acceptLinkedShare returns, so by
  // then the share must already be recoverable from localStorage -- waiting for the state-driven
  // persistence effect leaves a window where the hash is gone but nothing has been saved.
  assert.deepEqual(loadPendingShares().map((share) => share.cid), ['cid-file'])
  assert.equal(loadPendingShares()[0]?.autoImport, true)
  assert.equal(loadImportKeys()['cid-file'], 'file-secret')
})

test('acceptLinkedShare reports a failed persist so the share link hash is kept for recovery', () => {
  const throwingStorage = new MemoryStorage()
  throwingStorage.setItem = () => {
    throw new Error('QuotaExceededError')
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: throwingStorage,
    configurable: true,
  })
  let notice: Notice = { tone: 'info', text: '' }
  const actions = createPanelActions(makePanelOptions({ setNotice: (update) => { notice = applyStateUpdate(notice, update) } }))

  const accepted = actions.acceptLinkedShare({
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

  assert.equal(accepted as unknown, false)
  assert.equal(notice.tone, 'error')
  assert.match(notice.text, /保存に失敗/)
})

function makePanelOptions(overrides: Partial<Parameters<typeof createPanelActions>[0]> = {}): Parameters<typeof createPanelActions>[0] {
  const settings = makeSettings({ roomId: 'local-room', autoConnect: false })
  return {
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
    setJoinedRooms: () => {},
    setNotice: () => {},
    setPendingShares: () => {},
    setPopoverPositions: () => {},
    setProfileOpen: () => {},
    setSelectedFileId: () => {},
    setSettings: () => {},
    setSettingsOpen: () => {},
    settings,
    settingsDraft: settings,
    ...overrides,
  }
}

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
