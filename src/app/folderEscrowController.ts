import { EscrowClient } from '../escrow/client'
import type { EscrowTransport } from '../escrow/client'
import type { EscrowHead } from '../escrow/head'
import { headHash } from '../escrow/head'
import { deriveAutoRoom, sha256 } from '../escrow/crypto'
import type { FileRecord, FolderRecord, StorageSnapshot } from '../storage/domain.js'
import { createMistEscrowTransport } from '../escrow/mistTransport.js'
import type { StorageEscrowTransport } from '../escrow/mistTransport.js'
import {
  APP,
  CHECKPOINT_SCHEMA,
  MANIFEST_BYTES,
  checkpointFingerprint,
  contentIdentity,
  encodeCheckpoint,
  folderInput,
  mergeFolderCheckpoint,
  projectFolder,
  validateCheckpoint,
} from '../folder/folderCheckpoint.js'
import type { FolderCheckpoint } from '../folder/folderCheckpoint.js'
import { buildContentPacks, readPinnedPack, reconstructContent } from '../folder/folderEscrowContent.js'
import { loadFolderEscrow, persistFolderEscrow } from '../storage/folderEscrow.js'
import type { EscrowLocal } from '../storage/folderEscrow.js'
import { bytesToBase64 } from '../crypto/cryptoEncoding.js'
import { descendantFolderIds } from './appHelpers.js'
import { escrowAppRooms } from '../escrow/appRooms.js'

export type FolderEscrowStatus =
  'off' | 'searching' | 'restoring' | 'ready' | 'saving' | 'saved' | 'saved-with-omissions' | 'error'
