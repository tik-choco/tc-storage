import assert from 'node:assert/strict'
import { test } from 'node:test'
import { immediateConnectionAnnounceKey } from '../src/useAppEffects.js'

test('immediateConnectionAnnounceKey waits for stable mist peers', () => {
  const base = {
    autoConnect: true,
    networkMode: 'mistlib',
    nodeId: 'node-a',
    roomId: 'tc-storage-main',
    stablePeerCount: 0,
    stablePeerKey: '',
  }

  assert.equal(immediateConnectionAnnounceKey(base), '')
  assert.equal(immediateConnectionAnnounceKey({ ...base, stablePeerCount: 1, stablePeerKey: 'node-b' }), 'tc-storage-main:node-a:node-b')
})

test('immediateConnectionAnnounceKey does not fire while disabled or outside mistlib', () => {
  const base = {
    autoConnect: true,
    networkMode: 'local-gossip',
    nodeId: 'node-a',
    roomId: 'tc-storage-main',
    stablePeerCount: 1,
    stablePeerKey: 'node-b',
  }

  assert.equal(immediateConnectionAnnounceKey(base), '')
  assert.equal(immediateConnectionAnnounceKey({ ...base, autoConnect: false, networkMode: 'mistlib' }), '')
})
