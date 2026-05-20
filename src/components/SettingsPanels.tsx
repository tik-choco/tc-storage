import { Image, Save, ShieldCheck, UserRound, X } from 'lucide-preact'
import { useState } from 'preact/hooks'
import type { AppSettings } from '../localSettings.js'

export type ProfileAvatarImage = {
  busy: boolean
  dataUrl: string
  id: string
  name: string
  progress: number
  selected: boolean
}

export function SettingsPanel(props: {
  draft: AppSettings
  onDraft: (settings: AppSettings) => void
  onClose: () => void
  onSave: () => void
}) {
  return (
    <section class="settings-panel">
      <div class="panel-title">
        <div>
          <span>Settings</span>
          <strong>mistlib room</strong>
        </div>
        <button onClick={props.onClose} title="Close">
          <X size={17} />
        </button>
      </div>
      <label>
        <span>roomId</span>
        <input value={props.draft.roomId} onInput={(event) => props.onDraft({ ...props.draft, roomId: event.currentTarget.value })} />
      </label>
      <label>
        <span>Signaling URL</span>
        <input value={props.draft.signalingUrl} onInput={(event) => props.onDraft({ ...props.draft, signalingUrl: event.currentTarget.value })} />
      </label>
      <label class="check-line">
        <input
          type="checkbox"
          checked={props.draft.autoConnect}
          onChange={(event) => props.onDraft({ ...props.draft, autoConnect: event.currentTarget.checked })}
        />
        <span>Auto connect</span>
      </label>
      <label>
        <span>DID Node ID</span>
        <input value={props.draft.nodeId} readOnly />
      </label>
      <label>
        <span>Authentication key</span>
        <input value={props.draft.identity ? `${props.draft.identity.method} / ${props.draft.identity.keyType}` : 'Generating Ed25519 DID...'} readOnly />
      </label>
      <button class="primary wide" onClick={props.onSave}>
        <Save size={17} />
        <span>Save settings</span>
      </button>
    </section>
  )
}

export function ProfilePanel(props: {
  avatarImages: ProfileAvatarImage[]
  avatarPreviewUrl: string
  draft: AppSettings
  onDraft: (settings: AppSettings) => void
  onClose: () => void
  onOpenAvatarImages: () => void
  onSave: () => void
  onSelectAvatarImage: (fileId: string) => void
}) {
  const [avatarImagesOpen, setAvatarImagesOpen] = useState(false)

  function openAvatarImages() {
    setAvatarImagesOpen(true)
    props.onOpenAvatarImages()
  }

  return (
    <section class="settings-panel">
      <div class="panel-title">
        <div>
          <span>Profile</span>
          <strong>{props.draft.profileName.trim() || 'Local user'}</strong>
        </div>
        <button onClick={props.onClose} title="Close">
          <X size={17} />
        </button>
      </div>
      <div class="profile-preview">
        <div class="avatar-frame large">
          {props.avatarPreviewUrl ? <img src={props.avatarPreviewUrl} alt="" /> : <UserRound size={24} />}
        </div>
        <div>
          <strong>{props.draft.profileName.trim() || 'Local user'}</strong>
          <span>{props.draft.identity?.did ?? 'Generating Ed25519 DID...'}</span>
        </div>
      </div>
      <div class="security-box">
        <ShieldCheck size={18} />
        <div>
          <strong>Self-authenticating DID</strong>
          <span>{props.draft.identity ? `${props.draft.identity.method} / ${props.draft.identity.keyType}` : 'Ed25519 key is being created locally'}</span>
        </div>
      </div>
      <label>
        <span>Display name</span>
        <input value={props.draft.profileName} onInput={(event) => props.onDraft({ ...props.draft, profileName: event.currentTarget.value })} placeholder="Local user" />
      </label>
      <label>
        <span>Icon image URL</span>
        <input value={props.draft.avatarUrl} onInput={(event) => props.onDraft({ ...props.draft, avatarFileId: '', avatarUrl: event.currentTarget.value })} placeholder="https://example.com/avatar.png" type="url" />
      </label>
      {props.avatarImages.length > 0 ? (
        <div class="profile-avatar-picker">
          <button type="button" class="profile-avatar-open" onClick={openAvatarImages}>
            <Image size={16} />
            <span>アップロード済みから選択</span>
          </button>
          {avatarImagesOpen ? (
            <div class="profile-avatar-grid">
              {props.avatarImages.map((image) => (
                <button type="button" class={image.selected ? 'selected' : ''} onClick={() => props.onSelectAvatarImage(image.id)} title={image.name} key={image.id}>
                  <span class="profile-avatar-file-icon">
                    {image.dataUrl ? <img src={image.dataUrl} alt="" /> : <Image size={18} />}
                  </span>
                  <span class="profile-avatar-file-name">{image.busy ? `Loading ${image.progress}%` : image.name}</span>
                  {image.busy ? (
                    <span class="profile-avatar-progress" aria-hidden="true">
                      <span style={{ width: `${image.progress}%` }} />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <button class="primary wide" onClick={props.onSave}>
        <Save size={17} />
        <span>Save profile</span>
      </button>
    </section>
  )
}
