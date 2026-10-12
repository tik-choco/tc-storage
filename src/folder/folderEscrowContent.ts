import type { FileRecord } from '../storage/domain.js'
import type { EscrowTransport, EscrowClient } from '../escrow/client'
import { decryptBlob, deriveEscrowKeys, sha256 } from '../escrow/crypto'
import { headHash, verifyHead } from '../escrow/head'
import {
  contentIdentity,
  newPackNonce,
  packSlot,
  PACK_APP,
  PACK_BYTES,
  MAX_LIVE_PACKS,
  MAX_PACKS,
  packInput,
} from './folderCheckpoint.js'
import type { ContentEntry, ContentOmission, PackEntry, PendingUpload, RetiredPack, FolderCheckpoint } from './folderCheckpoint.js'

export async function readPinnedPack(
  transport: Pick<EscrowTransport, 'storageGet'>,
  pack: PackEntry,
  root: string,
  key: string,
): Promise<Uint8Array> {
  const keys = await deriveEscrowKeys(PACK_APP, packInput(root, key, pack.digest, pack.nonce))
  const h = pack.head
  if (
    h.seq !== 1 ||
    h.parent !== null ||
    h.schema !== PACK_APP ||
    h.comp !== 'none' ||
    h.size !== pack.length + 28 ||
    !(await verifyHead(h, { slot: keys.slot, writer: keys.writer, maxBlob: PACK_BYTES + 28 }))
  )
    throw new Error('Invalid pinned pack head')
  let timer: ReturnType<typeof setTimeout> | undefined
  const blob = await Promise.race([
    transport.storageGet(h.cid),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Escrow pack download timed out')), 30000)
    }),
  ]).finally(() => clearTimeout(timer))
  if (blob.length !== h.size || (await sha256(blob)) !== h.sha256) throw new Error('Pack ciphertext checksum mismatch')
  const plain = await decryptBlob(keys.encKey, keys.slot, h.seq, blob)
  if (plain.length !== pack.length || (await sha256(plain)) !== pack.digest)
    throw new Error('Pack plaintext checksum mismatch')
  return plain
}
export async function reconstructContent(
  entry: ContentEntry,
  packs: PackEntry[],
  read: (pack: PackEntry) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0 ||
    entry.segments.reduce((n, s) => n + s.length, 0) !== entry.size
  )
    throw new Error('Invalid content size')
  const result = new Uint8Array(entry.size)
  let offset = 0
  for (const s of entry.segments) {
    const pack = packs.find((p) => p.digest === s.packDigest)
    if (
      !pack ||
      !Number.isSafeInteger(s.offset) ||
      s.offset < 0 ||
      !Number.isSafeInteger(s.length) ||
      s.length < 1 ||
      s.offset + s.length > pack.length
    )
      throw new Error('Invalid content segment')
    const bytes = await read(pack)
    if (bytes.length !== pack.length || (await sha256(bytes)) !== pack.digest) throw new Error('Invalid content pack')
    result.set(bytes.subarray(s.offset, s.offset + s.length), offset)
    offset += s.length
  }
  if ((await sha256(result)) !== entry.checksum) throw new Error('File checksum mismatch')
  return result
}
export interface PackSession {
  client: Pick<EscrowClient, 'fetchLatest' | 'getHead' | 'put' | 'saveCheckpoint'>
  transport: EscrowTransport
  assertProvider(): void
  /** Called for every slot this session newly uploaded. */
  onPack?(pack: PackEntry): void
  /** Awaited before a pack PUT is first sent: the slot may exist later even if no ACK ever arrives. */
  onUpload?(upload: PendingUpload): void | Promise<void>
}
/**
 * Every upload gets a fresh slot (random nonce), so deleting a retired slot can never hit a
 * re-upload of the same bytes. Retries of one upload keep its nonce: a lost ACK stays idempotent.
 */
