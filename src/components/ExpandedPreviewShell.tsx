import { ChevronLeft, ChevronRight, Download, X } from 'lucide-preact'
import type { ProgressStatus } from '../appTypes.js'
import { formatBytes, type FileRecord } from '../domain.js'
import { PreviewContent } from './PreviewContent.js'

interface ExpandedPreviewShellProps {
  canNavigate: boolean
  canZoom: boolean
  clearMousePan: () => void
  closeFromEmptySpace: (event: MouseEvent) => void
  file: FileRecord
  flowBodyRef: { current: HTMLDivElement | null }
  flowEnabled: boolean
  flowFiles: FileRecord[]
  flowItemRefs: { current: Record<string, HTMLElement | null> }
  flowListStyle?: { width: string }
  handleMouseDown: (event: MouseEvent) => void
  handleMouseMove: (event: MouseEvent) => void
  handleTouchEnd: (event: TouchEvent) => void
  handleTouchMove: (event: TouchEvent) => void
  handleTouchStart: (event: TouchEvent) => void
  handleWheel: (event: WheelEvent) => void
  imageStyle?: Record<string, string | undefined>
  index: number
  loadingProgress?: ProgressStatus
  loadingProgressByFileId: Record<string, ProgressStatus>
  mode: 'single' | 'flow'
  onClose: () => void
  onDownload: (file: FileRecord) => void | Promise<void>
  onNext: () => void
  onPrevious: () => void
  setMode: (mode: 'single' | 'flow') => void
  total: number
}

export function ExpandedPreviewShell(props: ExpandedPreviewShellProps) {
  return (
    <section class={`preview-modal ${props.canZoom ? 'zoomable' : ''} ${props.flowEnabled ? 'flow-mode' : ''}`} role="dialog" aria-modal="true" aria-label={props.file.name} onClick={props.closeFromEmptySpace}>
      <header class="preview-modal-top">
        <div>
          <span>Preview</span>
          <strong>{props.file.name}</strong>
          <small>{props.index >= 0 ? `${props.index + 1} / ${props.total}` : `1 / ${props.total}`} · {formatBytes(props.file.size)}</small>
        </div>
        <div class="preview-modal-actions">
          {props.canNavigate ? (
            <div class="preview-mode-toggle" role="group" aria-label="Preview mode">
              <button type="button" class={props.mode === 'single' ? 'selected' : ''} aria-pressed={props.mode === 'single'} onClick={() => props.setMode('single')}>Single</button>
              <button type="button" class={props.mode === 'flow' ? 'selected' : ''} aria-pressed={props.mode === 'flow'} onClick={() => props.setMode('flow')}>Flow</button>
            </div>
          ) : null}
          <button onClick={() => props.onDownload(props.file)} title="Download"><Download size={18} /></button>
          <button onClick={props.onClose} title="Close"><X size={18} /></button>
        </div>
      </header>
      {props.flowEnabled ? null : <button class="preview-nav previous" onClick={props.onPrevious} disabled={!props.canNavigate} title="Previous file"><ChevronLeft size={26} /></button>}
      <div
        ref={props.flowBodyRef}
        class={`preview-modal-body ${props.flowEnabled ? 'flow-body' : ''}`}
        onClick={props.closeFromEmptySpace}
        onMouseDown={props.handleMouseDown}
        onMouseLeave={props.clearMousePan}
        onMouseMove={props.handleMouseMove}
        onMouseUp={props.clearMousePan}
        onWheel={props.handleWheel}
        onTouchStart={props.handleTouchStart}
        onTouchMove={props.handleTouchMove}
        onTouchEnd={props.handleTouchEnd}
      >
        {props.flowEnabled ? (
          <div class="preview-flow-list" style={props.flowListStyle}>
            {props.flowFiles.map((file) => (
              <article
                class={`preview-flow-item ${file.id === props.file.id ? 'current' : ''}`}
                data-file-id={file.id}
                key={file.id}
                ref={(element) => { props.flowItemRefs.current[file.id] = element }}
              >
                <PreviewContent file={file} loadingProgress={props.loadingProgressByFileId[file.id] ?? 0} expanded />
              </article>
            ))}
          </div>
        ) : (
          <PreviewContent file={props.file} loadingProgress={props.loadingProgress} expanded imageStyle={props.imageStyle} zoomable={props.canZoom} />
        )}
      </div>
      {props.flowEnabled ? null : <button class="preview-nav next" onClick={props.onNext} disabled={!props.canNavigate} title="Next file"><ChevronRight size={26} /></button>}
    </section>
  )
}
