import { decryptJson, encryptJson, type EncryptedPayload } from './crypto.js'
import { stripFileContent, type FileBundle, type FileRecord, type FolderBundle, type FolderRecord } from './domain.js'
import { describeError } from './errors.js'
import { debugInfo, debugWarn } from './logging.js'

type MistModule = typeof import('./vendor/mistlib-wasm/mistlib_wasm.js')
type NavigatorWithOpfs = Navigator & {
  storage?: StorageManager & {
    getDirectory?: () => Promise<unknown>
  }
}
type MistConfigBridge = {
  get_config: () => string
  set_config: (data: string) => boolean
}
type MistRuntimeController = Pick<MistModule, 'init_with_config'>
export type MistRuntimeSettings = {
  nodeId?: string
}
type StoredBundleKind = 'file' | 'folder'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
export const mistStorageMaxCapacityMb = 256 * 1024
const verifyStorageAddEnabled =
  typeof import.meta.env !== 'undefined' &&
  import.meta.env.VITE_VERIFY_MIST_STORAGE === 'true'
let mistModulePromise: Promise<MistModule> | undefined
let mistRuntimeInitKey = ''
let fallbackRuntimeNodeId = ''

function storageLog(message: string, details?: Record<string, unknown>): void {
  debugInfo('mist-storage', message, details)
}

function storageWarn(message: string, details?: Record<string, unknown>): void {
  debugWarn('mist-storage', message, details)
}

export async function loadMistModule(): Promise<MistModule> {
  if (!mistModulePromise) {
    storageLog('loading mistlib wasm module')
    mistModulePromise = import('./vendor/mistlib-wasm/mistlib_wasm.js').then(async (module) => {
      await module.default()
      configureMistStorageCapacity(module)
      storageLog('mistlib wasm module initialized', storageContextDetails())
      return module
    })
  }
  return mistModulePromise
}

export function configureMistStorageCapacity(mist: MistConfigBridge, capacityMb = mistStorageMaxCapacityMb): boolean {
  try {
    const config = parseMistConfig(mist.get_config())
    const nextConfig = { ...config, storageMaxCapacityMb: capacityMb }
    const configured = mist.set_config(JSON.stringify(nextConfig))
    if (!configured) storageWarn('mistlib storage capacity config was rejected', { capacityMb })
    else storageLog('mistlib storage capacity configured', { capacityMb })
    return configured
  } catch (error) {
    storageWarn('mistlib storage capacity config failed', { capacityMb, error: describeStorageError(error) })
    return false
  }
}

export function ensureMistRuntimeInitialized(
  mist: MistRuntimeController,
  settings: MistRuntimeSettings = {},
  options: { force?: boolean; reason?: string } = {},
): void {
  const runtime = normalizeMistRuntimeSettings(settings)
  const initKey = runtime.nodeId
  if (!options.force && mistRuntimeInitKey === initKey) return
  const reason = options.reason ?? 'storage'
  storageLog('mist runtime init start', { reason, force: Boolean(options.force), nodeId: shortRuntimeValue(runtime.nodeId) })
  mist.init_with_config(runtime.nodeId, JSON.stringify({ signaling: { mode: 'nostr', nostr: { relays: [] } } }))
  mistRuntimeInitKey = initKey
  storageLog('mist runtime init complete', { reason, nodeId: shortRuntimeValue(runtime.nodeId) })
}

function parseMistConfig(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

export async function saveEncryptedFolderToMist(options: {
  folder: FolderRecord
  folders?: FolderRecord[]
  files: FileRecord[]
  passphrase: string
  originNode: string
  runtimeNodeId?: string
}): Promise<string> {
  assertMistStorageAvailable()
  const mist = await loadMistModule()
  ensureMistRuntimeInitialized(mist, { nodeId: options.runtimeNodeId ?? options.originNode })
  const rootFolder = { ...options.folder, parentId: null }
  const folders = options.folders?.map((folder) => (folder.id === options.folder.id ? rootFolder : folder))
  const bundle: FolderBundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    originNode: options.originNode,
    folder: rootFolder,
    folders,
    files: options.files.map(stripFileContent),
  }
  const encrypted = await encryptJson(bundle, options.passphrase)
  const bytes = encoder.encode(JSON.stringify(encrypted))
  const name = `${options.folder.id}.tc-folder.enc.json`
  storageLog('storage_add folder start', {
    name,
    folderId: options.folder.id,
    folderName: options.folder.name,
    fileCount: options.files.length,
    fileCidCount: options.files.filter((file) => Boolean(file.lastCid)).length,
    bytes: bytes.byteLength,
  })
  try {
    const cid = await mist.storage_add(name, bytes)
    storageLog('storage_add folder complete', { name, folderId: options.folder.id, folderName: options.folder.name, cid, bytes: bytes.byteLength })
    await verifyStorageAdd(mist, 'folder', cid, { name, folderId: options.folder.id, folderName: options.folder.name })
    return cid
  } catch (error) {
    storageWarn('storage_add folder failed', { name, folderId: options.folder.id, folderName: options.folder.name, error: describeStorageError(error), ...storageContextDetails() })
    throw error
  }
}

