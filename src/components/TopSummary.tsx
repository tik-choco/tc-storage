import { AlertCircle, CheckCircle2, Wifi } from 'lucide-preact'
import type { DownloadProgress, Notice } from '../appTypes.js'
import type { NetworkState } from '../p2p.js'

export function TopSummary(props: {
  downloadProgress: DownloadProgress | null
  networkState: NetworkState
  notice: Notice
}) {
  return (
    <footer class="status-bar">
      <div class="status-network" title={props.networkState.lastEvent}>
        <Wifi size={14} />
        <strong>mistlib</strong>
        <span>{props.networkState.peers.length} peers</span>
      </div>
      <div class={`status-notice ${props.notice.tone}`}>
        {props.notice.text ? (
          <>
            {props.notice.tone === 'error' ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
            <span>{props.notice.text}</span>
          </>
        ) : null}
      </div>
      {props.downloadProgress ? (
        <div class="status-download" title={`${props.downloadProgress.fileName} ${props.downloadProgress.percent}%`}>
          <span>{props.downloadProgress.fileName}</span>
          <div class="status-download-bar" aria-hidden="true">
            <i style={{ width: `${props.downloadProgress.percent}%` }} />
          </div>
          <strong>{props.downloadProgress.percent}%</strong>
        </div>
      ) : null}
    </footer>
  )
}
