import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emergencyResetCommand, sanitizeSupervisorMessage } from './model.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const socketPath = process.env.COMPUTER_USE_SUPERVISOR_SOCKET
const token = process.env.COMPUTER_USE_SUPERVISOR_TOKEN
const principalId = process.env.COMPUTER_USE_PRINCIPAL_ID ?? 'local-user'
const sessionId = process.env.COMPUTER_USE_SESSION_ID
if (!socketPath || !token || !sessionId) {
  throw new Error('COMPUTER_USE_SUPERVISOR_SOCKET, _TOKEN, and _SESSION_ID are required')
}

let window
let socket
let buffer = ''

function send(message) {
  if (!socket || socket.destroyed) throw new Error('supervisor socket is disconnected')
  socket.write(`${JSON.stringify(message)}\n`)
}

function connectSupervisor() {
  socket = createConnection(socketPath)
  socket.setEncoding('utf8')
  socket.on('connect', () => send({ type: 'hello', token, principalId }))
  socket.on('data', chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) return socket.destroy(new Error('supervisor frame too large'))
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.type === 'hello') send({ type: 'subscribe', sessionId, afterSequence: 0 })
      window?.webContents.send('supervisor:event', sanitizeSupervisorMessage(message))
    }
  })
  socket.on('close', () => window?.webContents.send(
    'supervisor:event', sanitizeSupervisorMessage({ type: 'disconnected' }),
  ))
  socket.on('error', error => window?.webContents.send('supervisor:event', {
    ...sanitizeSupervisorMessage({ type: 'error', error: 'socket_error', message: error.message }),
  }))
}

function registerControls() {
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

app.whenReady().then(() => {
  registerControls()
  window = new BrowserWindow({
    width: 440, height: 720, minWidth: 360, minHeight: 480,
    alwaysOnTop: true, title: 'Computer Use', show: false,
    webPreferences: {
      preload: join(here, 'preload.mjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true,
    },
  })
  window.setAlwaysOnTop(true, 'floating')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', event => event.preventDefault())
  void window.loadFile(join(here, 'renderer.html'))
  window.once('ready-to-show', () => window.showInactive())
  connectSupervisor()
})

app.on('before-quit', () => socket?.destroy())
app.on('window-all-closed', () => app.quit())
