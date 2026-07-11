import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

export type PopoverKind = 'profile' | 'settings' | 'detail' | 'folder' | 'confirm'
export type PopoverPosition = { left: number; top: number }

const popoverMargin = 14
const statusBarClearance = 42
const minimumVisibleHeight = 180

export function DraggablePopover(props: {
  children: ComponentChildren
  className: string
  position: PopoverPosition
  onMove: (position: PopoverPosition) => void
}) {
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const clampCurrentPosition = () => {
      const width = popoverRef.current?.getBoundingClientRect().width
      const nextPosition = clampPopoverPosition(props.position, width)
      if (nextPosition.left !== props.position.left || nextPosition.top !== props.position.top) {
        props.onMove(nextPosition)
      }
    }
    clampCurrentPosition()
    window.addEventListener('resize', clampCurrentPosition)
    return () => window.removeEventListener('resize', clampCurrentPosition)
  }, [props.position.left, props.position.top])

  function startDrag(event: JSX.TargetedPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (!target.closest('.panel-title') || target.closest('button,input,select,textarea')) return
    event.preventDefault()
    const start = {
      clientX: event.clientX,
      clientY: event.clientY,
      left: props.position.left,
      top: props.position.top,
    }
    const onMove = (moveEvent: PointerEvent) => {
      props.onMove(clampPopoverPosition({
        left: start.left + moveEvent.clientX - start.clientX,
        top: start.top + moveEvent.clientY - start.clientY,
      }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  return (
    <div
      ref={popoverRef}
      class={`floating-popover ${props.className}`}
      style={{
        left: `${props.position.left}px`,
        maxHeight: `calc(100dvh - ${props.position.top + statusBarClearance}px)`,
        top: `${props.position.top}px`,
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={startDrag}
    >
      <div class="floating-popover-content">
        {props.children}
      </div>
    </div>
  )
}

export function initialPopoverPosition(kind: PopoverKind): PopoverPosition {
  const width = typeof window === 'undefined' ? 1280 : window.innerWidth
  if (kind === 'detail') return clampPopoverPosition({ left: width - 740, top: 176 }, 360)
  if (kind === 'settings') return clampPopoverPosition({ left: width - 390, top: 64 }, 330)
  if (kind === 'folder') return clampPopoverPosition({ left: width - 760, top: 132 }, 360)
  if (kind === 'confirm') return clampPopoverPosition({ left: width - 560, top: 200 }, 330)
  return clampPopoverPosition({ left: width - 390, top: 64 }, 320)
}

export function popoverPositionFromAnchor(anchor: HTMLElement, width = 330): PopoverPosition {
  const rect = anchor.getBoundingClientRect()
  return clampPopoverPosition({ left: rect.right - width, top: rect.bottom + 8 }, width)
}

export function clampPopoverPosition(position: PopoverPosition, width = 380): PopoverPosition {
  if (typeof window === 'undefined') return position
  const maxTop = Math.max(popoverMargin, window.innerHeight - statusBarClearance - minimumVisibleHeight)
  return {
    left: Math.min(Math.max(popoverMargin, position.left), Math.max(popoverMargin, window.innerWidth - width - popoverMargin)),
    top: Math.min(Math.max(popoverMargin, position.top), maxTop),
  }
}
