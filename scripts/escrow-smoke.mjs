import { spawn, execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createDidIdentity, publicDidIdentity } from '../dist-test/src/crypto/didIdentity.js'
import { makeFolder } from '../dist-test/src/storage/domain.js'

const root = resolve(import.meta.dirname, '..'),
  out = resolve(root, 'node_modules/.cache/escrow-smoke')
await mkdir(out, { recursive: true })
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const processes = []
const preview = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4179', '--strictPort'],
  { cwd: root, windowsHide: true, stdio: 'ignore' },
)
processes.push({ name: 'vite-preview', pid: preview.pid })
let chrome, socket
async function stop(child) {
  if (!child?.pid || child.exitCode !== null) return
  try {
    child.kill()
  } catch {}
  await new Promise((r) =>
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => r()),
  )
}
async function waitFor(fn) {
  for (let i = 0; i < 100; i++) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    await delay(100)
  }
  throw new Error('Smoke wait timed out')
}
try {
  console.log('Starting Vite preview PID ' + preview.pid)
  await waitFor(async () => (await fetch('http://127.0.0.1:4179', { signal: AbortSignal.timeout(500) })).ok)
  console.log('Preview ready')
  chrome = spawn(
    process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=9335',
      '--remote-debugging-address=127.0.0.1',
      '--window-size=1280,1000',
      '--lang=en',
      '--user-data-dir=' + resolve(out, 'chrome-profile'),
      'about:blank',
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let chromeLog = ''
  chrome.stderr.on('data', (d) => {
    chromeLog += d
  })
  chrome.on('close', (code) => {
    console.log('Chrome closed ' + code)
    void writeFile(resolve(out, 'chrome.log'), chromeLog)
  })
  console.log('Starting Chrome PID ' + chrome.pid)
  processes.push({ name: 'chrome-headless', pid: chrome.pid })
  await writeFile(resolve(out, 'processes.json'), JSON.stringify(processes, null, 2))
  const tabs = await waitFor(async () => {
    const r = await fetch('http://127.0.0.1:9335/json/list', { signal: AbortSignal.timeout(500) })
    const a = await r.json()
    return a.some((t) => t.type === 'page') ? a : undefined
  })
  console.log('CDP endpoint ready')
  const target = tabs.find((t) => t.type === 'page')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => {
    const timeout = setTimeout(() => j(new Error('CDP socket timed out')), 3000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout)
        r()
      },
      { once: true },
    )
    socket.addEventListener('error', j, { once: true })
  })
  let id = 0
  const pending = new Map(),
    exceptions = []
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id
      const timeout = setTimeout(() => {
        pending.delete(key)
        reject(new Error('CDP timed out: ' + method))
      }, 3000)
      pending.set(key, {
        resolve: (v) => {
          clearTimeout(timeout)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timeout)
          reject(e)
        },
      })
      socket.send(JSON.stringify({ id: key, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Page.enable')
  await send('Runtime.enable')
  const identity = await createDidIdentity(),
    now = new Date().toISOString()
  const folder = {
    ...makeFolder({
      id: 'folder-smoke',
      name: 'Escrow smoke',
      parentId: null,
      color: 'teal',
      roomId: 'tc-storage-main',
      now,
      nodeId: identity.did,
    }),
    shareEnabled: true,
  }
  const stored = {
    'tc-storage-did-identity-v1': JSON.stringify(identity),
    'tc-storage-settings-v1': JSON.stringify({
      nodeId: identity.did,
      identity: publicDidIdentity(identity),
      roomId: 'tc-storage-main',
      autoConnect: false,
      profileName: 'Smoke',
      avatarUrl: '',
      avatarFileId: '',
    }),
    'tc-storage-snapshot-v1': JSON.stringify({
      folders: [folder],
      files: [],
      activity: [],
      clock: 1,
      originNode: identity.did,
    }),
    'tc-storage-folder-keys-v1': JSON.stringify({ 'folder-smoke': 'smoke-secret' }),
    'tc-storage-onboarding-done-v1': '1',
  }
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      'if(location.origin==="http://127.0.0.1:4179"){localStorage.clear();for(const [k,v] of Object.entries(' +
      JSON.stringify(stored) +
      '))localStorage.setItem(k,v)}',
  })
  await send('Page.navigate', { url: 'http://127.0.0.1:4179/' })
  const shareSelector = '[data-select-id="folder-smoke"] button[title="Share folder"]'
  await waitFor(() => evaluate('Boolean(document.querySelector(' + JSON.stringify(shareSelector) + '))'))
  await evaluate('document.querySelector(' + JSON.stringify(shareSelector) + ').click()')
  const auto = await waitFor(() =>
    evaluate('document.querySelector(".escrow-settings input[readonly]")?.value || null'),
  )
  if (!/^tce-[a-f0-9]{24}$/.test(auto)) throw new Error('Invalid Auto room in panel: ' + auto)
  await evaluate(
    '(()=>{const select=document.querySelector(".escrow-settings select");select.value="custom";select.dispatchEvent(new Event("change",{bubbles:true}))})()',
  )
  await waitFor(() => evaluate('Boolean(document.querySelector(".escrow-settings input[maxlength]"))'))
  await evaluate(
    '(()=>{const input=document.querySelector(".escrow-settings input[maxlength]");input.value="smoke/custom";input.dispatchEvent(new Event("input",{bubbles:true}))})()',
  )
  await evaluate('document.querySelector(".escrow-settings label button").click()')
  await waitFor(() => evaluate('document.querySelector(".escrow-settings input[readonly]")?.value==="smoke/custom"'))
  await evaluate('document.querySelector(".escrow-settings").scrollIntoView({block:"center"})')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(resolve(out, 'panel.png'), Buffer.from(shot.data, 'base64'))
  await evaluate(
    '(()=>{const select=document.querySelector(".escrow-settings select");select.value="off";select.dispatchEvent(new Event("change",{bubbles:true}))})()',
  )
  await waitFor(() =>
    evaluate(
      'document.querySelector(".escrow-settings select")?.value==="off" && !document.querySelector(".escrow-settings input[readonly]")',
    ),
  )
  if (exceptions.length) throw new Error('Page exceptions: ' + JSON.stringify(exceptions))
  const result = {
    passed: true,
    autoRoom: auto,
    customRoom: 'smoke/custom',
    off: true,
    pageExceptions: 0,
    processes,
    screenshot: resolve(out, 'panel.png'),
  }
  await writeFile(resolve(out, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  socket?.close()
  await stop(chrome)
  await stop(preview)
  console.log('Stopped recorded Chrome and Vite PIDs: ' + processes.map((p) => p.pid).join(', '))
}
