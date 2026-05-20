import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeSnapshots, stampFolderPatch } from '../src/crdt.js'
import { createInitialSnapshot, makeFolder } from '../src/domain.js'

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
