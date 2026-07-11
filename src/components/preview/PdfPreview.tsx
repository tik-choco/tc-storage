import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { ExternalLink, MoveHorizontal, ZoomIn, ZoomOut } from 'lucide-preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { FileRecord } from '../../storage/domain.js'
import type { HandoffApp } from '../../storage/fileHandoff.js'
import { familyAppUrl } from '../../util/familyApps.js'

export interface PdfPreviewProps {
  file: FileRecord
  dataUrl: string
  expanded?: boolean
  onSendFileToApp?: (file: FileRecord, app: HandoffApp) => Promise<void>
}

const MIN_SCALE = 0.25
const MAX_SCALE = 4
const ZOOM_STEP = 0.15
const MAX_DPR = 2

type Status = 'loading' | 'ready' | 'error'

export function PdfPreview(props: PdfPreviewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const visibilityRef = useRef<Map<number, number>>(new Map())

  const [status, setStatus] = useState<Status>('loading')
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null)
  const [scale, setScale] = useState(1)
  const [fitWidth, setFitWidth] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)

  // Load the document whenever the dataUrl changes. `doc` is local to this effect run so
  // the cleanup always destroys exactly the instance it created, even across fast prop changes.
  useEffect(() => {
    let cancelled = false
    let doc: PDFDocumentProxy | null = null
    setStatus('loading')
    setPdfDoc(null)
    setNumPages(0)
    setBaseSize(null)
    setCurrentPage(1)

    async function load() {
      try {
        const pdfjs = await import('pdfjs-dist')
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
        const response = await fetch(props.dataUrl)
        const data = await response.arrayBuffer()
        if (cancelled) return
        const task = pdfjs.getDocument({ data })
        const loadedDoc = await task.promise
        if (cancelled) {
          void loadedDoc.destroy()
          return
        }
        doc = loadedDoc
        const firstPage = await loadedDoc.getPage(1)
        if (cancelled) return
        const viewport = firstPage.getViewport({ scale: 1 })
        setBaseSize({ width: viewport.width, height: viewport.height })
        setNumPages(loadedDoc.numPages)
        setPdfDoc(loadedDoc)
        setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      }
    }

    void load()

    return () => {
      cancelled = true
      if (doc) void doc.destroy()
    }
  }, [props.dataUrl])

  // Fit-width mode: derive scale from the container width and keep it in sync on resize.
  useEffect(() => {
    if (!fitWidth || !baseSize) return
    const container = scrollRef.current
    if (!container) return
    const applyFit = () => {
      const width = container.clientWidth - 32
      if (width > 0) setScale(clampScale(width / baseSize.width))
    }
    applyFit()
    const observer = new ResizeObserver(applyFit)
    observer.observe(container)
    return () => observer.disconnect()
  }, [fitWidth, baseSize])

  function handleZoomIn() {
    setFitWidth(false)
    setScale((prev) => clampScale(prev + ZOOM_STEP))
  }

  function handleZoomOut() {
    setFitWidth(false)
    setScale((prev) => clampScale(prev - ZOOM_STEP))
  }

  function handleResetZoom() {
    setFitWidth(true)
  }

  function handleWheel(event: WheelEvent) {
    if (!event.ctrlKey) return
    event.preventDefault()
    setFitWidth(false)
    setScale((prev) => clampScale(prev + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)))
  }

  const reportVisibility = useCallback((pageNumber: number, ratio: number) => {
    const map = visibilityRef.current
    if (ratio <= 0) map.delete(pageNumber)
    else map.set(pageNumber, ratio)
    let bestPage = pageNumber
    let bestRatio = 0
    for (const [page, r] of map) {
      if (r > bestRatio) {
        bestRatio = r
        bestPage = page
      }
    }
    if (bestRatio > 0) setCurrentPage(bestPage)
  }, [])

  const pageNumbers = useMemo(() => Array.from({ length: numPages }, (_, index) => index + 1), [numPages])
  const aspect = baseSize ? baseSize.height / baseSize.width : 1.414

  return (
    <div class={`pdf-preview ${props.expanded ? 'expanded' : ''}`}>
      <div class="pdf-preview-toolbar">
        <button type="button" class="pdf-toolbar-btn" onClick={handleZoomOut} disabled={status !== 'ready'} title="縮小">
          <ZoomOut size={16} />
        </button>
        <button type="button" class="pdf-zoom-display" onClick={handleResetZoom} disabled={status !== 'ready'} title="幅に合わせる">
          {Math.round(scale * 100)}%
        </button>
        <button type="button" class="pdf-toolbar-btn" onClick={handleZoomIn} disabled={status !== 'ready'} title="拡大">
          <ZoomIn size={16} />
        </button>
        <button
          type="button"
          class={`pdf-toolbar-btn ${fitWidth ? 'active' : ''}`}
          onClick={() => setFitWidth(true)}
          disabled={status !== 'ready'}
          title="幅に合わせる"
        >
          <MoveHorizontal size={16} />
        </button>
        <a
          class="pdf-toolbar-btn"
          href={familyAppUrl('tc-pdf-viewer')}
          target="_blank"
          rel="noopener noreferrer"
          title={props.onSendFileToApp ? 'tc-pdf-viewer アプリで開く (ファイルを送信)' : 'tc-pdf-viewer アプリを開く'}
          onClick={() => void props.onSendFileToApp?.(props.file, 'tc-pdf-viewer')}
        >
          <ExternalLink size={16} />
        </a>
        {status === 'ready' ? (
          <span class="pdf-page-indicator">{currentPage} / {numPages}</span>
        ) : null}
      </div>
      <div class="pdf-preview-scroll" ref={scrollRef} onWheel={handleWheel}>
        {status === 'loading' ? <div class="pdf-preview-state">読み込み中...</div> : null}
        {status === 'error' ? <div class="pdf-preview-state pdf-preview-error">PDFを読み込めませんでした</div> : null}
        {status === 'ready' ? (
          <div class="pdf-pages">
            {pageNumbers.map((pageNumber) => (
              <PdfPage
                key={pageNumber}
                pageNumber={pageNumber}
                doc={pdfDoc}
                scale={scale}
                aspectRatio={aspect}
                baseWidth={baseSize ? baseSize.width : 0}
                scrollRoot={scrollRef}
                onVisibilityChange={reportVisibility}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale * 100) / 100))
}

function PdfPage(props: {
  pageNumber: number
  doc: PDFDocumentProxy | null
  scale: number
  aspectRatio: number
  baseWidth: number
  scrollRoot: { current: HTMLDivElement | null }
  onVisibilityChange: (pageNumber: number, ratio: number) => void
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pageProxyRef = useRef<PDFPageProxy | null>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const [lazyVisible, setLazyVisible] = useState(false)

  const { pageNumber, doc, scale, onVisibilityChange } = props

  // The cached page proxy belongs to a specific document; drop it whenever the
  // document identity changes (e.g. navigating to a different file) so the next
  // render effect re-fetches the page instead of touching a destroyed document.
  useEffect(() => {
    pageProxyRef.current = null
  }, [doc])

  // Observe visibility for lazy rendering + approximate current-page tracking.
  useEffect(() => {
    const node = wrapperRef.current
    const root = props.scrollRoot.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setLazyVisible(true)
          onVisibilityChange(pageNumber, entry.isIntersecting ? entry.intersectionRatio : 0)
        }
      },
      { root, rootMargin: '250px 0px', threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    )
    observer.observe(node)
    return () => {
      observer.disconnect()
      onVisibilityChange(pageNumber, 0)
    }
  }, [pageNumber, onVisibilityChange])

  // Render (or re-render on scale/document change) once the page has entered the lazy window.
  useEffect(() => {
    if (!lazyVisible) return
    const canvas = canvasRef.current
    if (!doc || !canvas) return
    let cancelled = false

    async function render(doc: PDFDocumentProxy, canvas: HTMLCanvasElement) {
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
        renderTaskRef.current = null
      }
      try {
        let page = pageProxyRef.current
        if (!page) {
          page = await doc.getPage(pageNumber)
          if (cancelled) return
          pageProxyRef.current = page
        }
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
        const viewport = page.getViewport({ scale })
        const renderViewport = page.getViewport({ scale: scale * dpr })
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        canvas.width = Math.ceil(renderViewport.width)
        canvas.height = Math.ceil(renderViewport.height)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        const task = page.render({ canvasContext: ctx, canvas, viewport: renderViewport })
        renderTaskRef.current = task
        await task.promise
        if (renderTaskRef.current === task) renderTaskRef.current = null
      } catch {
        // Cancelled renders throw RenderingCancelledException; other failures on a single
        // page shouldn't take down the whole viewer, so both are swallowed here.
      }
    }

    void render(doc, canvas)

    return () => {
      cancelled = true
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
        renderTaskRef.current = null
      }
    }
  }, [lazyVisible, scale, pageNumber, doc])

  // Full teardown on unmount.
  useEffect(() => {
    return () => {
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
        renderTaskRef.current = null
      }
      pageProxyRef.current = null
    }
  }, [])

  const width = props.baseWidth * scale
  const height = width * props.aspectRatio

  return (
    <div ref={wrapperRef} class="pdf-page-wrapper" style={{ width: `${width}px`, height: `${height}px` }}>
      {lazyVisible ? (
        <canvas ref={canvasRef} class="pdf-page-canvas" />
      ) : (
        <div class="pdf-page-placeholder" />
      )}
    </div>
  )
}
