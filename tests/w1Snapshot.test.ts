import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactSnapshotTombstones, dropAllTombstones, makeFileFromDataUrl, makeFolder, stripFileContent, type StorageSnapshot } from '../src/storage/domain.js'
import { loadStoredSnapshot, persistSnapshot } from '../src/storage/localSnapshot.js'
import { normalizeFileVersions } from '../src/storage/crdt.js'

const old = '2025-01-01T00:00:00.000Z'
const now = Date.parse('2026-10-12T00:00:00.000Z')
function folder(id: string, parentId: string | null = null) {
  return makeFolder({ id, name: id, parentId, color: 'teal', roomId: 'room', now: old, nodeId: 'author' })
}
function file(id: string, folderId: string) {
  return makeFileFromDataUrl({ id, name: id, folderId, mimeType: 'text/plain', size: 5,
    dataUrl: 'data:text/plain;base64,aGVsbG8=', checksum: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', now: old, nodeId: 'author' })
}
function memory(value: unknown) {
  let text = JSON.stringify(value)
  return { getItem: () => text, setItem: (_key: string, next: string) => { text = next } }
}

test('snapshot migration isolates malformed records, repairs hierarchy, deduplicates IDs, and normalizes legacy defaults and stamps', () => {
  const legacyFolder = { ...folder('legacy'), parentId: 'missing', fieldVersions: undefined, color: undefined, encrypted: undefined, shareEnabled: undefined }
  const legacyFile = { ...file('legacy-file', 'legacy'), version: undefined, starred: undefined, fieldVersions: undefined }
  const partial = { ...file('partial', 'legacy'), fieldVersions: { name: { updatedAt: old, nodeId: 'remote' }, size: { updatedAt: 'bad', nodeId: 3 } } }
  const snapshot = { folders: [null, legacyFolder, { ...folder('bad-date'), updatedAt: 'bad' }, { ...folder('bad-escrow'), escrow: { mode: 'custom', room: 'spaces invalid' } }, folder('cycle-a', 'cycle-b'), folder('cycle-b', 'cycle-a'), folder('duplicate'), folder('duplicate')],
    files: [null, legacyFile, partial, { ...file('negative', 'legacy'), size: -1 }, { ...file('infinite', 'legacy'), size: Infinity }, { ...file('bad-hash', 'legacy'), checksum: 'bad' }, file('duplicate', 'legacy')],
    activity: [null, { id: 'entry', actorNodeId: 'author', action: 'create', detail: 'valid', at: old }, { at: 'bad' }], clock: -1, originNode: 'original' }
  const result = loadStoredSnapshot('local', memory(snapshot), now)
  assert.equal(result.loadedFromStorage, true)
  assert.deepEqual(result.snapshot.files.map(f => f.id).sort(), ['legacy-file', 'partial'])
  assert.equal(result.snapshot.folders.length, 4)
  assert.equal(result.snapshot.folders.find(f => f.id === 'legacy')?.parentId, null)
  assert.equal(result.snapshot.folders.find(f => f.id === 'cycle-a')?.parentId, null)
  assert.equal(result.snapshot.clock, 0)
  assert.equal(result.snapshot.activity.length, 1)
  const migrated = result.snapshot.files.find(f => f.id === 'legacy-file')!
  assert.equal(migrated.version, 1)
  assert.equal(migrated.starred, false)
  assert.deepEqual(migrated.fieldVersions, normalizeFileVersions({ ...legacyFile, version: 1, starred: false }, 'original').fieldVersions)
  assert.deepEqual(result.snapshot.files.find(f => f.id === 'partial')!.fieldVersions!.name, partial.fieldVersions.name)
  assert.equal(result.snapshot.files.find(f => f.id === 'partial')!.fieldVersions!.size.nodeId, 'original')
})

function tombstones(): StorageSnapshot {
  const root = { ...folder('root'), shareEnabled: true }
  const custom = { ...folder('custom'), shareEnabled: true, escrow: { mode: 'custom' as const, room: 'escrow' } }
  const off = { ...folder('off'), shareEnabled: true, escrow: { mode: 'off' as const, room: '' } }
  const child = { ...folder('child', 'root'), deletedAt: old }
  const plain = { ...folder('plain'), deletedAt: old }
  return { folders: [root, custom, off, child, plain],
    files: [{ ...file('protected', 'child'), deletedAt: old }, { ...file('custom-protected', 'custom'), deletedAt: old }, { ...file('off-file', 'off'), deletedAt: old }, { ...file('plain-file', 'plain'), deletedAt: old }],
    activity: [], clock: 1, originNode: 'author', scopeTombstones: [
      { scopeId: 'root', folders: [{ ...folder('moved-child', 'root'), deletedAt: old }], files: [{ ...file('moved-file', 'moved-child'), deletedAt: old }] },
      { scopeId: 'off', folders: [], files: [{ ...file('unprotected-exit', 'off'), deletedAt: old }] } ] }
}

test('90-day pruning retains Auto and Custom escrow tombstones and source exits while pruning Off and ordinary records', () => {
  const snapshot = tombstones()
  const compacted = compactSnapshotTombstones(snapshot, now)
  assert.deepEqual(compacted.files.map(f => f.id), ['protected', 'custom-protected'])
  assert.ok(compacted.folders.some(f => f.id === 'child'))
  assert.ok(!compacted.folders.some(f => f.id === 'plain'))
  assert.equal(compacted.scopeTombstones![0].files.length, 1)
  assert.equal(compacted.scopeTombstones![1].files.length, 0)
  const loaded = loadStoredSnapshot('local', memory(snapshot), now)
  assert.deepEqual(loaded.snapshot.files.map(f => f.id).sort(), ['custom-protected', 'protected'])
  assert.equal(loaded.snapshot.scopeTombstones![0].files.length, 1)
})

test('quota fallback preserves escrow tombstones and source history without mutating memory', () => {
  const snapshot = tombstones(), original = structuredClone(snapshot)
  let attempts = 0, persisted = ''
  const storage = { getItem: () => persisted, setItem: (_key: string, value: string) => {
    if (++attempts <= 2) throw new DOMException('quota', 'QuotaExceededError')
    persisted = value
  } }
  assert.equal(persistSnapshot(snapshot, storage), true)
  const saved = JSON.parse(persisted) as StorageSnapshot
  assert.deepEqual(saved.files.map(f => f.id), ['protected', 'custom-protected'])
  assert.equal(saved.scopeTombstones!.length, 1)
  assert.equal(saved.scopeTombstones![0].files[0].dataUrl, undefined)
  assert.deepEqual(snapshot, original)
  assert.deepEqual(dropAllTombstones(snapshot).files.map(f => f.id), ['protected', 'custom-protected'])
})

test('quota exhaustion fails persistence instead of dropping the final escrow tombstones', () => {
  const snapshot = tombstones()
  const storage = { getItem: () => null, setItem: (_key: string, value: string) => {
    const data = JSON.parse(value) as StorageSnapshot
    if (data.files.some(f => f.id === 'protected') || data.scopeTombstones?.some(s => s.scopeId === 'root')) throw new DOMException('quota', 'QuotaExceededError')
  } }
  assert.equal(persistSnapshot(snapshot, storage), false)
})

test('source move history survives persistence and per-record validation without replacing the active destination', () => {
  const snapshot = tombstones()
  snapshot.files.push(file('moved-file', 'off'))
  snapshot.scopeTombstones![0].files.push(null as never)
  const loaded = loadStoredSnapshot('local', memory(snapshot), now)
  assert.equal(loaded.loadedFromStorage, true)
  assert.equal(loaded.snapshot.scopeTombstones![0].files.length, 1)
  assert.equal(loaded.snapshot.files.find(f => f.id === 'moved-file')!.folderId, 'off')
  assert.equal(loaded.snapshot.files.find(f => f.id === 'moved-file')!.deletedAt, undefined)
})

test('content stripping is idempotent and preserves existing CRDT versions', () => {
  const stripped = stripFileContent(file('file', 'root'))
  assert.deepEqual(stripFileContent(stripped), stripped)
  assert.ok(stripped.fieldVersions?.checksum)
  assert.equal(stripped.fieldVersions?.dataUrl, undefined)
})
