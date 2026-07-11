import type { SyncPeer } from '../app/appTypes.js'

const folderPeersKey = 'tc-storage-folder-sync-peers-v1'

export type FolderSyncPeers = Record<string, SyncPeer[]>

export function loadFolderSyncPeers(): FolderSyncPeers {
  try {
    const parsed = JSON.parse(localStorage.getItem(folderPeersKey) ?? '') as FolderSyncPeers
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // Fall through to no known peers.
  }
  return {}
}

export function saveFolderSyncPeers(peers: FolderSyncPeers): void {
  localStorage.setItem(folderPeersKey, JSON.stringify(peers))
}

