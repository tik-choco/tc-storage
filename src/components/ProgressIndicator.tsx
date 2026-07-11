import type { ProgressStatus } from '../app/appTypes.js'

export function ProgressIndicator(props: { className?: string; progress?: ProgressStatus }) {
  if (!props.progress) return null
  const percent = typeof props.progress.percent === 'number' ? Math.max(0, Math.min(100, Math.round(props.progress.percent))) : undefined
  if (percent === undefined) return null
  if (percent === 100) return null
  const title = percent === undefined ? props.progress.label : `${props.progress.label} ${percent}%`

  return (
    <span class={`progress-indicator ${props.className ?? ''}`} title={title} role="status">
      <span class="progress-track" aria-hidden="true">
        <i style={{ width: `${percent}%` }} />
      </span>
      <em>{percent}%</em>
    </span>
  )
}
