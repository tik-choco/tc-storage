import assert from 'node:assert/strict'
import { test } from 'node:test'
import { familyAppUrl } from '../src/util/familyApps.js'

test('familyAppUrl resolves sibling app from production base path', () => {
  assert.equal(familyAppUrl('tc-pdf-viewer', '/tc-storage/', 'https://tik-choco.github.io'), 'https://tik-choco.github.io/tc-pdf-viewer/')
  assert.equal(familyAppUrl('tc-note', '/tc-storage/', 'https://tik-choco.github.io'), 'https://tik-choco.github.io/tc-note/')
})

test('familyAppUrl resolves sibling app behind dev-proxy', () => {
  assert.equal(familyAppUrl('tc-pdf-viewer', '/tc-storage/', 'http://localhost:8080'), 'http://localhost:8080/tc-pdf-viewer/')
})

test('familyAppUrl falls back to origin root for root base path', () => {
  assert.equal(familyAppUrl('tc-note', '/', 'http://localhost:5102'), 'http://localhost:5102/tc-note/')
})
