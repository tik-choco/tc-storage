import { createAccessRequestKey, decryptFolderKeyGrant, encryptFolderKeyForRequest, type AccessRequestKey } from '../crypto/accessGrantCrypto.js'
import { pendingShareKey, type FolderAccessMode, type FolderAccessRequest, type Notice, type PendingShare } from './appTypes.js'
import type { MistShare, MutableRef, SetState } from './appControllerTypes.js'
import type { FolderRecord, StorageSnapshot } from '../storage/domain.js'
import { describeError } from '../util/errors.js'
import { isEd25519DidKey } from '../crypto/didIdentity.js'
import { folderAccessGrantProof, matchesFolderAccessGrantProof, matchesFolderKeyHash } from '../crypto/folderKeyProof.js'
import { hasFolderAccessGrant, saveFolderAccessGrants, withFolderAccessGrant, type FolderAccessGrants } from '../folder/folderAccessGrants.js'
import type { AppSettings } from '../storage/localSettings.js'
import type { ShareEnvelope } from '../p2p/p2p.js'

export type RequestKeyEntry = AccessRequestKey & {
  accessGrantMode?: 'owner' | 'shared'
  folderId: string
  folderKeyHash?: string
  ownerNodeId?: string
  roomId: string
  requestId: string
  // When the request was last broadcast (epoch ms). Missing (older entries) counts as "long
  // ago", so the next requestFolderAccess call is allowed to resend immediately.
  sentAt?: number
}

// What we already did with a request id, so a re-broadcast replays that decision instead of
// asking the user again. `pending` means "already shown once, still undecided". Approvals are
// *not* tracked here -- they live per node in folderAccessGrants (persisted), since the requester
// re-mints its requestId on every reload.
export type HandledAccessRequest = {
  decision: 'pending' | 'rejected'
  handledAt: number
}

// A send can be lost without any error surfacing here (p2p.ts swallows per-peer mist failures
// and only drops the failed peers), so a pending request is re-broadcast -- with the same
// requestId, which the receiving side dedupes -- once this cooldown has elapsed without a
// grant/denial. Kept just under the 30s pending-share retry interval so each retry tick can
// actually resend.
export const accessRequestResendCooldownMs = 25_000

// Bound on handledAccessRequestsRef so a peer looping through fresh request ids can't grow it
// without limit; oldest decisions fall off first.
export const handledAccessRequestLimit = 64

interface AccessOptions {
  accessRequestKeysRef: MutableRef<Record<string, RequestKeyEntry>>
  folderAccessGrantsRef: MutableRef<FolderAccessGrants>
  folderAccessModesRef: MutableRef<Record<string, FolderAccessMode>>
  handledAccessRequestsRef: MutableRef<Record<string, HandledAccessRequest>>
  folderKeysRef: MutableRef<Record<string, string>>
  networkRef: MutableRef<MistShare>
  openFolderAccessRequests: (folderId: string) => void
  setFolderAccessRequests: SetState<FolderAccessRequest[]>
  setFolderKeys: SetState<Record<string, string>>
  setImportKeys: SetState<Record<string, string>>
  setNotice: SetState<Notice>
  setPendingShares: SetState<PendingShare[]>
  settingsRef: MutableRef<AppSettings>
  snapshotRef: MutableRef<StorageSnapshot>
}

