import { Upload } from 'lucide-preact'
import type { FolderRecord } from '../domain.js'

export function DropOverlay(props: { folder: FolderRecord | null }) {
  return (
    <div class="drop-overlay">
      <Upload size={24} />
      <strong>{props.folder ? props.folder.name : 'My Drive'}</strong>
    </div>
  )
}
