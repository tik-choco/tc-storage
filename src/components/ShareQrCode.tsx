import { EyeOff, QrCode as QrCodeIcon } from 'lucide-preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { createQrCode } from '../qr/qrCode.js'

const quietZone = 4

export function ShareQrCode(props: { label: string; value: string }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => setVisible(false), [props.value])

  const qrCode = useMemo(() => {
    if (!visible) return undefined
    try {
      return createQrCode(props.value)
    } catch {
      return undefined
    }
  }, [props.value, visible])
  const viewBoxSize = qrCode ? qrCode.size + quietZone * 2 : 0
  const path = useMemo(() => qrCode ? modulePath(qrCode.modules) : '', [qrCode])

  if (!visible) {
    return (
      <button type="button" class="share-qr-toggle" onClick={() => setVisible(true)} title={`Show ${props.label} QR`}>
        <QrCodeIcon size={16} />
        <span>Show QR</span>
      </button>
    )
  }

  if (!qrCode) {
    return (
      <div class="share-qr-card unavailable">
        <strong>QR unavailable</strong>
        <span>Share URL is too long</span>
        <button type="button" class="share-qr-hide" onClick={() => setVisible(false)} title="Hide QR">
          <EyeOff size={16} />
          <span>Hide QR</span>
        </button>
      </div>
    )
  }

  return (
    <div class="share-qr-card">
      <svg viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`} role="img" aria-label={`${props.label} QR code`}>
        <rect width={viewBoxSize} height={viewBoxSize} fill="#fff" />
        <path d={path} fill="#0f172a" />
      </svg>
      <span>{props.label} QR</span>
      <button type="button" class="share-qr-hide" onClick={() => setVisible(false)} title="Hide QR">
        <EyeOff size={16} />
        <span>Hide QR</span>
      </button>
    </div>
  )
}

function modulePath(modules: boolean[][]): string {
  const commands: string[] = []
  for (let y = 0; y < modules.length; y += 1) {
    let x = 0
    while (x < modules.length) {
      if (!modules[y][x]) {
        x += 1
        continue
      }
      const start = x
      while (x < modules.length && modules[y][x]) x += 1
      commands.push(`M${start + quietZone} ${y + quietZone}h${x - start}v1h-${x - start}z`)
    }
  }
  return commands.join('')
}
