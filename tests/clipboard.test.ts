import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { reserveClipboardWrite, writeReservedClipboard } from '../src/util/clipboard.js'

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem')

afterEach(() => {
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
  else Reflect.deleteProperty(globalThis, 'navigator')

  if (clipboardItemDescriptor) Object.defineProperty(globalThis, 'ClipboardItem', clipboardItemDescriptor)
  else Reflect.deleteProperty(globalThis, 'ClipboardItem')
})

test('reserveClipboardWrite falls back when clipboard reservation throws synchronously', () => {
  class ThrowingClipboardItem {
    constructor() {
      throw new Error('unsupported clipboard item')
    }
  }

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        write: () => Promise.resolve(),
      },
    },
  })
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: ThrowingClipboardItem })

  assert.equal(reserveClipboardWrite(), undefined)
})

test('reserveClipboardWrite falls back when clipboard.write throws synchronously', () => {
  class TestClipboardItem {
    constructor(_items: Record<string, Promise<Blob> | Blob>) {}
  }

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        write: () => {
          throw new Error('clipboard write denied')
        },
      },
    },
  })
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem })

  assert.equal(reserveClipboardWrite(), undefined)
})

test('writeReservedClipboard resolves the reserved clipboard payload', async () => {
  let clipboardPayload: Promise<Blob> | Blob | undefined
  let writeCalled = false

  class TestClipboardItem {
    constructor(items: Record<string, Promise<Blob> | Blob>) {
      clipboardPayload = items['text/plain']
    }
  }

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        write: () => {
          writeCalled = true
          return (async () => {
            const blob = await clipboardPayload
            assert.ok(blob)
            assert.equal(await blob.text(), 'https://example.test/#tc-share=abc')
          })()
        },
      },
    },
  })
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem })

  const reserved = reserveClipboardWrite()

  assert.ok(reserved)
  assert.equal(writeCalled, true)
  assert.equal(await writeReservedClipboard('https://example.test/#tc-share=abc', reserved), true)
})
