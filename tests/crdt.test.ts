import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeSnapshots, normalizeSnapshot, stampFilePatch, stampFolderPatch } from '../src/storage/crdt.js'
import { createInitialSnapshot, makeFileFromDataUrl, makeFolder, type StorageSnapshot } from '../src/storage/domain.js'

test('mergeSnapshots keeps independent folder field edits', () => {
  const base = snapshotWithFolder()
  const folder = base.folders[0]!

  const local = {
    ...base,
    originNode: 'node-local',
    folders: [stampFolderPatch(folder, { name: 'Product Local' }, '2099-05-16T00:00:01.000Z', 'node-local')],
  }
  const remote = {
    ...base,
    originNode: 'node-remote',
    folders: [stampFolderPatch(folder, { color: 'rose' }, '2099-05-16T00:00:02.000Z', 'node-remote')],
  }

  const merged = mergeSnapshots(local, remote)
  const mergedFolder = merged.folders.find((item) => item.id === folder.id)
  assert.equal(mergedFolder?.name, 'Product Local')
  assert.equal(mergedFolder?.color, 'rose')
})

test('field stamp tie breaks by node id', () => {
  const base = snapshotWithFolder()
  const folder = base.folders[0]!
  const stamp = '2099-05-16T00:00:01.000Z'
  const left = { ...base, folders: [stampFolderPatch(folder, { name: 'Alpha' }, stamp, 'node-a')] }
  const right = { ...base, folders: [stampFolderPatch(folder, { name: 'Zulu' }, stamp, 'node-z')] }

  const merged = mergeSnapshots(left, right)
  assert.equal(merged.folders.find((item) => item.id === folder.id)?.name, 'Zulu')
})

test('mergeSnapshots is idempotent for CRDT content', () => {
  const { folder, snapshot } = snapshotWithFolderAndFile()
  const edited = {
    ...snapshot,
    clock: 5,
    folders: [stampFolderPatch(folder, { name: 'Product Docs' }, '2099-05-16T00:00:01.000Z', 'node-a')],
  }

  const once = mergeSnapshots(edited, edited)
  const twice = mergeSnapshots(once, edited)

  assert.equal(once.clock, 5)
  assert.deepEqual(crdtContent(twice), crdtContent(once))
})

test('mergeSnapshots is commutative for CRDT content', () => {
  const { folder, snapshot } = snapshotWithFolderAndFile()
  const left = {
    ...snapshot,
    clock: 3,
    originNode: 'node-left',
    folders: [stampFolderPatch(folder, { name: 'Left Name' }, '2099-05-16T00:00:01.000Z', 'node-left')],
  }
  const right = {
    ...snapshot,
    clock: 8,
    originNode: 'node-right',
    folders: [stampFolderPatch(folder, { color: 'rose' }, '2099-05-16T00:00:02.000Z', 'node-right')],
  }

  assert.deepEqual(crdtContent(mergeSnapshots(left, right)), crdtContent(mergeSnapshots(right, left)))
})

test('mergeSnapshots is associative for CRDT content', () => {
  const { file, folder, snapshot } = snapshotWithFolderAndFile()
  const a = { ...snapshot, clock: 2, folders: [stampFolderPatch(folder, { name: 'Alpha' }, '2099-05-16T00:00:01.000Z', 'node-a')], files: [file] }
  const b = { ...snapshot, clock: 5, folders: [stampFolderPatch(folder, { color: 'amber' }, '2099-05-16T00:00:02.000Z', 'node-b')], files: [file] }
  const c = { ...snapshot, clock: 4, files: [stampFilePatch(file, { name: 'roadmap-final.md' }, '2099-05-16T00:00:03.000Z', 'node-c')] }

  const left = mergeSnapshots(mergeSnapshots(a, b), c)
  const right = mergeSnapshots(a, mergeSnapshots(b, c))

  assert.deepEqual(crdtContent(left), crdtContent(right))
})

test('mergeSnapshots keeps independent file field edits', () => {
  const { file, snapshot } = snapshotWithFolderAndFile()
  const left = {
    ...snapshot,
    originNode: 'node-left',
    files: [stampFilePatch(file, { name: 'roadmap-final.md' }, '2099-05-16T00:00:01.000Z', 'node-left')],
  }
  const right = {
    ...snapshot,
    originNode: 'node-right',
    files: [stampFilePatch(file, { checksum: 'checksum-two', size: 42, version: 2 }, '2099-05-16T00:00:02.000Z', 'node-right')],
  }

  const mergedFile = mergeSnapshots(left, right).files.find((item) => item.id === file.id)

  assert.equal(mergedFile?.name, 'roadmap-final.md')
  assert.equal(mergedFile?.checksum, 'checksum-two')
  assert.equal(mergedFile?.size, 42)
  assert.equal(mergedFile?.version, 2)
})

test('mergeSnapshots preserves tombstones across concurrent file edits', () => {
  const { file, snapshot } = snapshotWithFolderAndFile()
  const renamed = {
    ...snapshot,
    files: [stampFilePatch(file, { name: 'renamed.md' }, '2099-05-16T00:00:01.000Z', 'node-a')],
  }
  const deleted = {
    ...snapshot,
    files: [stampFilePatch(file, { deletedAt: '2099-05-16T00:00:02.000Z' }, '2099-05-16T00:00:02.000Z', 'node-b')],
  }

  const mergedFile = mergeSnapshots(renamed, deleted).files.find((item) => item.id === file.id)

  assert.equal(mergedFile?.name, 'renamed.md')
  assert.equal(mergedFile?.deletedAt, '2099-05-16T00:00:02.000Z')
})

