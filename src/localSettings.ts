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
const defaultSignalingUrl = 'https://rtc.tik-choco.com/signaling'

export function loadSettings(): AppSettings {
  const fallback = createDefaultSettings()
  try {
    const parsed = JSON.parse(localStorage.getItem(settingsKey) ?? '{}') as Partial<AppSettings>
    const identity = parsePublicDidIdentity(parsed.identity) ?? fallback.identity
    return {
      roomId: parsed.roomId?.trim() || fallback.roomId,
      signalingUrl: parsed.signalingUrl?.trim() || fallback.signalingUrl,
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

function createDefaultSettings(): AppSettings {
  return {
    roomId: 'tc-storage-main',
    signalingUrl: defaultSignalingUrl,
    nodeId: loadNodeId(),
    identity: loadPublicDidIdentity(),
    autoConnect: true,
    profileName: 'Local user',
    avatarUrl: '',
    avatarFileId: '',
  }
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