async function ensurePack(
  session: PackSession,
  root: string,
  key: string,
  digest: string,
  bytes: Uint8Array,
): Promise<PackEntry> {
  const nonce = newPackNonce()
  const input = packInput(root, key, digest, nonce)
  await session.onUpload?.({ digest, length: bytes.length, nonce, at: Date.now() })
  for (let attempt = 0; attempt < 3; attempt++) {
    session.assertProvider()
    const latest = await session.client.fetchLatest(PACK_APP, input)
    if (latest) {
      const pack = { digest, length: bytes.length, head: latest.head, nonce }
      if (
        latest.head.seq !== 1 ||
        latest.head.parent !== null ||
        latest.head.schema !== PACK_APP ||
        latest.head.comp !== 'none' ||
        latest.plaintext.length !== bytes.length ||
        (await sha256(latest.plaintext)) !== digest
      )
        throw new Error('Immutable pack was changed')
      const ack = await session.client.put(latest.head)
      session.assertProvider()
      if (ack.type === 'ack') {
        session.onPack?.(pack)
        return pack
      }
      if (ack.type === 'error') throw new Error(ack.code + ': ' + ack.message)
    } else {
      const ack = await session.client.saveCheckpoint(PACK_APP, input, bytes, {
        schema: PACK_APP,
        parent: null,
        seq: 1,
        comp: 'none',
      })
      session.assertProvider()
      if (ack.type === 'ack') {
        const pack = { digest, length: bytes.length, head: ack.head, nonce }
        session.onPack?.(pack)
        return pack
      }
      if (ack.type === 'error') throw new Error(ack.code + ': ' + ack.message)
    }
  }
  throw new Error('Immutable pack conflict retries exhausted')
}
export interface BuildOptions {
  /** Packs uploaded earlier in this save (digest -> pack); reused while their slot still holds the head. */
  reusable?: ReadonlyMap<string, PackEntry>
  /** Slots listed as retired or deleting by the manifest being parented on: never referenced again. */
  blocked?: ReadonlySet<string>
  /** Cap on live packs; content that would exceed it is omitted. */
  maxLivePacks?: number
}
async function stored(session: PackSession, pack: PackEntry): Promise<boolean> {
  session.assertProvider()
  const head = await session.client.getHead(pack.head.slot)
  session.assertProvider()
  return !!head && (await headHash(head)) === (await headHash(pack.head))
}
export async function buildContentPacks(
  session: PackSession,
  root: string,
  key: string,
  files: FileRecord[],
  previous: FolderCheckpoint | null,
  readFile: (file: FileRecord) => Promise<Uint8Array>,
  options: BuildOptions = {},
): Promise<{
  contents: ContentEntry[]
  packs: PackEntry[]
  omitted?: ContentOmission[]
}> {
  const entries: { entry: ContentEntry; file?: FileRecord }[] = []
  const packs = new Map<string, PackEntry>()
  // A descriptor can outlive its slot (another member's GC); retired slots are never reused.
  const available = new Map<string, PackEntry>()
  for (const pack of previous?.packs ?? []) {
    if (options.blocked?.has(packSlot(pack)) || !(await stored(session, pack))) continue
    available.set(pack.digest, pack)
  }
  for (const file of files
    .filter((f) => !f.deletedAt)
    .sort((a, b) => contentIdentity(a).localeCompare(contentIdentity(b)))) {
    const old = previous?.contents.find(
      (c) => c.fileId === file.id && c.checksum === file.checksum && c.size === file.size,
    )
    if (old && old.segments.every((s) => available.has(s.packDigest))) {
      entries.push({ entry: { ...old, segments: old.segments.map((s) => ({ ...s })) } })
      for (const s of old.segments) packs.set(s.packDigest, { ...available.get(s.packDigest)! })
    } else {
      entries.push({ entry: { fileId: file.id, checksum: file.checksum, size: file.size, segments: [] }, file })
    }
  }
  if (packs.size > MAX_PACKS) throw new Error('Checkpoint exceeds 1023 packs')
  let buffer = new Uint8Array(PACK_BYTES),
    used = 0
  let segments: {
    entry: ContentEntry
    offset: number
    length: number
  }[] = []
  const flush = async () => {
    if (!used) return
    const bytes = buffer.slice(0, used),
      digest = await sha256(bytes)
    if (!packs.has(digest) && packs.size >= MAX_PACKS) throw new Error('Checkpoint exceeds 1023 packs')
    let pack = packs.get(digest)
    const known = available.get(digest)
    if (!pack && known) pack = { ...known }
    const cached = options.reusable?.get(digest)
    // An earlier upload is subject to the same fence as every other cached pack.
    if (!pack && cached && !options.blocked?.has(packSlot(cached)) && (await stored(session, cached))) pack = { ...cached }
    pack ??= await ensurePack(session, root, key, digest, bytes)
    packs.set(digest, pack)
    for (const s of segments) s.entry.segments.push({ packDigest: digest, offset: s.offset, length: s.length })
    buffer = new Uint8Array(PACK_BYTES)
    used = 0
    segments = []
  }
  // Files that are already protected keep their packs. New content is admitted smallest first
  // while the live packs stay under the cap (a conservative bound: ceil(bytes / PACK_BYTES)).
  // A file whose bytes cannot be obtained (a restored member never had them) is omitted
  // instead of failing the save; admission is tried again on later saves.
  const free = Math.max(0, (options.maxLivePacks ?? MAX_LIVE_PACKS) - packs.size)
  const admitted = new Set<ContentEntry>()
  const omitted: ContentOmission[] = []
  const omit = (entry: ContentEntry, reason: ContentOmission['reason']) =>
    omitted.push({ fileId: entry.fileId, checksum: entry.checksum, size: entry.size, reason })
  let admittedBytes = 0
  for (const { entry, file } of entries
    .filter((e) => e.file)
    .sort((a, b) => a.file!.size - b.file!.size || a.file!.id.localeCompare(b.file!.id))) {
    if (Math.ceil((admittedBytes + file!.size) / PACK_BYTES) > free) {
      omit(entry, 'capacity')
      continue
    }
    session.assertProvider()
    let bytes: Uint8Array
    try {
      bytes = await readFile(file!)
      if (bytes.length !== file!.size || (await sha256(bytes)) !== file!.checksum) throw new Error('mismatch')
    } catch {
      session.assertProvider()
      omit(entry, 'unavailable')
      continue
    }
    admitted.add(entry)
    admittedBytes += bytes.length
    let offset = 0
    while (offset < bytes.length) {
      const length = Math.min(PACK_BYTES - used, bytes.length - offset)
      buffer.set(bytes.subarray(offset, offset + length), used)
      segments.push({ entry, offset: used, length })
      used += length
      offset += length
      if (used === PACK_BYTES) await flush()
    }
  }
  await flush()
  const contents = entries.filter((e) => !e.file || admitted.has(e.entry)).map((e) => e.entry)
  const result = [...packs.values()].sort((a, b) => a.digest.localeCompare(b.digest))
  await verifyReferencedPacks(session, root, key, result, contents, files, readFile)
  return { contents, packs: result, ...(omitted.length ? { omitted } : {}) }
}

