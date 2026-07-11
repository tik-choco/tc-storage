import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  loadImportedNoteState,
  parseNoteDocEntries,
  saveImportedNoteState,
  sanitizeNoteFileBaseName,
} from '../src/app/appNoteDocInbox.js'

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

test('parseNoteDocEntries extracts valid entries and ignores malformed ones', () => {
  const entries = parseNoteDocEntries({
    notes: [
      { id: 'note-1', title: 'Hello', cid: 'cid-1', updatedAt: 1000 },
      { id: 'note-2', title: '', cid: 'cid-2', updatedAt: 2000 }, // empty title is valid
      { id: '', title: 'no id', cid: 'cid-3', updatedAt: 3000 }, // missing id
      { id: 'note-4', title: 'no cid', cid: '', updatedAt: 4000 }, // missing cid
      { id: 'note-5', title: 'bad updatedAt', cid: 'cid-5', updatedAt: 'not-a-number' },
      { id: 'note-6', title: 123, cid: 'cid-6', updatedAt: 6000 }, // title not a string
      null,
      'not an object',
      { id: 'note-7', title: 'ok', cid: 'cid-7', updatedAt: 7000 },
    ],
  })

  assert.deepEqual(entries, [
    { id: 'note-1', title: 'Hello', cid: 'cid-1', updatedAt: 1000 },
    { id: 'note-2', title: '', cid: 'cid-2', updatedAt: 2000 },
    { id: 'note-7', title: 'ok', cid: 'cid-7', updatedAt: 7000 },
  ])
})

test('parseNoteDocEntries returns an empty array when notes is missing or not an array', () => {
  assert.deepEqual(parseNoteDocEntries({}), [])
  assert.deepEqual(parseNoteDocEntries({ notes: 'nope' }), [])
  assert.deepEqual(parseNoteDocEntries({ notes: null }), [])
})

test('parseNoteDocEntries caps at 500 entries even if the publisher sends more', () => {
  const notes = Array.from({ length: 600 }, (_, index) => ({ id: `note-${index}`, title: `Note ${index}`, cid: `cid-${index}`, updatedAt: index }))
  const entries = parseNoteDocEntries({ notes })
  assert.equal(entries.length, 500)
  assert.equal(entries[0]?.id, 'note-0')
  assert.equal(entries[499]?.id, 'note-499')
})

test('sanitizeNoteFileBaseName strips Windows-invalid characters and trims whitespace', () => {
  assert.equal(sanitizeNoteFileBaseName('  My: Note/Idea*?  '), 'My NoteIdea')
  assert.equal(sanitizeNoteFileBaseName('normal title'), 'normal title')
  assert.equal(sanitizeNoteFileBaseName('a<b>c"d|e'), 'abcde')
})

test('sanitizeNoteFileBaseName falls back to a placeholder for an empty or whitespace-only title', () => {
  assert.equal(sanitizeNoteFileBaseName(''), '無題')
  assert.equal(sanitizeNoteFileBaseName('   '), '無題')
  assert.equal(sanitizeNoteFileBaseName('***'), '無題')
})

test('imported note state round-trips through localStorage', () => {
  const state = new Map([
    ['note-1', { cid: 'cid-1', fileId: 'file-1' }],
    ['note-2', { cid: 'cid-2', fileId: 'file-2' }],
  ])
  saveImportedNoteState(state)

  const loaded = loadImportedNoteState()
  assert.deepEqual([...loaded.entries()], [...state.entries()])
})

test('loadImportedNoteState tolerates missing, corrupt, or malformed JSON', () => {
  assert.deepEqual(loadImportedNoteState(), new Map())

  store['tc-storage-note-doc-imported-v1'] = 'not json'
  assert.deepEqual(loadImportedNoteState(), new Map())

  store['tc-storage-note-doc-imported-v1'] = JSON.stringify([1, 2, 3])
  assert.deepEqual(loadImportedNoteState(), new Map())

  store['tc-storage-note-doc-imported-v1'] = JSON.stringify({ v: 2, entries: {} })
  assert.deepEqual(loadImportedNoteState(), new Map())

  store['tc-storage-note-doc-imported-v1'] = JSON.stringify({ v: 1, entries: { 'note-1': { cid: 'cid-1' } } })
  assert.deepEqual(loadImportedNoteState(), new Map()) // missing fileId is dropped

  store['tc-storage-note-doc-imported-v1'] = JSON.stringify({ v: 1, entries: { 'note-1': { cid: 'cid-1', fileId: 'file-1' }, 'note-2': 'not-an-object' } })
  assert.deepEqual([...loadImportedNoteState().entries()], [['note-1', { cid: 'cid-1', fileId: 'file-1' }]])
})

test('saveImportedNoteState caps to the 1000 most recently touched entries', () => {
  const state = new Map<string, { cid: string; fileId: string }>()
  for (let index = 0; index < 1200; index += 1) {
    state.set(`note-${index}`, { cid: `cid-${index}`, fileId: `file-${index}` })
  }
  saveImportedNoteState(state)

  const loaded = loadImportedNoteState()
  assert.equal(loaded.size, 1000)
  assert.equal(loaded.has('note-199'), false) // oldest 200 dropped
  assert.equal(loaded.has('note-200'), true)
  assert.equal(loaded.has('note-1199'), true)
})
