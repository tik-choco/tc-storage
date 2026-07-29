import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createShareImportActions } from '../src/app/appShareImportActions.js'
import type { Notice, PendingShare } from '../src/app/appTypes.js'
import { createInitialSnapshot } from '../src/storage/domain.js'
import { applyStateUpdate, networkStub, settingsStub } from './accessApprovalHelpers.js'

// These tests exercise `autoImportLinkedShare`'s failure path (see appShareImportActions.ts's
// `pendingShareRetryNotice`): a failed storage_get should only be reported as "waiting for the
// sender to come online" when the share's room genuinely has no stable peer. When a stable peer
// is present, the fetch failure is something else (block not replicated yet, decrypt trouble,
// ...) and should be surfaced as such instead of misreporting the sender as offline.
//
// The fetch itself is left unstubbed, same as the "linked share import can force retry" case in
// retryBackoff.test.ts: loadEncryptedFileFromMist naturally fails against the bogus cid in this
// Node test environment, which is enough to drive the catch branch under test.

const waitingNoticeText = '共有データを待機中です。送り主がオンラインになったら自動的に再試行します'

function linkedFileShare(): PendingShare {
  return {
    type: 'file-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 2,
    cid: 'cid-missing-file',
    folderId: 'folder-shared',
    fileId: 'file-shared',
    fileName: 'Shared file',
    autoImport: true,
  }
}

function shareImportActionsFor(share: PendingShare, network: ReturnType<typeof networkStub>, captureNotice: (notice: Notice) => void) {
  const pendingSharesRef = { current: [share] }
  return createShareImportActions({
    autoImportCidsRef: { current: new Set() },
    autoImportFailuresRef: { current: {} },
    autoImportInFlightRef: { current: new Set() },
    clearFolderSyncTimer: () => {},
    importKeys: { [share.cid ?? '']: 'secret' },
    materializeFolderBundleFiles: async (bundle) => bundle,
    networkRef: { current: network },
    pendingSharesRef,
    rememberFolderPeer: () => {},
    setBusy: () => {},
    setCurrentFolderId: () => {},
    setDetailFileId: () => {},
    setFileContentCache: () => {},
    setFileShareKeys: () => {},
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: (update) => { captureNotice(applyStateUpdate({ tone: 'info', text: '' } as Notice, update)) },
    setPendingShares: (update) => { pendingSharesRef.current = applyStateUpdate(pendingSharesRef.current, update) },
    setShareImportProgress: () => {},
    setSnapshot: () => {},
    settingsRef: { current: settingsStub('node-a') },
    snapshotRef: { current: createInitialSnapshot('node-a') },
    syncSignaturesRef: { current: {} },
  })
}

test('reports "waiting for sender" when the share room has no stable peer', async () => {
  const share = linkedFileShare()
  const network = networkStub()
  // stablePeersByRoom has no entry at all for this room -- the default, empty-network case.
  let notice: Notice | undefined
  const actions = shareImportActionsFor(share, network, (next) => { notice = next })

  await actions.autoImportLinkedShare(share, 'secret')

  assert.equal(notice?.tone, 'info')
  assert.equal(notice?.text, waitingNoticeText)
})

test('reports the underlying fetch failure when a stable peer is present in the share room', async () => {
  const share = linkedFileShare()
  const network = networkStub()
  network.state.stablePeersByRoom[share.roomId] = ['peer-b']
  let notice: Notice | undefined
  const actions = shareImportActionsFor(share, network, (next) => { notice = next })

  await actions.autoImportLinkedShare(share, 'secret')

  assert.equal(notice?.tone, 'info')
  assert.notEqual(notice?.text, waitingNoticeText)
  assert.match(notice?.text ?? '', /共有データをまだ取得できません/)
})

test('still reports "waiting for sender" when the stable peer is in a different room', async () => {
  const share = linkedFileShare()
  const network = networkStub()
  network.state.stablePeersByRoom['some-other-room'] = ['peer-b']
  let notice: Notice | undefined
  const actions = shareImportActionsFor(share, network, (next) => { notice = next })

  await actions.autoImportLinkedShare(share, 'secret')

  assert.equal(notice?.tone, 'info')
  assert.equal(notice?.text, waitingNoticeText)
})
