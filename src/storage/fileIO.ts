import { sha256Hex } from '../crypto/crypto.js'
import { bytesToBase64 } from '../crypto/cryptoEncoding.js'
import { makeFileFromDataUrl, type FileRecord } from './domain.js'

export async function readBrowserFile(file: File, folderId: string, now: string, nodeId: string): Promise<FileRecord> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const checksum = await sha256Hex(bytes)
  const dataUrl = bytesToDataUrl(bytes, file.type || 'application/octet-stream')
  return makeFileFromDataUrl({
    folderId,
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    dataUrl,
    checksum,
    now,
    nodeId,
  })
}

export function downloadFile(file: FileRecord): void {
  if (!file.dataUrl) throw new Error(`${file.name} の本文がローカルにありません`)
  const link = document.createElement('a')
  link.href = file.dataUrl
  link.download = file.name
  link.click()
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`
}
