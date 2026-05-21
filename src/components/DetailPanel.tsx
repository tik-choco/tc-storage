import { Check, Copy, Download, KeyRound, ShieldCheck, Trash2, UserRound, X } from 'lucide-preact'
import type { FolderAccessMode, FolderAccessRequest, SyncPeer } from '../appTypes.js'
import type { FolderColor, FolderRecord } from '../domain.js'
import { dateLabel, shortCid, shortNode } from '../format.js'
import { ShareQrCode } from './ShareQrCode.js'

const folderColors: FolderColor[] = ['teal', 'blue', 'amber', 'rose', 'slate']

export function FolderPanel(props: {
  folder: FolderRecord | null
  accessOnly: boolean
  accessMode: FolderAccessMode
  accessRequests: FolderAccessRequest[]
  shareUrl: string
  syncPeers: SyncPeer[]
  onAccessModeChange: (mode: FolderAccessMode) => void
  onApproveAccess: (request: FolderAccessRequest) => void
  onCopy: (value: string, label: string) => void
  onDownloadFolder: (folder: FolderRecord) => void
  onDeleteFolder: () => void
  onPatchFolder: (patch: Partial<FolderRecord>) => void
  onRejectAccess: (request: FolderAccessRequest) => void
}) {
  return (
    <section class="folder-panel">
      <div class="panel-title">
        <div>
          <span>{props.accessOnly ? 'Access request' : 'Folder'}</span>
          <strong>{props.folder ? props.folder.name : 'My Drive'}</strong>
        </div>
      </div>
      {props.folder ? (
        props.accessOnly
          ? <AccessOnlyPanel requests={props.accessRequests} onApprove={props.onApproveAccess} onReject={props.onRejectAccess} />
          : <FolderSettings {...props} folder={props.folder} />
      ) : <div class="empty-detail">Select a folder to manage sharing.</div>}
      {props.folder && !props.accessOnly ? <SyncPeers peers={props.syncPeers} /> : null}
    </section>
  )
}

function FolderSettings(props: {
  folder: FolderRecord
  accessMode: FolderAccessMode
  accessRequests: FolderAccessRequest[]
  shareUrl: string
  onAccessModeChange: (mode: FolderAccessMode) => void
  onApproveAccess: (request: FolderAccessRequest) => void
  onCopy: (value: string, label: string) => void
  onDownloadFolder: (folder: FolderRecord) => void
  onDeleteFolder: () => void
  onPatchFolder: (patch: Partial<FolderRecord>) => void
  onRejectAccess: (request: FolderAccessRequest) => void
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
      {props.folder.shareEnabled ? (
        <label>
          <span>Access</span>
          <select value={props.accessMode} onChange={(event) => props.onAccessModeChange(event.currentTarget.value as FolderAccessMode)}>
            <option value="approval">承認制</option>
            <option value="open">無制限受け入れ</option>
          </select>
        </label>
      ) : null}
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
      {props.folder.shareEnabled && props.accessRequests.length > 0 ? (
        <AccessRequests requests={props.accessRequests} onApprove={props.onApproveAccess} onReject={props.onRejectAccess} />
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

function AccessOnlyPanel(props: {
  requests: FolderAccessRequest[]
  onApprove: (request: FolderAccessRequest) => void
  onReject: (request: FolderAccessRequest) => void
}) {
  return props.requests.length > 0
    ? <AccessRequests requests={props.requests} onApprove={props.onApprove} onReject={props.onReject} />
    : <div class="empty-detail compact">No access requests</div>
}

function AccessRequests(props: {
  requests: FolderAccessRequest[]
  onApprove: (request: FolderAccessRequest) => void
  onReject: (request: FolderAccessRequest) => void
}) {
  return (
    <div class="shares-section">
      <div class="section-label">
        <ShieldCheck size={17} />
        <span>Access requests</span>
      </div>
      {props.requests.map((request) => <AccessRequestRow key={request.id} request={request} onApprove={props.onApprove} onReject={props.onReject} />)}
    </div>
  )
}

function AccessRequestRow(props: {
  request: FolderAccessRequest
  onApprove: (request: FolderAccessRequest) => void
  onReject: (request: FolderAccessRequest) => void
}) {
  const name = props.request.profile?.name?.trim() || props.request.nodeId
  const avatarUrl = props.request.profile?.avatarUrl?.trim()

  return (
    <div class="access-request" title={props.request.nodeId}>
      <div class="avatar-frame tiny">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <UserRound size={14} />}
      </div>
      <div>
        <strong>{name}</strong>
        <span>{shortNode(props.request.nodeId)} · {dateLabel(props.request.requestedAt)}</span>
      </div>
      <div class="access-request-actions">
        <button type="button" class="approve" title="Approve" onClick={() => props.onApprove(props.request)}><Check size={16} /></button>
        <button type="button" class="reject" title="Reject" onClick={() => props.onReject(props.request)}><X size={16} /></button>
      </div>
    </div>
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
