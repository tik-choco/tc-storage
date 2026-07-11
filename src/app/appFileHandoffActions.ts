import type { Notice } from './appTypes.js'
import type { FileContentActions, MutableRef, SetState } from './appControllerTypes.js'
import { syncLog, syncWarn } from './appUtils.js'
import type { FileRecord } from '../storage/domain.js'
import { publishFileHandoff, type HandoffApp } from '../storage/fileHandoff.js'
import type { AppSettings } from '../storage/localSettings.js'
import { describeError } from '../util/errors.js'
import { dataUrlToBytes } from '../util/zip.js'

interface FileHandoffOptions {
  ensureFileContent: FileContentActions['ensureFileContent']
  setNotice: SetState<Notice>
  settingsRef: MutableRef<AppSettings>
  publishHandoff?: typeof publishFileHandoff
}

export interface FileHandoffActions {
  sendFileToApp: (file: FileRecord, app: HandoffApp) => Promise<void>
}

export function createFileHandoffActions(options: FileHandoffOptions): FileHandoffActions {
  const { ensureFileContent, setNotice, settingsRef, publishHandoff = publishFileHandoff } = options

  async function sendFileToApp(file: FileRecord, app: HandoffApp): Promise<void> {
    try {
      const fileWithContent = await ensureFileContent(file)
      if (!fileWithContent.dataUrl) throw new Error(`${file.name} の本文がローカルにありません`)
      const bytes = dataUrlToBytes(fileWithContent.dataUrl)
      syncLog('file handoff publish start', { fileId: file.id, fileName: file.name, app, bytes: bytes.byteLength })
      await publishHandoff({ app, file: { name: file.name, mimeType: file.mimeType }, bytes, nodeId: settingsRef.current.nodeId })
      syncLog('file handoff publish complete', { fileId: file.id, fileName: file.name, app })
      setNotice({ tone: 'success', text: `${file.name} を ${app} へ送信しました` })
    } catch (error) {
      syncWarn('file handoff publish failed', { fileId: file.id, fileName: file.name, app, error: describeError(error, 'unknown error') })
      setNotice({ tone: 'error', text: describeError(error, `${app} への送信に失敗しました`) })
    }
  }

  return { sendFileToApp }
}
