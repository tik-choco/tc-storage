import { base64ToBytes } from './cryptoEncoding.js'

export type ZipEntry = {
  data: Uint8Array
  modifiedAt?: string
  path: string
}

const encoder = new TextEncoder()
const zipUint32Limit = 0xffffffff
let crc32Table: Uint32Array | null = null

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) throw new Error('Invalid data URL')
  const metadata = dataUrl.slice(0, commaIndex).toLowerCase()
  const payload = dataUrl.slice(commaIndex + 1)
  if (metadata.includes(';base64')) return base64ToBytes(payload)
  return encoder.encode(decodeURIComponent(payload))
}

export function createZipBlob(entries: ZipEntry[]): Blob {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const path = normalizeZipPath(entry.path)
    const fileName = encoder.encode(path)
    const data = entry.data
    const crc = crc32(data)
    const { date, time } = dosDateTime(entry.modifiedAt)
    assertZipSize(fileName.length, 'File name is too long for a ZIP archive')
    assertZipSize(data.length, 'File is too large for this ZIP archive')
    assertZipSize(offset, 'Folder is too large for this ZIP archive')

    const localHeader = new Uint8Array(30 + fileName.length)
    const local = new DataView(localHeader.buffer)
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true)
    local.setUint16(8, 0, true)
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, fileName.length, true)
    localHeader.set(fileName, 30)
    localParts.push(localHeader, data)

    const centralHeader = new Uint8Array(46 + fileName.length)
    const central = new DataView(centralHeader.buffer)
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(4, 20, true)
    central.setUint16(6, 20, true)
    central.setUint16(8, 0x0800, true)
    central.setUint16(10, 0, true)
    central.setUint16(12, time, true)
    central.setUint16(14, date, true)
    central.setUint32(16, crc, true)
    central.setUint32(20, data.length, true)
    central.setUint32(24, data.length, true)
    central.setUint16(28, fileName.length, true)
    central.setUint32(38, path.endsWith('/') ? 0x10 : 0, true)
    central.setUint32(42, offset, true)
    centralHeader.set(fileName, 46)
    centralParts.push(centralHeader)

    offset += localHeader.length + data.length
  }

  const centralOffset = offset
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  assertZipSize(centralOffset, 'Folder is too large for this ZIP archive')
  assertZipSize(centralSize, 'Folder is too large for this ZIP archive')
  if (entries.length > 0xffff) throw new Error('Too many files for this ZIP archive')

  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, centralOffset, true)

  return new Blob([...localParts, ...centralParts, end].map(toBlobPart), { type: 'application/zip' })
}

function crc32(bytes: Uint8Array): number {
  const table = getCrc32Table()
  let crc = 0xffffffff
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function getCrc32Table(): Uint32Array {
  if (crc32Table) return crc32Table
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  crc32Table = table
  return table
}

function normalizeZipPath(path: string): string {
  const directory = path.endsWith('/') || path.endsWith('\\')
  const normalized = path.replaceAll('\\', '/').split('/').filter(Boolean).join('/')
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('Invalid ZIP path')
  return directory ? `${normalized}/` : normalized
}

function dosDateTime(value: string | undefined): { date: number; time: number } {
  const parsed = value ? new Date(value) : new Date()
  const source = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  const year = Math.max(1980, Math.min(2107, source.getFullYear()))
  const month = source.getMonth() + 1
  const day = source.getDate()
  const hours = source.getHours()
  const minutes = source.getMinutes()
  const seconds = Math.floor(source.getSeconds() / 2)
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  }
}

function assertZipSize(value: number, message: string): void {
  if (value > zipUint32Limit) throw new Error(message)
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