/**
 * Check every referenced slot again immediately before publishing its manifest. A pack that vanished
 * (or changed) is uploaded again under a new nonce; when its old layout also holds bytes of files that
 * are no longer referenced, the remaining live ranges are packed afresh. `packs` and `contents` are
 * repaired in place.
 */
export async function verifyReferencedPacks(
  session: PackSession, root: string, key: string, packs: PackEntry[], contents: ContentEntry[],
  files: FileRecord[], readFile: (file: FileRecord) => Promise<Uint8Array>,
): Promise<void> {
  const sources = new Map<string, Uint8Array>()
  const source = async (entry: ContentEntry): Promise<Uint8Array> => {
    let bytes = sources.get(entry.fileId)
    if (!bytes) {
      const file = files.find((f) => f.id === entry.fileId && !f.deletedAt &&
        f.checksum === entry.checksum && f.size === entry.size)
      if (!file) throw new Error('Missing pack source file')
      bytes = await readFile(file)
      if (bytes.length !== entry.size || await sha256(bytes) !== entry.checksum)
        throw new Error('Mismatching pack source bytes')
      sources.set(entry.fileId, bytes)
    }
    return bytes
  }
  for (const pack of [...packs]) {
    if (await stored(session, pack)) continue
    const users = contents.filter((e) => e.segments.some((s) => s.packDigest === pack.digest))
    // Reconstruct the exact pack layout from currently referenced, verified files.
    const exact = new Uint8Array(pack.length)
    for (const entry of users) {
      const bytes = await source(entry)
      let offset = 0
      for (const segment of entry.segments) {
        if (segment.packDigest === pack.digest)
          exact.set(bytes.subarray(offset, offset + segment.length), segment.offset)
        offset += segment.length
      }
    }
    if ((await sha256(exact)) === pack.digest) {
      const restored = await ensurePack(session, root, key, pack.digest, exact)
      pack.head = restored.head
      pack.nonce = restored.nonce
      session.assertProvider()
      continue
    }
    // A reused pack also holds bytes of files that are gone: pack the live ranges again.
    const ranges = new Map<string, number>()
    const parts: Uint8Array[] = []
    let size = 0
    for (const entry of users) {
      const bytes = await source(entry)
      let offset = 0
      for (const segment of entry.segments) {
        const range = segment.offset + ':' + segment.length
        if (segment.packDigest === pack.digest && !ranges.has(range)) {
          ranges.set(range, size)
          parts.push(bytes.subarray(offset, offset + segment.length))
          size += segment.length
        }
        offset += segment.length
      }
    }
    if (!size || size > PACK_BYTES) throw new Error('Pack cannot be rebuilt from live content')
    const repacked = new Uint8Array(size)
    let at = 0
    for (const part of parts) {
      repacked.set(part, at)
      at += part.length
    }
    const digest = await sha256(repacked)
    const next =
      packs.find((p) => p !== pack && p.digest === digest) ?? (await ensurePack(session, root, key, digest, repacked))
    session.assertProvider()
    for (const entry of users)
      for (const segment of entry.segments)
        if (segment.packDigest === pack.digest) {
          segment.offset = ranges.get(segment.offset + ':' + segment.length)!
          segment.packDigest = digest
        }
    packs.splice(packs.indexOf(pack), 1)
    if (!packs.includes(next)) packs.push(next)
    packs.sort((a, b) => a.digest.localeCompare(b.digest))
  }
}

