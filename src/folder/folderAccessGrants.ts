// Which nodes we already granted a folder key to, kept per folder and persisted: a granted key
// can't be taken back, and the requester mints a fresh requestId whenever it reloads (its request
// key pair lives in memory only), so remembering the *node* -- not the request -- is what keeps an
// already-approved peer from showing up as a brand-new approval request.
const folderAccessGrantsKey = 'tc-storage-folder-access-grants-v1'

// Bound per folder so a peer cycling through DIDs can't grow this without limit; oldest approvals
// fall off first.
export const folderAccessGrantLimit = 128

export type FolderAccessGrants = Record<string, string[]>

export function loadFolderAccessGrants(): FolderAccessGrants {
  try {
    return normalizeFolderAccessGrants(JSON.parse(localStorage.getItem(folderAccessGrantsKey) ?? '{}') as unknown)
  } catch {
    return {}
  }
}

export function saveFolderAccessGrants(grants: FolderAccessGrants): void {
  try {
    localStorage.setItem(folderAccessGrantsKey, JSON.stringify(normalizeFolderAccessGrants(grants)))
  } catch {
    // Persistence is best effort here: losing it only costs one extra approval prompt after a
    // reload, so a full storage quota must not break the approval itself.
  }
}

export function withFolderAccessGrant(grants: FolderAccessGrants, folderId: string, nodeId: string): FolderAccessGrants {
  if (!folderId || !nodeId) return grants
  const nodeIds = [...(grants[folderId] ?? []).filter((item) => item !== nodeId), nodeId]
  return { ...grants, [folderId]: nodeIds.slice(-folderAccessGrantLimit) }
}

export function hasFolderAccessGrant(grants: FolderAccessGrants, folderId: string, nodeId: string): boolean {
  return Boolean(folderId && nodeId && grants[folderId]?.includes(nodeId))
}

function normalizeFolderAccessGrants(value: unknown): FolderAccessGrants {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([folderId, nodeIds]) => {
    if (!Array.isArray(nodeIds)) return []
    const normalized = [...new Set(nodeIds.filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0))].slice(-folderAccessGrantLimit)
    return normalized.length > 0 ? [[folderId, normalized] as const] : []
  }))
}
