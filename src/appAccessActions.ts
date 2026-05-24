import { createAccessRequestKey, decryptFolderKeyGrant, encryptFolderKeyForRequest, type AccessRequestKey } from './accessGrantCrypto.js'
import { pendingShareKey, type FolderAccessMode, type FolderAccessRequest, type Notice, type PendingShare } from './appTypes.js'
import type { MistShare, MutableRef, SetState } from './appControllerTypes.js'
import type { FolderRecord, StorageSnapshot } from './domain.js'
import { describeError } from './errors.js'
import { isEd25519DidKey } from './didIdentity.js'
import { folderAccessGrantProof, matchesFolderAccessGrantProof, matchesFolderKeyHash } from './folderKeyProof.js'
import type { AppSettings } from './localSettings.js'
import type { ShareEnvelope } from './p2p.js'

export type RequestKeyEntry = AccessRequestKey & {
  accessGrantMode?: 'owner' | 'shared'
  folderId: string
  folderKeyHash?: string
  ownerNodeId?: string
  roomId: string
  requestId: string
}

interface AccessOptions {
  accessRequestKeysRef: MutableRef<Record<string, RequestKeyEntry>>
  folderAccessModesRef: MutableRef<Record<string, FolderAccessMode>>
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
    accessRequestKeysRef, folderAccessModesRef, folderKeysRef, networkRef, openFolderAccessRequests, setFolderAccessRequests,
    setFolderKeys, setImportKeys, setNotice, setPendingShares, settingsRef, snapshotRef,
  } = options

  async function requestFolderAccess(share: PendingShare): Promise<void> {
    if (share.type !== 'folder-share' || !share.folderId) return
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
    if (share.roomId !== settingsRef.current.roomId) {
      setNotice({ tone: 'info', text: '共有ルームへ接続後に参加リクエストを送信します' })
      return
    }
    const key = pendingShareKey(share)
    if (accessRequestKeysRef.current[key]) return
    try {
      const accessKey = await createAccessRequestKey()
      const requestId = `access-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const entry = { ...accessKey, accessGrantMode, folderId: share.folderId, folderKeyHash: share.folderKeyHash, ownerNodeId: share.ownerNodeId, requestId, roomId: share.roomId }
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
      })
      setNotice({ tone: 'info', text: '共有フォルダーへの参加承認をリクエストしました' })
    } catch (error) {
      setNotice({ tone: 'error', text: describeError(error, '参加リクエストを作成できませんでした') })
    }
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
    setFolderAccessRequests((current) => [
      request,
      ...current.filter((item) => item.id !== request.id),
    ].slice(0, 24))
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
      })
      setFolderAccessRequests((current) => current.filter((item) => item.id !== request.id))
      setNotice({ tone: 'success', text: `${request.profile?.name?.trim() || request.nodeId} を承認しました` })
    } catch (error) {
      setNotice({ tone: 'error', text: describeError(error, '参加承認を送信できませんでした') })
    }
  }

  function rejectFolderAccess(request: FolderAccessRequest): void {
    networkRef.current.broadcastShare({
      type: 'folder-access-denied',
      clock: snapshotRef.current.clock,
      folderId: request.folderId,
      folderName: request.folderName,
      targetNodeId: request.nodeId,
      requestId: request.requestId,
    })
    setFolderAccessRequests((current) => current.filter((item) => item.id !== request.id))
    setNotice({ tone: 'info', text: '参加リクエストを却下しました' })
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
    setFolderAccessRequests((current) => current.filter((request) => (
      request.folderId !== envelope.folderId ||
      request.requestId !== envelope.requestId ||
      request.nodeId !== envelope.targetNodeId
    )))
  }

  return { approveFolderAccess, handleFolderAccessDenied, handleFolderAccessGrant, handleFolderAccessRequest, rejectFolderAccess, requestFolderAccess }
}