export function createAccessActions(options: AccessOptions) {
  const {
    accessRequestKeysRef, folderAccessGrantsRef, folderAccessModesRef, folderKeysRef, handledAccessRequestsRef, networkRef, openFolderAccessRequests, setFolderAccessRequests,
    setFolderKeys, setImportKeys, setNotice, setPendingShares, settingsRef, snapshotRef,
  } = options

  async function requestFolderAccess(share: PendingShare): Promise<void> {
    if (share.type !== 'folder-share' || !share.folderId) return
    // Already granted: the pending share stays around until its bundle actually imports (the
    // owner may not have published a cid yet), so the retry tick keeps calling in here. Without
    // this guard the request entry is gone -- handleFolderAccessGrant clears it -- and we'd mint
    // a *new* requestId, which the owner sees as a brand-new approval request every retry tick.
    if (folderKeysRef.current[share.folderId]) return
    const accessGrantMode: NonNullable<ShareEnvelope['accessGrantMode']> = share.accessGrantMode === 'shared' ? 'shared' : 'owner'
    if (!share.ownerNodeId || !isEd25519DidKey(share.ownerNodeId)) {
      setNotice({ tone: 'error', text: '署名された共有URLではないため、参加リクエストを送れません' })
      return
    }
    if (!share.folderKeyHash) {
      setNotice({ tone: 'error', text: 'フォルダーキー検証情報のない共有URLでは参加リクエストを送れません' })
      return
    }
    if (!isEd25519DidKey(settingsRef.current.nodeId)) {
      setNotice({ tone: 'info', text: 'DID生成後に参加リクエストを送信します' })
      return
    }
    // With the app joined to every room in `roomIds` simultaneously (see p2p.ts), presence in
    // share.roomId is guaranteed as long as it's part of the joined-room set -- no need to wait
    // for a single "active" room to rotate onto it before sending.
    const key = pendingShareKey(share)
    const existing = accessRequestKeysRef.current[key]
    if (existing) {
      if (Date.now() - (existing.sentAt ?? 0) < accessRequestResendCooldownMs) return
      resendFolderAccessRequest(key, existing, share)
      return
    }
    try {
      const accessKey = await createAccessRequestKey()
      const requestId = `access-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const entry = { ...accessKey, accessGrantMode, folderId: share.folderId, folderKeyHash: share.folderKeyHash, ownerNodeId: share.ownerNodeId, requestId, roomId: share.roomId, sentAt: Date.now() }
      accessRequestKeysRef.current = {
        ...accessRequestKeysRef.current,
        [key]: entry,
        [requestId]: entry,
      }
      networkRef.current.broadcastShare({
        type: 'folder-access-request',
        clock: 0,
        folderId: share.folderId,
        folderName: share.folderName,
        accessGrantMode,
        folderKeyHash: share.folderKeyHash,
        targetNodeId: accessGrantMode === 'shared' ? undefined : share.ownerNodeId,
        requestId,
        accessPublicKey: accessKey.publicKey,
      }, share.roomId)
      setNotice({ tone: 'info', text: '共有フォルダーへの参加承認をリクエストしました' })
    } catch (error) {
      setNotice({ tone: 'error', text: describeError(error, '参加リクエストを作成できませんでした') })
    }
  }

  // Re-broadcasts a still-pending request with its original requestId and keys; no notice, since
  // the first send already announced the request and resends may repeat on every retry tick.
  function resendFolderAccessRequest(key: string, entry: RequestKeyEntry, share: PendingShare): void {
    const accessGrantMode: NonNullable<ShareEnvelope['accessGrantMode']> = entry.accessGrantMode === 'shared' ? 'shared' : 'owner'
    const refreshed = { ...entry, sentAt: Date.now() }
    accessRequestKeysRef.current = { ...accessRequestKeysRef.current, [key]: refreshed, [entry.requestId]: refreshed }
    networkRef.current.broadcastShare({
      type: 'folder-access-request',
      clock: 0,
      folderId: entry.folderId,
      folderName: share.folderName,
      accessGrantMode,
      folderKeyHash: entry.folderKeyHash,
      targetNodeId: accessGrantMode === 'shared' ? undefined : entry.ownerNodeId,
      requestId: entry.requestId,
      accessPublicKey: entry.publicKey,
    }, entry.roomId)
  }

  function handleFolderAccessRequest(envelope: ShareEnvelope): void {
    if (envelope.targetNodeId && envelope.targetNodeId !== settingsRef.current.nodeId) return
    if (!isEd25519DidKey(envelope.from)) return
    if (!envelope.folderId || !envelope.requestId || !envelope.accessPublicKey) return
    const requestGrantMode = envelope.accessGrantMode === 'shared' ? 'shared' : 'owner'
    if (requestGrantMode !== 'shared' && envelope.targetNodeId !== settingsRef.current.nodeId) return
    const folder = snapshotRef.current.folders.find((item) => item.id === envelope.folderId && !item.deletedAt)
    const folderKey = folder ? folderKeysRef.current[folder.id] : ''
    if (!folder?.shareEnabled || !folderKey) return
    if (!matchesFolderKeyHash(folder.id, folderKey, envelope.folderKeyHash)) return
    const request = accessRequestFromEnvelope(envelope, folder)
    // A requester only resends while it is still waiting, so a request from a node we already
    // approved means our grant never landed (p2p.ts drops per-peer send failures without
    // surfacing an error) or the requester reloaded and re-minted its request. Either way the
    // node already holds -- or was meant to hold -- this folder key, so re-grant silently to the
    // key it is asking with instead of putting the same person in front of the user again.
    if (hasFolderAccessGrant(folderAccessGrantsRef.current, folder.id, request.nodeId)) {
      void sendFolderAccessGrant(request, folder, folderKey, { silent: true })
      return
    }
    const handled = handledAccessRequestsRef.current[request.id]
    if (handled?.decision === 'rejected') {
      sendFolderAccessDenied(request)
      return
    }
    setFolderAccessRequests((current) => [
      request,
      ...current.filter((item) => item.id !== request.id),
    ].slice(0, 24))
    // Only the first sighting pops the panel open and notifies; later resends of the same
    // still-undecided request just refresh the row above.
    if (handled) return
    rememberHandledAccessRequest(request.id, 'pending')
    openFolderAccessRequests(folder.id)
    setNotice({ tone: 'info', text: `${request.folderName ?? folder.name} への参加リクエストがあります` })
  }

  async function approveFolderAccess(request: FolderAccessRequest): Promise<void> {
    const folder = snapshotRef.current.folders.find((item) => item.id === request.folderId && !item.deletedAt)
    const folderKey = folder ? folderKeysRef.current[folder.id] : ''
    if (!folder?.shareEnabled || !folderKey) {
      setNotice({ tone: 'error', text: '承認できる共有フォルダーが見つかりません' })
      return
    }
    if (!await sendFolderAccessGrant(request, folder, folderKey)) return
    rememberFolderAccessGrant(folder.id, request.nodeId)
    setFolderAccessRequests((current) => current.filter((item) => item.id !== request.id))
    setNotice({ tone: 'success', text: `${request.profile?.name?.trim() || request.nodeId} を承認しました` })
  }

  async function sendFolderAccessGrant(request: FolderAccessRequest, folder: FolderRecord, folderKey: string, options: { silent?: boolean } = {}): Promise<boolean> {
    try {
      const grant = await encryptFolderKeyForRequest(folderKey, request.publicKey)
      networkRef.current.broadcastShare({
        type: 'folder-access-grant',
        clock: snapshotRef.current.clock,
        folderId: folder.id,
        folderName: folder.name,
        cid: folder.lastCid,
        targetNodeId: request.nodeId,
        requestId: request.requestId,
        accessGrantProof: folderAccessGrantProof(folderKey, folder.id, request.requestId, request.nodeId),
        accessGrantPublicKey: grant.publicKey,
        accessGrantIv: grant.iv,
        accessGrantCipherText: grant.cipherText,
      }, request.roomId)
      return true
    } catch (error) {
      if (!options.silent) setNotice({ tone: 'error', text: describeError(error, '参加承認を送信できませんでした') })
      return false
    }
  }

  function rejectFolderAccess(request: FolderAccessRequest): void {
    rememberHandledAccessRequest(request.id, 'rejected')
    sendFolderAccessDenied(request)
    setFolderAccessRequests((current) => current.filter((item) => item.id !== request.id))
    setNotice({ tone: 'info', text: '参加リクエストを却下しました' })
  }

  function sendFolderAccessDenied(request: FolderAccessRequest): void {
    networkRef.current.broadcastShare({
      type: 'folder-access-denied',
      clock: snapshotRef.current.clock,
      folderId: request.folderId,
      folderName: request.folderName,
      targetNodeId: request.nodeId,
      requestId: request.requestId,
    }, request.roomId)
  }

  function rememberFolderAccessGrant(folderId: string, nodeId: string): void {
    folderAccessGrantsRef.current = withFolderAccessGrant(folderAccessGrantsRef.current, folderId, nodeId)
    saveFolderAccessGrants(folderAccessGrantsRef.current)
  }

  function rememberHandledAccessRequest(id: string, decision: HandledAccessRequest['decision']): void {
    const next = { ...handledAccessRequestsRef.current, [id]: { decision, handledAt: Date.now() } }
    const entries = Object.entries(next)
    handledAccessRequestsRef.current = entries.length <= handledAccessRequestLimit
      ? next
      : Object.fromEntries(entries.toSorted((a, b) => b[1].handledAt - a[1].handledAt).slice(0, handledAccessRequestLimit))
  }

  function handleFolderAccessDenied(envelope: ShareEnvelope): void {
    if (envelope.targetNodeId && envelope.targetNodeId !== settingsRef.current.nodeId) return
    if (!envelope.folderId || !envelope.requestId) return
    const entry = accessRequestKeysRef.current[envelope.requestId]
    const roomId = entry?.roomId ?? envelope.roomId
    const folderId = entry?.folderId ?? envelope.folderId
    const accessGrantMode = entry?.accessGrantMode === 'shared' ? 'shared' : 'owner'
    if (accessGrantMode === 'shared') return
    if (!entry?.ownerNodeId || !isEd25519DidKey(entry.ownerNodeId) || envelope.from !== entry.ownerNodeId) return
    const shareKey = pendingShareKey({ type: 'folder-share', roomId, folderId })
    accessRequestKeysRef.current = Object.fromEntries(Object.entries(accessRequestKeysRef.current).filter(([key]) => key !== envelope.requestId && key !== shareKey))
    setPendingShares((current) => current.filter((share) => (
      pendingShareKey(share) !== shareKey &&
      !(share.type === 'folder-share' && share.folderId === folderId && share.roomId === roomId)
    )))
    setNotice({ tone: 'error', text: `${envelope.folderName ?? '共有フォルダー'} への参加リクエストが却下されました` })
  }

  async function handleFolderAccessGrant(envelope: ShareEnvelope): Promise<void> {
    if (!envelope.folderId || !envelope.requestId) return
    clearGrantedAccessRequest(envelope)
    if (envelope.targetNodeId && envelope.targetNodeId !== settingsRef.current.nodeId) return
    if (!envelope.accessGrantPublicKey || !envelope.accessGrantIv || !envelope.accessGrantCipherText) return
    const entry = accessRequestKeysRef.current[envelope.requestId]
    if (!entry || entry.folderId !== envelope.folderId) return
    const accessGrantMode = entry.accessGrantMode === 'shared' ? 'shared' : 'owner'
    if (accessGrantMode === 'owner' && (!entry.ownerNodeId || !isEd25519DidKey(entry.ownerNodeId) || envelope.from !== entry.ownerNodeId)) return
    if (accessGrantMode === 'shared' && !isEd25519DidKey(envelope.from)) return
    try {
      const passphrase = await decryptFolderKeyGrant({
        cipherText: envelope.accessGrantCipherText,
        iv: envelope.accessGrantIv,
        privateKey: entry.privateKey,
        publicKey: envelope.accessGrantPublicKey,
      })
      if (!matchesFolderKeyHash(envelope.folderId, passphrase, entry.folderKeyHash)) {
        setNotice({ tone: 'error', text: '承認レスポンスのフォルダーキー検証に失敗しました' })
        return
      }
      folderKeysRef.current = { ...folderKeysRef.current, [envelope.folderId]: passphrase }
      setFolderKeys((current) => ({ ...current, [envelope.folderId ?? '']: passphrase }))
      setPendingShares((current) => current.map((share) => (
        share.type === 'folder-share' && share.folderId === envelope.folderId && share.roomId === entry.roomId
          ? { ...share, autoImport: true, cid: envelope.cid ?? share.cid, folderName: envelope.folderName ?? share.folderName }
          : share
      )))
      if (envelope.cid) setImportKeys((current) => ({ ...current, [envelope.cid ?? '']: passphrase }))
      if (accessGrantMode !== 'shared') {
        accessRequestKeysRef.current = Object.fromEntries(Object.entries(accessRequestKeysRef.current).filter(([key]) => key !== envelope.requestId && key !== pendingShareKey({ type: 'folder-share', roomId: entry.roomId, folderId: entry.folderId })))
      }
      setNotice({ tone: 'success', text: '参加が承認されました。共有フォルダーを同期します' })
    } catch (error) {
      setNotice({ tone: 'error', text: describeError(error, '承認レスポンスを復号できませんでした') })
    }
  }

  function accessRequestFromEnvelope(envelope: ShareEnvelope, folder: FolderRecord): FolderAccessRequest {
    const requestId = envelope.requestId ?? ''
    return {
      id: `${folder.id}:${envelope.from}:${requestId}`,
      folderId: folder.id,
      folderName: envelope.folderName ?? folder.name,
      nodeId: envelope.from,
      profile: envelope.senderProfile,
      publicKey: envelope.accessPublicKey ?? '',
      folderKeyHash: envelope.folderKeyHash,
      requestedAt: envelope.sentAt,
      requestId,
      roomId: envelope.roomId,
    }
  }

  function clearGrantedAccessRequest(envelope: ShareEnvelope): void {
    if (!envelope.folderId || !envelope.requestId || !envelope.targetNodeId || !envelope.accessGrantProof) return
    if (!isEd25519DidKey(envelope.from)) return
    const folder = snapshotRef.current.folders.find((item) => item.id === envelope.folderId && !item.deletedAt)
    const folderKey = folder ? folderKeysRef.current[folder.id] : ''
    if (!folder?.shareEnabled || !folderKey) return
    if (folderAccessModesRef.current[folder.id] !== 'shared-approval' && envelope.from !== settingsRef.current.nodeId) return
    if (!matchesFolderAccessGrantProof(folderKey, folder.id, envelope.requestId, envelope.targetNodeId, envelope.accessGrantProof)) return
    // Someone (possibly us) already granted this node, so a later request from it must not
    // re-prompt -- the grant's target is the requester.
    rememberFolderAccessGrant(folder.id, envelope.targetNodeId)
    setFolderAccessRequests((current) => current.filter((request) => (
      request.folderId !== envelope.folderId ||
      request.requestId !== envelope.requestId ||
      request.nodeId !== envelope.targetNodeId
    )))
  }

  return { approveFolderAccess, handleFolderAccessDenied, handleFolderAccessGrant, handleFolderAccessRequest, rejectFolderAccess, requestFolderAccess }
}
