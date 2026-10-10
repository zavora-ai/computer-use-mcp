/**
 * Optional, first-party Windows desktop status panel.
 *
 * Displays tool activity without replacing any MCP/native input code.
 * The local UI may pause or stop NEW desktop mutations and abort a currently
 * running operation where the handler supports AbortSignal cancellation.
 * Never creates a network listener and never reads a foreign user's session.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type OverlayMode = 'running' | 'paused' | 'stopped'
export type OverlayStep = { label: string; outcome: 'active' | 'done' | 'failed' }

export class WindowsStatusOverlay {
  private readonly directory: string
  private readonly stateFile: string
  private readonly controlFile: string
  private readonly startedAt = Date.now()
  private child?: ChildProcess
  private timer?: ReturnType<typeof setInterval>
  private currentMode: OverlayMode = 'running'
  private activeController = new AbortController()
  private active = 0
  private steps: OverlayStep[] = []
  private closed = false
  private lastState = ''

  constructor(private readonly launch: boolean = true) {
    this.directory = mkdtempSync(join(tmpdir(), 'computer-use-status-'))
    this.stateFile = join(this.directory, 'state.json')
    this.controlFile = join(this.directory, 'control.txt')
    writeFileSync(this.controlFile, 'running', { mode: 0o600 })
    this.publish()
  }

  /** Does not start PowerShell until an actual desktop tool is used. */
  private ensureVisible(): void {
    if (!this.launch || this.child || this.closed) return
    const script = fileURLToPath(new URL('../libexec/windows-status-overlay.ps1', import.meta.url))
    const child = spawn('powershell.exe',
      ['-NoLogo', '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-File', script, this.directory],
      { windowsHide: true, stdio: 'ignore' })
    this.child = child
    child.on('error', () => { /* overlay is optional: never break desktop tools */ })
    this.timer = setInterval(() => this.refreshControl(), 150)
    this.timer.unref()
  }

  private refreshControl(): void {
    if (this.closed) return
    let value: string
    try { value = readFileSync(this.controlFile, 'utf8').trim().toLowerCase() }
    catch { return }
    if (value !== 'running' && value !== 'paused' && value !== 'stopped') return
    if (value === this.currentMode) return
    this.currentMode = value
    if (value !== 'running') this.activeController.abort(new Error('Desktop control ' + value + ' by local user'))
    else this.activeController = new AbortController()
    this.publish()
  }

  /** Return a local-control veto; read-only observation is never blocked. */
  check(mutation: boolean): string | undefined {
    this.refreshControl()
    return mutation && this.currentMode !== 'running' ? this.currentMode + '_by_user' : undefined
  }

  get signal(): AbortSignal {
    this.refreshControl()
    return this.activeController.signal
  }

  begin(tool: string): void {
    this.ensureVisible()
    this.refreshControl()
    ++this.active
    this.steps.push({ label: friendlyToolName(tool), outcome: 'active' })
    this.steps = this.steps.slice(-4)
    this.publish()
  }

  finish(failed: boolean): void {
    this.active = Math.max(0, this.active - 1)
    const step = [...this.steps].reverse().find(s => s.outcome === 'active')
    if (step) step.outcome = failed ? 'failed' : 'done'
    this.publish()
  }

  private publish(): void {
    const payload = JSON.stringify({
      mode: this.currentMode, active: this.active, startedAt: this.startedAt,
      steps: this.steps, description: this.steps.at(-1)?.label ?? 'Ready',
    })
    if (payload === this.lastState) return
    try {
      const tmp = this.stateFile + '.tmp'
      writeFileSync(tmp, payload, { mode: 0o600 })
      renameSync(tmp, this.stateFile)
      this.lastState = payload
    } catch { /* optional panel must not change MCP results */ }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.currentMode = 'stopped'
    this.activeController.abort(new Error('Desktop session closed'))
    if (this.timer) clearInterval(this.timer)
    try { writeFileSync(this.controlFile, 'stopped') } catch { /* optional UI */ }
    try { this.child?.kill() } catch { /* process may already have exited */ }
    try { rmSync(this.directory, { recursive: true, force: true }) } catch { /* remove on next startup */ }
  }
}

export function friendlyToolName(tool: string): string {
  if (/screenshot|zoom|capture|ui_tree|read_window|find_element|list_window/.test(tool)) return 'Inspecting the screen'
  if (/click|select|press_button|menu_item/.test(tool)) return 'Selecting'
  if (/type|key|fill|set_value|edit/.test(tool)) return 'Typing'
  if (/scroll|drag|mouse_move|agent_pointer/.test(tool)) return 'Navigating'
  if (/open|activate|launch|window/.test(tool)) return 'Opening an app'
  return tool.replace(/_/g, ' ').slice(0,42)
}
