import type { FileRecord } from '../storage/domain.js'

export type FolderContentProgress = { ready: number; total: number; percent: number }

/** Files whose content has landed vs. the folder's total, for the "n/m received" row hint. */
export function folderContentProgress(files: FileRecord[], folderId: string, fileDataUrls: Record<string, string>): FolderContentProgress | undefined {
  // Same population as `filesInFolder` in storage/domain.ts (folder membership, live records
  // only) so this count always matches the "N files" total already shown next to it.
  const inFolder = files.filter((file) => file.folderId === folderId && !file.deletedAt)
  const total = inFolder.length
  if (total === 0) return undefined
  const ready = inFolder.filter((file) => Boolean(file.dataUrl || fileDataUrls[file.id])).length
  if (ready === total) return undefined
  const percent = Math.round((ready / total) * 100)
  return { ready, total, percent }
}
