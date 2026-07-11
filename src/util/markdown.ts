import { Marked } from 'marked'
import DOMPurify from 'dompurify'

const marked = new Marked({ async: false, gfm: true, breaks: false })

let linkHookInstalled = false

/**
 * Renders markdown to sanitized HTML. Files can arrive from remote peers, so
 * any embedded HTML/script must never execute — everything goes through
 * DOMPurify before it reaches `dangerouslySetInnerHTML`.
 *
 * DOMPurify needs a real browser DOM. Outside a browser (SSR, node tests)
 * this falls back to an escaped `<pre>` block so raw markup never leaks out.
 */
export function renderMarkdownHtml(markdown: string): string {
  if (!markdown) return ''
  if (typeof window === 'undefined') return `<pre>${escapeHtml(markdown)}</pre>`
  try {
    const rawHtml = marked.parse(markdown, { async: false })
    ensureLinkHook()
    return DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ['target'],
      FORBID_ATTR: ['style'],
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    })
  } catch {
    return `<pre>${escapeHtml(markdown)}</pre>`
  }
}

function ensureLinkHook(): void {
  if (linkHookInstalled) return
  linkHookInstalled = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element) || node.tagName !== 'A') return
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}
