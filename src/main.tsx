import { render } from 'preact'
import { App } from './app.js'
import { registerServiceWorker } from './pwa.js'
import './styles.css'
import { writeAppManifest } from './storage/appManifest.js'
import { BUS_VERSION } from './storage/sharedBus.js'
import { applyThemePreference, loadThemePreference } from './storage/theme.js'

applyThemePreference(loadThemePreference())
render(<App />, document.getElementById('app')!)
registerServiceWorker()

// protocol の app-manifest.md 参照: 他アプリからの自己申告キャッシュとして起動を記録する
writeAppManifest({
  app: 'tc-storage',
  busVersion: BUS_VERSION,
  publishes: ['drive-index', 'pdf-viewer-inbox', 'note-inbox'],
  consumes: ['translations-inbox', 'folder-export', 'storage-drive-inbox', 'note-doc-index', 'books-backup'],
  reads: [],
})
