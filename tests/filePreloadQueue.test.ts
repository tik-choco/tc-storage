import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createInitialSnapshot, makeFileFromDataUrl, makeFolder, stripFileContent, type FileRecord, type StorageSnapshot } from '../src/storage/domain.js'
import { stampFilePatch } from '../src/storage/crdt.js'
import { createContentActionsHarness } from './fileContentResave.test.js'

// Grid-view thumbnails call preloadFileContent for every tile that scrolls into
// view; before this fix the queue processed one file at a time
// (queue.running: boolean gate), so a folder with many visible thumbnails took
// file-count x per-file storage_get+decrypt latency just to finish populating.
test('preview preload queue runs several files concurrently instead of one at a time', async () => {
  const { snapshot, folder, files } = snapshotWithFiles(6)
  const queueRef = { current: { items: new Map(), activeCount: 0 } }
  let concurrentCount = 0
  let maxConcurrentSeen = 0
  const releasers: Array<() => void> = []
  const harness = createContentActionsHarness({
    snapshot,
    folderKeys: { [folder.id]: 'folder-secret' },
    fileContentPreloadQueueRef: queueRef,
    loadEncryptedFile: async (cid) => {
      concurrentCount += 1
      maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrentCount)
      await new Promise<void>((resolve) => releasers.push(resolve))
      concurrentCount -= 1
      const file = files.find((item) => item.lastCid === cid)
      if (!file) throw new Error(`no fixture file for cid ${cid}`)
      return { version: 1, exportedAt: '2026-05-21T00:00:00.000Z', originNode: 'node-a', folder, file: { ...file, dataUrl: 'data:text/plain;base64,aGVsbG8=' } }
    },
  })

  for (const file of files) harness.actions.preloadFileContent(file)

  // Scheduling falls back to setTimeout(task, 80) outside a browser
  // (no requestIdleCallback in the test runtime); wait for exactly the
  // concurrency-capped set of calls to reach the mock loader and block on it.
  await waitUntil(() => releasers.length === 4, 500)

  assert.equal(maxConcurrentSeen, 4, 'should run up to the concurrency cap in parallel, not serialize to 1')
  assert.equal(queueRef.current.items.size, 2, 'files beyond the concurrency cap stay queued until a slot frees up')

  releasers.splice(0).forEach((release) => release())
  await waitUntil(() => releasers.length === 2, 500)
  releasers.splice(0).forEach((release) => release())
  await waitUntil(() => queueRef.current.activeCount === 0 && queueRef.current.items.size === 0, 500)
})

function snapshotWithFiles(count: number): { snapshot: StorageSnapshot; folder: ReturnType<typeof makeFolder>; files: FileRecord[] } {
  const now = '2026-05-21T00:00:00.000Z'
  const folder = makeFolder({ id: 'folder-a', name: 'Photos', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: 'node-a' })
  const files = Array.from({ length: count }, (_, index) => {
    const file = makeFileFromDataUrl({
      id: `file-${index}`,
      folderId: folder.id,
      name: `photo-${index}.jpg`,
      mimeType: 'image/jpeg',
      size: 5,
      dataUrl: 'data:image/jpeg;base64,aGVsbG8=',
      checksum: `checksum-${index}`,
      now,
      nodeId: 'node-a',
    })
    return stripFileContent(stampFilePatch(file, { lastCid: `cid-${index}` }, now, 'node-a'))
  })
  const snapshot = { ...createInitialSnapshot('node-a'), folders: [folder], files, activity: [] }
  return { snapshot, folder, files }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
