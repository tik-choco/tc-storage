import { Copy } from 'lucide-preact'
import { useEffect, useState } from 'preact/hooks'
import type { FolderRecord } from '../storage/domain.js'
import type { FolderEscrowView } from '../app/folderEscrowController.js'
import { escrowMessages } from '../escrow/i18n.js'
import { customEscrowRoomError } from '../escrow/appRooms.js'

export function FolderEscrowSettings(props: {
  folder: FolderRecord
  view?: FolderEscrowView
  appRoomIds: string[]
  onChange(setting: NonNullable<FolderRecord['escrow']>): void
  onCopy(value: string, label: string): void
}) {
  const t = escrowMessages(),
    setting = props.folder.escrow ?? { mode: 'auto', room: '' }
  const [draft, setDraft] = useState(setting.room)
  const [custom, setCustom] = useState(false)
  const [invalid, setInvalid] = useState<'invalidRoom' | 'roomCollision'>()
  useEffect(() => {
    if (!custom) setDraft(setting.room)
  }, [setting.room, custom])
  const mode = custom ? 'custom' : setting.mode
  const view = props.view
  const apply = () => {
    const room = draft.trim()
    const error = customEscrowRoomError(room, props.appRoomIds)
    if (error) {
      setInvalid(error)
      return
    }
    setInvalid(undefined)
    setCustom(false)
    props.onChange({ mode: 'custom', room })
  }
  return (
    <div class="shares-section escrow-settings">
      <div class="section-label">
        <span>{t.title}</span>
      </div>
      <label>
        <span>{t.mode}</span>
        <select
          aria-label={t.mode}
          value={mode}
          onChange={(event) => {
            const next = event.currentTarget.value as 'auto' | 'custom' | 'off'
            setInvalid(undefined)
            if (next === 'custom') {
              setCustom(true)
              setDraft(setting.room || view?.room || '')
            } else {
              setCustom(false)
              props.onChange({ mode: next, room: '' })
            }
          }}
        >
          <option value="auto">{t.auto}</option>
          <option value="custom">{t.custom}</option>
          <option value="off">{t.off}</option>
        </select>
      </label>
      {mode === 'custom' ? (
        <label>
          <span>{t.customRoom}</span>
          <small>{t.roomCollision}</small>
          <input
            aria-label={t.customRoom}
            value={draft}
            maxLength={96}
            onInput={(e) => setDraft(e.currentTarget.value)}
          />
          <button type="button" onClick={apply}>
            {t.apply}
          </button>
          {invalid ? <small role="alert">{t[invalid]}</small> : null}
        </label>
      ) : null}
      {setting.mode !== 'off' ? (
        <label>
          <span>{t.room}</span>
          <div class="key-display one-action">
            <input aria-label={t.room} value={view?.room ?? ''} readOnly onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              title={t.copy}
              disabled={!view?.room}
              onClick={() => props.onCopy(view!.room, t.copy)}
            >
              <Copy size={16} />
            </button>
          </div>
        </label>
      ) : null}
      <div role="status">
        {t[setting.mode === 'off' ? 'off' : (view?.status ?? 'searching')]}
        {view?.reason ? ' — ' + view.reason : ''}
      </div>
      {view?.savedAt ? (
        <small>
          {t.savedAt}: {new Date(view.savedAt).toLocaleString()}
        </small>
      ) : null}
      {view?.totalFiles ? (
        <small>
          {t.protected}: {view.protectedFiles}/{view.totalFiles}
        </small>
      ) : null}
      {setting.mode !== 'off' ? <small>{t.hint}</small> : null}
    </div>
  )
}
