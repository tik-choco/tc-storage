import { FileText } from 'lucide-preact'
import type { ProgressStatus } from '../app/appTypes.js'
import { isAudioFile, isImageFile, isInlinePreviewFile, isPdfFile, isVideoFile, isVrmFile } from '../app/appUtils.js'
import { formatBytes, type FileRecord } from '../storage/domain.js'
import type { HandoffApp } from '../storage/fileHandoff.js'
import { isTextLike } from '../util/format.js'
import { PdfPreview } from './preview/PdfPreview.js'
import { TextFilePreview } from './preview/TextFilePreview.js'
import { VrmPreview } from './preview/VrmPreview.js'
import { ProgressIndicator } from './ProgressIndicator.js'

export function PreviewContent(props: {
  file: FileRecord
  expanded?: boolean
  imageStyle?: Record<string, string | undefined>
  loadingProgress?: ProgressStatus
  zoomable?: boolean
  onSaveText?: (file: FileRecord, text: string) => Promise<void>
  onSendFileToApp?: (file: FileRecord, app: HandoffApp) => Promise<void>
}) {
  const isImage = isImageFile(props.file)
  const isVideo = isVideoFile(props.file)
  const isAudio = isAudioFile(props.file)
  const isPdf = isPdfFile(props.file)
  const isVrm = isVrmFile(props.file)
  const isText = !isPdf && !isVrm && isTextLike(props.file)
  const isInlinePreview = isInlinePreviewFile(props.file)
  const dataUrl = props.file.dataUrl
  const isLoading = !dataUrl && (Boolean(props.loadingProgress) || Boolean(props.file.lastCid))

  return (
    <div class={`preview-frame ${props.expanded ? 'expanded' : ''}`}>
      {isLoading ? <BinaryPreview file={props.file} progress={props.loadingProgress ?? { label: 'Loading' }} message="Loading from mistlib..." /> : null}
      {dataUrl && isImage ? <img class={props.zoomable ? 'zoomable-preview-image' : ''} src={dataUrl} alt={props.file.name} style={props.imageStyle} /> : null}
      {dataUrl && isVideo ? <video src={dataUrl} controls /> : null}
      {dataUrl && isAudio ? <audio src={dataUrl} controls /> : null}
      {dataUrl && isPdf ? <PdfPreview file={props.file} dataUrl={dataUrl} expanded={props.expanded} onSendFileToApp={props.onSendFileToApp} /> : null}
      {dataUrl && isVrm ? <VrmPreview file={props.file} dataUrl={dataUrl} expanded={props.expanded} /> : null}
      {dataUrl && isText ? <TextFilePreview file={props.file} dataUrl={dataUrl} expanded={props.expanded} onSaveText={props.onSaveText} onSendFileToApp={props.onSendFileToApp} /> : null}
      {dataUrl && !isInlinePreview ? <BinaryPreview file={props.file} /> : null}
      {!dataUrl && !isLoading ? <BinaryPreview file={props.file} message="Content unavailable" /> : null}
    </div>
  )
}

function BinaryPreview(props: { file: FileRecord; progress?: ProgressStatus; message?: string }) {
  return (
    <div class="binary-preview">
      <FileText size={34} />
      <strong>{props.file.mimeType || 'application/octet-stream'}</strong>
      <span>{props.message ?? formatBytes(props.file.size)}</span>
      <ProgressIndicator className="binary-preview-progress" progress={props.progress} />
    </div>
  )
}
