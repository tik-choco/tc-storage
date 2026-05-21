import { useEffect, useRef, useState } from 'preact/hooks'
import { ExpandedPreviewShell } from './ExpandedPreviewShell.js'
import { clamp, clampZoom, isInteractiveFlowTarget, isLeftSideTap, isMobilePreview, pinchMetrics, pointInElement } from './previewInteraction.js'
import type { ExpandedPreviewProps } from './previewTypes.js'

export function ExpandedPreview(props: ExpandedPreviewProps) {
  const [mode, setMode] = useState<'single' | 'flow'>('single')
  const canNavigate = props.total > 1
  const flowFiles = props.files.length ? props.files : [props.file]
  const flowEnabled = mode === 'flow' && canNavigate
  const canZoom = !flowEnabled && props.file.mimeType.startsWith('image/') && Boolean(props.file.dataUrl)
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 })
  const [flowZoom, setFlowZoom] = useState(1)
  const flowBodyRef = useRef<HTMLDivElement>(null)
  const flowItemRefs = useRef<Record<string, HTMLElement | null>>({})
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const wheelLastNavigateAtRef = useRef(0)
  const wheelDeltaRef = useRef(0)
  const flowZoomRef = useRef(flowZoom)
  const flowPinchRef = useRef<{ distance: number; zoom: number; center: { x: number; y: number }; scroll: { x: number; y: number } } | null>(null)
  const flowMousePanRef = useRef<{ x: number; y: number; scroll: { x: number; y: number } } | null>(null)
  const singleMousePanRef = useRef<{ x: number; y: number; zoom: { scale: number; x: number; y: number } } | null>(null)
  const pinchRef = useRef<{ distance: number; center: { x: number; y: number }; zoom: { scale: number; x: number; y: number } } | null>(null)
  const panRef = useRef<{ x: number; y: number; zoom: { scale: number; x: number; y: number } } | null>(null)
  const zoomRef = useRef(zoom)

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    flowZoomRef.current = flowZoom
  }, [flowZoom])

  useEffect(() => {
    setZoom({ scale: 1, x: 0, y: 0 })
    touchStartRef.current = null
    pinchRef.current = null
    panRef.current = null
    singleMousePanRef.current = null
  }, [props.file.id])

  useEffect(() => {
    if (!flowEnabled) return
    props.onPreloadFile(props.file)
    const current = flowItemRefs.current[props.file.id]
    current?.scrollIntoView({ block: 'start' })
  }, [flowEnabled, props.file.id])

  useEffect(() => {
    if (!flowEnabled) return
    const root = flowBodyRef.current
    if (!root || typeof IntersectionObserver !== 'function') {
      for (const file of flowFiles.slice(Math.max(0, props.index - 1), props.index + 2)) props.onPreloadFile(file)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const id = (entry.target as HTMLElement).dataset.fileId
        const file = flowFiles.find((item) => item.id === id)
        if (file) props.onPreloadFile(file)
      }
    }, { root, rootMargin: '260px 0px' })
    for (const element of Object.values(flowItemRefs.current)) {
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [flowEnabled, flowFiles, props.index])

  const closeFromEmptySpace = (event: MouseEvent) => {
    if (event.target === event.currentTarget) props.onClose()
  }
  const handleTouchStart = (event: TouchEvent) => {
    if (flowEnabled && event.touches.length >= 2) {
      const pinch = pinchMetrics(event.touches)
      const root = flowBodyRef.current
      flowPinchRef.current = pinch && root
        ? { distance: pinch.distance, zoom: flowZoomRef.current, center: pointInElement(pinch.center, root), scroll: { x: root.scrollLeft, y: root.scrollTop } }
        : null
      touchStartRef.current = null
      return
    }
    if (flowEnabled) {
      touchStartRef.current = null
      return
    }
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
    if (flowEnabled && event.touches.length >= 2 && flowPinchRef.current) {
      const pinch = pinchMetrics(event.touches)
      const root = flowBodyRef.current
      if (!pinch || !root) return
      event.preventDefault()
      const nextZoom = clamp(flowPinchRef.current.zoom * (pinch.distance / flowPinchRef.current.distance), 0.6, 3)
      const currentCenter = pointInElement(pinch.center, root)
      const ratio = nextZoom / flowPinchRef.current.zoom
      setFlowZoom(nextZoom)
      flowZoomRef.current = nextZoom
      root.scrollLeft = (flowPinchRef.current.scroll.x + flowPinchRef.current.center.x) * ratio - currentCenter.x
      root.scrollTop = (flowPinchRef.current.scroll.y + flowPinchRef.current.center.y) * ratio - currentCenter.y
      return
    }
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
    if (flowPinchRef.current) {
      if (event.touches.length < 2) flowPinchRef.current = null
      return
    }
    if (flowEnabled) return
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
      if (isLeftSideTap(touch.clientX, event.currentTarget)) props.onPrevious()
      else props.onNext()
      return
    }
    if (!canNavigate || Math.abs(deltaX) < 52 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25 || zoomRef.current.scale > 1.02) return
    if (deltaX > 0) props.onPrevious()
    else props.onNext()
  }
  const handleWheel = (event: WheelEvent) => {
    if (flowEnabled) {
      if (!event.ctrlKey && !event.metaKey) return
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      if (Math.abs(delta) < 1) return
      event.preventDefault()
      zoomFlowAtPoint(clamp(flowZoomRef.current * (delta > 0 ? 0.88 : 1.14), 0.6, 3), { x: event.clientX, y: event.clientY })
      return
    }
    if (canZoom && (event.ctrlKey || event.metaKey)) {
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      if (Math.abs(delta) < 1) return
      event.preventDefault()
      zoomSingleAtPoint(clamp(zoomRef.current.scale * (delta > 0 ? 0.88 : 1.14), 1, 5), { x: event.clientX, y: event.clientY })
      return
    }
    if (!canNavigate || flowEnabled || zoomRef.current.scale > 1.02) return
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (Math.abs(delta) < 4) return
    event.preventDefault()
    const now = Date.now()
    if (now - wheelLastNavigateAtRef.current < 420) return
    wheelDeltaRef.current += delta
    if (Math.abs(wheelDeltaRef.current) < 48) return
    if (wheelDeltaRef.current > 0) props.onNext()
    else props.onPrevious()
    wheelDeltaRef.current = 0
    wheelLastNavigateAtRef.current = now
  }
  const handleMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || isInteractiveFlowTarget(event.target)) return
    if (flowEnabled) {
      const root = flowBodyRef.current
      if (!root) return
      event.preventDefault()
      flowMousePanRef.current = { x: event.clientX, y: event.clientY, scroll: { x: root.scrollLeft, y: root.scrollTop } }
      return
    }
    if (canZoom && zoomRef.current.scale > 1.02) {
      event.preventDefault()
      singleMousePanRef.current = { x: event.clientX, y: event.clientY, zoom: zoomRef.current }
    }
  }
  const handleMouseMove = (event: MouseEvent) => {
    if (flowEnabled && flowMousePanRef.current) {
      const root = flowBodyRef.current
      if (!root) return
      event.preventDefault()
      root.scrollLeft = flowMousePanRef.current.scroll.x - (event.clientX - flowMousePanRef.current.x)
      root.scrollTop = flowMousePanRef.current.scroll.y - (event.clientY - flowMousePanRef.current.y)
      return
    }
    if (!flowEnabled && singleMousePanRef.current) {
      event.preventDefault()
      const next = clampZoom({
        scale: singleMousePanRef.current.zoom.scale,
        x: singleMousePanRef.current.zoom.x + event.clientX - singleMousePanRef.current.x,
        y: singleMousePanRef.current.zoom.y + event.clientY - singleMousePanRef.current.y,
      })
      setZoom(next)
      zoomRef.current = next
    }
  }
  const clearMousePan = () => {
    flowMousePanRef.current = null
    singleMousePanRef.current = null
  }
  function zoomFlowAtPoint(nextZoom: number, point: { x: number; y: number }) {
    const root = flowBodyRef.current
    const currentZoom = flowZoomRef.current
    if (!root || nextZoom === currentZoom) return
    const center = pointInElement(point, root)
    const ratio = nextZoom / currentZoom
    const nextScrollLeft = (root.scrollLeft + center.x) * ratio - center.x
    const nextScrollTop = (root.scrollTop + center.y) * ratio - center.y
    setFlowZoom(nextZoom)
    flowZoomRef.current = nextZoom
    window.requestAnimationFrame(() => {
      root.scrollLeft = nextScrollLeft
      root.scrollTop = nextScrollTop
    })
  }
  function zoomSingleAtPoint(nextScale: number, point: { x: number; y: number }) {
    const root = flowBodyRef.current
    const current = zoomRef.current
    if (!root || nextScale === current.scale) return
    const rect = root.getBoundingClientRect()
    const offsetX = point.x - (rect.left + rect.width / 2)
    const offsetY = point.y - (rect.top + rect.height / 2)
    const ratio = nextScale / current.scale
    const next = clampZoom({
      scale: nextScale,
      x: offsetX - (offsetX - current.x) * ratio,
      y: offsetY - (offsetY - current.y) * ratio,
    })
    setZoom(next)
    zoomRef.current = next
  }
  const imageStyle = canZoom
    ? {
        transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
        transition: pinchRef.current || panRef.current ? 'none' : undefined,
      }
    : undefined
  const flowListStyle = flowEnabled
    ? { width: `min(${Math.round(780 * flowZoom)}px, ${Math.round(100 * flowZoom)}%)` }
    : undefined

  return (
    <ExpandedPreviewShell
      {...{
        canNavigate, canZoom, clearMousePan, closeFromEmptySpace, file: props.file, flowBodyRef,
        flowEnabled, flowFiles, flowItemRefs, flowListStyle, handleMouseDown, handleMouseMove,
        handleTouchEnd, handleTouchMove, handleTouchStart, handleWheel, imageStyle, index: props.index,
        loadingProgress: props.loadingProgress, loadingProgressByFileId: props.loadingProgressByFileId,
        mode, onClose: props.onClose, onDownload: props.onDownload, onNext: props.onNext,
        onPrevious: props.onPrevious, setMode, total: props.total,
      }}
    />
  )
}
