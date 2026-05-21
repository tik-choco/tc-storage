import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { browserViewModeKey, loadBrowserViewMode, shouldPreloadVisibleThumbnail } from '../src/appUtils.js'

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
})
