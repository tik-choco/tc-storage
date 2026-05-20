import { generateFolderKey } from './folderKeys.js'

const fileShareKeysStorageKey = 'tc-storage-file-share-keys-v1'

export function loadFileShareKeys(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(fileShareKeysStorageKey) ?? '{}') as Record<string, string>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function saveFileShareKeys(keys: Record<string, string>): void {
  localStorage.setItem(fileShareKeysStorageKey, JSON.stringify(keys))
}

export function generateFileShareKey(): string {
  return generateFolderKey()
}
