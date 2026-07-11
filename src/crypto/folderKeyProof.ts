import { hex } from './cryptoEncoding.js'
import { constantTimeEqual, hmacSha256, sha256 } from './cryptoFallback.js'

const encoder = new TextEncoder()
const folderKeyHashPrefix = 'tc-storage-folder-key-v1'
const accessGrantProofPrefix = 'tc-storage-folder-access-grant-v1'

export function folderKeyHash(folderId: string, passphrase: string): string {
  return hex(sha256(encoder.encode(`${folderKeyHashPrefix}\0${folderId}\0${passphrase.trim()}`)))
}

export function matchesFolderKeyHash(folderId: string, passphrase: string, expectedHash?: string): boolean {
  return Boolean(expectedHash && folderKeyHash(folderId, passphrase) === expectedHash)
}

export function folderAccessGrantProof(passphrase: string, folderId: string, requestId: string, targetNodeId: string): string {
  const key = encoder.encode(passphrase.trim())
  const message = encoder.encode(`${accessGrantProofPrefix}\0${folderId}\0${requestId}\0${targetNodeId}`)
  return hex(hmacSha256(key, message))
}

export function matchesFolderAccessGrantProof(passphrase: string, folderId: string, requestId: string, targetNodeId: string, expectedProof?: string): boolean {
  if (!expectedProof || !/^[a-f0-9]{64}$/.test(expectedProof)) return false
  return constantTimeEqual(encoder.encode(folderAccessGrantProof(passphrase, folderId, requestId, targetNodeId)), encoder.encode(expectedProof))
}
