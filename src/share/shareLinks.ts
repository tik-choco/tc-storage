import { useEffect, useRef } from 'preact/hooks'
import type { FolderAccessMode, PendingShare } from '../app/appTypes.js'
import { base64ToBytes, bytesToBase64 } from '../crypto/cryptoEncoding.js'
import { isEd25519DidKey } from '../crypto/didIdentity.js'
import type { FileRecord, FolderRecord } from '../storage/domain.js'
import { folderKeyHash } from '../crypto/folderKeyProof.js'
import { removeFolderRouteFromUrl } from '../folder/folderRoute.js'
import type { ShareProfile } from '../p2p/p2p.js'

type ShareKind = 'folder-share' | 'file-share'

type ShareLinkPayload = {
  v: 1
  type: ShareKind
  roomId: string
  clock?: number
  cid?: string
  key?: string
  folderId?: string
  folderName?: string
  fileId?: string
  fileName?: string
  ownerNodeId?: string
  accessGrantMode?: 'owner' | 'shared'
  folderKeyHash?: string
  senderProfile?: ShareProfile
}

export type LinkedShare = {
  share: PendingShare
  key: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function makeFolderShareUrl(folder: FolderRecord, roomId: string, senderProfile: ShareProfile, ownerNodeId: string, folderKey: string, accessMode: FolderAccessMode = 'approval'): string {
  if (!isEd25519DidKey(ownerNodeId)) throw new Error('フォルダー共有URLには署名用DIDが必要です')
  const trimmedKey = folderKey.trim()
  if (!trimmedKey) throw new Error('フォルダー共有URLにはフォルダーキーの検証情報が必要です')
  return makeShareUrl({ v: 1, type: 'folder-share', roomId, folderId: folder.id, folderName: folder.name, ownerNodeId, accessGrantMode: folderAccessGrantMode(accessMode), folderKeyHash: folderKeyHash(folder.id, trimmedKey), senderProfile })
}

export function makeFileShareUrl(file: FileRecord, folder: FolderRecord, roomId: string, clock: number, cid: string, key: string, senderProfile: ShareProfile): string {
  return makeShareUrl({ v: 1, type: 'file-share', roomId, clock, cid, key, folderId: folder.id, folderName: folder.name, fileId: file.id, fileName: file.name, senderProfile })
}

export function useShareLinkImport(onShare: (linked: LinkedShare) => boolean | void): void {
  const callbackRef = useRef(onShare)
  useEffect(() => {
    callbackRef.current = onShare
  }, [onShare])
  useEffect(() => {
    const read = () => {
      const linked = readShareLink(location.hash)
      if (!linked) return
      // A callback returning false means the share could not be persisted; keep the hash in the
      // URL -- it is then the only remaining copy of the share, and a reload retries the import.
      if (callbackRef.current(linked) === false) return
      history.replaceState(null, document.title, `${location.pathname}${location.search}`)
    }
    read()
    window.addEventListener('hashchange', read)
    return () => window.removeEventListener('hashchange', read)
  }, [])
}

function makeShareUrl(payload: ShareLinkPayload): string {
  const encoded = toBase64Url(bytesToBase64(encoder.encode(JSON.stringify(payload))))
  const url = new URL(removeFolderRouteFromUrl(location.href))
  url.hash = `tc-share=${encoded}`
  return url.toString()
}

export function readShareLink(hash: string): LinkedShare | undefined {
  const raw = new URLSearchParams(hash.replace(/^#/, '')).get('tc-share')
  if (!raw) return undefined
  try {
    const payload = JSON.parse(decoder.decode(base64ToBytes(fromBase64Url(raw)))) as unknown
    if (!isShareLinkPayload(payload)) return undefined
    return {
      key: payload.key ?? '',
      share: {
        type: payload.type,
        from: 'share-url',
        roomId: payload.roomId,
        sentAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        clock: payload.clock ?? 0,
        folderId: payload.folderId,
        folderName: payload.folderName,
        fileId: payload.fileId,
        fileName: payload.fileName,
        ownerNodeId: payload.ownerNodeId,
        accessGrantMode: payload.accessGrantMode,
        folderKeyHash: payload.folderKeyHash,
        cid: payload.cid,
        senderProfile: payload.senderProfile,
      },
    }
  } catch {
    return undefined
  }
}

function isShareLinkPayload(value: unknown): value is ShareLinkPayload {
  const payload = value as Partial<ShareLinkPayload>
  return Boolean(
    payload &&
      payload.v === 1 &&
      (payload.type === 'folder-share' || payload.type === 'file-share') &&
      typeof payload.roomId === 'string' &&
      (payload.clock === undefined || typeof payload.clock === 'number') &&
      (payload.accessGrantMode === undefined || payload.accessGrantMode === 'owner' || payload.accessGrantMode === 'shared') &&
      (payload.type === 'folder-share'
        ? typeof payload.ownerNodeId === 'string' && isEd25519DidKey(payload.ownerNodeId) && isFolderKeyHash(payload.folderKeyHash) && payload.cid === undefined && payload.key === undefined
        : typeof payload.cid === 'string' && payload.cid.length > 0 && typeof payload.key === 'string' && payload.key.length > 0),
  )
}

function folderAccessGrantMode(mode: FolderAccessMode): 'owner' | 'shared' {
  return mode === 'shared-approval' ? 'shared' : 'owner'
}

function isFolderKeyHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function toBase64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
}
