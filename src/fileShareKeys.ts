import { generateFolderKey } from './folderKeys.js'
import { normalizeStringRecord } from './storageRecords.js'

const fileShareKeysStorageKey = 'tc-storage-file-share-keys-v1'

export function loadFileShareKeys(): Record<string, string> {
  try {
    return normalizeStringRecord(JSON.parse(localStorage.getItem(fileShareKeysStorageKey) ?? '{}') as unknown)
  } catch {
    return {}
  }
}

export function saveFileShareKeys(keys: Record<string, string>): void {
  localStorage.setItem(fileShareKeysStorageKey, JSON.stringify(normalizeStringRecord(keys)))
}

export function generateFileShareKey(): string {
  return generateFolderKey()
}
