import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FolderAccessRequest } from '../src/app/appTypes.js'
import { createAccessActions } from '../src/app/appAccessActions.js'
import { createAccessRequestKey } from '../src/crypto/accessGrantCrypto.js'
import { createInitialSnapshot, makeFolder } from '../src/storage/domain.js'
import type { ShareEnvelope } from '../src/p2p/p2p.js'
import type { FolderAccessGrants } from '../src/folder/folderAccessGrants.js'
import { applyStateUpdate, expectedFolderKeyHash, fixedFolderId, folderSecret, networkStub, otherDid, ownerDid, requesterDid, settingsStub } from './accessApprovalHelpers.js'

// --- Requester side: a granted folder must not mint a fresh requestId every retry tick -------

test('requestFolderAccess does not broadcast once the folder key is already held', async () => {
  const broadcasts: unknown[] = []
  const actions = createAccessActions({
    accessRequestKeysRef: { current: {} },
    folderAccessGrantsRef: { current: {} },
    folderAccessModesRef: { current: {} },
    handledAccessRequestsRef: { current: {} },
    folderKeysRef: { current: { [fixedFolderId]: folderSecret } },
    networkRef: { current: networkStub(broadcasts) },
    openFolderAccessRequests: () => {},
    setFolderAccessRequests: () => {},
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: () => {},
    setPendingShares: () => {},
    settingsRef: { current: settingsStub(requesterDid) },
    snapshotRef: { current: createInitialSnapshot(requesterDid) },
  })

  await actions.requestFolderAccess({
    type: 'folder-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 0,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    ownerNodeId: ownerDid,
    folderKeyHash: expectedFolderKeyHash,
    autoImport: true,
  })

  assert.deepEqual(broadcasts, [])
})

test('requestFolderAccess still broadcasts when the folder key has not been granted yet', async () => {
  // Contrast case for the test above: without a held folder key the guard must not fire, so the
  // usual first-request broadcast still happens.
  const broadcasts: unknown[] = []
  const actions = createAccessActions({
    accessRequestKeysRef: { current: {} },
    folderAccessGrantsRef: { current: {} },
    folderAccessModesRef: { current: {} },
    handledAccessRequestsRef: { current: {} },
    folderKeysRef: { current: {} },
    networkRef: { current: networkStub(broadcasts) },
    openFolderAccessRequests: () => {},
    setFolderAccessRequests: () => {},
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: () => {},
    setPendingShares: () => {},
    settingsRef: { current: settingsStub(requesterDid) },
    snapshotRef: { current: createInitialSnapshot(requesterDid) },
  })

  await actions.requestFolderAccess({
    type: 'folder-share',
    from: 'share-url',
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:00.000Z',
    receivedAt: '2026-05-21T00:00:01.000Z',
    clock: 0,
    folderId: fixedFolderId,
    folderName: 'Fixed invite',
    ownerNodeId: ownerDid,
    folderKeyHash: expectedFolderKeyHash,
    autoImport: true,
  })

  assert.equal(broadcasts.length, 1)
  assert.equal((broadcasts[0] as { type?: string }).type, 'folder-access-request')
})

// --- Approver side: a resend of an already-decided request must replay silently --------------

