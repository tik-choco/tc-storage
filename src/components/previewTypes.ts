import type { ProgressStatus } from '../appTypes.js'
import type { FileRecord } from '../domain.js'

export type PreviewMode = 'single' | 'flow'

export interface ExpandedPreviewProps {
  file: FileRecord
  files: FileRecord[]
  index: number
  loadingProgressByFileId: Record<string, ProgressStatus>
  loadingProgress?: ProgressStatus
  total: number
  onClose: () => void
  onPrevious: () => void
  onNext: () => void
  onDownload: (file: FileRecord) => void | Promise<void>
  onPreloadFile: (file: FileRecord) => void
}
