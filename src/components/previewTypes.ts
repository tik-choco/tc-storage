import type { ProgressStatus } from '../app/appTypes.js'
import type { FileRecord } from '../storage/domain.js'
import type { HandoffApp } from '../storage/fileHandoff.js'

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
  onSaveText?: (file: FileRecord, text: string) => Promise<void>
  onSendFileToApp?: (file: FileRecord, app: HandoffApp) => Promise<void>
}
