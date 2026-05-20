import { AppLayout } from './components/AppLayout.js'
import { useAppController } from './useAppController.js'

export function App() {
  return <AppLayout controller={useAppController()} />
}
