import { Copy, Download, Eye, EyeOff, KeyRound, Share2, Trash2, UserRound } from 'lucide-preact'
import { useState } from 'preact/hooks'
import type { PendingShare, SyncPeer } from '../appTypes.js'
import type { FolderColor, FolderRecord } from '../domain.js'
import { dateLabel, shortCid, shortNode } from '../format.js'
import { ShareQrCode } from './ShareQrCode.js'

const folderColors: FolderColor[] = ['teal', 'blue', 'amber', 'rose', 'slate']

export function FolderPanel(props: {
  folder: FolderRecord | null
  shareUrl: string
  syncPeers: SyncPeer[]
  pendingShares: PendingShare[]
  importKeys: Record<string, string>
  busy: string
  onCopy: (value: string, label: string) => void
  onDeleteFolder: () => void
  onImportKey: (cid: string, value: string) => void
  onImportShare: (share: PendingShare) => void
  onPatchFolder: (patch: Partial<FolderRecord>) => void
}) {
  return (
    <section class="folder-panel">
      <div class="panel-title">
        <div>
          <span>Folder</span>
          <strong>{props.folder ? props.folder.name : 'My Drive'}</strong>
        </div>
        {props.folder?.lastCid ? <button onClick={() => props.onCopy(props.folder?.lastCid ?? '', 'CID')} title="Copy CID"><Copy size={17} /></button> : null}
      </div>
      {props.folder ? <FolderSettings {...props} folder={props.folder} /> : <div class="empty-detail">Select a folder to manage sharing.</div>}
      {props.folder ? <SyncPeers peers={props.syncPeers} /> : null}
      <IncomingShares {...props} />
    </section>
  )
}

function FolderSettings(props: {
  folder: FolderRecord
  shareUrl: string
  onCopy: (value: string, label: string) => void
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
      <button class="danger wide" type="button" onClick={props.onDeleteFolder}>
        <Trash2 size={17} />
        <span>Delete folder</span>
      </button>
    </form>
  )
}

function IncomingShares(props: {
  pendingShares: PendingShare[]
  importKeys: Record<string, string>
  busy: string
  onImportKey: (cid: string, value: string) => void
  onImportShare: (share: PendingShare) => void
}) {
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({})

  return (
    <div class="shares-section">
      <div class="section-label">
        <Share2 size={17} />
        <span>Pending imports</span>
      </div>
      {props.pendingShares.map((share) => (
        <form class="share-item" key={share.cid} onSubmit={(event) => { event.preventDefault(); props.onImportShare(share) }}>
          <div>
            <strong>{share.type === 'file-share' ? share.fileName ?? 'Shared file' : share.folderName ?? 'Shared folder'}</strong>
            <span>{share.type === 'file-share' ? share.folderName ?? shortCid(share.cid ?? '') : shortCid(share.cid ?? '')}</span>
            <ShareSender share={share} />
          </div>
          <input
            value={share.cid ? props.importKeys[share.cid] ?? '' : ''}
            onInput={(event) => share.cid && props.onImportKey(share.cid, event.currentTarget.value)}
            placeholder={share.type === 'file-share' ? 'File key' : 'Folder key'}
            type={share.cid && visibleKeys[share.cid] ? 'text' : 'password'}
            autocomplete="current-password"
          />
          <button type="button" onClick={() => share.cid && setVisibleKeys((current) => ({ ...current, [share.cid ?? '']: !current[share.cid ?? ''] }))} title={share.cid && visibleKeys[share.cid] ? 'Hide key' : 'Show key'}>
            {share.cid && visibleKeys[share.cid] ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button type="submit" disabled={props.busy === `import-${share.cid}`}>
            <Download size={16} />
            <span>Import</span>
          </button>
        </form>
      ))}
      {props.pendingShares.length === 0 ? <div class="empty-detail compact">No pending imports</div> : null}
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

function ShareSender(props: { share: PendingShare }) {
  const name = props.share.senderProfile?.name?.trim() || props.share.from
  const avatarUrl = props.share.senderProfile?.avatarUrl?.trim()

  return (
    <div class="share-sender" title={`Shared by ${name}`}>
      <div class="avatar-frame tiny">
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <UserRound size={14} />}
      </div>
      <span>Shared by {name}</span>
    </div>
  )
}
