import { Edit3, ExternalLink, Eye, LoaderCircle, Save, TriangleAlert, ZoomIn, ZoomOut } from 'lucide-preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { FileRecord } from '../../storage/domain.js'
import type { HandoffApp } from '../../storage/fileHandoff.js'
import { familyAppUrl } from '../../util/familyApps.js'
import { isMarkdownFile } from '../../util/format.js'
import { renderMarkdownHtml } from '../../util/markdown.js'

export interface TextFilePreviewProps {
  file: FileRecord
  dataUrl: string
  expanded?: boolean
  onSaveText?: (file: FileRecord, text: string) => Promise<void>
  onSendFileToApp?: (file: FileRecord, app: HandoffApp) => Promise<void>
}

type ViewMode = 'preview' | 'source'

const minFontScale = 70
const maxFontScale = 180

export function TextFilePreview(props: TextFilePreviewProps) {
  const isMarkdown = isMarkdownFile(props.file)
  const readOnly = !props.onSaveText
  const canSave = Boolean(props.onSaveText) && Boolean(props.expanded)

  const [mode, setMode] = useState<ViewMode>('preview')
  const [baseline, setBaseline] = useState('')
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [fontScale, setFontScale] = useState(100)

  const dirty = loaded && text !== baseline
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const lastFileIdRef = useRef<string | null>(null)

  // Reloads the decoded text whenever the file's content changes. A different
  // file always reloads (it's a new document); the same file only reloads
  // when the editor has no unsaved changes, so we never clobber the user's
  // in-progress edits when content refreshes underneath them (e.g. sync).
  useEffect(() => {
    const fileChanged = lastFileIdRef.current !== props.file.id
    lastFileIdRef.current = props.file.id
    if (!fileChanged && dirtyRef.current) return
    let cancelled = false
    setLoaded(false)
    setError('')
    fetch(props.dataUrl)
      .then((response) => response.text())
      .then((decoded) => {
        if (cancelled) return
        setBaseline(decoded)
        setText(decoded)
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setBaseline('')
        setText('')
        setLoaded(true)
      })
    if (fileChanged) setMode('preview')
    return () => { cancelled = true }
  }, [props.dataUrl, props.file.id])

  const previewHtml = useMemo(() => (isMarkdown ? renderMarkdownHtml(text) : ''), [isMarkdown, text])

  async function handleSave() {
    if (!canSave || !dirty || saving) return
    const pending = text
    setSaving(true)
    setError('')
    try {
      await props.onSaveText?.(props.file, pending)
      setBaseline(pending)
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  function handleTextareaKeyDown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void handleSave()
    }
  }

  function changeFontScale(delta: number) {
    setFontScale((current) => Math.min(maxFontScale, Math.max(minFontScale, current + delta)))
  }

  const bodyStyle = { fontSize: `${0.9 * (fontScale / 100)}rem` }

  return (
    <div class={`text-preview ${props.expanded ? 'expanded' : ''}`}>
      <div class="text-preview-toolbar">
        <div class="text-preview-mode-toggle" role="group" aria-label="表示モード">
          <button type="button" class={mode === 'preview' ? 'selected' : ''} aria-pressed={mode === 'preview'} onClick={() => setMode('preview')} title="プレビュー">
            <Eye size={15} />
          </button>
          <button type="button" class={mode === 'source' ? 'selected' : ''} aria-pressed={mode === 'source'} onClick={() => setMode('source')} title={readOnly ? 'ソース' : 'ソース / 編集'}>
            <Edit3 size={15} />
          </button>
        </div>
        <div class="text-preview-toolbar-spacer" />
        <div class="text-preview-font-controls" title="文字サイズ">
          <button type="button" onClick={() => changeFontScale(-10)} disabled={fontScale <= minFontScale} title="文字を小さく">
            <ZoomOut size={14} />
          </button>
          <span class="text-preview-font-value">{fontScale}%</span>
          <button type="button" onClick={() => changeFontScale(10)} disabled={fontScale >= maxFontScale} title="文字を大きく">
            <ZoomIn size={14} />
          </button>
        </div>
        <a
          class="text-preview-app-link"
          href={familyAppUrl('tc-note')}
          target="_blank"
          rel="noopener noreferrer"
          title={props.onSendFileToApp ? 'tc-note アプリで開く (ファイルを送信)' : 'tc-note アプリを開く'}
          onClick={() => void props.onSendFileToApp?.(props.file, 'tc-note')}
        >
          <ExternalLink size={15} />
        </a>
        {canSave ? (
          <button type="button" class="text-preview-save-btn" onClick={() => void handleSave()} disabled={!dirty || saving} title="保存 (Ctrl+S)">
            {saving ? <LoaderCircle size={15} class="text-preview-spin" /> : <Save size={15} />}
            {dirty && !saving ? <span class="text-preview-dirty-dot" aria-hidden="true" /> : null}
          </button>
        ) : null}
      </div>
      {error ? (
        <div class="text-preview-error">
          <TriangleAlert size={14} />
          <span>{error}</span>
        </div>
      ) : null}
      <div class="text-preview-body">
        {mode === 'preview' ? (
          isMarkdown ? (
            <div class="text-preview-markdown-doc" style={bodyStyle} dangerouslySetInnerHTML={{ __html: previewHtml }} />
          ) : (
            <pre class="text-preview-plain" style={bodyStyle}>{text}</pre>
          )
        ) : (
          <textarea
            class="text-preview-editor"
            style={bodyStyle}
            value={text}
            readOnly={readOnly}
            spellcheck={false}
            onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
            onKeyDown={handleTextareaKeyDown}
          />
        )}
      </div>
    </div>
  )
}
