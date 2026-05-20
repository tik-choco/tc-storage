import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createQrCode } from '../src/qrCode.js'

test('createQrCode returns a square module matrix', () => {
  const qrCode = createQrCode('tc-share=abc')

  assert.equal(qrCode.size, 21)
  assert.equal(qrCode.version, 1)
  assert.equal(qrCode.modules.length, qrCode.size)
  assert.ok(qrCode.modules.every((row) => row.length === qrCode.size))
  assert.ok(qrCode.modules.some((row) => row.some(Boolean)))
})

test('createQrCode supports unicode share URLs', () => {
  const qrCode = createQrCode('https://example.test/#tc-share=共有フォルダー')

  assert.ok(qrCode.version >= 2)
  assert.equal(qrCode.size, qrCode.version * 4 + 17)
})

test('createQrCode rejects URLs that exceed QR capacity', () => {
  assert.throws(() => createQrCode('x'.repeat(4000)), /too long/)
})