export interface FolderEscrowView {
  room: string
  status: FolderEscrowStatus
  savedAt: number
  reason?: string
  protectedFiles: number
  totalFiles: number
}
export interface FolderEscrowContext {
  folderId: string
  key: string
  appRoom: string
  appRoomIds?(): readonly string[]
  nodeId: string
  setting?: FolderRecord['escrow']
  enabled?: boolean
  snapshot(): StorageSnapshot
  merge(checkpoint: FolderCheckpoint): void
  readFile(file: FileRecord): Promise<Uint8Array>
  changed(view: FolderEscrowView): void
  transport?(provider?: string): StorageEscrowTransport
  createClient?(transport: EscrowTransport, room: string): EscrowClient
  loadLocal?(room: string): EscrowLocal | Promise<EscrowLocal>
  persist?(room: string, local: EscrowLocal): void | Promise<void>
}
// mistl admits one active blob pull per transport peer, across all folder controllers.
let uploads: Promise<unknown> = Promise.resolve()
function serial<T>(action: () => Promise<T>): Promise<T> {
  const next = uploads.catch(() => {}).then(action)
  uploads = next.catch(() => {})
  return next
}
export class FolderEscrowController {
  private ctx: FolderEscrowContext
  private client?: EscrowClient
  private discovery?: StorageEscrowTransport
  private local: EscrowLocal = { lastSeq: 0, lastHash: null, providerSeen: false, savedAt: 0 }
  private checkpoint: FolderCheckpoint | null = null
  private contentSources: FolderCheckpoint[] = []
  private closed = false
  private initialized = false
  private dirty = 1
  private acknowledged = 0
  private fingerprint = ''
  private firstDirty = 0
  private retry = 0
  private timer?: ReturnType<typeof setTimeout>
  private hello?: ReturnType<typeof setInterval>
  private peerOff?: () => void
  private work?: Promise<void>
  private session?: {
    client: EscrowClient
    transport: StorageEscrowTransport
  }
  private loads = new Map<string, Promise<string>>()
  private contentTransports = new Set<StorageEscrowTransport>()
  private viewValue: FolderEscrowView = { room: '', status: 'searching', savedAt: 0, protectedFiles: 0, totalFiles: 0 }
  constructor(ctx: FolderEscrowContext) {
    this.ctx = ctx
  }
  get view(): FolderEscrowView {
    return this.viewValue
  }
  private transport(provider?: string) {
    return this.ctx.transport?.(provider) ?? createMistEscrowTransport(this.ctx.nodeId, provider)
  }
  private makeClient(transport: EscrowTransport, room: string): EscrowClient {
    return (
      this.ctx.createClient?.(transport, room) ?? new EscrowClient(transport, room, { maxPlaintext: MANIFEST_BYTES })
    )
  }
  /** Collision is terminal for this controller; the hook recreates it when app rooms change. */
  private roomAvailable(): boolean {
    if (this.closed) return false
    const rooms = escrowAppRooms([this.ctx.appRoom, ...(this.ctx.appRoomIds?.() ?? [])], this.ctx.snapshot().folders)
    if (this.view.room && rooms.includes(this.view.room)) {
      this.setStatus('error', 'Escrow room "' + this.view.room + '" conflicts with an app room (home, joined, or shared folder room)')
      this.dispose()
      return false
    }
    return true
  }
  async start(): Promise<void> {
    if (this.closed) return
    if (this.ctx.setting?.mode === 'off') {
      this.setStatus('off')
      return
    }
    try {
      const room =
        this.ctx.setting?.mode === 'custom'
          ? this.ctx.setting.room
          : await deriveAutoRoom(APP, folderInput(this.ctx.folderId, this.ctx.key))
      if (!this.roomAvailable()) return
      this.viewValue.room = room
      if (!this.roomAvailable()) return
      this.local = await (this.ctx.loadLocal?.(room) ?? loadFolderEscrow(this.ctx.folderId, this.ctx.key, room))
      this.viewValue.savedAt = this.local.savedAt
      // Persisted descriptors are untrusted and must pass the same remote validation.
      if (this.local.checkpoint)
        this.checkpoint = await validateCheckpoint(
          encodeCheckpoint(this.local.checkpoint),
          this.ctx.folderId,
          this.ctx.key,
          this.ctx.appRoom,
        )
      if (this.local.contentSources) {
        if (!Array.isArray(this.local.contentSources) || this.local.contentSources.length > 2)
          throw new Error('Invalid stored escrow descriptors')
        for (const c of this.local.contentSources)
          this.contentSources.push(
            await validateCheckpoint(encodeCheckpoint(c), this.ctx.folderId, this.ctx.key, this.ctx.appRoom),
          )
      }
      if (this.checkpoint) this.contentSources.push(this.checkpoint)
      if (!this.roomAvailable()) return
      if (this.ctx.enabled === false) {
        this.setStatus('searching')
        return
      }
      this.discovery = this.transport()
      this.client = this.makeClient(this.discovery, room)
      this.client.onProvider(() => {
        if (!this.closed && !this.work && !this.initialized) void this.restore()
      })
      this.peerOff = this.discovery.onPeer(room, (_id, joined) => {
        if (!joined && !this.closed) {
          this.initialized = false
          this.setStatus('searching')
        }
      })
      await this.client.join()
      if (!this.roomAvailable()) return
      if (!this.work) this.setStatus('searching')
      this.hello = setInterval(() => {
        if (!this.roomAvailable()) return
        try {
          this.discovery?.send(room, null, new TextEncoder().encode('{"v":1,"type":"escrow_hello"}'))
        } catch {
          /* Retry after runtime recovery. */
        }
        if (!this.work && this.dirty !== this.acknowledged && this.client?.providers.size) this.schedule()
      }, 10000)
      this.observe()
    } catch (error) {
      if (!this.closed) {
        this.setStatus('error', String(error))
        this.scheduleRetry()
      }
    }
  }
  observe(): void {
    if (!this.roomAvailable() || this.ctx.enabled === false || this.ctx.setting?.mode === 'off') return
    try {
      const snapshot = this.ctx.snapshot()
      if (!snapshot.folders.some((f) => f.id === this.ctx.folderId)) return
      const signature = checkpointFingerprint(snapshot, this.ctx.folderId)
      if (signature !== this.fingerprint) {
        this.fingerprint = signature
        this.dirty++
        if (this.view.status === 'saved') this.setStatus('ready')
        this.schedule()
      }
    } catch (error) {
      this.setStatus('error', String(error))
    }
  }
  private setStatus(status: FolderEscrowStatus, reason?: string): void {
    if (this.closed) return
    const snapshot = this.ctx.snapshot(),
      ids = descendantFolderIds(snapshot.folders, this.ctx.folderId)
    const files = snapshot.files.filter((f) => !f.deletedAt && ids.has(f.folderId))
    const contents = [this.checkpoint, ...this.contentSources].flatMap((c) => c?.contents ?? [])
    this.viewValue = {
      ...this.viewValue,
      status,
      reason,
      protectedFiles: files.filter((file) =>
        contents.some((c) => c.fileId === file.id && c.checksum === file.checksum && c.size === file.size),
      ).length,
      totalFiles: files.length,
    }
    this.ctx.changed(this.viewValue)
  }
  private async persist(): Promise<void> {
    const local = {
      ...this.local,
      ...(this.checkpoint && { checkpoint: this.checkpoint }),
      contentSources: this.contentSources.filter((c) => c !== this.checkpoint).slice(-2),
    }
    if (this.ctx.persist) await this.ctx.persist(this.view.room, local)
    else await persistFolderEscrow(this.ctx.folderId, this.ctx.key, this.view.room, local)
  }
  private remember(checkpoint: FolderCheckpoint): void {
    if (this.checkpoint) this.contentSources.push(this.checkpoint)
    this.contentSources = this.contentSources.slice(-2)
    this.checkpoint = checkpoint
  }
  private contentSource(snapshot: StorageSnapshot): FolderCheckpoint | null {
    if (!this.checkpoint) return null
    const sources = [this.checkpoint, ...this.contentSources.toReversed()]
    const contents = snapshot.files.flatMap((file) => {
      const entry = sources
        .flatMap((c) => c.contents)
        .find((c) => c.fileId === file.id && c.checksum === file.checksum && c.size === file.size)
      return entry ? [entry] : []
    })
    const digests = new Set(contents.flatMap((c) => c.segments.map((s) => s.packDigest)))
    const packs = sources
      .flatMap((c) => c.packs)
      .filter((p, i, all) => digests.has(p.digest) && all.findIndex((q) => q.digest === p.digest) === i)
    return { ...this.checkpoint, snapshot, contents, packs }
  }
  private schedule(delay = 2000): void {
    if (this.closed || this.ctx.setting?.mode === 'off' || this.dirty === this.acknowledged) return
    const now = Date.now()
    if (!this.firstDirty) this.firstDirty = now
    clearTimeout(this.timer)
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        void this.flush()
      },
      Math.max(0, Math.min(delay, 30000 - (now - this.firstDirty))) + Math.random() * 150,
    )
  }
  private scheduleRetry(): void {
    if (this.closed) return
    this.firstDirty = 0
    this.retry++
    clearTimeout(this.timer)
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        if (!this.client) void this.start()
        else if (!this.initialized) void this.restore()
        else void this.flush()
      },
      Math.min(60000, 2000 * 2 ** Math.min(this.retry, 5)) + Math.random() * 500,
    )
  }
  private async transaction<T>(
    action: (client: EscrowClient, transport: StorageEscrowTransport) => Promise<T>,
  ): Promise<T> {
    if (!this.roomAvailable()) throw new Error('Escrow controller closed')
    const provider = [...(this.client?.providers.keys() ?? [])].sort()[0]
    if (!provider) throw new Error('No escrow provider')
    const transport = this.transport(provider),
      client = this.makeClient(transport, this.view.room)
    this.session = { client, transport }
    const offLoss = transport.onPeer(this.view.room, (_id, joined) => {
      if (!joined) client.dispose()
    })
    try {
      if (!(await client.waitForProvider(4000))) throw new Error('Selected escrow provider unavailable')
      if (!this.roomAvailable()) throw new Error('Escrow controller closed')
      transport.assertProvider()
      return await action(client, transport)
    } finally {
      offLoss()
      await transport.releasePins()
      client.dispose()
      if (this.session?.client === client) this.session = undefined
    }
  }
  private async fetch(client: EscrowClient): Promise<{
    checkpoint: FolderCheckpoint
    head: EscrowHead
    hash: string
  } | null> {
    const latest = await client.fetchLatest(APP, folderInput(this.ctx.folderId, this.ctx.key))
    if (!this.roomAvailable()) throw new Error('Escrow controller closed')
    if (!latest) {
      if (this.local.lastSeq > 0 || (this.local.verifiedSeq ?? 0) > 0)
        throw new Error('Known escrow checkpoint missing from provider')
      return null
    }
    if (latest.head.schema !== CHECKPOINT_SCHEMA) throw new Error('Invalid folder checkpoint schema')
    const hash = await headHash(latest.head)
    for (const known of [
      { seq: this.local.lastSeq, hash: this.local.lastHash },
      { seq: this.local.verifiedSeq ?? 0, hash: this.local.verifiedHash },
    ]) {
      if (latest.head.seq < known.seq || (latest.head.seq === known.seq && known.hash !== hash))
        throw new Error('Escrow rollback detected')
    }
    const checkpoint = await validateCheckpoint(latest.plaintext, this.ctx.folderId, this.ctx.key, this.ctx.appRoom)
    // A verified read protects readers against rollback without implying a local ACK.
    this.local = { ...this.local, verifiedSeq: latest.head.seq, verifiedHash: hash }
    await this.persist()
    return { checkpoint, head: latest.head, hash }
  }
  private restore(): Promise<void> {
    if (this.work || this.closed || !this.client?.providers.size) return this.work ?? Promise.resolve()
    this.setStatus('restoring')
    this.work = serial(() =>
      this.transaction(async (client, transport) => {
        const latest = await this.fetch(client)
        transport.assertProvider()
        if (!this.roomAvailable()) return
        if (latest) {
          if (this.checkpoint) this.ctx.merge(this.checkpoint)
          this.remember(latest.checkpoint)
          this.ctx.merge(latest.checkpoint)
        }
        this.local.providerSeen = true
        await this.persist()
        this.initialized = true
        this.retry = 0
        this.setStatus('ready')
      }),
    )
      .catch((error) => {
        if (!this.closed) {
          this.setStatus('error', String(error))
          this.scheduleRetry()
        }
      })
      .finally(() => {
        this.work = undefined
        if (this.initialized && !this.closed) {
          this.observe()
          this.schedule()
        }
      })
    return this.work
  }
  async flush(): Promise<void> {
    if (!this.roomAvailable()) return
    // A disconnect flush must include the revision requested by this caller,
    // even if an older save or the initial restore is already running.
    const revision = this.dirty
    if (this.work) {
      await this.work
      if (this.view.status === 'error') return
    }
    while (
      !this.closed &&
      this.ctx.setting?.mode !== 'off' &&
      this.client?.providers.size &&
      this.acknowledged < revision
    ) {
      if (!this.initialized) await this.restore()
      else await this.save()
      if (this.view.status === 'error') return
    }
  }
  private save(): Promise<void> {
    if (this.work) return this.work
    if (
      this.closed ||
      this.ctx.setting?.mode === 'off' ||
      !this.client?.providers.size ||
      this.dirty === this.acknowledged
    )
      return Promise.resolve()
    if (!this.initialized) return this.restore()
    this.firstDirty = 0
    this.work = serial(() =>
      this.transaction(async (client, transport) => {
        this.setStatus('saving')
        for (let attempt = 0; attempt < 3; attempt++) {
          const latest = await this.fetch(client)
          transport.assertProvider()
          if (!this.roomAvailable()) return
          if (latest) {
            if (this.checkpoint) this.ctx.merge(this.checkpoint)
            this.ctx.merge(latest.checkpoint)
            this.remember(latest.checkpoint)
          }
          const revision = this.dirty
          let snapshot = this.ctx.snapshot()
          if (this.checkpoint) snapshot = mergeFolderCheckpoint(snapshot, this.checkpoint)
          const scoped = projectFolder(snapshot, this.ctx.folderId)
          const signature = checkpointFingerprint(snapshot, this.ctx.folderId)
          const content = await buildContentPacks(
            {
              client,
              transport,
              assertProvider: () => {
                transport.assertProvider()
                if (!this.roomAvailable()) throw new Error('Escrow controller closed')
              },
            },
            this.ctx.folderId,
            this.ctx.key,
            scoped.files,
            this.contentSource(scoped),
            this.ctx.readFile,
          )
          transport.assertProvider()
          if (!this.roomAvailable()) return
          const checkpoint: FolderCheckpoint = {
            v: 1,
            rootFolderId: this.ctx.folderId,
            appRoomId: this.ctx.appRoom,
            snapshot: scoped,
            ...content,
          }
          const bytes = encodeCheckpoint(checkpoint)
          await validateCheckpoint(bytes, this.ctx.folderId, this.ctx.key, this.ctx.appRoom)
          transport.assertProvider()
          if (!this.roomAvailable()) return
          const result = await client.saveCheckpoint(APP, folderInput(this.ctx.folderId, this.ctx.key), bytes, {
            schema: CHECKPOINT_SCHEMA,
            parent: latest?.hash ?? null,
            seq: (latest?.head.seq ?? 0) + 1,
          })
          transport.assertProvider()
          if (!this.roomAvailable()) return
          if (result.type === 'ack') {
            this.checkpoint = checkpoint
            this.contentSources = []
            this.local = {
              ...this.local,
              lastSeq: result.seq,
              lastHash: result.hash,
              savedAt: Date.now(),
              providerSeen: true,
            }
            await this.persist()
            this.acknowledged = revision
            this.retry = 0
            this.viewValue.savedAt = this.local.savedAt
            const current = checkpointFingerprint(this.ctx.snapshot(), this.ctx.folderId)
            if (current !== signature) {
              this.dirty++
              this.fingerprint = current
            }
            this.setStatus(this.dirty === this.acknowledged ? 'saved' : 'ready')
            return
          }
          if (result.type === 'error') throw new Error(result.code + ': ' + result.message)
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt + Math.random() * 200))
        }
        throw new Error('Folder checkpoint conflict retries exhausted')
      }),
    )
      .catch((error) => {
        if (!this.closed) {
          this.setStatus('error', String(error))
          this.scheduleRetry()
        }
      })
      .finally(() => {
        this.work = undefined
        if (!this.closed && this.view.status !== 'error' && this.dirty !== this.acknowledged) this.schedule()
      })
    return this.work
  }
  hasContent(file: FileRecord): boolean {
    return (
      this.roomAvailable() &&
      this.ctx.enabled !== false &&
      this.ctx.setting?.mode !== 'off' &&
      [this.checkpoint, ...this.contentSources].some((source) =>
        source?.contents.some((c) => c.fileId === file.id && c.checksum === file.checksum && c.size === file.size),
      )
    )
  }
  loadContent(file: FileRecord): Promise<string> {
    if (!this.roomAvailable()) return Promise.reject(new Error('Escrow content unavailable'))
    const identity = contentIdentity(file)
    const pending = this.loads.get(identity)
    if (pending) return pending
    const source = [this.checkpoint, ...this.contentSources].find((source) =>
      source?.contents.some((c) => c.fileId === file.id && c.checksum === file.checksum && c.size === file.size),
    )
    const entry = source?.contents.find(
      (c) => c.fileId === file.id && c.checksum === file.checksum && c.size === file.size,
    )
    if (!entry || this.closed || this.ctx.enabled === false || this.ctx.setting?.mode === 'off')
      return Promise.reject(new Error('Escrow content unavailable'))
    const packs = source!.packs,
      transport = this.transport()
    this.contentTransports.add(transport)
    const promise = (async () => {
      try {
        await transport.join(this.view.room)
        if (!this.roomAvailable()) throw new Error('Escrow controller closed')
        const bytes = await reconstructContent(entry, packs, (p) =>
          readPinnedPack(transport, p, this.ctx.folderId, this.ctx.key),
        )
        if ((await sha256(bytes)) !== file.checksum) throw new Error('File checksum mismatch')
        if (!this.roomAvailable()) throw new Error('Escrow controller closed')
        const current = this.ctx.snapshot().files.find((f) => f.id === file.id && !f.deletedAt)
        if (!current || contentIdentity(current) !== identity)
          throw new Error('File changed while downloading escrow content')
        return 'data:' + file.mimeType + ';base64,' + bytesToBase64(bytes)
      } finally {
        transport.leave(this.view.room)
        this.contentTransports.delete(transport)
      }
    })().finally(() => this.loads.delete(identity))
    this.loads.set(identity, promise)
    return promise
  }
  dispose(): void {
    this.closed = true
    clearTimeout(this.timer)
    clearInterval(this.hello)
    this.peerOff?.()
    this.client?.dispose()
    this.session?.client.dispose()
    for (const transport of this.contentTransports) transport.leave(this.view.room)
    this.contentTransports.clear()
    void this.session?.transport.releasePins()
  }
}