test('mergeSnapshots repairs concurrent folder move cycles deterministically', () => {
  const now = '2026-05-17T00:00:00.000Z'
  const folderA = makeFolder({ id: 'folder-a', name: 'A', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const folderB = makeFolder({ id: 'folder-b', name: 'B', parentId: null, color: 'blue', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const snapshot = { ...createInitialSnapshot('node-a'), folders: [folderA, folderB], activity: [] }
  const left = { ...snapshot, folders: [stampFolderPatch(folderA, { parentId: folderB.id }, '2099-05-16T00:00:01.000Z', 'node-a'), folderB] }
  const right = { ...snapshot, folders: [folderA, stampFolderPatch(folderB, { parentId: folderA.id }, '2099-05-16T00:00:01.000Z', 'node-b')] }

  const merged = mergeSnapshots(left, right)

  assertNoFolderCycles(merged)
  assert.equal(merged.folders.find((item) => item.id === folderA.id)?.parentId, null)
  assert.equal(merged.folders.find((item) => item.id === folderB.id)?.parentId, folderA.id)
})

test('mergeSnapshots detaches folders whose parent is missing', () => {
  const now = '2026-05-17T00:00:00.000Z'
  const orphan = makeFolder({ id: 'folder-orphan', name: 'Orphan', parentId: 'folder-missing', color: 'slate', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const snapshot = { ...createInitialSnapshot('node-a'), folders: [orphan], activity: [] }

  const merged = mergeSnapshots({ ...createInitialSnapshot('node-b'), activity: [] }, snapshot)

  assert.equal(merged.folders.find((item) => item.id === orphan.id)?.parentId, null)
})

test('mergeSnapshots merges activity deterministically', () => {
  const left = {
    ...createInitialSnapshot('node-a'),
    activity: [
      { id: 'activity-same', actorNodeId: 'node-a', action: 'folder.rename', detail: 'A', at: '2099-05-16T00:00:01.000Z' },
      { id: 'activity-b', actorNodeId: 'node-a', action: 'file.upload', detail: 'B', at: '2099-05-16T00:00:02.000Z' },
    ],
  }
  const right = {
    ...createInitialSnapshot('node-b'),
    activity: [
      { id: 'activity-same', actorNodeId: 'node-b', action: 'folder.rename', detail: 'Z', at: '2099-05-16T00:00:01.000Z' },
      { id: 'activity-a', actorNodeId: 'node-b', action: 'file.delete', detail: 'A', at: '2099-05-16T00:00:02.000Z' },
    ],
  }

  const leftFirst = mergeSnapshots(left, right)
  const rightFirst = mergeSnapshots(right, left)

  assert.deepEqual(crdtContent(leftFirst), crdtContent(rightFirst))
  assert.deepEqual(leftFirst.activity.map((entry) => entry.id), ['activity-a', 'activity-b', 'activity-same'])
  assert.equal(leftFirst.activity.find((entry) => entry.id === 'activity-same')?.detail, 'Z')
})

function snapshotWithFolder() {
  const now = '2026-05-17T00:00:00.000Z'
  const folder = makeFolder({
    id: 'folder-product',
    name: 'Product',
    parentId: null,
    color: 'teal',
    roomId: 'tc-storage-main',
    now,
    nodeId: 'node-a',
  })
  return { ...createInitialSnapshot('node-a'), folders: [folder] }
}

function snapshotWithFolderAndFile() {
  const now = '2026-05-17T00:00:00.000Z'
  const folder = makeFolder({
    id: 'folder-product',
    name: 'Product',
    parentId: null,
    color: 'teal',
    roomId: 'tc-storage-main',
    now,
    nodeId: 'node-a',
  })
  const file = makeFileFromDataUrl({
    id: 'file-roadmap',
    folderId: folder.id,
    name: 'roadmap.md',
    mimeType: 'text/markdown',
    size: 4,
    dataUrl: 'data:text/markdown;base64,dGVzdA==',
    checksum: 'checksum',
    now,
    nodeId: 'node-a',
  })
  return { file, folder, snapshot: { ...createInitialSnapshot('node-a'), folders: [folder], files: [file], activity: [] } }
}

function crdtContent(snapshot: StorageSnapshot) {
  const normalized = normalizeSnapshot(snapshot)
  return {
    folders: normalized.folders,
    files: normalized.files,
    activity: normalized.activity,
    clock: normalized.clock,
  }
}

function assertNoFolderCycles(snapshot: StorageSnapshot): void {
  const foldersById = new Map(snapshot.folders.map((folder) => [folder.id, folder]))
  for (const folder of snapshot.folders) {
    const visited = new Set<string>()
    let current = folder
    while (current.parentId) {
      assert.equal(visited.has(current.id), false, `folder cycle detected at ${current.id}`)
      visited.add(current.id)
      const parent = foldersById.get(current.parentId)
      if (!parent) break
      current = parent
    }
  }
}
