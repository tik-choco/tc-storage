import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createZipBlob, dataUrlToBytes } from '../src/zip.js'

test('dataUrlToBytes decodes base64 and URL encoded payloads', () => {
  assert.deepEqual([...dataUrlToBytes('data:text/plain;base64,SGVsbG8=')], [72, 101, 108, 108, 111])
  assert.equal(new TextDecoder().decode(dataUrlToBytes('data:text/plain,hello%20zip')), 'hello zip')
})

test('createZipBlob writes a basic ZIP archive with nested paths', async () => {
  const zip = createZipBlob([
    { path: 'Root/', data: new Uint8Array(), modifiedAt: '2026-05-20T00:00:00.000Z' },
    { path: 'Root/a.txt', data: new TextEncoder().encode('alpha'), modifiedAt: '2026-05-20T00:00:00.000Z' },
    { path: 'Root/Nested/b.txt', data: new TextEncoder().encode('beta'), modifiedAt: '2026-05-20T00:00:00.000Z' },
  ])
  const bytes = new Uint8Array(await zip.arrayBuffer())
  const text = new TextDecoder().decode(bytes)

  assert.equal(zip.type, 'application/zip')
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04])
  assert.match(text, /Root\//)
  assert.match(text, /Root\/a\.txt/)
  assert.match(text, /Root\/Nested\/b\.txt/)
  assert.deepEqual([...bytes.slice(-22, -18)], [0x50, 0x4b, 0x05, 0x06])
})

test('createZipBlob rejects traversal paths', () => {
  assert.throws(
    () => createZipBlob([{ path: '../evil.txt', data: new Uint8Array() }]),
    /Invalid ZIP path/,
  )
  assert.throws(
    () => createZipBlob([{ path: 'Root/../../evil.txt', data: new Uint8Array() }]),
    /Invalid ZIP path/,
  )
  assert.throws(
    () => createZipBlob([{ path: 'Root\\..\\evil.txt', data: new Uint8Array() }]),
    /Invalid ZIP path/,
  )
})
