import { ChevronLeft, ChevronRight, Download, FileText, X } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { formatBytes, type FileRecord } from '../domain.js'
import { isTextLike } from '../format.js'

export function ExpandedPreview(props: {
  file: FileRecord
  index: number
  loadingProgress: number
  total: number
  onClose: () => void
  onPrevious: () => void
  onNext: () => void
  onDownload: (file: FileRecord) => void | Promise<void>
}) {
  const canNavigate = props.total > 1
  const canZoom = props.file.mimeType.startsWith('image/') && Boolean(props.file.dataUrl)
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 })
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const pinchRef = useRef<{ distance: number; center: { x: number; y: number }; zoom: { scale: number; x: number; y: number } } | null>(null)
  const panRef = useRef<{ x: number; y: number; zoom: { scale: number; x: number; y: number } } | null>(null)
  const zoomRef = useRef(zoom)

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    setZoom({ scale: 1, x: 0, y: 0 })
    touchStartRef.current = null
    pinchRef.current = null
    panRef.current = null
  }, [props.file.id])

  const closeFromEmptySpace = (event: MouseEvent) => {
    if (event.target === event.currentTarget) props.onClose()
  }
  const handleTouchStart = (event: TouchEvent) => {
    if (canZoom && event.touches.length >= 2) {
      const pinch = pinchMetrics(event.touches)
      pinchRef.current = pinch ? { ...pinch, zoom: zoomRef.current } : null
      panRef.current = null
      touchStartRef.current = null
      return
    }
    const touch = event.touches[0]
    if (canZoom && zoomRef.current.scale > 1.02 && touch) {
      panRef.current = { x: touch.clientX, y: touch.clientY, zoom: zoomRef.current }
      touchStartRef.current = null
      return
    }
    touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null
  }
  const handleTouchMove = (event: TouchEvent) => {
    if (!canZoom) return
    if (event.touches.length >= 2 && pinchRef.current) {
      const pinch = pinchMetrics(event.touches)
      if (!pinch) return
      event.preventDefault()
      const nextScale = clamp(pinchRef.current.zoom.scale * (pinch.distance / pinchRef.current.distance), 1, 5)
      setZoom(clampZoom({
        scale: nextScale,
        x: pinchRef.current.zoom.x + (pinch.center.x - pinchRef.current.center.x),
        y: pinchRef.current.zoom.y + (pinch.center.y - pinchRef.current.center.y),
      }))
      return
    }
    const touch = event.touches[0]
    if (touch && panRef.current && zoomRef.current.scale > 1.02) {
      event.preventDefault()
      setZoom(clampZoom({
        scale: zoomRef.current.scale,
        x: panRef.current.zoom.x + touch.clientX - panRef.current.x,
        y: panRef.current.zoom.y + touch.clientY - panRef.current.y,
      }))
    }
  }
  const handleTouchEnd = (event: TouchEvent) => {
    if (pinchRef.current) {
      if (event.touches.length < 2) pinchRef.current = null
      if (event.touches.length === 1) {
        const touch = event.touches[0]
        panRef.current = touch ? { x: touch.clientX, y: touch.clientY, zoom: zoomRef.current } : null
      }
      if (zoomRef.current.scale <= 1.02) setZoom({ scale: 1, x: 0, y: 0 })
      return
    }
    if (panRef.current) {
      if (event.touches.length === 0) panRef.current = null
      if (zoomRef.current.scale <= 1.02) setZoom({ scale: 1, x: 0, y: 0 })
      return
    }
    const start = touchStartRef.current
    const touch = event.changedTouches[0]
    touchStartRef.current = null
    if (!start || !touch) return
    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    const movement = Math.hypot(deltaX, deltaY)
    if (movement < 12 && canZoom && canNavigate && isMobilePreview() && zoomRef.current.scale <= 1.02) {
      event.preventDefault()
      props.onNext()
      return
    }
    if (!canNavigate || Math.abs(deltaX) < 52 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25 || zoomRef.current.scale > 1.02) return
    if (deltaX > 0) props.onPrevious()
    else props.onNext()
  }
  const imageStyle = canZoom
    ? {
        transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
        transition: pinchRef.current || panRef.current ? 'none' : undefined,
      }
    : undefined

  return (
    <section class={`preview-modal ${canZoom ? 'zoomable' : ''}`} role="dialog" aria-modal="true" aria-label={props.file.name} onClick={closeFromEmptySpace}>
      <header class="preview-modal-top">
        <div>
          <span>Preview</span>
          <strong>{props.file.name}</strong>
          <small>{props.index >= 0 ? `${props.index + 1} / ${props.total}` : `1 / ${props.total}`} · {formatBytes(props.file.size)}</small>
        </div>
        <div class="preview-modal-actions">
          <button onClick={() => props.onDownload(props.file)} title="Download"><Download size={18} /></button>
          <button onClick={props.onClose} title="Close"><X size={18} /></button>
        </div>
      </header>
      <button class="preview-nav previous" onClick={props.onPrevious} disabled={!canNavigate} title="Previous file"><ChevronLeft size={26} /></button>
      <div class="preview-modal-body" onClick={closeFromEmptySpace} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
        <PreviewContent file={props.file} loadingProgress={props.loadingProgress} expanded imageStyle={imageStyle} zoomable={canZoom} />
      </div>
      <button class="preview-nav next" onClick={props.onNext} disabled={!canNavigate} title="Next file"><ChevronRight size={26} /></button>
    </section>
  )
}

