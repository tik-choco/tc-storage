import { defineConfig, loadEnv } from 'vite'
import type { Connect, Plugin, ViteDevServer } from 'vite'
import preact from '@preact/preset-vite'

const noopViteClientModule = `
import "/@vite/env";

const sheets = new Map()

export const createHotContext = () => ({
  data: {},
  accept() {},
  acceptExports() {},
  dispose() {},
  prune() {},
  decline() {},
  invalidate() {},
  on() {},
  off() {},
  send() {},
})

export const updateStyle = (id, content) => {
  let style = sheets.get(id)
  if (!style) {
    style = document.createElement('style')
    style.setAttribute('type', 'text/css')
    style.setAttribute('data-vite-dev-id', id)
    document.head.appendChild(style)
    sheets.set(id, style)
  }
  style.textContent = content
}

export const removeStyle = (id) => {
  const style = sheets.get(id)
  if (style) {
    style.remove()
    sheets.delete(id)
  }
}
`

const noopViteHmrClientPlugin = (): Plugin => ({
  name: 'tc-storage:no-vite-hmr-client',
  enforce: 'pre',
  configureServer(server: ViteDevServer) {
    const handle: Connect.NextHandleFunction = (req, res, next) => {
      if (req.url?.split('?')[0] !== '/@vite/client') {
        next()
        return
      }

      res.setHeader('Content-Type', 'text/javascript')
      res.end(noopViteClientModule)
    }

    server.middlewares.use(handle)
  },
  resolveId(id: string) {
    return id === '/@vite/client' || id === '@vite/client'
      ? '\0tc-storage:no-vite-hmr-client'
      : null
  },
  load(id: string) {
    return id === '\0tc-storage:no-vite-hmr-client'
      ? noopViteClientModule
      : null
  },
})

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const hmrEnabled = env.VITE_HMR_ENABLED !== 'false'
  const hmrHost = env.VITE_HMR_HOST
  const hmrProtocol = env.VITE_HMR_PROTOCOL
  const hmrClientPort = env.VITE_HMR_CLIENT_PORT
    ? Number(env.VITE_HMR_CLIENT_PORT)
    : undefined
  const base = env.VITE_BASE_PATH || '/'

  return {
    base,
    plugins: [
      !hmrEnabled && noopViteHmrClientPlugin(),
      preact(),
    ].filter(Boolean),
    server: {
      allowedHosts: hmrHost ? [hmrHost] : true,
      hmr: !hmrEnabled
        ? false
        : hmrHost
        ? {
            host: hmrHost,
            protocol: hmrProtocol === 'ws' ? 'ws' : 'wss',
            clientPort: hmrClientPort,
          }
        : undefined,
    },
  }
})
