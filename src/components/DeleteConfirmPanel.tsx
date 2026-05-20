import type { DeleteRequest } from '../appTypes.js'

export function DeleteConfirmPanel(props: {
  request: DeleteRequest
  onCancel: () => void
  onConfirm: () => void
}) {
  const count = props.request.type === 'selection' ? props.request.files.length + props.request.folders.length : 1
  const name = props.request.type === 'file' ? props.request.file.name : props.request.type === 'folder' ? props.request.folder.name : `${count} selected items`
  const label = props.request.type === 'file' ? 'file' : props.request.type === 'folder' ? 'folder' : 'items'
  const note = props.request.type === 'file'
    ? 'この操作で一覧から削除されます。'
    : props.request.type === 'folder'
      ? '配下のフォルダーとファイルも削除されます。'
      : '選択したフォルダーの配下も削除されます。'

  return (
    <section class="delete-confirm-panel">
      <div class="panel-title">
        <div>
          <span>Confirm</span>
          <strong>Delete {label}</strong>
        </div>
      </div>
      <p><strong>{name}</strong> を削除しますか？</p>
      <small>{note}</small>
      <div class="confirm-actions">
        <button type="button" onClick={props.onCancel}>Cancel</button>
        <button type="button" class="danger" onClick={props.onConfirm}>Delete</button>
      </div>
    </section>
  )
}
