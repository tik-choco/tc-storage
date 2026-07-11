export function pinchMetrics(touches: TouchList): { distance: number; center: { x: number; y: number } } | null {
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

export function pointInElement(point: { x: number; y: number }, element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect()
  return { x: point.x - rect.left, y: point.y - rect.top }
}

// Resolve one axis of `object-position` (e.g. "50%", "left", "12px") to a
// fraction of the free space [0, 1]. Defaults to centered.
function resolvePositionFraction(value: string | undefined, free: number): number {
  if (!value) return 0.5
  const token = value.trim().toLowerCase()
  if (token === 'left' || token === 'top') return 0
  if (token === 'right' || token === 'bottom') return 1
  if (token === 'center') return 0.5
  if (token.endsWith('%')) return (parseFloat(token) || 0) / 100
  if (token.endsWith('px') && free > 0) return (parseFloat(token) || 0) / free
  return 0.5
}

// True when the pointer landed on the letterbox padding of an object-fit:
// contain image rather than on its visible pixels. Accounts for the image's
// actual object-position so off-centre alignments are handled correctly.
export function isImageLetterboxClick(image: HTMLImageElement, event: { clientX: number; clientY: number }): boolean {
  const { naturalWidth, naturalHeight } = image
  if (!naturalWidth || !naturalHeight) return false
  const rect = image.getBoundingClientRect()
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight)
  const displayedWidth = naturalWidth * scale
  const displayedHeight = naturalHeight * scale
  const freeX = rect.width - displayedWidth
  const freeY = rect.height - displayedHeight
  const position = window.getComputedStyle(image).objectPosition.split(/\s+/)
  const offsetX = freeX * resolvePositionFraction(position[0], freeX)
  const offsetY = freeY * resolvePositionFraction(position[1], freeY)
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  return x < offsetX || x > offsetX + displayedWidth || y < offsetY || y > offsetY + displayedHeight
}

export function isInteractiveFlowTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('button, input, textarea, select, video, audio, iframe'))
}

export function clampZoom(zoom: { scale: number; x: number; y: number }) {
  if (zoom.scale <= 1.02) return { scale: 1, x: 0, y: 0 }
  const maxX = ((zoom.scale - 1) * window.innerWidth) / 2
  const maxY = ((zoom.scale - 1) * window.innerHeight) / 2
  return {
    scale: zoom.scale,
    x: clamp(zoom.x, -maxX, maxX),
    y: clamp(zoom.y, -maxY, maxY),
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function isMobilePreview(): boolean {
  return window.matchMedia('(max-width: 760px)').matches
}

export function isLeftSideTap(clientX: number, target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return clientX < window.innerWidth / 2
  const rect = target.getBoundingClientRect()
  return clientX < rect.left + rect.width / 2
}