/**
 * A manifest from before the live-pack cap can hold more live packs than MAX_LIVE_PACKS. Keep the
 * smallest files (a stable order) within the cap and mark the others omitted; their packs stop being
 * live and are retired by the usual rotation. Existing omissions are kept.
 */
export function trimLivePacks(
  checkpoint: Pick<FolderCheckpoint, 'contents' | 'packs' | 'omitted'>,
  max: number,
): { contents: ContentEntry[]; packs: PackEntry[]; omitted?: ContentOmission[] } {
  const kept = new Set<string>(),
    keptEntries = new Set<ContentEntry>()
  const omitted = [...(checkpoint.omitted ?? [])]
  for (const entry of [...checkpoint.contents].sort((a, b) => a.size - b.size || a.fileId.localeCompare(b.fileId))) {
    const digests = new Set(entry.segments.map((s) => s.packDigest))
    if (kept.size + [...digests].filter((d) => !kept.has(d)).length > max) {
      omitted.push({ fileId: entry.fileId, checksum: entry.checksum, size: entry.size, reason: 'capacity' })
      continue
    }
    for (const d of digests) kept.add(d)
    keptEntries.add(entry)
  }
  return {
    contents: checkpoint.contents.filter((e) => keptEntries.has(e)),
    packs: checkpoint.packs.filter((p) => kept.has(p.digest)),
    ...(omitted.length ? { omitted } : {}),
  }
}

