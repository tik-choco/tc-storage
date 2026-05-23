import { useRef, useState } from 'preact/hooks'
import type { DownloadProgress, ProgressStatus } from './appTypes.js'
import type { FileRecord } from './domain.js'
import { withoutRecordKey } from './appUtils.js'

type DownloadTarget = Pick<FileRecord, 'id' | 'name'>

export function useTransferProgress() {
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
  const [fileLoadProgress, setFileLoadProgress] = useState<Record<string, ProgressStatus>>({})
  const downloadRequestRef = useRef(0)

  function startDownloadProgress(file: DownloadTarget, cached: boolean): number {
    const requestId = downloadRequestRef.current + 1
    downloadRequestRef.current = requestId
    setDownloadProgress({ fileId: file.id, fileName: file.name, label: cached ? 'Preparing' : 'Loading' })
    return requestId
  }

  function updateDownloadProgress(file: DownloadTarget, percent: number, requestId: number, label = 'Preparing'): void {
    if (downloadRequestRef.current !== requestId) return
    setDownloadProgress((current) => (
      current?.fileId === file.id
        ? { ...current, label, percent: Math.max(current.percent ?? 0, Math.min(99, Math.round(percent))) }
        : current
    ))
  }

  function finishDownloadProgress(_file: DownloadTarget, requestId: number): void {
    if (downloadRequestRef.current !== requestId) return
    setDownloadProgress(null)
  }

  function failDownloadProgress(requestId: number): void {
    if (downloadRequestRef.current !== requestId) return
    window.setTimeout(() => {
      if (downloadRequestRef.current === requestId) setDownloadProgress(null)
    }, 900)
  }

  function startFileLoadProgress(file: FileRecord): string {
    setFileLoadProgress((current) => ({ ...current, [file.id]: { label: 'Loading' } }))
    return file.id
  }

  function finishFileLoadProgress(fileId: string): void {
    setFileLoadProgress((current) => withoutRecordKey(current, fileId))
  }

  function failFileLoadProgress(fileId: string): void {
    window.setTimeout(() => setFileLoadProgress((current) => withoutRecordKey(current, fileId)), 650)
  }

  return {
    downloadProgress,
    failDownloadProgress,
    failFileLoadProgress,
    fileLoadProgress,
    finishDownloadProgress,
    finishFileLoadProgress,
    startDownloadProgress,
    startFileLoadProgress,
    updateDownloadProgress,
  }
}