export async function saveEncryptedFileToMist(options: {
  folder: FolderRecord
  file: FileRecord
  passphrase: string
  originNode: string
  runtimeNodeId?: string
}): Promise<string> {
  assertMistStorageAvailable()
  if (!options.file.dataUrl) throw new Error(`${options.file.name} の本文がローカルにありません。CIDから取得してから保存してください。`)
  const mist = await loadMistModule()
  ensureMistRuntimeInitialized(mist, { nodeId: options.runtimeNodeId ?? options.originNode })
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
  storageLog('storage_add file start', {
    name,
    folderId: options.folder.id,
    folderName: options.folder.name,
    fileId: options.file.id,
    fileName: options.file.name,
    mimeType: options.file.mimeType,
    size: options.file.size,
    checksum: options.file.checksum,
    bytes: bytes.byteLength,
  })
  try {
    const cid = await mist.storage_add(name, bytes)
    storageLog('storage_add file complete', { name, folderId: options.folder.id, folderName: options.folder.name, fileId: options.file.id, fileName: options.file.name, cid, bytes: bytes.byteLength })
    await verifyStorageAdd(mist, 'file', cid, { name, folderId: options.folder.id, folderName: options.folder.name, fileId: options.file.id, fileName: options.file.name })
    return cid
  } catch (error) {
    storageWarn('storage_add file failed', { name, folderId: options.folder.id, folderName: options.folder.name, fileId: options.file.id, fileName: options.file.name, error: describeStorageError(error), ...storageContextDetails() })
    throw error
  }
}

export async function loadEncryptedFolderFromMist(cid: string, passphrase: string, runtime: MistRuntimeSettings = {}): Promise<FolderBundle> {
  assertMistStorageAvailable()
  const mist = await loadMistModule()
  ensureMistRuntimeInitialized(mist, runtime)
  const normalizedCid = cid.trim()
  storageLog('storage_get folder start', { cid: normalizedCid })
  try {
    const bytes = await loadStoredBytes(mist, 'folder', normalizedCid)
    const encrypted = parseEncryptedPayload(bytes, 'folder', normalizedCid)
    const bundle = await decryptEncryptedPayload<FolderBundle>(encrypted, passphrase, 'folder', normalizedCid)
    storageLog('storage_get folder decrypted', {
      cid: normalizedCid,
      folderId: bundle.folder.id,
      folderName: bundle.folder.name,
      fileCount: bundle.files.length,
      fileCidCount: bundle.files.filter((file) => Boolean(file.lastCid)).length,
      fileDataUrlCount: bundle.files.filter((file) => Boolean(file.dataUrl)).length,
      originNode: bundle.originNode,
    })
    return bundle
  } catch (error) {
    storageWarn('storage_get folder failed', { cid: normalizedCid, error: describeStorageError(error), ...storageContextDetails() })
    throw error
  }
}

