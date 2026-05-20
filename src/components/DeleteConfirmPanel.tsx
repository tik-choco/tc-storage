import type { DeleteRequest } from '../appTypes.js'

export function DeleteConfirmPanel(props: {
  request: DeleteRequest
  onCancel: () => void
  onConfirm: () => void
}) {
  const name = props.request.type === 'file' ? props.request.file.name : props.request.folder.name
  const label = props.request.type === 'file' ? 'file' : 'folder'

  return (
    <section class="delete-confirm-panel">
      <div class="panel-title">
        <div>
          <span>Confirm</span>
          <strong>Delete {label}</strong>
        </div>
      </div>
      <p><strong>{name}</strong> を削除しますか？</p>
      <small>{props.request.type === 'folder' ? '配下のフォルダーとファイルも削除されます。' : 'この操作で一覧から削除されます。'}</small>
      <div class="confirm-actions">
        <button type="button" onClick={props.onCancel}>Cancel</button>
        <button type="button" class="danger" onClick={props.onConfirm}>Delete</button>
      </div>
    </section>
  )
}
