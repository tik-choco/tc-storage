import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { browserViewModeKey, loadBrowserViewMode } from '../src/appUtils.js'

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
