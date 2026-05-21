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
