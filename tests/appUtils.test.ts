import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { activeSharedFolderRoomId, browserViewModeKey, canPreloadPreviewContent, folderSharedRoomId, isMediaFile, largeDownloadConfirmThresholdBytes, loadBrowserViewMode, previewPreloadMaxBytes, requiresLargeDownloadConfirmation, shouldPreloadVisibleThumbnail } from '../src/appUtils.js'

let originalLocalStorage: Storage | undefined
let store: Record<string, string>

beforeEach(() => {
  originalLocalStorage = globalThis.localStorage
  store = {}
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value
      },
    },
  })
})

afterEach(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('browser view mode defaults to grid when no preference is saved', () => {
  assert.equal(loadBrowserViewMode(), 'grid')
})

test('browser view mode keeps an explicitly saved list preference', () => {
  localStorage.setItem(browserViewModeKey, 'list')

  assert.equal(loadBrowserViewMode(), 'list')
})

test('visible thumbnail preload is limited to uncached media with a cid', () => {
  const image = { deletedAt: undefined, lastCid: 'cid-a', lastShareCid: undefined, mimeType: 'image/png', name: 'image.png', size: 1024 }

  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: image, visible: true }), true)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: 'data:image/png;base64,a', file: image, visible: true }), false)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: image, visible: false }), false)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: { ...image, lastCid: '', lastShareCid: '' }, visible: true }), false)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: { ...image, mimeType: 'application/pdf', name: 'file.pdf' }, visible: true }), false)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: { ...image, mimeType: 'video/mp4' }, visible: true }), true)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: { ...image, mimeType: 'application/octet-stream', name: 'clip.mkv' }, visible: true }), true)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: { ...image, mimeType: '', name: 'clip.mkv' }, visible: true }), true)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: { ...image, mimeType: 'video/matroska', name: 'large.mkv', size: largeDownloadConfirmThresholdBytes + 1 }, visible: true }), true)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: { ...image, size: previewPreloadMaxBytes }, visible: true }), false)
})

test('preview content preload includes inline preview file types', () => {
  const base = { deletedAt: undefined, name: 'file.bin', size: 1024 }

  assert.equal(canPreloadPreviewContent({ ...base, mimeType: 'image/png' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, mimeType: 'video/mp4' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, name: 'movie.mkv', mimeType: 'application/octet-stream' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, name: 'movie.mkv', mimeType: '' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, name: 'large.mkv', size: largeDownloadConfirmThresholdBytes + 1, mimeType: 'video/matroska' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, mimeType: 'audio/mpeg' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, name: 'audio.flac', mimeType: 'application/octet-stream' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, mimeType: 'application/pdf' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, name: 'notes.md', mimeType: 'application/octet-stream' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, mimeType: 'application/octet-stream' }), false)
  assert.equal(canPreloadPreviewContent({ ...base, deletedAt: '2026-05-21T00:00:00.000Z', mimeType: 'audio/mpeg' }), false)
  assert.equal(canPreloadPreviewContent({ ...base, size: previewPreloadMaxBytes, mimeType: 'video/mp4' }), false)
})

test('media file detection includes images and video', () => {
  assert.equal(isMediaFile({ mimeType: 'image/png' }), true)
  assert.equal(isMediaFile({ mimeType: 'video/mp4' }), true)
  assert.equal(isMediaFile({ name: 'clip.mkv', mimeType: 'application/octet-stream' }), true)
  assert.equal(isMediaFile({ name: 'clip.mkv', mimeType: '' }), true)
  assert.equal(isMediaFile({ name: 'photo.webp', mimeType: 'application/octet-stream' }), true)
  assert.equal(isMediaFile({ name: 'file.pdf', mimeType: 'application/pdf' }), false)
})

test('large download confirmation starts at 100 MiB', () => {
  assert.equal(requiresLargeDownloadConfirmation(largeDownloadConfirmThresholdBytes - 1), false)
  assert.equal(requiresLargeDownloadConfirmation(largeDownloadConfirmThresholdBytes), true)
  assert.equal(requiresLargeDownloadConfirmation(largeDownloadConfirmThresholdBytes + 1), true)
})

test('active shared folder room follows the nearest shared ancestor', () => {
  const root = { id: 'folder-root', name: 'Root', parentId: null, color: 'teal' as const, encrypted: true, shareEnabled: true, sharedRoomId: 'room-root', createdAt: '2026-05-25T00:00:00.000Z', updatedAt: '2026-05-25T00:00:00.000Z' }
  const child = { id: 'folder-child', name: 'Child', parentId: 'folder-root', color: 'blue' as const, encrypted: true, shareEnabled: false, sharedRoomId: 'room-child', createdAt: root.createdAt, updatedAt: root.updatedAt }
  const other = { id: 'folder-other', name: 'Other', parentId: null, color: 'rose' as const, encrypted: true, shareEnabled: false, sharedRoomId: 'room-other', createdAt: root.createdAt, updatedAt: root.updatedAt }
  const snapshot = { folders: [root, child, other], files: [], activity: [], clock: 1, originNode: 'node-a' }

  assert.equal(folderSharedRoomId({ sharedRoomId: ' room-a ' }, 'fallback'), 'room-a')
  assert.equal(folderSharedRoomId({ sharedRoomId: ' ' }, 'fallback'), 'fallback')
  assert.equal(activeSharedFolderRoomId(snapshot, 'folder-child'), 'room-root')
  assert.equal(activeSharedFolderRoomId(snapshot, 'folder-other'), '')
})