async function approverFixture(broadcasts: unknown[]) {
  // A real ECDH public key is required here (not a placeholder string like the other
  // handleFolderAccessRequest tests use), since these tests exercise approveFolderAccess all the
  // way through sendFolderAccessGrant, which actually encrypts the folder key for it.
  const accessKey = await createAccessRequestKey()
  const now = '2026-05-21T00:00:00.000Z'
  const folder = { ...makeFolder({ id: fixedFolderId, name: 'Fixed invite', parentId: null, color: 'teal', roomId: 'tc-storage-main', now, nodeId: ownerDid }), shareEnabled: true }
  const snapshot = { ...createInitialSnapshot(ownerDid), folders: [folder], files: [], activity: [] }
  let accessRequests: FolderAccessRequest[] = []
  let opened = 0
  const noticeTexts: string[] = []
  const folderAccessGrantsRef = { current: {} as FolderAccessGrants }
  const actions = createAccessActions({
    accessRequestKeysRef: { current: {} },
    folderAccessGrantsRef,
    folderAccessModesRef: { current: {} },
    handledAccessRequestsRef: { current: {} },
    folderKeysRef: { current: { [folder.id]: folderSecret } },
    networkRef: { current: networkStub(broadcasts) },
    openFolderAccessRequests: () => { opened += 1 },
    setFolderAccessRequests: (update) => { accessRequests = applyStateUpdate(accessRequests, update) },
    setFolderKeys: () => {},
    setImportKeys: () => {},
    setNotice: (update) => { noticeTexts.push(applyStateUpdate({ tone: 'info' as const, text: '' }, update).text) },
    setPendingShares: () => {},
    settingsRef: { current: settingsStub(ownerDid) },
    snapshotRef: { current: snapshot },
  })
  const envelope: ShareEnvelope = {
    type: 'folder-access-request',
    from: requesterDid,
    roomId: 'tc-storage-main',
    sentAt: '2026-05-21T00:00:02.000Z',
    clock: 2,
    folderId: folder.id,
    folderName: folder.name,
    folderKeyHash: expectedFolderKeyHash,
    targetNodeId: ownerDid,
    requestId: 'request-a',
    accessPublicKey: accessKey.publicKey,
  }
  return {
    actions,
    envelope,
    folder,
    folderAccessGrantsRef,
    getAccessRequests: () => accessRequests,
    getOpened: () => opened,
    getNoticeTexts: () => noticeTexts,
  }
}

test('handleFolderAccessRequest replays an approved grant on resend without re-opening the panel', async () => {
  const broadcasts: unknown[] = []
  const { actions, envelope, getAccessRequests, getOpened, getNoticeTexts } = await approverFixture(broadcasts)

  actions.handleFolderAccessRequest(envelope)
  assert.equal(getOpened(), 1)
  assert.equal(getAccessRequests().length, 1)

  const request = getAccessRequests()[0]!
  await actions.approveFolderAccess(request)
  assert.equal(getAccessRequests().length, 0)
  assert.equal(broadcasts.length, 1)
  assert.equal((broadcasts[0] as { type?: string }).type, 'folder-access-grant')

  // The requester never saw the grant land (p2p.ts swallows per-peer send failures), so it
  // resends the identical envelope. The approved decision must replay quietly. The replay path
  // re-encrypts the grant asynchronously (fire-and-forget inside handleFolderAccessRequest), so
  // give its microtasks a tick to settle before asserting on the broadcast.
  actions.handleFolderAccessRequest(envelope)
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(getOpened(), 1, 'panel must not re-open for an already-approved request')
  assert.equal(getNoticeTexts().filter((text) => text.includes('参加リクエストがあります')).length, 1)
  assert.equal(getAccessRequests().length, 0, 'approved request must not reappear in the list')
  assert.equal(broadcasts.length, 2)
  assert.equal((broadcasts[1] as { type?: string }).type, 'folder-access-grant')
  assert.equal((broadcasts[1] as { requestId?: string }).requestId, (broadcasts[0] as { requestId?: string }).requestId)
})

test('handleFolderAccessRequest replays a rejection on resend without re-showing UI', async () => {
  const broadcasts: unknown[] = []
  const { actions, envelope, getAccessRequests, getOpened, getNoticeTexts } = await approverFixture(broadcasts)

  actions.handleFolderAccessRequest(envelope)
  assert.equal(getOpened(), 1)
  const request = getAccessRequests()[0]!
  actions.rejectFolderAccess(request)
  assert.equal(getAccessRequests().length, 0)
  assert.equal(broadcasts.length, 1)
  assert.equal((broadcasts[0] as { type?: string }).type, 'folder-access-denied')

  actions.handleFolderAccessRequest(envelope)

  assert.equal(getOpened(), 1, 'panel must not re-open for an already-rejected request')
  assert.equal(getNoticeTexts().filter((text) => text.includes('参加リクエストがあります')).length, 1)
  assert.equal(getAccessRequests().length, 0, 'rejected request must not reappear in the list')
  assert.equal(broadcasts.length, 2)
  assert.equal((broadcasts[1] as { type?: string }).type, 'folder-access-denied')
  assert.equal((broadcasts[1] as { requestId?: string }).requestId, (broadcasts[0] as { requestId?: string }).requestId)
})

