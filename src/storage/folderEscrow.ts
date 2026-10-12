import type { FolderCheckpoint } from '../folder/folderCheckpoint.js'
import { folderKeyHash } from '../crypto/folderKeyProof.js'
export interface EscrowLocal {
  lastSeq: number
  lastHash: string | null
  providerSeen: boolean
  savedAt: number
  verifiedSeq?: number
  verifiedHash?: string
  checkpoint?: FolderCheckpoint
  contentSources?: FolderCheckpoint[]
}
export const escrowStorageKey = (folder: string, key: string, room: string) =>
  'tc-storage:escrow:v1:' + JSON.stringify([folder, folderKeyHash(folder, key.trim()), room])
let database: Promise<IDBDatabase> | undefined
function db(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('tc-storage-escrow-v1', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('descriptors')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    void database.catch(() => {
      database = undefined
    })
  }
  return database
}
async function storedDescriptors(id: string): Promise<Pick<EscrowLocal, 'checkpoint' | 'contentSources'> | undefined> {
  const store = (await db()).transaction('descriptors', 'readonly').objectStore('descriptors')
  return new Promise((resolve, reject) => {
    const request = store.get(id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function loadFolderEscrow(folder: string, key: string, room: string): Promise<EscrowLocal> {
  const id = escrowStorageKey(folder, key, room)
  let local: EscrowLocal = { lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0 }
  try {
    const value = JSON.parse(localStorage.getItem(id) ?? 'null') as EscrowLocal | null
    if (
      value &&
      Number.isSafeInteger(value.lastSeq) &&
      value.lastSeq >= 0 &&
      (value.lastHash === null || /^[a-f0-9]{64}$/.test(value.lastHash)) &&
      typeof value.providerSeen === 'boolean' &&
      Number.isSafeInteger(value.savedAt) &&
      value.savedAt >= 0
    ) {
      const verified =
        Number.isSafeInteger(value.verifiedSeq) &&
        value.verifiedSeq! > 0 &&
        typeof value.verifiedHash === 'string' &&
        /^[a-f0-9]{64}$/.test(value.verifiedHash)
      local = {
        ...value,
        verifiedSeq: verified ? value.verifiedSeq : undefined,
        verifiedHash: verified ? value.verifiedHash : undefined,
      }
    }
  } catch {
    /* Invalid local watermarks are ignored. */
  }
  // Metadata/descriptors may approach the 16 MiB manifest bound; keep them out of localStorage's small quota.
  const descriptors = await storedDescriptors(id)
  return { ...local, ...descriptors }
}
export async function persistFolderEscrow(
  folder: string,
  key: string,
  room: string,
  local: EscrowLocal,
): Promise<void> {
  const id = escrowStorageKey(folder, key, room)
  const { checkpoint, contentSources, ...watermark } = local
  const tx = (await db()).transaction('descriptors', 'readwrite')
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('Escrow descriptor persistence aborted'))
  })
  tx.objectStore('descriptors').put({ checkpoint, contentSources }, id)
  await completed
  localStorage.setItem(id, JSON.stringify(watermark))
}