export const PACK_GC_GRACE_MS = 24 * 60 * 60 * 1000
/** Clock skew alone cannot expire a grace period: entries must also be this many manifests old. */
export const PACK_GC_MIN_GENERATIONS = 3
const order = (a: RetiredPack, b: RetiredPack) =>
  a.digest.localeCompare(b.digest) || a.head.slot.localeCompare(b.head.slot)
export const providerCanDelete = (client: Pick<EscrowClient, 'providers'>) =>
  [...client.providers.values()].some((p) => p.features?.includes('delete'))

/**
 * The retired/deleting lists of the manifest being parented on, united with entries this writer
 * learned from earlier manifests (a writer that did not know them could have dropped them).
 * Entries are keyed by slot; deleting wins over retired; anything the parent still references is alive.
 */
export function mergeRetirementLists(
  latest: FolderCheckpoint | null,
  known: readonly FolderCheckpoint[],
): { retired: RetiredPack[]; deleting: RetiredPack[] } {
  const alive = new Set([...(latest?.packs ?? []), ...(latest?.retained ?? [])].map(packSlot))
  const retired = new Map<string, RetiredPack>(),
    deleting = new Map<string, RetiredPack>()
  for (const source of [latest, ...known.toReversed()]) {
    for (const [target, list] of [
      [retired, source?.retired],
      [deleting, source?.deleting],
    ] as const)
      for (const pack of list ?? []) {
        const slot = packSlot(pack)
        if (alive.has(slot) || target.has(slot)) continue
        target.set(slot, pack)
      }
  }
  for (const slot of deleting.keys()) retired.delete(slot)
  return { retired: [...retired.values()].sort(order), deleting: [...deleting.values()].sort(order) }
}

/** An intent with no visible head is forgotten only after this many manifests (an in-flight PUT lands by then). */
export const UPLOAD_INTENT_GENERATIONS = 2
/**
 * Resolve recorded pack uploads that no manifest tracks (crash or lost ACK between the pack PUT and
 * the manifest). A slot that exists becomes a retirement candidate. One that does not exist yet may
 * still be committed by a PUT in flight, so it is kept (stamped with the manifest sequence of the
 * first miss) and forgotten only by a miss at least UPLOAD_INTENT_GENERATIONS manifests later;
 * wall-clock time plays no part.
 */
export async function reconcileUploads(
  session: Pick<PackSession, 'assertProvider'> & { client: Pick<EscrowClient, 'getHead'> },
  root: string,
  key: string,
  uploads: Iterable<PendingUpload>,
  tracked: ReadonlySet<string>,
  seq: number,
): Promise<{ candidates: PackEntry[]; keep: PendingUpload[] }> {
  const candidates: PackEntry[] = [],
    keep: PendingUpload[] = []
  for (const upload of uploads) {
    session.assertProvider()
    const keys = await deriveEscrowKeys(PACK_APP, packInput(root, key, upload.digest, upload.nonce))
    if (tracked.has(keys.slot)) continue
    let head: Awaited<ReturnType<EscrowClient['getHead']>>
    try {
      head = await session.client.getHead(keys.slot)
    } catch {
      session.assertProvider()
      keep.push(upload)
      continue
    }
    session.assertProvider()
    if (!head) {
      if (upload.absentSeq === undefined) keep.push({ ...upload, absentSeq: seq })
      else if (seq - upload.absentSeq < UPLOAD_INTENT_GENERATIONS) keep.push(upload)
      continue
    }
    if (
      head.seq === 1 && head.parent === null && head.schema === PACK_APP && head.comp === 'none' &&
      head.size === upload.length + 28 &&
      (await verifyHead(head, { slot: keys.slot, writer: keys.writer, maxBlob: PACK_BYTES + 28 }))
    )
      candidates.push({ digest: upload.digest, length: upload.length, head, nonce: upload.nonce })
  }
  return { candidates, keep }
}

