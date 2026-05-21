import type { PendingShare } from './appTypes.js'
import type { ShareProfile } from './p2p.js'

const pendingSharesStorageKey = 'tc-storage-pending-shares-v1'
const importKeysStorageKey = 'tc-storage-import-keys-v1'
const maxStoredPendingShares = 12

export function loadPendingShares(): PendingShare[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(pendingSharesStorageKey) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      const share = normalizePendingShare(item)
      return share ? [share] : []
    }).slice(0, maxStoredPendingShares)
  } catch {
    return []
  }
}

export function savePendingShares(shares: PendingShare[]): void {
  localStorage.setItem(pendingSharesStorageKey, JSON.stringify(shares.slice(0, maxStoredPendingShares)))
}

export function loadImportKeys(): Record<string, string> {
  try {
    return normalizeStringRecord(JSON.parse(localStorage.getItem(importKeysStorageKey) ?? '{}') as unknown)
  } catch {
    return {}
  }
}

export function saveImportKeys(keys: Record<string, string>): void {
  localStorage.setItem(importKeysStorageKey, JSON.stringify(normalizeStringRecord(keys)))
}

function normalizePendingShare(value: unknown): PendingShare | undefined {
  if (!value || typeof value !== 'object') return undefined
  const share = value as Partial<PendingShare>
  if (
    (share.type !== 'folder-share' && share.type !== 'file-share') ||
    typeof share.from !== 'string' ||
    typeof share.roomId !== 'string' ||
    typeof share.sentAt !== 'string' ||
    typeof share.receivedAt !== 'string' ||
    typeof share.clock !== 'number' ||
    (share.type === 'file-share' && typeof share.cid !== 'string')
  ) {
    return undefined
  }

  const normalized: PendingShare = {
    type: share.type,
    from: share.from,
    roomId: share.roomId,
    sentAt: share.sentAt,
    receivedAt: share.receivedAt,
    clock: share.clock,
  }
  if (typeof share.cid === 'string') normalized.cid = share.cid
  if (share.autoImport === true) normalized.autoImport = true
  assignOptionalString(normalized, 'folderId', share.folderId)
  assignOptionalString(normalized, 'folderName', share.folderName)
  assignOptionalString(normalized, 'fileId', share.fileId)
  assignOptionalString(normalized, 'fileName', share.fileName)
  assignOptionalString(normalized, 'ownerNodeId', share.ownerNodeId)
  assignOptionalString(normalized, 'folderSignature', share.folderSignature)
  assignOptionalString(normalized, 'signature', share.signature)
  const senderProfile = normalizeShareProfile(share.senderProfile)
  if (senderProfile) normalized.senderProfile = senderProfile
  return normalized
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function normalizeShareProfile(value: unknown): ShareProfile | undefined {
  if (!value || typeof value !== 'object') return undefined
  const profile = value as Partial<ShareProfile>
  if (typeof profile.name !== 'string') return undefined
  const normalized: ShareProfile = { name: profile.name }
  const avatarUrl = optionalString(profile.avatarUrl)
  if (avatarUrl) normalized.avatarUrl = avatarUrl
  return normalized
}

function assignOptionalString<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  if (typeof value === 'string') target[key] = value as T[K]
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
