import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { loadSettings } from '../src/localSettings.js'

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
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true })
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('default settings use a private room and do not auto-connect', () => {
  const settings = loadSettings()
  const reloaded = loadSettings()

  assert.match(settings.roomId, /^tc-storage-/)
  assert.notEqual(settings.roomId, 'tc-storage-main')
  assert.equal(reloaded.roomId, settings.roomId)
  assert.equal(settings.autoConnect, false)
})

test('stored settings keep an explicit room and auto-connect preference', () => {
  localStorage.setItem('tc-storage-settings-v1', JSON.stringify({
    roomId: 'tc-storage-main',
    signalingUrl: 'https://rtc.example.test/signaling',
    nodeId: 'node-a',
    autoConnect: true,
    profileName: 'A',
  }))

  const settings = loadSettings()

  assert.equal(settings.roomId, 'tc-storage-main')
  assert.equal(settings.autoConnect, true)
})
