import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeError } from '../src/util/errors.js'

test('describeError preserves Error and string messages', () => {
  assert.equal(describeError(new Error('storage_add failed'), 'fallback'), 'storage_add failed')
  assert.equal(describeError('mistlib send failed', 'fallback'), 'mistlib send failed')
})

test('describeError falls back for empty or opaque thrown values', () => {
  assert.equal(describeError('', 'fallback'), 'fallback')
  assert.equal(describeError({}, 'fallback'), 'fallback')
})