export interface GcPlan {
  retired: RetiredPack[]
  deleting: RetiredPack[]
  /** Entries newly committed for deletion by this manifest; delete them only after it is ACKed. */
  moved: RetiredPack[]
}
/**
 * Lists of the new manifest. The new manifest references `packs` and keeps its parent's packs as
 * `retained`. Packs that left that two-manifest window become retired; retired packs older than the
 * grace period (writer clock) and PACK_GC_MIN_GENERATIONS manifests move to deleting.
 */
export function planPackGc(input: {
  packs: PackEntry[]
  previous: FolderCheckpoint | null
  retired: RetiredPack[]
  deleting: RetiredPack[]
  pending: Iterable<PackEntry>
  now: number
  seq: number
  canDelete: boolean
}): GcPlan {
  const referenced = new Set([...input.packs, ...(input.previous?.packs ?? [])].map(packSlot))
  const retired = new Map<string, RetiredPack>(),
    deleting = new Map<string, RetiredPack>(),
    moved: RetiredPack[] = []
  for (const pack of input.deleting) if (!referenced.has(packSlot(pack))) deleting.set(packSlot(pack), pack)
  for (const pack of input.retired) {
    const slot = packSlot(pack)
    if (referenced.has(slot) || deleting.has(slot)) continue
    const entry = { ...pack, seq: pack.seq ?? input.seq }
    const old = input.now - entry.since >= PACK_GC_GRACE_MS && input.seq - entry.seq >= PACK_GC_MIN_GENERATIONS
    if (input.canDelete && old) {
      deleting.set(slot, entry)
      moved.push(entry)
    } else retired.set(slot, entry)
  }
  for (const pack of [...(input.previous?.retained ?? []), ...input.pending]) {
    const slot = packSlot(pack)
    if (referenced.has(slot) || retired.has(slot) || deleting.has(slot)) continue
    retired.set(slot, {
      digest: pack.digest,
      since: input.now,
      seq: input.seq,
      head: pack.head,
      ...(pack.nonce !== undefined && { nonce: pack.nonce }),
    })
  }
  const slots = new Set([...referenced, ...retired.keys(), ...deleting.keys()])
  if (slots.size > MAX_PACKS) throw new Error('Escrow slot budget exhausted: retired packs are waiting for deletion (waiting for GC grace)')
  return { retired: [...retired.values()].sort(order), deleting: [...deleting.values()].sort(order), moved }
}

/**
 * Delete committed `deleting` slots. An absent slot counts as deleted (restart after the delete but
 * before a manifest dropped the entry); anything else keeps the entry for a later retry.
 * Returns the entries that remain.
 */
export async function sweepDeleting(
  session: Pick<PackSession, 'assertProvider'> & {
    client: Pick<EscrowClient, 'providers' | 'getHead' | 'deleteSlot'>
  },
  root: string,
  key: string,
  entries: RetiredPack[],
): Promise<RetiredPack[]> {
  const remaining: RetiredPack[] = []
  const canDelete = providerCanDelete(session.client)
  const one = async (pack: RetiredPack): Promise<boolean> => {
    session.assertProvider()
    try {
      const current = await session.client.getHead(packSlot(pack))
      session.assertProvider()
      if (!current) return true
      if (canDelete && (await headHash(current)) === (await headHash(pack.head))) {
        const result = await session.client.deleteSlot(PACK_APP, packInput(root, key, pack.digest, pack.nonce), pack.head)
        session.assertProvider()
        if (result.type === 'deleted') return true
      }
    } catch {
      session.assertProvider()
    }
    return false
  }
  // A few requests at a time: a full budget means up to a thousand slots to release.
  for (let i = 0; i < entries.length; i += SWEEP_CONCURRENCY) {
    const chunk = entries.slice(i, i + SWEEP_CONCURRENCY)
    const done = await Promise.all(chunk.map(one))
    chunk.forEach((pack, j) => {
      if (!done[j]) remaining.push(pack)
    })
  }
  return remaining
}
const SWEEP_CONCURRENCY = 8
