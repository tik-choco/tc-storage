import type { FolderRecord } from './domain.js'
import { bytesToBase64 } from './cryptoEncoding.js'
import { normalizeStringRecord } from './storageRecords.js'

const folderKeysStorageKey = 'tc-storage-folder-keys-v1'

export function loadFolderKeys(): Record<string, string> {
  try {
    return normalizeStringRecord(JSON.parse(localStorage.getItem(folderKeysStorageKey) ?? '{}') as unknown)
  } catch {
    return {}
  }
}

export function saveFolderKeys(keys: Record<string, string>): void {
  localStorage.setItem(folderKeysStorageKey, JSON.stringify(normalizeStringRecord(keys)))
}

export function ensureFolderKeys(folders: FolderRecord[], current: Record<string, string>): Record<string, string> {
  let changed = false
  const next = { ...current }
  for (const folder of folders) {
    if (!folder.deletedAt && !next[folder.id]) {
      next[folder.id] = generateFolderKey()
      changed = true
    }
  }
  return changed ? next : current
}

export function generateFolderKey(): string {
  const bytes = new Uint8Array(24)
  const cryptoApi = globalThis.crypto
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('暗号キー生成に必要な安全な乱数生成が利用できません')
  }
  cryptoApi.getRandomValues(bytes)
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
