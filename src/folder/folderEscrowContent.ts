import type { FileRecord } from '../storage/domain.js'
import type { EscrowTransport, EscrowClient } from '../escrow/client'
import { decryptBlob, deriveEscrowKeys, sha256 } from '../escrow/crypto'
import { headHash, verifyHead } from '../escrow/head'
import { contentIdentity, PACK_APP, PACK_BYTES, MAX_PACKS, packInput } from './folderCheckpoint.js'
import type { ContentEntry, PackEntry, FolderCheckpoint } from './folderCheckpoint.js'

export async function readPinnedPack(
  transport: Pick<EscrowTransport, 'storageGet'>,
  pack: PackEntry,
  root: string,
  key: string,
): Promise<Uint8Array> {
  const keys = await deriveEscrowKeys(PACK_APP, packInput(root, key, pack.digest))
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
interface PackSession {
  client: Pick<EscrowClient, 'fetchLatest' | 'put' | 'saveCheckpoint'>
  transport: EscrowTransport
  assertProvider(): void
}
/** Existing heads are re-PUT for an identical-head ACK from this transaction's provider. */
async function ensurePack(
  session: PackSession,
  root: string,
  key: string,
  digest: string,
  bytes: Uint8Array,
): Promise<PackEntry> {
  const input = packInput(root, key, digest)
  for (let attempt = 0; attempt < 3; attempt++) {
    session.assertProvider()
    const latest = await session.client.fetchLatest(PACK_APP, input)
    if (latest) {
      const pack = { digest, length: bytes.length, head: latest.head }
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
      if (ack.type === 'ack') return pack
      if (ack.type === 'error') throw new Error(ack.code + ': ' + ack.message)
    } else {
      const ack = await session.client.saveCheckpoint(PACK_APP, input, bytes, {
        schema: PACK_APP,
        parent: null,
        seq: 1,
        comp: 'none',
      })
      session.assertProvider()
      if (ack.type === 'ack') return { digest, length: bytes.length, head: ack.head }
      if (ack.type === 'error') throw new Error(ack.code + ': ' + ack.message)
    }
  }
  throw new Error('Immutable pack conflict retries exhausted')
}
export async function buildContentPacks(
  session: PackSession,
  root: string,
  key: string,
  files: FileRecord[],
  previous: FolderCheckpoint | null,
  readFile: (file: FileRecord) => Promise<Uint8Array>,
): Promise<{
  contents: ContentEntry[]
  packs: PackEntry[]
}> {
  const contents: ContentEntry[] = []
  const packs = new Map<string, PackEntry>()
  const pending: {
    file: FileRecord
    entry: ContentEntry
  }[] = []
  for (const file of files
    .filter((f) => !f.deletedAt)
    .sort((a, b) => contentIdentity(a).localeCompare(contentIdentity(b)))) {
    const old = previous?.contents.find(
      (c) => c.fileId === file.id && c.checksum === file.checksum && c.size === file.size,
    )
    if (old) {
      contents.push(old)
      for (const s of old.segments) {
        const pack = previous!.packs.find((p) => p.digest === s.packDigest)!
        packs.set(pack.digest, pack)
      }
    } else {
      const entry: ContentEntry = { fileId: file.id, checksum: file.checksum, size: file.size, segments: [] }
      contents.push(entry)
      pending.push({ file, entry })
    }
  }
  if (packs.size > MAX_PACKS) throw new Error('Checkpoint exceeds 1023 packs')
  // Copies of existing ciphertext are temporarily pinned so this provider can pull absent packs.
  for (const [digest, pack] of packs) {
    session.assertProvider()
    const bytes = await readPinnedPack(session.transport, pack, root, key)
    const blob = await session.transport.storageGet(pack.head.cid)
    if ((await session.transport.storageAdd('tc-escrow.bin', blob)) !== pack.head.cid)
      throw new Error('Pinned pack CID changed')
    const ack = await session.client.put(pack.head)
    session.assertProvider()
    if (ack.type !== 'ack' || ack.hash !== (await headHash(pack.head)))
      throw new Error('Pack not ACKed by selected provider')
    if ((await sha256(bytes)) !== digest) throw new Error('Pack checksum mismatch')
  }
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
    const pack = packs.get(digest) ?? (await ensurePack(session, root, key, digest, bytes))
    packs.set(digest, pack)
    for (const s of segments) s.entry.segments.push({ packDigest: digest, offset: s.offset, length: s.length })
    buffer = new Uint8Array(PACK_BYTES)
    used = 0
    segments = []
  }
  for (const { file, entry } of pending) {
    session.assertProvider()
    const bytes = await readFile(file)
    if (bytes.length !== file.size || (await sha256(bytes)) !== file.checksum)
      throw new Error('Missing or mismatching source bytes: ' + file.name)
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
  return { contents, packs: [...packs.values()].sort((a, b) => a.digest.localeCompare(b.digest)) }
}
