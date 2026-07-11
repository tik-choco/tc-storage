import { useMemo, useRef, useState, type Dispatch, type StateUpdater } from 'preact/hooks'
import type { Notice } from '../app/appTypes.js'
import { withoutRecordKey } from '../app/appUtils.js'
import type { FileRecord } from '../storage/domain.js'
import { describeError } from '../util/errors.js'
import type { AppSettings } from '../storage/localSettings.js'

interface ProfileAvatarPickerOptions {
  canResolveFileContent: (file: FileRecord) => boolean
  ensureFileContent: (file: FileRecord) => Promise<FileRecord>
  fileContentCacheRef: { current: Record<string, string> }
  fileDataUrls: Record<string, string>
  preloadFileContent: (file: FileRecord) => void
  profileImageFiles: FileRecord[]
  selectedAvatarFileId: string
  setNotice: Dispatch<StateUpdater<Notice>>
  setSettingsDraft: Dispatch<StateUpdater<AppSettings>>
}

export function useProfileAvatarPicker({
  canResolveFileContent,
  ensureFileContent,
  fileContentCacheRef,
  fileDataUrls,
  preloadFileContent,
  profileImageFiles,
  selectedAvatarFileId,
  setNotice,
  setSettingsDraft,
}: ProfileAvatarPickerOptions) {
  const [avatarImageBusyId, setAvatarImageBusyId] = useState('')
  const [avatarImageProgress, setAvatarImageProgress] = useState<Record<string, number>>({})
  const avatarImageLoadRequestRef = useRef(0)

  const profileAvatarImages = useMemo(() => profileImageFiles.map((file) => ({
    busy: avatarImageBusyId === file.id,
    dataUrl: fileDataUrls[file.id] ?? '',
    id: file.id,
    name: file.name,
    progress: avatarImageProgress[file.id] ?? 0,
    selected: selectedAvatarFileId === file.id,
  })), [avatarImageBusyId, avatarImageProgress, fileDataUrls, profileImageFiles, selectedAvatarFileId])

  function openProfileAvatarImages(): void {
    for (const file of profileImageFiles.filter(canResolveFileContent).slice(0, 18)) {
      if (file.dataUrl || fileContentCacheRef.current[file.id]) continue
      preloadFileContent(file)
    }
  }

  function selectProfileAvatarImage(fileId: string): void {
    const file = profileImageFiles.find((item) => item.id === fileId)
    if (!file) return
    const requestId = avatarImageLoadRequestRef.current + 1
    avatarImageLoadRequestRef.current = requestId
    setSettingsDraft((current) => ({ ...current, avatarFileId: file.id, avatarUrl: '' }))
    if (file.dataUrl || fileContentCacheRef.current[file.id]) {
      setAvatarImageProgress((current) => withoutRecordKey(current, file.id))
      return
    }
    const stopProgress = startAvatarImageProgress(file.id, requestId)
    setAvatarImageBusyId(file.id)
    updateAvatarImageProgress(file.id, 0, requestId)
    void ensureFileContent(file).then(() => {
      stopProgress()
      updateAvatarImageProgress(file.id, 100, requestId)
      if (avatarImageLoadRequestRef.current === requestId) setNotice({ tone: 'success', text: 'アイコン画像を選択しました' })
    }).catch((error) => {
      stopProgress()
      setSettingsDraft((current) => current.avatarFileId === file.id ? { ...current, avatarFileId: '' } : current)
      setAvatarImageProgress((current) => withoutRecordKey(current, file.id))
      if (avatarImageLoadRequestRef.current === requestId) setNotice({ tone: 'error', text: describeError(error, 'アイコン画像を読み込めませんでした') })
    }).finally(() => {
      if (avatarImageLoadRequestRef.current === requestId) setAvatarImageBusyId('')
      window.setTimeout(() => setAvatarImageProgress((current) => withoutRecordKey(current, file.id)), 900)
    })
  }

  function startAvatarImageProgress(fileId: string, requestId: number): () => void {
    const steps = [14, 28, 43, 57, 71, 84, 92]
    let index = 0
    const timer = window.setInterval(() => {
      if (avatarImageLoadRequestRef.current !== requestId) {
        window.clearInterval(timer)
        return
      }
      const progress = steps[Math.min(index, steps.length - 1)] ?? 92
      updateAvatarImageProgress(fileId, progress, requestId)
      index += 1
    }, 350)
    return () => window.clearInterval(timer)
  }

  function updateAvatarImageProgress(fileId: string, progress: number, requestId: number): void {
    setAvatarImageProgress((current) => ({ ...current, [fileId]: progress }))
    if (avatarImageLoadRequestRef.current === requestId && progress < 100) {
      setNotice({ tone: 'info', text: `アイコン画像を読み込み中... ${progress}%` })
    }
  }

  return { openProfileAvatarImages, profileAvatarImages, selectProfileAvatarImage }
}
