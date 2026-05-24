import { loadStoredDidIdentity, publicDidIdentity, type PublicDidIdentity } from './didIdentity.js'

export type AppSettings = {
  roomId: string
  signalingUrl: string
  nodeId: string
  identity: PublicDidIdentity | null
  autoConnect: boolean
  profileName: string
  avatarUrl: string
  avatarFileId: string
}

const settingsKey = 'tc-storage-settings-v1'
const roomIdKey = 'tc-storage-room-id-v1'
export const defaultSignalingUrl = 'wss://rtc.tik-choco.com/signaling'

export function loadSettings(): AppSettings {
  const fallback = createDefaultSettings()
  try {
    const parsed = JSON.parse(localStorage.getItem(settingsKey) ?? '{}') as Partial<AppSettings>
    const identity = parsePublicDidIdentity(parsed.identity) ?? fallback.identity
    return {
      roomId: parsed.roomId?.trim() || fallback.roomId,
      signalingUrl: normalizeSignalingUrl(parsed.signalingUrl ?? fallback.signalingUrl),
      nodeId: identity?.did || parsed.nodeId?.trim() || fallback.nodeId,
      identity,
      autoConnect: parsed.autoConnect ?? fallback.autoConnect,
      profileName: parsed.profileName?.trim() || fallback.profileName,
      avatarUrl: '',
      avatarFileId: parsed.avatarFileId?.trim() || fallback.avatarFileId,
    }
  } catch {
    return fallback
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(settingsKey, JSON.stringify(settings))
  localStorage.setItem('tc-storage-node-id-v1', settings.nodeId)
}

export function normalizeSignalingUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return defaultSignalingUrl
  if (/^https:\/\//i.test(trimmed)) return `wss://${trimmed.slice(8)}`
  if (/^http:\/\//i.test(trimmed)) return `ws://${trimmed.slice(7)}`
  return trimmed
}

function createDefaultSettings(): AppSettings {
  return {
    roomId: loadRoomId(),
    signalingUrl: defaultSignalingUrl,
    nodeId: loadNodeId(),
    identity: loadPublicDidIdentity(),
    autoConnect: false,
    profileName: 'Local user',
    avatarUrl: '',
    avatarFileId: '',
  }
}

export function defaultRoomId(): string {
  return loadRoomId()
}

function loadRoomId(): string {
  const stored = localStorage.getItem(roomIdKey)?.trim()
  if (stored) return stored
  const roomId = generateRoomId()
  localStorage.setItem(roomIdKey, roomId)
  return roomId
}

function generateRoomId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return `tc-storage-${cryptoApi.randomUUID()}`
  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
    return `tc-storage-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
  }
  return `tc-storage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function loadNodeId(): string {
  const identity = loadStoredDidIdentity()
  if (identity) return identity.did
  const key = 'tc-storage-node-id-v1'
  const stored = localStorage.getItem(key)
  if (stored) return stored
  const nodeId = `node-${Math.random().toString(36).slice(2, 8)}`
  localStorage.setItem(key, nodeId)
  return nodeId
}

function loadPublicDidIdentity(): PublicDidIdentity | null {
  const identity = loadStoredDidIdentity()
  return identity ? publicDidIdentity(identity) : null
}

function parsePublicDidIdentity(value: unknown): PublicDidIdentity | null {
  const identity = value as Partial<PublicDidIdentity> | null
  if (
    identity &&
    identity.method === 'did:key' &&
    identity.keyType === 'Ed25519' &&
    typeof identity.did === 'string' &&
    typeof identity.publicKeyMultibase === 'string' &&
    typeof identity.createdAt === 'string'
  ) {
    return {
      did: identity.did,
      method: identity.method,
      keyType: identity.keyType,
      publicKeyMultibase: identity.publicKeyMultibase,
      createdAt: identity.createdAt,
    }
  }
  return null
}
