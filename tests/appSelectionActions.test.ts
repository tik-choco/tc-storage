import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSelectionActions } from '../src/app/appSelectionActions.js'
import type { BrowserDragItem, Notice } from '../src/app/appTypes.js'
import { makeFileFromDataUrl, makeFolder, type FileRecord, type FolderRecord } from '../src/storage/domain.js'

type StateUpdate<T> = T | ((current: T) => T)

test('selection move exposes valid targets and moves selected items without drag events', async () => {
  const now = '2026-05-21T00:00:00.000Z'
  const root = makeTestFolder('folder-root', 'Root', null)
  const target = makeTestFolder('folder-target', 'Target', root.id)
  const selectedFolder = makeTestFolder('folder-selected', 'Selected', root.id)
  const childOfSelected = makeTestFolder('folder-child', 'Child', selectedFolder.id)
  const selectedFile = makeTestFile('file-selected', root.id, now)
  const nestedFile = makeTestFile('file-nested', selectedFolder.id, now)
  const folders = [root, target, selectedFolder, childOfSelected]
  const files = [selectedFile, nestedFile]
  let selectedItems: BrowserDragItem[] = [
    { type: 'file', id: selectedFile.id },
    { type: 'folder', id: selectedFolder.id },
    { type: 'file', id: nestedFile.id },
  ]
  let notice: Notice | null = null
  const movedItems: Array<{ item: BrowserDragItem; targetFolderId: string | null }> = []
  const actions = createSelectionActions({
    fileRows: files,
    files,
    folderRows: folders.filter((folder) => folder.parentId === root.id),
    folders,
    moveActions: {
      canMoveItemToFolder: (_item, targetFolderId) => targetFolderId === target.id,
      moveDraggedItem: async (item, targetFolderId) => {
        movedItems.push({ item, targetFolderId })
      },
    },
    selectedItems,
    setDeleteRequest: () => {},
    setNotice: (update) => {
      notice = typeof update === 'function' ? (update as (current: Notice) => Notice)(notice ?? { tone: 'info', text: '' }) : update
    },
    setSelectedItems: (update) => {
      selectedItems = applyStateUpdate(selectedItems, update)
    },
  })

  assert.deepEqual(actions.moveTargetFolders.map((folder) => folder.id), [target.id])

  await actions.moveSelectionToFolder(target.id)

  assert.deepEqual(movedItems, [
    { item: { type: 'file', id: selectedFile.id }, targetFolderId: target.id },
    { item: { type: 'folder', id: selectedFolder.id }, targetFolderId: target.id },
  ])
  assert.deepEqual(selectedItems, [{ type: 'file', id: nestedFile.id }])
  assert.deepEqual(notice, { tone: 'success', text: '2 件を移動しました' })
})

function makeTestFolder(id: string, name: string, parentId: string | null): FolderRecord {
  return makeFolder({ id, name, parentId, color: 'teal', roomId: 'tc-storage-main', now: '2026-05-21T00:00:00.000Z', nodeId: 'node-a' })
}

function makeTestFile(id: string, folderId: string, now: string): FileRecord {
  return makeFileFromDataUrl({ id, folderId, name: `${id}.txt`, mimeType: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,YQ==', checksum: id, now, nodeId: 'node-a' })
}

function applyStateUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === 'function' ? (update as (current: T) => T)(current) : update
}
