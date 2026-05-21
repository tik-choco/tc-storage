import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDragDropActions } from '../src/appDragDropActions.js'
import { compareFilesForDisplay, compareFoldersForDisplay, createInitialSnapshot, makeFileFromDataUrl, makeFolder, type FileRecord, type FolderRecord, type StorageSnapshot } from '../src/domain.js'

type StateUpdate<T> = T | ((current: T) => T)

test('file reorder broadcasts immediate upserts for changed sort orders', () => withFakeHTMLElement(() => {
  const { files, root, snapshot } = snapshotWithSharedFiles()
  const harness = createDragDropHarness(snapshot, root.id)
  harness.dragItemsRef.current = [{ type: 'file', id: files[2]!.id }]

  harness.actions.handleBrowserItemDrop({ type: 'file', id: files[0]!.id }, fakeDropEventBefore())

  assert.deepEqual(
    harness.snapshot().files.filter((file) => file.folderId === root.id).sort(compareFilesForDisplay).map((file) => file.id),
    ['file-c', 'file-a', 'file-b'],
  )
  assert.deepEqual(
    harness.announcements.map((item) => [item.changeType, item.folderId, item.fileId]),
    [
      ['file-upserted', root.id, 'file-a'],
      ['file-upserted', root.id, 'file-b'],
      ['file-upserted', root.id, 'file-c'],
    ],
  )
  assert.deepEqual(harness.scheduled, [{ folderId: root.id, reason: 'local file reorder' }])
}))

test('folder reorder broadcasts immediate upserts for changed sort orders', () => withFakeHTMLElement(() => {
  const { folders, root, snapshot } = snapshotWithSharedFolders()
  const harness = createDragDropHarness(snapshot, root.id)
  harness.dragItemsRef.current = [{ type: 'folder', id: folders[2]!.id }]

  harness.actions.handleBrowserItemDrop({ type: 'folder', id: folders[0]!.id }, fakeDropEventBefore())

  assert.deepEqual(
    harness.snapshot().folders.filter((folder) => folder.parentId === root.id).sort(compareFoldersForDisplay).map((folder) => folder.id),
    ['folder-c', 'folder-a', 'folder-b'],
  )
  assert.deepEqual(
    harness.announcements.map((item) => [item.changeType, item.folderId, item.changedFolderId]),
    [
      ['folder-upserted', root.id, 'folder-a'],
      ['folder-upserted', root.id, 'folder-b'],
      ['folder-upserted', root.id, 'folder-c'],
    ],
  )
  assert.deepEqual(harness.scheduled, [{ folderId: root.id, reason: 'local folder reorder' }])
}))

function createDragDropHarness(snapshot: StorageSnapshot, currentFolderId: string) {
  let snapshotValue = snapshot
  const dragItemRef = { current: null as { type: 'file' | 'folder'; id: string } | null }
  const dragItemsRef = { current: [] as Array<{ type: 'file' | 'folder'; id: string }> }
  const announcements: Array<{ changeType: string; folderId: string; fileId?: string; changedFolderId?: string }> = []
  const scheduled: Array<{ folderId: string; reason: string }> = []
  const snapshotRef = { current: snapshotValue }
  const actions = createDragDropActions({
    announceFolderChange: (folder, changeType, file, changedFolder) => {
      announcements.push({ changeType, folderId: folder.id, fileId: file?.id, changedFolderId: changedFolder?.id })
    },
    browserViewMode: 'list',
    currentFolderId,
    dragItemRef,
    dragItemsRef,
    moveActions: {
      canMoveItemToFolder: () => false,
      moveDraggedItem: async () => {},
    },
    scheduleFolderSync: (folderId, reason) => {
      scheduled.push({ folderId, reason })
    },
    selectedItems: [],
    setDragActive: () => {},
    setDragItem: (update) => {
      dragItemRef.current = applyStateUpdate(dragItemRef.current, update)
    },
    setDropTargetFolderId: () => {},
    setNotice: () => {},
    setReorderTarget: () => {},
    setSelectedItems: () => {},
    setSnapshot: (update) => {
      snapshotValue = applyStateUpdate(snapshotValue, update)
      snapshotRef.current = snapshotValue
    },
    settings: {
      roomId: 'tc-storage-main',
      signalingUrl: 'https://rtc.example.test/signaling',
      nodeId: 'node-a',
      identity: null,
      autoConnect: false,
      profileName: 'Test user',
      avatarUrl: '',
      avatarFileId: '',
    },
    snapshotRef,
    uploadFiles: async () => {},
  })
  return { actions, announcements, dragItemsRef, scheduled, snapshot: () => snapshotValue }
}

function snapshotWithSharedFiles(): { files: FileRecord[]; root: FolderRecord; snapshot: StorageSnapshot } {
  const now = '2026-05-21T00:00:00.000Z'
  const root = { ...makeTestFolder('folder-root', 'Root', null, 1000), shareEnabled: true }
  const files = [
    makeTestFile('file-a', root.id, 'A.txt', 1000),
    makeTestFile('file-b', root.id, 'B.txt', 2000),
    makeTestFile('file-c', root.id, 'C.txt', 3000),
  ]
  return { files, root, snapshot: { ...createInitialSnapshot('node-a'), folders: [root], files, activity: [], clock: 1, originNode: 'node-a' } }

  function makeTestFile(id: string, folderId: string, name: string, sortOrder: number): FileRecord {
    return { ...makeFileFromDataUrl({ id, folderId, name, mimeType: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,YQ==', checksum: id, now, nodeId: 'node-a' }), sortOrder }
  }
}

function snapshotWithSharedFolders(): { folders: FolderRecord[]; root: FolderRecord; snapshot: StorageSnapshot } {
  const root = { ...makeTestFolder('folder-root', 'Root', null, 1000), shareEnabled: true }
  const folders = [
    makeTestFolder('folder-a', 'A', root.id, 1000),
    makeTestFolder('folder-b', 'B', root.id, 2000),
    makeTestFolder('folder-c', 'C', root.id, 3000),
  ]
  return { folders, root, snapshot: { ...createInitialSnapshot('node-a'), folders: [root, ...folders], files: [], activity: [], clock: 1, originNode: 'node-a' } }
}

function makeTestFolder(id: string, name: string, parentId: string | null, sortOrder: number): FolderRecord {
  const now = '2026-05-21T00:00:00.000Z'
  return { ...makeFolder({ id, name, parentId, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-a' }), sortOrder }
}

function fakeDropEventBefore(): DragEvent {
  const target = new FakeElement()
  return {
    clientX: 10,
    clientY: 10,
    currentTarget: target,
    dataTransfer: null,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as DragEvent
}

function applyStateUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update
}

function withFakeHTMLElement(run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeElement })
  try {
    run()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'HTMLElement', descriptor)
    else Reflect.deleteProperty(globalThis, 'HTMLElement')
  }
}

class FakeElement {
  getBoundingClientRect() {
    return { bottom: 100, height: 100, left: 0, right: 100, top: 0, width: 100 }
  }
}
