import { decryptJson, encryptJson, type EncryptedPayload } from './crypto.js'
import { stripFileContent, type FileBundle, type FileRecord, type FolderBundle, type FolderRecord } from './domain.js'

type MistModule = typeof import('./vendor/mistlib-wasm/mistlib_wasm.js')
type NavigatorWithOpfs = Navigator & {
  storage?: StorageManager & {
    getDirectory?: () => Promise<unknown>
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
let mistModulePromise: Promise<MistModule> | undefined

function storageLog(message: string, details?: Record<string, unknown>): void {
  console.info('[tc-storage:mist-storage]', message, details ?? '')
}

function storageWarn(message: string, details?: Record<string, unknown>): void {
  console.warn('[tc-storage:mist-storage]', message, details ?? '')
}

export async function loadMistModule(): Promise<MistModule> {
  if (!mistModulePromise) {
    storageLog('loading mistlib wasm module')
    mistModulePromise = import('./vendor/mistlib-wasm/mistlib_wasm.js').then(async (module) => {
      await module.default()
      storageLog('mistlib wasm module initialized')
      return module
    })
  }
  return mistModulePromise
}

export async function saveEncryptedFolderToMist(options: {
  folder: FolderRecord
  folders?: FolderRecord[]
  files: FileRecord[]
  passphrase: string
  originNode: string
}): Promise<string> {
  assertMistStorageAvailable()
  const mist = await loadMistModule()
  const bundle: FolderBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    originNode: options.originNode,
    folder: options.folder,
    folders: options.folders,
    files: options.files.map(stripFileContent),
  }
  const encrypted = await encryptJson(bundle, options.passphrase)
  const bytes = encoder.encode(JSON.stringify(encrypted))
  const name = `${options.folder.id}.tc-folder.enc.json`
  storageLog('storage_add folder start', { name, folderId: options.folder.id, fileCount: options.files.length, bytes: bytes.byteLength })
  try {
    const cid = await mist.storage_add(name, bytes)
    storageLog('storage_add folder complete', { name, folderId: options.folder.id, cid, bytes: bytes.byteLength })
    return cid
  } catch (error) {
    storageWarn('storage_add folder failed', { name, folderId: options.folder.id, error: describeStorageError(error) })
    throw error
  }
}

export async function saveEncryptedFileToMist(options: {
  folder: FolderRecord
  file: FileRecord
  passphrase: string
  originNode: string
}): Promise<string> {
  assertMistStorageAvailable()
  if (!options.file.dataUrl) throw new Error(`${options.file.name} の本文がローカルにありません。CIDから取得してから保存してください。`)
  const mist = await loadMistModule()
  const bundle: FileBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    originNode: options.originNode,
    folder: options.folder,
    file: options.file,
  }
  const encrypted = await encryptJson(bundle, options.passphrase)
  const bytes = encoder.encode(JSON.stringify(encrypted))
  const name = `${options.file.id}.tc-file.enc.json`
  storageLog('storage_add file start', { name, folderId: options.folder.id, fileId: options.file.id, bytes: bytes.byteLength })
  try {
    const cid = await mist.storage_add(name, bytes)
    storageLog('storage_add file complete', { name, folderId: options.folder.id, fileId: options.file.id, cid, bytes: bytes.byteLength })
    return cid
  } catch (error) {
    storageWarn('storage_add file failed', { name, folderId: options.folder.id, fileId: options.file.id, error: describeStorageError(error) })
    throw error
  }
}

export async function loadEncryptedFolderFromMist(cid: string, passphrase: string): Promise<FolderBundle> {
  assertMistStorageAvailable()
  const mist = await loadMistModule()
  const normalizedCid = cid.trim()
  storageLog('storage_get folder start', { cid: normalizedCid })
  try {
    const bytes = await mist.storage_get(normalizedCid)
    storageLog('storage_get folder complete', { cid: normalizedCid, bytes: bytes.byteLength })
    const encrypted = JSON.parse(decoder.decode(bytes)) as EncryptedPayload
    const bundle = await decryptJson<FolderBundle>(encrypted, passphrase)
    storageLog('storage_get folder decrypted', { cid: normalizedCid, folderId: bundle.folder.id, fileCount: bundle.files.length })
    return bundle
  } catch (error) {
    storageWarn('storage_get folder failed', { cid: normalizedCid, error: describeStorageError(error) })
    throw error
  }
}

export async function loadEncryptedFileFromMist(cid: string, passphrase: string): Promise<FileBundle> {
  assertMistStorageAvailable()
  const mist = await loadMistModule()
  const normalizedCid = cid.trim()
  storageLog('storage_get file start', { cid: normalizedCid })
  try {
    const bytes = await mist.storage_get(normalizedCid)
    storageLog('storage_get file complete', { cid: normalizedCid, bytes: bytes.byteLength })
    const encrypted = JSON.parse(decoder.decode(bytes)) as EncryptedPayload
    const bundle = await decryptJson<FileBundle>(encrypted, passphrase)
    storageLog('storage_get file decrypted', { cid: normalizedCid, folderId: bundle.folder.id, fileId: bundle.file.id })
    return bundle
  } catch (error) {
    storageWarn('storage_get file failed', { cid: normalizedCid, error: describeStorageError(error) })
    throw error
  }
}

export function assertMistStorageAvailable(): void {
  const navigatorValue = globalThis.navigator as NavigatorWithOpfs | undefined
  if (typeof navigatorValue?.storage?.getDirectory === 'function') return
  throw new Error(mistStorageUnavailableMessage())
}

function mistStorageUnavailableMessage(): string {
  const locationValue = globalThis.location
  const localhostUrl =
    locationValue?.protocol === 'http:' && locationValue.port && locationValue.hostname !== 'localhost'
      ? ` http://localhost:${locationValue.port}${locationValue.pathname}${locationValue.search}${locationValue.hash} を同じ端末で開くか、`
      : ' '
  return `mistlib保存にはOPFSが必要です。現在のブラウザURLでは navigator.storage.getDirectory が利用できません。${localhostUrl}HTTPSで開いてください。`
}

function describeStorageError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
