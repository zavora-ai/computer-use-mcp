import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRendererDeliveryGate, emergencyResetCommand, sanitizeSupervisorMessage } from './model.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const socketPath = process.env.COMPUTER_USE_SUPERVISOR_SOCKET
const token = process.env.COMPUTER_USE_SUPERVISOR_TOKEN
const principalId = process.env.COMPUTER_USE_PRINCIPAL_ID ?? 'local-user'
const sessionId = process.env.COMPUTER_USE_SESSION_ID
const debugEnabled = process.env.COMPUTER_USE_SUPERVISOR_DEBUG === 'true'
if (!socketPath || !token || !sessionId) {
  throw new Error('COMPUTER_USE_SUPERVISOR_SOCKET, _TOKEN, and _SESSION_ID are required')
}

let window
let socket
let buffer = ''
const rendererGate = createRendererDeliveryGate(message => {
  window?.webContents.send('supervisor:event', message)
})

function debug(message) {
  if (debugEnabled) console.error(`[computer-use-supervisor] ${message}`)
}

function deliverToRenderer(message) {
  const safe = sanitizeSupervisorMessage(message)
  const delivered = rendererGate.push(safe)
  debug(`${delivered ? 'delivered' : 'buffered'} renderer message type=${safe.type}`)
}

function send(message) {
  if (!socket || socket.destroyed) throw new Error('supervisor socket is disconnected')
  socket.write(`${JSON.stringify(message)}\n`)
}

function connectSupervisor() {
  debug('opening local supervisor socket')
  socket = createConnection(socketPath)
  socket.setEncoding('utf8')
  socket.on('connect', () => {
    debug('socket connected; sending authenticated hello')
    send({ type: 'hello', token, principalId })
  })
  socket.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) return socket.destroy(new Error('supervisor frame too large'))
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      debug(`received socket message type=${String(message.type ?? 'unknown')}`)
      if (message.type === 'hello') {
        debug('hello accepted; subscribing to session replay')
        send({ type: 'subscribe', sessionId, afterSequence: 0 })
      }
      deliverToRenderer(message)
    }
  })
  socket.on('close', () => {
    debug('socket closed')
    deliverToRenderer({ type: 'disconnected' })
  })
  socket.on('error', error => {
    debug(`socket error code=${String(error.code ?? 'unknown')}`)
    deliverToRenderer({ type: 'error', error: 'socket_error', message: error.message })
  })
}

function registerControls() {
  ipcMain.handle('supervisor:renderer-ready', () => {
    const flushed = rendererGate.ready()
    debug(`renderer ready; flushed ${flushed} buffered messages`)
    return { ready: true }
  })
  const commands = new Set(['pause', 'resume', 'takeover', 'stop'])
  ipcMain.handle('supervisor:command', (_event, command, payload = {}) => {
    if (!commands.has(command)) throw new Error('unsupported supervisor command')
    send({ type: command, sessionId, ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}) })
  })
  ipcMain.handle('supervisor:approve', (_event, actionId, scope = 'exact_action') => {
    if (typeof actionId !== 'string' || !actionId) throw new Error('actionId is required')
    if (scope !== 'exact_action' && scope !== 'session_operation') throw new Error('unsupported approval scope')
    send({
      type: 'approve', sessionId, actionId, scope,
      ttlMs: scope === 'session_operation' ? 120_000 : 60_000,
      ...(scope === 'session_operation' ? { uses: 10 } : {}),
    })
  })
  ipcMain.handle('supervisor:get-frame', (_event, frameId) => {
    if (typeof frameId !== 'string' || !frameId || frameId.length > 128) throw new Error('frameId is required')
    send({ type: 'get_frame', sessionId, frameId })
  })
  ipcMain.handle('supervisor:emergency-stop', () => send({ type: 'emergency_stop', reason: 'pip_emergency_stop' }))
  ipcMain.handle('supervisor:emergency-reset', async () => {
    const choice = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Reset emergency stop?',
      message: 'This will allow computer mutations again.',
      detail: 'Reset only after you have inspected the task and it is safe to continue.',
      buttons: ['Keep stopped', 'Reset emergency stop'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    const command = emergencyResetCommand(choice)
    if (!command) return { reset: false }
    send(command)
    return { reset: true }
  })
}

app.whenReady().then(async () => {
  debug('electron ready; creating PiP window')
  registerControls()
  window = new BrowserWindow({
    width: 440, height: 720, minWidth: 360, minHeight: 480,
    alwaysOnTop: true, title: 'Computer Use', show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true,
    },
  })
  window.setAlwaysOnTop(true, 'floating')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.webContents.on('console-message', (_event, details) => {
    const message = typeof details === 'object' ? details.message : String(details)
    debug(`renderer console: ${String(message).slice(0, 500)}`)
  })
  window.webContents.on('preload-error', (_event, _preloadPath, error) => {
    debug(`preload error: ${String(error?.message ?? error).slice(0, 500)}`)
  })
  window.webContents.on('did-fail-load', (_event, code, description) => {
    debug(`load failed code=${code} description=${String(description).slice(0, 200)}`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    debug(`renderer gone reason=${String(details?.reason ?? 'unknown')}`)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.once('ready-to-show', () => {
    debug('PiP ready to show')
    window.showInactive()
  })
  // Connect only after the isolated renderer has installed its preload event
  // listener. Otherwise the initial hello/subscription replay can arrive while
  // the document is loading and leave PiP permanently showing "connecting".
  await window.loadFile(join(here, 'renderer.html'))
  debug('PiP document loaded')
  connectSupervisor()
})

app.on('before-quit', () => socket?.destroy())
app.on('window-all-closed', () => app.quit())
