import type { ShareImportPhase, ShareImportProgress } from './appTypes.js'

// Pure helpers for tracking share-import staging progress (see appShareImportActions.ts).
// Kept free of Preact/DOM so they stay trivially unit-testable.

export const shareImportPhaseLabels: Record<ShareImportPhase, string> = {
  connecting: '接続中',
  fetching: '受信中',
  decrypting: '復号中',
  materializing: '展開中',
  failed: '再試行待ち',
}

export function makeShareImportProgress(
  phase: ShareImportPhase,
  options: { folderId?: string } = {},
): ShareImportProgress {
  const progress: ShareImportProgress = { phase, label: shareImportPhaseLabels[phase] }
  if (options.folderId !== undefined) progress.folderId = options.folderId
  return progress
}

export function withShareImportProgress(
  current: Record<string, ShareImportProgress>,
  key: string,
  next: ShareImportProgress,
): Record<string, ShareImportProgress> {
  return { ...current, [key]: next }
}

export function withoutShareImportProgress(current: Record<string, ShareImportProgress>, key: string): Record<string, ShareImportProgress> {
  if (!(key in current)) return current
  const { [key]: _removed, ...rest } = current
  return rest
}

/** True while bytes are actually moving. `failed` is excluded on purpose: the share is parked
 * waiting on a retry, so the row must not keep animating as if it were still transferring. */
export function isShareImportActive(progress?: ShareImportProgress): boolean {
  if (!progress) return false
  return progress.phase !== 'failed'
}
