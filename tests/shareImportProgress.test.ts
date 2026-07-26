import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isShareImportActive,
  makeShareImportProgress,
  shareImportPhaseLabels,
  withoutShareImportProgress,
  withShareImportProgress,
} from '../src/app/shareImportProgress.js'
import type { ShareImportPhase, ShareImportProgress } from '../src/app/appTypes.js'

const allPhases: ShareImportPhase[] = ['connecting', 'fetching', 'decrypting', 'materializing', 'failed']

test('makeShareImportProgress sets the phase and its label, with no folderId by default', () => {
  for (const phase of allPhases) {
    const progress = makeShareImportProgress(phase)
    assert.equal(progress.phase, phase)
    assert.equal(progress.label, shareImportPhaseLabels[phase])
    assert.equal(progress.folderId, undefined)
  }
})

test('makeShareImportProgress only sets folderId when explicitly passed', () => {
  const withoutFolderId = makeShareImportProgress('materializing')
  assert.equal(withoutFolderId.folderId, undefined)

  const withFolderId = makeShareImportProgress('materializing', { folderId: 'folder-a' })
  assert.equal(withFolderId.folderId, 'folder-a')
})

test('withShareImportProgress adds/replaces a key without mutating the original object', () => {
  const original: Record<string, ShareImportProgress> = { 'share-a': makeShareImportProgress('connecting') }
  const next = withShareImportProgress(original, 'share-b', makeShareImportProgress('fetching'))

  assert.notEqual(next, original)
  assert.deepEqual(Object.keys(original), ['share-a'])
  assert.deepEqual(Object.keys(next), ['share-a', 'share-b'])
  assert.equal(next['share-b']?.phase, 'fetching')

  const replaced = withShareImportProgress(next, 'share-a', makeShareImportProgress('materializing'))
  assert.equal(replaced['share-a']?.phase, 'materializing')
  assert.equal(original['share-a']?.phase, 'connecting', 'original entry for share-a stays untouched')
})

test('withoutShareImportProgress removes a key without mutating the original object', () => {
  const original: Record<string, ShareImportProgress> = {
    'share-a': makeShareImportProgress('connecting'),
    'share-b': makeShareImportProgress('fetching'),
  }
  const next = withoutShareImportProgress(original, 'share-a')

  assert.notEqual(next, original)
  assert.deepEqual(Object.keys(original), ['share-a', 'share-b'])
  assert.deepEqual(Object.keys(next), ['share-b'])
})

test('withoutShareImportProgress returns the same reference when the key is absent', () => {
  const original: Record<string, ShareImportProgress> = { 'share-a': makeShareImportProgress('connecting') }
  const next = withoutShareImportProgress(original, 'share-missing')
  assert.equal(next, original)
})

test('isShareImportActive truth table', () => {
  assert.equal(isShareImportActive(undefined), false)
  for (const phase of allPhases) {
    assert.equal(isShareImportActive(makeShareImportProgress(phase)), phase !== 'failed', `phase ${phase}`)
  }
})