export async function loadEncryptedFileFromMist(cid: string, passphrase: string, runtime: MistRuntimeSettings = {}): Promise<FileBundle> {
  assertMistStorageAvailable()
  const mist = await loadMistModule()
  ensureMistRuntimeInitialized(mist, runtime)
  const normalizedCid = cid.trim()
  storageLog('storage_get file start', { cid: normalizedCid })
  try {
    const bytes = await loadStoredBytes(mist, 'file', normalizedCid)
    const encrypted = parseEncryptedPayload(bytes, 'file', normalizedCid)
    const bundle = await decryptEncryptedPayload<FileBundle>(encrypted, passphrase, 'file', normalizedCid)
    storageLog('storage_get file decrypted', {
      cid: normalizedCid,
      folderId: bundle.folder.id,
      folderName: bundle.folder.name,
      fileId: bundle.file.id,
      fileName: bundle.file.name,
      mimeType: bundle.file.mimeType,
      size: bundle.file.size,
      checksum: bundle.file.checksum,
      hasDataUrl: Boolean(bundle.file.dataUrl),
      originNode: bundle.originNode,
    })
    return bundle
  } catch (error) {
    storageWarn('storage_get file failed', { cid: normalizedCid, error: describeStorageError(error), ...storageContextDetails() })
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
  return describeError(error, 'unknown storage error')
}

async function loadStoredBytes(mist: Pick<MistModule, 'storage_get'>, kind: StoredBundleKind, cid: string): Promise<Uint8Array> {
  try {
    const bytes = await mist.storage_get(cid)
    storageLog(`storage_get ${kind} complete`, { cid, bytes: bytes.byteLength })
    return bytes
  } catch (error) {
    const message = describeStorageError(error)
    storageWarn(`storage_get ${kind} retrieval failed`, { cid, error: message, ...storageContextDetails() })
    throw new Error(`storage_get ${kind} retrieval failed: ${message}`)
  }
}

function parseEncryptedPayload(bytes: Uint8Array, kind: StoredBundleKind, cid: string): EncryptedPayload {
  const text = decoder.decode(bytes)
  try {
    return JSON.parse(text) as EncryptedPayload
  } catch (error) {
    const message = describeStorageError(error)
    storageWarn(`storage_get ${kind} parse failed`, { cid, bytes: bytes.byteLength, textPrefix: text.slice(0, 32), error: message, ...storageContextDetails() })
    throw new Error(`保存データJSONを解析できませんでした (${kind}): ${message}`)
  }
}

function normalizeMistRuntimeSettings(settings: MistRuntimeSettings): Required<MistRuntimeSettings> {
  return {
    nodeId: settings.nodeId?.trim() || storedRuntimeNodeId() || createFallbackRuntimeNodeId(),
  }
}

function storedRuntimeNodeId(): string {
  try {
    return globalThis.localStorage?.getItem('tc-storage-node-id-v1')?.trim() ?? ''
  } catch {
    return ''
  }
}

function createFallbackRuntimeNodeId(): string {
  if (fallbackRuntimeNodeId) return fallbackRuntimeNodeId
  const cryptoApi = globalThis.crypto
  fallbackRuntimeNodeId = typeof cryptoApi?.randomUUID === 'function'
    ? `node-${cryptoApi.randomUUID()}`
    : `node-${Math.random().toString(36).slice(2, 10)}`
  return fallbackRuntimeNodeId
}

function shortRuntimeValue(value: string): string {
  return value.length > 22 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value
}

async function decryptEncryptedPayload<T>(encrypted: EncryptedPayload, passphrase: string, kind: StoredBundleKind, cid: string): Promise<T> {
  try {
    return await decryptJson<T>(encrypted, passphrase)
  } catch (error) {
    const message = describeStorageError(error)
    storageWarn(`storage_get ${kind} decrypt failed`, { cid, error: message, ...storageContextDetails() })
    throw new Error(`保存データを復号できませんでした (${kind}): ${message}`)
  }
}

async function verifyStorageAdd(mist: Pick<MistModule, 'storage_get'>, kind: 'file' | 'folder', cid: string, details: Record<string, unknown>): Promise<void> {
  if (!verifyStorageAddEnabled) return
  storageLog('storage_add verify start', { kind, cid, ...details })
  try {
    const bytes = await mist.storage_get(cid)
    storageLog('storage_add verify complete', { kind, cid, bytes: bytes.byteLength, ...details })
  } catch (error) {
    storageWarn('storage_add verify failed', { kind, cid, error: describeStorageError(error), ...details, ...storageContextDetails() })
  }
}

function storageContextDetails(): Record<string, unknown> {
  const locationValue = globalThis.location
  const navigatorValue = globalThis.navigator as NavigatorWithOpfs | undefined
  return {
    origin: locationValue?.origin,
    pathname: locationValue?.pathname,
    isSecureContext: globalThis.isSecureContext,
    hasOpfs: typeof navigatorValue?.storage?.getDirectory === 'function',
    verifyStorageAdd: verifyStorageAddEnabled,
  }
}
