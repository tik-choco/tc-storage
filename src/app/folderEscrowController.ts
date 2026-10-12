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
  manifestSlots,
  MAX_LIVE_PACKS,
  MAX_PENDING_UPLOADS,
  mergeFolderCheckpoint,
  packSlot,
  PENDING_UPLOAD_PRESSURE,
  projectFolder,
  sanitizePendingUploads,
  validateCheckpoint,
} from '../folder/folderCheckpoint.js'
import type { FolderCheckpoint, PackEntry, PendingUpload } from '../folder/folderCheckpoint.js'
import {
  buildContentPacks,
  mergeRetirementLists,
  PACK_GC_GRACE_MS,
  PACK_GC_MIN_GENERATIONS,
  planPackGc,
  providerCanDelete,
  reconcileUploads,
  sweepDeleting,
  trimLivePacks,
  verifyReferencedPacks,
  readPinnedPack,
  reconstructContent,
} from '../folder/folderEscrowContent.js'
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
  slotsInUse: number
  retiredCount: number
  /** Files whose content is not protected because the live packs would exceed the capacity cap. */
  omittedFiles: number
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
// Above this many slots a save may first run GC-only manifests so uploads find room.
const GC_FIRST_SLOTS = 512
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
  // Uploads of a save that has not been ACKed (by slot): reused by retries, retired if never referenced.
  private pendingPacks = new Map<string, PackEntry>()
  // Pack uploads recorded durably before their PUT (by nonce) until a manifest tracks their slot.
  private uploads = new Map<string, PendingUpload>()
  private loads = new Map<string, Promise<string>>()
  private contentTransports = new Set<StorageEscrowTransport>()
  private viewValue: FolderEscrowView = {
    room: '', status: 'searching', savedAt: 0,
    protectedFiles: 0, totalFiles: 0, slotsInUse: 0, retiredCount: 0, omittedFiles: 0,
  }
  constructor(ctx: FolderEscrowContext) {
    this.ctx = ctx
  }
  get view(): FolderEscrowView {
    return this.viewValue
  }
  private transport(provider?: string) {
    const transport = this.ctx.transport?.(provider) ?? createMistEscrowTransport(this.ctx.nodeId, provider)
    transport.onRoomCollision?.((room) => this.roomCollision(room))
    return transport
  }
  private makeClient(transport: EscrowTransport, room: string): EscrowClient {
    return (
      this.ctx.createClient?.(transport, room) ?? new EscrowClient(transport, room, { maxPlaintext: MANIFEST_BYTES })
    )
  }
  private roomCollision(room: string): void {
    if (this.closed) return
    this.discovery?.excludeAppPeers?.(room)
    this.setStatus('error', 'Escrow room "' + room + '" conflicts with an app room (home, joined, or shared folder room)')
    this.dispose()
  }
  /** Collision is terminal for this controller; the hook recreates it when app rooms change. */
  private roomAvailable(): boolean {
    if (this.closed) return false
    const rooms = escrowAppRooms([this.ctx.appRoom, ...(this.ctx.appRoomIds?.() ?? [])], this.ctx.snapshot().folders)
    if (this.view.room && rooms.includes(this.view.room)) {
      this.roomCollision(this.view.room)
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
      this.uploads = new Map(sanitizePendingUploads(this.local.pendingUploads).map((u) => [u.nonce, u]))
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
        if (this.view.status === 'saved' || this.view.status === 'saved-with-omissions') this.setStatus('ready')
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
      slotsInUse: this.checkpoint ? 1 + manifestSlots(this.checkpoint).size : 0,
      retiredCount: (this.checkpoint?.retired?.length ?? 0) + (this.checkpoint?.deleting?.length ?? 0),
      omittedFiles: files.filter((file) =>
        this.checkpoint?.omitted?.some((o) => o.fileId === file.id && o.checksum === file.checksum && o.size === file.size),
      ).length,
    }
    this.ctx.changed(this.viewValue)
  }
  private async persist(): Promise<void> {
    const local = {
      ...this.local,
      ...(this.checkpoint && { checkpoint: this.checkpoint }),
      contentSources: this.contentSources.filter((c) => c !== this.checkpoint).slice(-2),
      pendingUploads: [...this.uploads.values()],
    }
    if (this.ctx.persist) await this.ctx.persist(this.view.room, local)
    else await persistFolderEscrow(this.ctx.folderId, this.ctx.key, this.view.room, local)
  }
  private remember(checkpoint: FolderCheckpoint): void {
    if (this.checkpoint) this.contentSources.push(this.checkpoint)
    this.contentSources = this.contentSources.slice(-2)
    this.checkpoint = checkpoint
  }
  /** Cached descriptors usable as the base of a new manifest; blocked (retired/deleting) slots are never reused. */
  private contentSource(snapshot: StorageSnapshot, blocked: ReadonlySet<string>): FolderCheckpoint | null {
    if (!this.checkpoint) return null
    const sources = [this.checkpoint, ...this.contentSources.toReversed()]
    const available = new Map<string, PackEntry>()
    for (const pack of sources.flatMap((c) => c.packs))
      if (!blocked.has(packSlot(pack)) && !available.has(pack.digest)) available.set(pack.digest, pack)
    const contents = snapshot.files.flatMap((file) => {
      const entry = sources
        .flatMap((c) => c.contents)
        .find(
          (c) =>
            c.fileId === file.id &&
            c.checksum === file.checksum &&
            c.size === file.size &&
            c.segments.every((s) => available.has(s.packDigest)),
        )
      return entry ? [entry] : []
    })
    const digests = new Set(contents.flatMap((c) => c.segments.map((s) => s.packDigest)))
    const packs = [...available.values()].filter((p) => digests.has(p.digest))
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
  /** Adopt an ACKed manifest as the new local base. */
  private async commit(
    checkpoint: FolderCheckpoint,
    latest: { checkpoint: FolderCheckpoint } | null,
    result: { seq: number; hash: string },
  ): Promise<void> {
    this.contentSources = latest ? [latest.checkpoint] : []
    this.checkpoint = checkpoint
    this.local = {
      ...this.local,
      lastSeq: result.seq,
      lastHash: result.hash,
      savedAt: Date.now(),
      providerSeen: true,
    }
    await this.persist()
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
        let gcPasses = 0
        for (let attempt = 0; attempt < 3; ) {
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
          const packSession = {
            client, transport,
            assertProvider: () => {
              transport.assertProvider()
              if (!this.roomAvailable()) throw new Error('Escrow controller closed')
            },
            onPack: (pack: PackEntry) => this.pendingPacks.set(packSlot(pack), pack),
            onUpload: async (upload: PendingUpload) => {
              // Never upload without room for a durable intent; the save is retried after GC.
              if (this.uploads.size >= MAX_PENDING_UPLOADS)
                throw new Error('Too many unresolved escrow uploads; waiting for GC')
              // Durable before the PUT: a crash or lost ACK must not leave an untracked slot.
              this.uploads.set(upload.nonce, upload)
              await this.persist()
            },
          }
          const seq = (latest?.head.seq ?? 0) + 1
          // Packs of the parent that are retired or deleting are never referenced again by any
          // manifest parented on it: content that is needed is uploaded under a new nonce.
          const lists = mergeRetirementLists(latest?.checkpoint ?? null, this.contentSources)
          const blocked = new Set([...lists.retired, ...lists.deleting].map(packSlot))
          const deleting = await sweepDeleting(packSession, this.ctx.folderId, this.ctx.key, lists.deleting)
          // GC-only manifests (same content, new lists) run first when uploads need room or the
          // upload intents pile up: they rotate the previous generation's packs into `retired`,
          // move eligible retired packs to deleting, advance the generation grace and fold
          // unresolved uploads into `retired`. Without any manifest yet, the first one carries
          // the folder metadata only (no files), so intents can still be folded.
          const base = latest?.checkpoint ?? null
          const slotsNow = base ? manifestSlots(base).size : 0
          const pressure = this.uploads.size >= PENDING_UPLOAD_PRESSURE
          // A manifest from before the live-pack cap may hold too many live packs for a replacement
          // to fit: an omission transition first drops the excess from the live set.
          const overCap = !!base && base.packs.length > MAX_LIVE_PACKS
          if (gcPasses <= PACK_GC_MIN_GENERATIONS && (slotsNow >= GC_FIRST_SLOTS || pressure || overCap)) {
            const trimmed = overCap ? trimLivePacks(base!, MAX_LIVE_PACKS) : null
            const folded = pressure
              ? await reconcileUploads(packSession, this.ctx.folderId, this.ctx.key, [...this.uploads.values()],
                  new Set(base ? manifestSlots({ ...base, retired: lists.retired, deleting }) : []), seq)
              : { candidates: [] as PackEntry[], keep: [] as PendingUpload[] }
            const gc = planPackGc({
              packs: trimmed?.packs ?? base?.packs ?? [], previous: base, retired: lists.retired, deleting,
              pending: pressure ? [...this.pendingPacks.values(), ...folded.candidates] : [],
              now: Date.now(), seq, canDelete: providerCanDelete(client),
            })
            const rotates = gc.retired.length > lists.retired.length
            // Retired packs that wait only for manifests need them to qualify.
            const advance = !gc.moved.length && lists.retired.some((p) => Date.now() - p.since >= PACK_GC_GRACE_MS)
            if (gc.moved.length || rotates || advance || pressure || overCap) {
              gcPasses++
              const only: FolderCheckpoint = base
                ? { ...base, ...trimmed, retained: base.packs, retired: gc.retired, deleting: gc.deleting }
                : {
                    v: 1,
                    rootFolderId: this.ctx.folderId,
                    appRoomId: this.ctx.appRoom,
                    snapshot: { ...scoped, files: [] },
                    contents: [],
                    packs: [],
                    retained: [],
                    retired: gc.retired,
                    deleting: gc.deleting,
                  }
              const gcBytes = encodeCheckpoint(only)
              await validateCheckpoint(gcBytes, this.ctx.folderId, this.ctx.key, this.ctx.appRoom)
              transport.assertProvider()
              const done = await client.saveCheckpoint(APP, folderInput(this.ctx.folderId, this.ctx.key), gcBytes, {
                schema: CHECKPOINT_SCHEMA,
                parent: latest?.hash ?? null,
                seq,
              })
              transport.assertProvider()
              if (!this.roomAvailable()) return
              if (done.type === 'error') throw new Error(done.code + ': ' + done.message)
              if (done.type === 'ack') {
                if (pressure) {
                  this.pendingPacks.clear()
                  this.uploads = new Map(folded.keep.map((u) => [u.nonce, u]))
                }
                await this.commit(only, latest, done)
                await sweepDeleting(packSession, this.ctx.folderId, this.ctx.key, gc.moved).catch(() => {})
              }
              continue
            }
          }
          const reusable = new Map<string, PackEntry>()
          for (const [slot, pack] of this.pendingPacks) {
            if (blocked.has(slot)) this.pendingPacks.delete(slot)
            else reusable.set(pack.digest, pack)
          }
          const content = await buildContentPacks(
            packSession,
            this.ctx.folderId,
            this.ctx.key,
            scoped.files,
            this.contentSource(scoped, blocked),
            this.ctx.readFile,
            { reusable, blocked },
          )
          transport.assertProvider()
          if (!this.roomAvailable()) return
          // Every referenced slot is checked again right before the manifest is published.
          await verifyReferencedPacks(packSession, this.ctx.folderId, this.ctx.key,
            content.packs, content.contents, scoped.files, this.ctx.readFile)
          // Uploads that never made it into a manifest (crash, lost ACK) become retirement candidates.
          const tracked = new Set([
            ...manifestSlots({ packs: latest?.checkpoint.packs ?? [], retained: latest?.checkpoint.retained, retired: lists.retired, deleting }),
            ...this.pendingPacks.keys(),
          ])
          const orphans = await reconcileUploads(packSession, this.ctx.folderId, this.ctx.key,
            [...this.uploads.values()], tracked, seq)
          const plan = planPackGc({
            packs: content.packs, previous: latest?.checkpoint ?? null,
            retired: lists.retired, deleting, pending: [...this.pendingPacks.values(), ...orphans.candidates],
            now: Date.now(), seq, canDelete: providerCanDelete(client),
          })
          const checkpoint: FolderCheckpoint = {
            v: 1,
            rootFolderId: this.ctx.folderId,
            appRoomId: this.ctx.appRoom,
            snapshot: scoped,
            ...content,
            retained: latest?.checkpoint.packs ?? [],
            retired: plan.retired,
            deleting: plan.deleting,
          }
          const bytes = encodeCheckpoint(checkpoint)
          await validateCheckpoint(bytes, this.ctx.folderId, this.ctx.key, this.ctx.appRoom)
          transport.assertProvider()
          if (!this.roomAvailable()) return
          const result = await client.saveCheckpoint(APP, folderInput(this.ctx.folderId, this.ctx.key), bytes, {
            schema: CHECKPOINT_SCHEMA,
            parent: latest?.hash ?? null,
            seq,
          })
          transport.assertProvider()
          if (!this.roomAvailable()) return
          if (result.type === 'ack') {
            // Every upload is now referenced by this manifest or listed in it.
            this.pendingPacks.clear()
            this.uploads = new Map(orphans.keep.map((u) => [u.nonce, u]))
            await this.commit(checkpoint, latest, result)
            this.acknowledged = revision
            this.retry = 0
            this.viewValue.savedAt = this.local.savedAt
            const current = checkpointFingerprint(this.ctx.snapshot(), this.ctx.folderId)
            if (current !== signature) {
              this.dirty++
              this.fingerprint = current
            }
            this.setStatus(
              this.dirty !== this.acknowledged ? 'ready' : checkpoint.omitted?.length ? 'saved-with-omissions' : 'saved',
            )
            // Phase two: only entries an ACKed manifest lists as deleting are deleted. A failure
            // leaves them for the next save (the slot is dropped from the list once it is gone).
            if (plan.moved.length)
              await sweepDeleting(packSession, this.ctx.folderId, this.ctx.key, plan.moved).catch(() => {})
            return
          }
          if (result.type === 'error') throw new Error(result.code + ': ' + result.message)
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt + Math.random() * 200))
          attempt++
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
