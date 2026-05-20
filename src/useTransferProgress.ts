import { useEffect, useRef, useState } from 'preact/hooks'
import type { DownloadProgress } from './appTypes.js'
import type { FileRecord } from './domain.js'
import { withoutRecordKey } from './appUtils.js'

type DownloadTarget = Pick<FileRecord, 'id' | 'name'>

export function useTransferProgress() {
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
  const [fileLoadProgress, setFileLoadProgress] = useState<Record<string, number>>({})
  const downloadRequestRef = useRef(0)
  const downloadTimerRef = useRef<number | null>(null)
  const fileLoadTimersRef = useRef<Record<string, number>>({})

  useEffect(() => () => {
    clearDownloadTimer()
    clearFileLoadTimers()
  }, [])

  function startDownloadProgress(file: DownloadTarget, cached: boolean): number {
    const requestId = downloadRequestRef.current + 1
    downloadRequestRef.current = requestId
    clearDownloadTimer()
    const steps = cached ? [84, 94] : [8, 16, 25, 34, 44, 55, 66, 76, 85, 92, 96]
    let index = 0
    setDownloadProgress({ fileId: file.id, fileName: file.name, percent: cached ? 72 : 4 })
    downloadTimerRef.current = window.setInterval(() => {
      if (downloadRequestRef.current !== requestId) {
        clearDownloadTimer()
        return
      }
      const percent = steps[Math.min(index, steps.length - 1)] ?? 96
      updateDownloadProgress(file, percent, requestId)
      index += 1
    }, 360)
    return requestId
  }

  function updateDownloadProgress(file: DownloadTarget, percent: number, requestId: number): void {
    if (downloadRequestRef.current !== requestId) return
    setDownloadProgress((current) => (
      current?.fileId === file.id
        ? { ...current, percent: Math.max(current.percent, Math.min(100, Math.round(percent))) }
        : current
    ))
  }

  function finishDownloadProgress(file: DownloadTarget, requestId: number): void {
    if (downloadRequestRef.current !== requestId) return
    clearDownloadTimer()
    setDownloadProgress({ fileId: file.id, fileName: file.name, percent: 100 })
    window.setTimeout(() => {
      if (downloadRequestRef.current === requestId) setDownloadProgress(null)
    }, 1000)
  }

  function failDownloadProgress(requestId: number): void {
    if (downloadRequestRef.current !== requestId) return
    clearDownloadTimer()
    window.setTimeout(() => {
      if (downloadRequestRef.current === requestId) setDownloadProgress(null)
    }, 900)
  }

  function startFileLoadProgress(file: FileRecord): string {
    clearFileLoadTimer(file.id)
    const steps = [7, 15, 24, 34, 45, 57, 68, 78, 87, 93, 96]
    let index = 0
    setFileLoadProgress((current) => ({ ...current, [file.id]: 3 }))
    fileLoadTimersRef.current[file.id] = window.setInterval(() => {
      const percent = steps[Math.min(index, steps.length - 1)] ?? 96
      setFileLoadProgress((current) => ({ ...current, [file.id]: Math.max(current[file.id] ?? 0, percent) }))
      index += 1
    }, 360)
    return file.id
  }

  function finishFileLoadProgress(fileId: string): void {
    clearFileLoadTimer(fileId)
    setFileLoadProgress((current) => ({ ...current, [fileId]: 100 }))
    window.setTimeout(() => {
      setFileLoadProgress((current) => current[fileId] === 100 ? withoutRecordKey(current, fileId) : current)
    }, 650)
  }

  function failFileLoadProgress(fileId: string): void {
    clearFileLoadTimer(fileId)
    window.setTimeout(() => setFileLoadProgress((current) => withoutRecordKey(current, fileId)), 650)
  }

  function clearDownloadTimer(): void {
    if (downloadTimerRef.current === null) return
    window.clearInterval(downloadTimerRef.current)
    downloadTimerRef.current = null
  }

  function clearFileLoadTimer(fileId: string): void {
    const timer = fileLoadTimersRef.current[fileId]
    if (timer === undefined) return
    window.clearInterval(timer)
    delete fileLoadTimersRef.current[fileId]
  }

  function clearFileLoadTimers(): void {
    for (const fileId of Object.keys(fileLoadTimersRef.current)) clearFileLoadTimer(fileId)
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
