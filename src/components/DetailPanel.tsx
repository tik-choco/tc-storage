import { Copy, Download, KeyRound, Trash2, UserRound } from 'lucide-preact'
import type { SyncPeer } from '../appTypes.js'
import type { FolderColor, FolderRecord } from '../domain.js'
import { dateLabel, shortCid, shortNode } from '../format.js'
import { ShareQrCode } from './ShareQrCode.js'

const folderColors: FolderColor[] = ['teal', 'blue', 'amber', 'rose', 'slate']

export function FolderPanel(props: {
  folder: FolderRecord | null
  shareUrl: string
  syncPeers: SyncPeer[]
  onCopy: (value: string, label: string) => void
  onDownloadFolder: (folder: FolderRecord) => void
  onDeleteFolder: () => void
  onPatchFolder: (patch: Partial<FolderRecord>) => void
}) {
  return (
    <section class="folder-panel">
      <div class="panel-title">
        <div>
          <span>Folder</span>
          <strong>{props.folder ? props.folder.name : 'My Drive'}</strong>
        </div>
      </div>
      {props.folder ? <FolderSettings {...props} folder={props.folder} /> : <div class="empty-detail">Select a folder to manage sharing.</div>}
      {props.folder ? <SyncPeers peers={props.syncPeers} /> : null}
    </section>
  )
}

function FolderSettings(props: {
  folder: FolderRecord
  shareUrl: string
  onCopy: (value: string, label: string) => void
  onDownloadFolder: (folder: FolderRecord) => void
  onDeleteFolder: () => void
  onPatchFolder: (patch: Partial<FolderRecord>) => void
}) {
  return (
    <form class="folder-settings" onSubmit={(event) => event.preventDefault()}>
      <label>
        <span>Name</span>
        <input value={props.folder.name} onInput={(event) => props.onPatchFolder({ name: event.currentTarget.value })} />
      </label>
      <label>
        <span>Color</span>
        <select value={props.folder.color} onChange={(event) => props.onPatchFolder({ color: event.currentTarget.value as FolderColor })}>
          {folderColors.map((color) => <option value={color} key={color}>{color}</option>)}
        </select>
      </label>
      <label class="check-line">
        <input type="checkbox" checked={props.folder.shareEnabled} onChange={(event) => props.onPatchFolder({ shareEnabled: event.currentTarget.checked })} />
        <span>Shared folder</span>
      </label>
      <div class="security-box">
        <KeyRound size={18} />
        <div>
          <strong>mistlib</strong>
          <span>{props.folder.lastCid ? `CID ${shortCid(props.folder.lastCid)}` : 'Not saved'}</span>
        </div>
      </div>
      {props.shareUrl ? (
        <div class="share-link-block">
          <label>
            <span>Share URL</span>
            <div class="key-display one-action">
              <input value={props.shareUrl} readOnly onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} />
              <button type="button" onClick={() => props.onCopy(props.shareUrl, '共有URL')} title="Copy URL"><Copy size={16} /></button>
            </div>
          </label>
          <ShareQrCode label="Folder share" value={props.shareUrl} />
        </div>
      ) : null}
      <button class="primary wide" type="button" onClick={() => props.onDownloadFolder(props.folder)}>
        <Download size={17} />
        <span>Download ZIP</span>
      </button>
      <button class="danger wide" type="button" onClick={props.onDeleteFolder}>
        <Trash2 size={17} />
        <span>Delete folder</span>
      </button>
    </form>
  )
}

export function SyncPeers(props: { peers: SyncPeer[] }) {
  return (
    <div class="shares-section">
      <div class="section-label">
        <UserRound size={17} />
        <span>Sync peers</span>
      </div>
      {props.peers.map((peer) => <SyncPeerRow peer={peer} key={peer.nodeId} />)}
      {props.peers.length === 0 ? <div class="empty-detail compact">No sync peers yet</div> : null}
    </div>
  )
}

function SyncPeerRow(props: { peer: SyncPeer }) {
  const name = props.peer.profile?.name?.trim() || props.peer.nodeId
  const avatarUrl = props.peer.profile?.avatarUrl?.trim()

  return (
    <div class="sync-peer" title={props.peer.nodeId}>
      <div class="avatar-frame tiny">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <UserRound size={14} />}
      </div>
      <div>
        <strong>{name}</strong>
        <span>{shortNode(props.peer.nodeId)} · {dateLabel(props.peer.lastSeenAt)}</span>
      </div>
    </div>
  )
}
