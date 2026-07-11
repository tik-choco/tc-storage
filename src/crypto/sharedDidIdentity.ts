/**
 * Reconciles tc-storage's local DID identity with the shared-key identity
 * store used across tc-* apps (see tc-vrm-viewer's src/profile/didIdentity.ts
 * for the canonical shared-store design).
 *
 * tc-storage cannot adopt that design directly: its nodeId must be available
 * synchronously before mistlib initializes (see localSettings.ts / p2p.ts),
 * so the local mirror (`tc-storage-did-identity-v1`, handled in
 * didIdentity.ts) remains the source of truth read at startup. This module
 * runs a best-effort reconciliation once mistlib is available, so tc-storage
 * converges on the same DID as other tc-* apps sharing the same OPFS:
 *
 *  - local mirror present: it wins; written back to the shared store if the
 *    shared store disagrees or is empty.
 *  - local mirror absent, shared store present: shared identity is adopted
 *    and mirrored locally (new device / new app case).
 *  - neither present: caller supplies a freshly minted identity, which is
 *    persisted to both.
 *
 * Failures never throw; callers should treat this as fire-and-forget.
 */
import { parseStoredDidIdentity, type DidIdentity } from './didIdentity.js'

export type SharedStorageBackend = {
  retrieve: (cid: string) => Promise<Uint8Array | undefined>
  store: (bytes: Uint8Array) => Promise<string>
}

type JsonStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Shared (non app-namespaced) localStorage key pointing at the identity record's mistlib storage CID. */
export const sharedDidIdentityCidKey = 'tc-shared-did-identity-cid-v1'

const jsonEncoder = new TextEncoder()
const jsonDecoder = new TextDecoder()

export async function reconcileSharedDidIdentity(options: {
  localIdentity: DidIdentity | undefined
  backend: SharedStorageBackend
  storage: JsonStorage
}): Promise<DidIdentity | undefined> {
  const { localIdentity, backend, storage } = options
  try {
    const shared = await readSharedIdentity(backend, storage)

    if (localIdentity) {
      if (!shared || shared.did !== localIdentity.did) {
        await writeSharedIdentity(backend, storage, localIdentity)
      }
      return localIdentity
    }

    if (shared) {
      storage.setItem(localMirrorKeyForWriteback, JSON.stringify(shared))
      return shared
    }

    return undefined
  } catch (error) {
    console.warn('tc-storage: shared DID identity reconciliation failed', error)
    return localIdentity
  }
}

// tc-storage's local mirror key, duplicated here (rather than imported) to keep this
// module decoupled from didIdentity.ts's private constants; kept in sync manually.
const localMirrorKeyForWriteback = 'tc-storage-did-identity-v1'

async function readSharedIdentity(backend: SharedStorageBackend, storage: JsonStorage): Promise<DidIdentity | undefined> {
  const cid = storage.getItem(sharedDidIdentityCidKey)?.trim()
  if (!cid) return undefined
  try {
    const bytes = await backend.retrieve(cid)
    if (!bytes) return undefined
    return parseStoredDidIdentity(jsonDecoder.decode(bytes))
  } catch (error) {
    console.warn('tc-storage: failed to read shared DID identity', error)
    return undefined
  }
}

async function writeSharedIdentity(backend: SharedStorageBackend, storage: JsonStorage, identity: DidIdentity): Promise<void> {
  const cid = await backend.store(jsonEncoder.encode(JSON.stringify(identity)))
  storage.setItem(sharedDidIdentityCidKey, cid)
}