test('handleFolderAccessRequest does not re-open the panel for a still-pending resend', async () => {
  const broadcasts: unknown[] = []
  const { actions, envelope, getAccessRequests, getOpened, getNoticeTexts } = await approverFixture(broadcasts)

  actions.handleFolderAccessRequest(envelope)
  actions.handleFolderAccessRequest(envelope)

  assert.equal(getOpened(), 1, 'panel must only open on the first sighting')
  assert.equal(getNoticeTexts().filter((text) => text.includes('参加リクエストがあります')).length, 1)
  // Still undecided, so the request must stay visible in the list (just refreshed in place).
  assert.equal(getAccessRequests().length, 1)
})

// --- Approver side: the grant is remembered per node, not per requestId ------------------------

test('approveFolderAccess records the grant per folder and node id', async () => {
  const broadcasts: unknown[] = []
  const { actions, envelope, folder, folderAccessGrantsRef, getAccessRequests } = await approverFixture(broadcasts)

  actions.handleFolderAccessRequest(envelope)
  const request = getAccessRequests()[0]!
  await actions.approveFolderAccess(request)

  assert.deepEqual(folderAccessGrantsRef.current, { [folder.id]: [requesterDid] })
})

test('handleFolderAccessRequest re-grants silently when the requester reloads with a fresh requestId and key', async () => {
  // A reload mints both a new requestId and a new access key pair (the requester's request key
  // pair lives only in memory), so this simulates that scenario end-to-end: the resend must still
  // be recognized as coming from an already-granted *node*, even though neither the requestId nor
  // the accessPublicKey match the original request.
  const broadcasts: unknown[] = []
  const { actions, envelope, getAccessRequests, getOpened, getNoticeTexts } = await approverFixture(broadcasts)

  actions.handleFolderAccessRequest(envelope)
  const request = getAccessRequests()[0]!
  await actions.approveFolderAccess(request)
  assert.equal(getOpened(), 1)
  assert.equal(broadcasts.length, 1)

  const reloadedKey = await createAccessRequestKey()
  const reloadedEnvelope: ShareEnvelope = {
    ...envelope,
    requestId: 'request-b',
    accessPublicKey: reloadedKey.publicKey,
  }
  actions.handleFolderAccessRequest(reloadedEnvelope)
  // The replay path re-encrypts the grant asynchronously (fire-and-forget inside
  // handleFolderAccessRequest), so give its microtasks a tick to settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(getOpened(), 1, 'panel must not re-open for a reload from an already-granted node')
  assert.equal(getNoticeTexts().filter((text) => text.includes('参加リクエストがあります')).length, 1)
  assert.equal(getAccessRequests().length, 0, 'a reload from an already-granted node must not surface as a new request')
  assert.equal(broadcasts.length, 2)
  assert.equal((broadcasts[1] as { type?: string }).type, 'folder-access-grant')
  assert.equal((broadcasts[1] as { requestId?: string }).requestId, 'request-b')
})

test('handleFolderAccessRequest still shows a request from a different node after another node was granted', async () => {
  // Contrast case for the reload test above: the grant is scoped to the node that was actually
  // approved, so a different DID asking for the same folder must not be swept up by it -- the
  // per-node suppression must not over-suppress.
  const broadcasts: unknown[] = []
  const { actions, envelope, getAccessRequests, getOpened, getNoticeTexts } = await approverFixture(broadcasts)

  actions.handleFolderAccessRequest(envelope)
  const request = getAccessRequests()[0]!
  await actions.approveFolderAccess(request)
  assert.equal(getOpened(), 1)

  const otherEnvelope: ShareEnvelope = {
    ...envelope,
    from: otherDid,
    requestId: 'request-c',
    accessPublicKey: 'public-other',
  }
  actions.handleFolderAccessRequest(otherEnvelope)

  assert.equal(getOpened(), 2, 'a different node must not be suppressed by another node\'s grant')
  assert.equal(getNoticeTexts().filter((text) => text.includes('参加リクエストがあります')).length, 2)
  assert.equal(getAccessRequests().length, 1)
  assert.equal(getAccessRequests()[0]?.nodeId, otherDid)
})
