export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the legacy selection-based copy path.
  }
  return legacyCopy(value)
}

export type ReservedClipboardWrite = {
  cancel: () => void
  write: (value: string) => Promise<boolean>
}

export function reserveClipboardWrite(): ReservedClipboardWrite | undefined {
  const clipboard = navigator.clipboard
  if (!clipboard?.write || typeof ClipboardItem !== 'function') return undefined
  let settle: ((blob: Blob) => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const blob = new Promise<Blob>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  try {
    const item = new ClipboardItem({ 'text/plain': blob })
    const done = clipboard.write([item]).then(() => true, () => false)
    return {
      cancel: () => fail?.(new Error('clipboard write cancelled')),
      write: (value: string) => {
        settle?.(new Blob([value], { type: 'text/plain' }))
        return done
      },
    }
  } catch {
    return undefined
  }
}

export async function writeReservedClipboard(value: string, reserved: ReservedClipboardWrite | undefined): Promise<boolean> {
  if (reserved) return reserved.write(value)
  return copyToClipboard(value)
}

function legacyCopy(value: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
  }
}
