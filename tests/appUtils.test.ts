import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { browserViewModeKey, canPreloadPreviewContent, isMediaFile, largeDownloadConfirmThresholdBytes, loadBrowserViewMode, requiresLargeDownloadConfirmation, shouldPreloadVisibleThumbnail } from '../src/appUtils.js'

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
  const image = { deletedAt: undefined, lastCid: 'cid-a', lastShareCid: undefined, mimeType: 'image/png' }

  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: image, visible: true }), true)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: 'data:image/png;base64,a', file: image, visible: true }), false)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: image, visible: false }), false)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: { ...image, lastCid: '', lastShareCid: '' }, visible: true }), false)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: { ...image, mimeType: 'application/pdf' }, visible: true }), false)
  assert.equal(shouldPreloadVisibleThumbnail({ dataUrl: undefined, file: { ...image, mimeType: 'video/mp4' }, visible: true }), true)
})

test('preview content preload includes inline preview file types', () => {
  const base = { deletedAt: undefined, name: 'file.bin' }

  assert.equal(canPreloadPreviewContent({ ...base, mimeType: 'image/png' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, mimeType: 'video/mp4' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, mimeType: 'audio/mpeg' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, mimeType: 'application/pdf' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, name: 'notes.md', mimeType: 'application/octet-stream' }), true)
  assert.equal(canPreloadPreviewContent({ ...base, mimeType: 'application/octet-stream' }), false)
  assert.equal(canPreloadPreviewContent({ ...base, deletedAt: '2026-05-21T00:00:00.000Z', mimeType: 'audio/mpeg' }), false)
})

test('media file detection includes images and video', () => {
  assert.equal(isMediaFile({ mimeType: 'image/png' }), true)
  assert.equal(isMediaFile({ mimeType: 'video/mp4' }), true)
  assert.equal(isMediaFile({ mimeType: 'application/pdf' }), false)
})

test('large download confirmation starts at 100 MiB', () => {
  assert.equal(requiresLargeDownloadConfirmation(largeDownloadConfirmThresholdBytes - 1), false)
  assert.equal(requiresLargeDownloadConfirmation(largeDownloadConfirmThresholdBytes), true)
  assert.equal(requiresLargeDownloadConfirmation(largeDownloadConfirmThresholdBytes + 1), true)
})
