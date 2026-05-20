import type { AppController } from '../useAppController.js'
import { BrowserPanel } from './BrowserPanel.js'
import { DeleteConfirmPanel } from './DeleteConfirmPanel.js'
import { FolderPanel } from './DetailPanel.js'
import { DraggablePopover } from './FloatingPopover.js'
import { ExpandedPreview, FileDetailPanel } from './Preview.js'
import { ProfilePanel, SettingsPanel } from './SettingsPanels.js'
import { Sidebar } from './Sidebar.js'
import { TopSummary } from './TopSummary.js'

interface AppLayoutProps {
  controller: AppController
}

export function AppLayout({ controller: c }: AppLayoutProps) {
  return (
    <main class="app-shell">
      <Sidebar
        avatarUrl={c.avatarUrl}
        currentFolderId={c.currentFolderId}
        dragItem={c.dragItem}
        dropTargetFolderId={c.dropTargetFolderId}
        snapshot={c.snapshot}
        onItemDragEnd={c.endItemDrag}
        onItemDragStart={c.beginItemDrag}
        onMoveTargetDragLeave={c.handleMoveTargetDragLeave}
        onMoveTargetDragOver={c.handleMoveTargetDragOver}
        onMoveTargetDrop={c.handleMoveTargetDrop}
        onOpenProfile={c.openProfile}
        onOpenSettings={c.openSettings}
        onSelectFolder={c.selectFolder}
      />
      <section class="main-column">
        <BrowserPanel
          busy={c.busy}
          currentFolder={c.currentFolder}
          currentFolderId={c.currentFolderId}
          dragActive={c.dragActive}
          dragItem={c.dragItem}
          dropTargetFolderId={c.dropTargetFolderId}
          fileDataUrls={c.fileDataUrls}
          fileRows={c.fileRows}
          folderNameDraft={c.folderNameDraft}
          folderRows={c.folderRows}
          pendingFolderShares={c.pendingFolderShares}
          files={c.files}
          query={c.query}
          reorderTarget={c.reorderTarget}
          snapshot={c.snapshot}
          selection={c.selection}
          viewMode={c.browserViewMode}
          onBrowserItemDragLeave={c.handleBrowserItemDragLeave}
          onBrowserItemDragOver={c.handleBrowserItemDragOver}
          onBrowserItemDrop={c.handleBrowserItemDrop}
          onCancelCreateFolder={c.cancelCreateFolder}
          onCancelPendingShare={c.cancelPendingShare}
          onConfirmCreateFolder={c.confirmCreateFolder}
          onCreateFolder={c.beginCreateFolder}
          onDownloadFile={(file) => void c.downloadStoredFile(file)}
          onDownloadFolder={(folder) => void c.downloadFolderAsZip(folder)}
          onDeleteFolder={c.requestDeleteFolder}
          onDeleteFile={c.requestDeleteFile}
          onDrag={c.handleDrag}
          onDrop={c.handleDrop}
          onFolderNameDraft={c.setFolderNameDraft}
          onItemDragEnd={c.endItemDrag}
          onItemDragStart={c.beginItemDrag}
          onMoveTargetDragLeave={c.handleMoveTargetDragLeave}
          onMoveTargetDragOver={c.handleMoveTargetDragOver}
          onMoveTargetDrop={c.handleMoveTargetDrop}
          onOpenFile={c.openFile}
          onOpenFolderPanel={c.openFolderPanel}
          onPreloadFile={c.preloadFileContent}
          onQuery={c.setQuery}
          onSaveFolder={(share) => void c.saveFolderToMist(share)}
          onSelectFolder={c.selectFolder}
          onShareFile={(file) => void c.shareFile(file)}
          onShowFileDetails={c.showFileDetails}
          onShowFolderDetails={c.showFolderDetails}
          onUploadFiles={(list) => void c.uploadFiles(list)}
          onViewMode={c.setBrowserViewMode}
        />
      </section>
      <TopSummary currentFolderName={c.currentFolder?.name ?? null} currentFolderStorageUsed={c.currentFolderStorageUsed} downloadProgress={c.downloadProgress} networkState={c.networkState} notice={c.notice} storageUsed={c.storageUsed} />
      {renderFolderPanel(c)}
      {renderProfilePanel(c)}
      {renderSettingsPanel(c)}
      {renderFileDetailPanel(c)}
      {renderDeleteConfirmPanel(c)}
      {c.expandedPreviewOpen && c.selectedPreviewFile ? (
        <ExpandedPreview
          file={c.selectedPreviewFile}
          files={c.previewFilesWithContent}
          index={c.selectedFileIndex}
          loadingProgressByFileId={c.fileLoadProgress}
          loadingProgress={c.selectedPreviewProgress}
          total={c.previewFiles.length}
          onClose={() => c.setExpandedPreviewOpen(false)}
          onPrevious={() => c.movePreview(-1)}
          onNext={() => c.movePreview(1)}
          onDownload={(file) => void c.downloadStoredFile(file)}
          onPreloadFile={c.preloadFileContent}
        />
      ) : null}
    </main>
  )
}

