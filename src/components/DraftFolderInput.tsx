import { useEffect, useRef } from 'preact/hooks'

export function DraftFolderInput(props: {
  name: string
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <input ref={inputRef} value={props.name} onInput={(event) => props.onChange(event.currentTarget.value)} onKeyDown={props.onKeyDown} placeholder="Folder name" />
  )
}