function PreviewContent(props: { file: FileRecord; expanded?: boolean; imageStyle?: Record<string, string | undefined>; loadingProgress: number; zoomable?: boolean }) {
  const [text, setText] = useState('')
  const [textError, setTextError] = useState('')
  const isImage = props.file.mimeType.startsWith('image/')
  const isVideo = props.file.mimeType.startsWith('video/')
  const isAudio = props.file.mimeType.startsWith('audio/')
  const isPdf = props.file.mimeType === 'application/pdf' || props.file.name.toLowerCase().endsWith('.pdf')
  const isText = isTextLike(props.file)
  const isInlinePreview = isImage || isVideo || isAudio || isPdf || isText
  const dataUrl = props.file.dataUrl
  const isLoading = !dataUrl && (props.loadingProgress > 0 || Boolean(props.file.lastCid))

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
      {isLoading ? <BinaryPreview file={props.file} loadingProgress={props.loadingProgress} message="Loading from mistlib..." /> : null}
      {dataUrl && isImage ? <img class={props.zoomable ? 'zoomable-preview-image' : ''} src={dataUrl} alt={props.file.name} style={props.imageStyle} /> : null}
      {dataUrl && isVideo ? <video src={dataUrl} controls /> : null}
      {dataUrl && isAudio ? <audio src={dataUrl} controls /> : null}
      {dataUrl && isPdf ? <iframe src={dataUrl} title={props.file.name} /> : null}
      {dataUrl && isText ? <pre>{textError || text || 'Loading...'}</pre> : null}
      {dataUrl && !isInlinePreview ? <BinaryPreview file={props.file} /> : null}
      {!dataUrl && !isLoading ? <BinaryPreview file={props.file} message="Content unavailable" /> : null}
    </div>
  )
}

function pinchMetrics(touches: TouchList): { distance: number; center: { x: number; y: number } } | null {
  const first = touches[0]
  const second = touches[1]
  if (!first || !second) return null
  const dx = second.clientX - first.clientX
  const dy = second.clientY - first.clientY
  return {
    distance: Math.max(1, Math.hypot(dx, dy)),
    center: { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 },
  }
}

function clampZoom(zoom: { scale: number; x: number; y: number }) {
  if (zoom.scale <= 1.02) return { scale: 1, x: 0, y: 0 }
  const maxX = ((zoom.scale - 1) * window.innerWidth) / 2
  const maxY = ((zoom.scale - 1) * window.innerHeight) / 2
  return {
    scale: zoom.scale,
    x: clamp(zoom.x, -maxX, maxX),
    y: clamp(zoom.y, -maxY, maxY),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isMobilePreview(): boolean {
  return window.matchMedia('(max-width: 760px)').matches
}

function BinaryPreview(props: { file: FileRecord; loadingProgress?: number; message?: string }) {
  const hasProgress = typeof props.loadingProgress === 'number'

  return (
    <div class="binary-preview">
      <FileText size={34} />
      <strong>{props.file.mimeType || 'application/octet-stream'}</strong>
      <span>{props.message ?? formatBytes(props.file.size)}</span>
      {hasProgress ? (
        <div class="binary-preview-progress" aria-label={`Loading ${props.loadingProgress}%`}>
          <i style={{ width: `${props.loadingProgress}%` }} />
          <em>{props.loadingProgress}%</em>
        </div>
      ) : null}
    </div>
  )
}
