import type { MutableRef, SetState } from './appControllerTypes.js'
import type { FolderSyncPeers } from './folderPeers.js'
import type { AppSettings } from './localSettings.js'
import type { ShareEnvelope } from './p2p.js'

export function createPeerActions(options: {
  setFolderPeers: SetState<FolderSyncPeers>
  settingsRef: MutableRef<AppSettings>
}) {
  const { setFolderPeers, settingsRef } = options

  function rememberFolderPeer(envelope: Pick<ShareEnvelope, 'folderId' | 'from' | 'senderProfile' | 'sentAt'>) {
    if (!envelope.folderId || envelope.from === settingsRef.current.nodeId) return
    setFolderPeers((current) => {
      const peers = current[envelope.folderId ?? ''] ?? []
      const peer = {
        nodeId: envelope.from,
        profile: envelope.senderProfile,
        lastSeenAt: envelope.sentAt || new Date().toISOString(),
      }
      const nextPeers = [peer, ...peers.filter((item) => item.nodeId !== envelope.from)]
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
        .slice(0, 16)
      return { ...current, [envelope.folderId ?? '']: nextPeers }
    })
  }

  return { rememberFolderPeer }
}
