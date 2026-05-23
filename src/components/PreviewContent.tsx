import { FileText } from 'lucide-preact'
import { useEffect, useState } from 'preact/hooks'
import type { ProgressStatus } from '../appTypes.js'
import { isAudioFile, isImageFile, isInlinePreviewFile, isPdfFile, isVideoFile } from '../appUtils.js'
import { formatBytes, type FileRecord } from '../domain.js'
import { isTextLike } from '../format.js'
import { ProgressIndicator } from './ProgressIndicator.js'

export function PreviewContent(props: { file: FileRecord; expanded?: boolean; imageStyle?: Record<string, string | undefined>; loadingProgress?: ProgressStatus; zoomable?: boolean }) {
  const [text, setText] = useState('')
  const [textError, setTextError] = useState('')
  const isImage = isImageFile(props.file)
  const isVideo = isVideoFile(props.file)
  const isAudio = isAudioFile(props.file)
  const isPdf = isPdfFile(props.file)
  const isText = isTextLike(props.file)
  const isInlinePreview = isInlinePreviewFile(props.file)
  const dataUrl = props.file.dataUrl
  const isLoading = !dataUrl && (Boolean(props.loadingProgress) || Boolean(props.file.lastCid))

  useEffect(() => {
    let cancelled = false
    setText('')
    setTextError('')
    if (!isText || !dataUrl) return
    void fetch(dataUrl)
      .then((response) => response.text())
      .then((value) => {
        if (!cancelled) setText(value)
      })
      .catch(() => {
        if (!cancelled) setTextError('Preview unavailable')
      })
    return () => {
      cancelled = true
    }
  }, [dataUrl, isText])

  return (
    <div class={`preview-frame ${props.expanded ? 'expanded' : ''}`}>
      {isLoading ? <BinaryPreview file={props.file} progress={props.loadingProgress ?? { label: 'Loading' }} message="Loading from mistlib..." /> : null}
      {dataUrl && isImage ? <img class={props.zoomable ? 'zoomable-preview-image' : ''} src={dataUrl} alt={props.file.name} style={props.imageStyle} /> : null}
      {dataUrl && isVideo ? <video src={dataUrl} controls /> : null}
      {dataUrl && isAudio ? <audio src={dataUrl} controls /> : null}
      {dataUrl && isPdf ? <iframe src={dataUrl} title={props.file.name} sandbox="" referrerPolicy="no-referrer" /> : null}
      {dataUrl && isText ? <pre>{textError || text || 'Loading...'}</pre> : null}
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
