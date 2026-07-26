import type { ProgressStatus } from '../app/appTypes.js'

// `indeterminate` is opt-in: existing callers pass `{ label }` with no percent and previously
// got nothing rendered at all. Making that suddenly draw a bar would change layouts nobody
// asked for, so only callers that explicitly want the "still working" affordance get it.
export function ProgressIndicator(props: {
  className?: string
  progress?: ProgressStatus
  indeterminate?: boolean
  showLabel?: boolean
}) {
  if (!props.progress) return null
  const percent = typeof props.progress.percent === 'number' ? Math.max(0, Math.min(100, Math.round(props.progress.percent))) : undefined
  const isIndeterminate = percent === undefined && Boolean(props.indeterminate)
  if (percent === undefined && !isIndeterminate) return null
  if (percent === 100) return null
  const title = percent === undefined ? props.progress.label : `${props.progress.label} ${percent}%`

  return (
    <span
      class={`progress-indicator ${isIndeterminate ? 'indeterminate' : ''} ${props.showLabel ? 'with-label' : ''} ${props.className ?? ''}`}
      title={title}
      role="status"
    >
      {props.showLabel ? <span class="progress-label">{props.progress.label}</span> : null}
      <span class="progress-bar-row">
        <span class="progress-track" aria-hidden="true">
          <i style={isIndeterminate ? undefined : { width: `${percent}%` }} />
        </span>
        {percent !== undefined ? <em>{percent}%</em> : null}
      </span>
    </span>
  )
}
