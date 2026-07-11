import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendHandoffItem, handoffTopicByApp, maxHandoffItems, parseHandoffItems, publishFileHandoff, type FileHandoffItem } from '../src/storage/fileHandoff.js'
import { base64ToBytes, toArrayBuffer } from '../src/crypto/cryptoEncoding.js'
import { sha256Hex } from '../src/crypto/crypto.js'

function makeItem(id: string): FileHandoffItem {
  return { id, name: `${id}.pdf`, mimeType: 'application/pdf', size: 3, checksum: 'c', cid: `cid-${id}`, key: 'k', iv: 'i', addedAt: '2026-07-10T00:00:00.000Z' }
}

test('parseHandoffItems tolerates missing/malformed meta and filters bad entries', () => {
  assert.deepEqual(parseHandoffItems(undefined), [])
  assert.deepEqual(parseHandoffItems({}), [])
  assert.deepEqual(parseHandoffItems({ items: 'nope' }), [])
  const good = makeItem('a')
  const items = parseHandoffItems({ items: [good, { id: '' }, null, 7, { ...makeItem('b'), size: 'big' }] })
  assert.deepEqual(items, [good])
})

test('appendHandoffItem caps the rolling list at the most recent entries', () => {
  const existing = Array.from({ length: maxHandoffItems }, (_, index) => makeItem(`item-${index}`))
  const next = appendHandoffItem(existing, makeItem('newest'))
  assert.equal(next.length, maxHandoffItems)
  assert.equal(next[0]?.id, 'item-1')
  assert.equal(next.at(-1)?.id, 'newest')
})

test('publishFileHandoff encrypts, uploads, and republishes the appended item list', async () => {
  const plaintext = new TextEncoder().encode('hello handoff')
  const added: { name: string; bytes: Uint8Array }[] = []
  const published: { topic: string; cid: string; meta: Record<string, unknown> }[] = []
  const existing = makeItem('existing')

  const item = await publishFileHandoff({
    app: 'tc-pdf-viewer',
    file: { name: 'doc.pdf', mimeType: 'application/pdf' },
    bytes: plaintext,
    nodeId: 'node-1',
    addBytes: async (name, bytes) => {
      added.push({ name, bytes })
      return 'cid-new'
    },
    publish: (topic, cid, meta) => published.push({ topic, cid, meta }),
    readRecord: () => ({ cid: '', meta: { items: [existing] }, updatedAt: '2026-07-10T00:00:00.000Z', from: 'tc-storage' }),
  })

  assert.equal(item.cid, 'cid-new')
  assert.equal(item.name, 'doc.pdf')
  assert.equal(item.size, plaintext.byteLength)
  assert.equal(item.checksum, await sha256Hex(plaintext))
  assert.equal(added.length, 1)
  assert.notDeepEqual(added[0]?.bytes.slice(0, plaintext.byteLength), plaintext)

  assert.equal(published.length, 1)
  assert.equal(published[0]?.topic, handoffTopicByApp['tc-pdf-viewer'])
  assert.equal(published[0]?.cid, '')
  const items = parseHandoffItems(published[0]?.meta)
  assert.deepEqual(items.map((entry) => entry.id), ['existing', item.id])

  // The consumer-side recipe (storage_get → AES-GCM decrypt → checksum check) round-trips.
  const key = await crypto.subtle.importKey('raw', toArrayBuffer(base64ToBytes(item.key)), 'AES-GCM', false, ['decrypt'])
  const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(base64ToBytes(item.iv)) }, key, toArrayBuffer(added[0]!.bytes)))
  assert.deepEqual(decrypted, plaintext)
  assert.equal(await sha256Hex(decrypted), item.checksum)
})

test('publishFileHandoff rejects oversized files without uploading', async () => {
  await assert.rejects(publishFileHandoff({
    app: 'tc-note',
    file: { name: 'big.md', mimeType: 'text/markdown' },
    bytes: new Uint8Array(50 * 1024 * 1024 + 1),
    nodeId: 'node-1',
    addBytes: async () => assert.fail('must not upload'),
    publish: () => assert.fail('must not publish'),
    readRecord: () => null,
  }))
})
