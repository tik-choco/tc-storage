import { render } from 'preact'
import { App } from './app.js'
import { registerServiceWorker } from './pwa.js'
import './styles.css'

render(<App />, document.getElementById('app')!)
registerServiceWorker()
