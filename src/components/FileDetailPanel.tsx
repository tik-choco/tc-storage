import { Check, ChevronDown, ChevronUp, Copy, Download, Eye, EyeOff, Share2, Trash2, X } from 'lucide-preact'
import { useEffect, useState } from 'preact/hooks'
import type { SyncPeer } from '../app/appTypes.js'
import { formatBytes, type FileRecord } from '../storage/domain.js'
import { dateLabel, shortCid, shortHash } from '../util/format.js'
import { SyncPeers } from './DetailPanel.js'
import { ShareQrCode } from './ShareQrCode.js'

export function FileDetailPanel(props: {
  busy: boolean
  file: FileRecord
  shareKey: string
  shareUrl: string
  syncPeers: SyncPeer[]
  onClose: () => void
  onCopy: (value: string, label: string) => void
  onDownload: (file: FileRecord) => void | Promise<void>
  onDelete: (file: FileRecord) => void
  onRename: (file: FileRecord, name: string) => void
  onShare: (file: FileRecord) => void
}) {
  const [showKey, setShowKey] = useState(false)
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState(props.file.name)
  const normalizedName = nameDraft.trim()
  const nameChanged = normalizedName !== props.file.name

  useEffect(() => {
    setNameDraft(props.file.name)
  }, [props.file.id, props.file.name])

  function submitRename() {
    if (!normalizedName || !nameChanged) return
    props.onRename(props.file, normalizedName)
  }

  return (
    <form class="file-detail-panel" onSubmit={(event) => event.preventDefault()}>
      <div class="panel-title">
        <div>
          <span>Details</span>
          <strong>{props.file.name}</strong>
        </div>
        <div class="panel-actions">
          <button type="button" onClick={props.onClose} title="Close details"><X size={17} /></button>
        </div>
      </div>
      <label class="file-share-key file-name-field">
        <span>Name</span>
        <div class="key-display one-action">
          <input
            value={nameDraft}
            onInput={(event) => setNameDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitRename()
            }}
          />
          <button type="button" onClick={submitRename} disabled={!normalizedName || !nameChanged} title="Save name">
            <Check size={16} />
          </button>
        </div>
      </label>
      <FileMeta file={props.file} />
      {props.shareUrl ? (
        <div class="share-link-block">
          <label class="file-share-key">
            <span>Share URL</span>
            <div class="key-display one-action">
              <input value={props.shareUrl} readOnly onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()} />
              <CopyFeedbackButton value={props.shareUrl} label="共有URL" title="Copy URL" onCopy={props.onCopy} />
            </div>
          </label>
          <ShareQrCode label="File share" value={props.shareUrl} />
        </div>
      ) : null}
      <div class="preview-actions">
        <button type="button" class="primary wide" onClick={() => props.onShare(props.file)} disabled={props.busy}>
          <Share2 size={17} />
          <span>{props.busy ? 'Sharing' : 'Share'}</span>
        </button>
        <button type="button" class="secondary wide" onClick={() => props.onDownload(props.file)}>
          <Download size={17} />
          <span>Download</span>
        </button>
        <button type="button" class="danger wide" onClick={() => props.onDelete(props.file)}>
          <Trash2 size={17} />
          <span>Delete</span>
        </button>
      </div>
      <button type="button" class="technical-toggle" onClick={() => setTechnicalOpen((current) => !current)} aria-expanded={technicalOpen}>
        {technicalOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        <span>{technicalOpen ? 'Hide technical details' : 'Show technical details'}</span>
      </button>
      {technicalOpen ? (
        <div class="technical-details">
          <TechnicalFileMeta file={props.file} />
          <SyncPeers peers={props.syncPeers} />
          {props.shareKey ? (
            <label class="file-share-key">
              <span>File key</span>
              <div class="key-display two-actions">
                <input value={props.shareKey} readOnly type={showKey ? 'text' : 'password'} autocomplete="off" />
                <button type="button" onClick={() => setShowKey((current) => !current)} title={showKey ? 'Hide key' : 'Show key'}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                <CopyFeedbackButton value={props.shareKey} label="ファイルキー" title="Copy key" onCopy={props.onCopy} />
              </div>
            </label>
          ) : null}
        </div>
      ) : null}
    </form>
  )
}

function FileMeta(props: { file: FileRecord }) {
  return (
    <div class="file-meta">
      <div><span>Size</span><strong>{formatBytes(props.file.size)}</strong></div>
      <div><span>Updated</span><strong>{dateLabel(props.file.updatedAt)}</strong></div>
    </div>
  )
}

function TechnicalFileMeta(props: { file: FileRecord }) {
  return (
    <div class="file-meta">
      <div><span>Version</span><strong>v{props.file.version}</strong></div>
      <div><span>Checksum</span><strong title={props.file.checksum}>{shortHash(props.file.checksum)}</strong></div>
      {props.file.lastCid ? <div><span>CID</span><strong title={props.file.lastCid}>{shortCid(props.file.lastCid)}</strong></div> : null}
      {props.file.lastShareCid ? <div><span>Share CID</span><strong title={props.file.lastShareCid}>{shortCid(props.file.lastShareCid)}</strong></div> : null}
    </div>
  )
}

function CopyFeedbackButton(props: {
  value: string
  label: string
  title: string
  onCopy: (value: string, label: string) => void
}) {
  const [copied, setCopied] = useState(false)

  function copyValue() {
    props.onCopy(props.value, props.label)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <button type="button" class={copied ? 'copied' : ''} onClick={copyValue} title={copied ? 'Copied' : props.title}>
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  )
}
