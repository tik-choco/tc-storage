import { AlertCircle, CheckCircle2, HardDrive, Wifi } from 'lucide-preact'
import type { DownloadProgress, Notice } from '../appTypes.js'
import { formatBytes } from '../domain.js'
import type { NetworkState } from '../p2p.js'

export function TopSummary(props: {
  currentFolderName: string | null
  currentFolderStorageUsed: number
  downloadProgress: DownloadProgress | null
  networkState: NetworkState
  notice: Notice
  storageUsed: number
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
      {props.downloadProgress?.percent !== undefined && props.downloadProgress.percent !== 100 ? (
        <div class={`status-download ${props.downloadProgress.percent === undefined ? 'indeterminate' : ''}`} title={downloadTitle(props.downloadProgress)}>
          <span>{props.downloadProgress.fileName}</span>
          <div class="status-download-bar" aria-hidden="true">
            <i style={props.downloadProgress.percent === undefined ? undefined : { width: `${props.downloadProgress.percent}%` }} />
          </div>
          <strong>{props.downloadProgress.percent === undefined ? props.downloadProgress.label : `${props.downloadProgress.percent}%`}</strong>
        </div>
      ) : null}
      <div class="status-storage" title={`${props.currentFolderName}: ${formatBytes(props.currentFolderStorageUsed)} / Total: ${formatBytes(props.storageUsed)}`}>
        <HardDrive size={14} />
        {props.currentFolderName ? (
          <>
            <span>{props.currentFolderName}</span>
            <strong>{formatBytes(props.currentFolderStorageUsed)}</strong>
            <i />
          </>
        ) : null}
        <span>Total</span>
        <strong>{formatBytes(props.storageUsed)}</strong>
      </div>
    </footer>
  )
}

function downloadTitle(progress: DownloadProgress): string {
  return progress.percent === undefined ? `${progress.fileName}: ${progress.label}` : `${progress.fileName}: ${progress.label} ${progress.percent}%`
}