function renderFolderPanel(c: AppController) {
  if (!c.folderPanelOpen) return null
  return (
    <div class="floating-popover-layer" onMouseDown={() => c.setFolderPanelOpen(false)}>
      <DraggablePopover className="folder-popover" position={c.popoverPositions.folder} onMove={(position) => c.movePopover('folder', position)}>
        <FolderPanel
          folder={c.folderPanelFolder}
          shareUrl={c.folderShareUrl}
          syncPeers={c.folderPanelPeers}
          onCopy={c.copyText}
          onDownloadFolder={(folder) => void c.downloadFolderAsZip(folder)}
          onDeleteFolder={c.deleteCurrentFolder}
          onPatchFolder={c.patchCurrentFolder}
        />
      </DraggablePopover>
    </div>
  )
}

function renderProfilePanel(c: AppController) {
  if (!c.profileOpen) return null
  return (
    <div class="floating-popover-layer" onMouseDown={() => c.setProfileOpen(false)}>
      <DraggablePopover className="profile-popover" position={c.popoverPositions.profile} onMove={(position) => c.movePopover('profile', position)}>
        <ProfilePanel
          avatarImages={c.profileAvatarImages}
          avatarPreviewUrl={c.draftAvatarUrl}
          draft={c.settingsDraft}
          onDraft={c.setSettingsDraft}
          onClose={() => c.setProfileOpen(false)}
          onOpenAvatarImages={c.openProfileAvatarImages}
          onSave={c.saveProfileDraft}
          onSelectAvatarImage={c.selectProfileAvatarImage}
        />
      </DraggablePopover>
    </div>
  )
}

function renderSettingsPanel(c: AppController) {
  if (!c.settingsOpen) return null
  return (
    <div class="floating-popover-layer" onMouseDown={() => c.setSettingsOpen(false)}>
      <DraggablePopover className="settings-popover" position={c.popoverPositions.settings} onMove={(position) => c.movePopover('settings', position)}>
        <SettingsPanel
          draft={c.settingsDraft}
          onDraft={c.setSettingsDraft}
          onClose={() => c.setSettingsOpen(false)}
          onSave={c.saveSettingsDraft}
        />
      </DraggablePopover>
    </div>
  )
}

function renderFileDetailPanel(c: AppController) {
  if (!c.detailFileWithContent) return null
  return (
    <div class="floating-popover-layer" onMouseDown={() => c.setDetailFileId(null)}>
      <DraggablePopover className="file-detail-popover" position={c.popoverPositions.detail} onMove={(position) => c.movePopover('detail', position)}>
        <FileDetailPanel
          file={c.detailFileWithContent}
          busy={c.busy === `file-share-${c.detailFileWithContent.id}`}
          shareKey={c.fileShareKeys[c.detailFileWithContent.id] ?? ''}
          shareUrl={c.fileShareUrl}
          syncPeers={c.detailFolderPeers}
          onClose={() => c.setDetailFileId(null)}
          onCopy={c.copyText}
          onDownload={(file) => void c.downloadStoredFile(file)}
          onDelete={c.requestDeleteFile}
          onRename={c.renameFile}
          onShare={(file) => void c.shareFile(file)}
        />
      </DraggablePopover>
    </div>
  )
}

function renderDeleteConfirmPanel(c: AppController) {
  if (!c.deleteRequest) return null
  return (
    <div class="floating-popover-layer" onMouseDown={() => c.setDeleteRequest(null)}>
      <div class="floating-popover confirm-popover centered-popover" onMouseDown={(event) => event.stopPropagation()}>
        <div class="floating-popover-content">
        <DeleteConfirmPanel request={c.deleteRequest} onCancel={() => c.setDeleteRequest(null)} onConfirm={c.confirmDelete} />
        </div>
      </div>
    </div>
  )
}
