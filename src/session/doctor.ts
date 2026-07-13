import { execFileSync as defaultExecFileSync } from 'node:child_process'
import type { NativeModule } from '../native.js'
import type { SpawnBounded, SpawnResult } from './spawn.js'
import type { LegacyPolicyConfig } from './legacy-policy.js'

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface DoctorCheck {
  id: string
  status: DoctorStatus
  summary: string
  details?: Record<string, unknown>
  remediation?: string[]
}

/** Run host diagnostics with every external dependency supplied explicitly. */
export async function runDoctor(options: {
  native: NativeModule
  includeRemediation: boolean
  platform?: NodeJS.Platform
  arch?: string
  nodeVersion?: string
  now?: () => number
  spawnBounded: SpawnBounded
  runScript(language: string, script: string, timeoutMs: number): Promise<SpawnResult>
  getPowerShellExe(): string
  policyConfig: LegacyPolicyConfig
  policyStatus(): Record<string, unknown>
  auditEnabled: boolean
  auditLogPath: string
  execFileSync?: typeof defaultExecFileSync
}): Promise<Record<string, unknown>> {
  const platform = options.platform ?? process.platform
  const isMacos = platform === 'darwin'
  const isWindows = platform === 'win32'
  const executeFile = options.execFileSync ?? defaultExecFileSync
  const checks: DoctorCheck[] = []
  const add = (input: DoctorCheck) => {
    const check = { ...input }
    if (!options.includeRemediation) delete check.remediation
    checks.push(check)
  }
  const failure = (error: unknown) => error instanceof Error ? error.message : String(error)

  add({
    id: 'platform',
    status: isMacos || isWindows ? 'pass' : 'fail',
    summary: `${platform}-${options.arch ?? process.arch} on Node ${options.nodeVersion ?? process.version}`,
    remediation: ['Use macOS arm64/x64 or Windows x64 with Node.js 18+.'],
  })
  try {
    add({
      id: 'native_binary', status: 'pass',
      summary: 'Native NAPI module loaded and display APIs responded.',
      details: options.native.getDisplaySize(),
    })
  } catch (error) {
    add({
      id: 'native_binary', status: 'fail', summary: failure(error),
      remediation: ['Run npm run build for source checkouts, or reinstall @zavora-ai/computer-use-mcp for your platform.'],
    })
  }
  try {
    const shot = options.native.takeScreenshot(320, undefined, 80, undefined, undefined)
    add({
      id: 'display_capture', status: shot.base64 ? 'pass' : 'fail',
      summary: shot.base64 ? `Captured ${shot.width}x${shot.height}.` : 'Screenshot returned no image payload.',
      details: { width: shot.width, height: shot.height, mimeType: shot.mimeType },
      remediation: isMacos
        ? ['Open System Settings > Privacy & Security > Screen & System Audio Recording and enable your terminal, IDE, or agent host. Restart the host app afterwards.']
        : ['Run from an interactive desktop session. If using RDP/VMs, ensure Desktop Duplication or GDI capture is available.'],
    })
  } catch (error) {
    add({
      id: 'display_capture', status: 'fail', summary: failure(error),
      remediation: isMacos
        ? ['Open System Settings > Privacy & Security > Screen & System Audio Recording and enable your terminal, IDE, or agent host. Restart the host app afterwards.']
        : ['Run from an interactive desktop session. If using RDP/VMs, ensure Desktop Duplication or GDI capture is available.'],
    })
  }
  try {
    const marker = `computer-use-mcp-doctor-${(options.now ?? Date.now)()}`
    let saved = ''
    try {
      saved = isWindows && options.native.readClipboard
        ? options.native.readClipboard()
        : executeFile('pbpaste', []).toString()
    } catch { /* clipboard may be empty */ }
    let roundTrip: string
    if (isWindows && options.native.writeClipboard && options.native.readClipboard) {
      options.native.writeClipboard(marker)
      roundTrip = options.native.readClipboard()
      if (saved) options.native.writeClipboard(saved)
    } else {
      executeFile('pbcopy', [], { input: marker })
      roundTrip = executeFile('pbpaste', []).toString()
      executeFile('pbcopy', [], { input: saved })
    }
    add({
      id: 'clipboard', status: roundTrip === marker ? 'pass' : 'fail',
      summary: 'Clipboard read/write round trip completed.',
    })
  } catch (error) {
    add({
      id: 'clipboard', status: 'fail', summary: failure(error),
      remediation: ['Ensure the agent host can access the user clipboard and is running in an interactive desktop session.'],
    })
  }
  try {
    const frontmost = options.native.getFrontmostApp()
    const windows = options.native.listWindows(frontmost?.bundleId)
    add({
      id: isWindows ? 'ui_automation' : 'accessibility',
      status: frontmost ? 'pass' : 'warn',
      summary: frontmost ? `Frontmost app detected: ${frontmost.bundleId}.` : 'No frontmost app detected.',
      details: { frontmost, topLevelWindows: windows.length },
      remediation: isMacos
        ? ['Open System Settings > Privacy & Security > Accessibility and enable your terminal, IDE, or agent host. Restart the host app afterwards.']
        : ['UI Automation is built into Windows. If controls are missing, run the agent at the same integrity level as the target app.'],
    })
  } catch (error) {
    add({
      id: isWindows ? 'ui_automation' : 'accessibility', status: 'fail', summary: failure(error),
      remediation: isMacos
        ? ['Open System Settings > Privacy & Security > Accessibility and enable your terminal, IDE, or agent host. Restart the host app afterwards.']
        : ['Run the agent from an interactive desktop session and avoid crossing elevated/non-elevated integrity boundaries.'],
    })
  }
  if (isMacos) {
    const result = await options.runScript(
      'applescript', 'tell application "System Events" to count processes', 5_000,
    )
    add({
      id: 'automation', status: result.code === 0 ? 'pass' : 'warn',
      summary: result.code === 0
        ? 'System Events automation responded.'
        : (result.stderr || result.stdout || 'System Events automation did not respond.').trim(),
      remediation: ['Open System Settings > Privacy & Security > Automation and allow your terminal, IDE, or agent host to control System Events and target apps when prompted.'],
    })
  } else {
    add({ id: 'automation', status: 'skip', summary: 'macOS Automation permissions do not apply on Windows.' })
  }
  if (isWindows) {
    try {
      const executable = options.getPowerShellExe()
      const result = await options.spawnBounded(
        executable,
        ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
        5_000,
      )
      add({
        id: 'powershell', status: result.code === 0 ? 'pass' : 'fail',
        summary: result.code === 0 ? `${executable}: ${result.stdout.trim()}` : (result.stderr || result.stdout).trim(),
        remediation: ['Install PowerShell 7 or ensure Windows PowerShell is available on PATH.'],
      })
    } catch (error) {
      add({
        id: 'powershell', status: 'fail', summary: failure(error),
        remediation: ['Install PowerShell 7 or ensure Windows PowerShell is available on PATH.'],
      })
    }
  } else {
    add({ id: 'powershell', status: 'skip', summary: 'PowerShell is only required for Windows-specific scripting.' })
  }

  const config = options.policyConfig
  add({
    id: 'policy',
    status: config.approvalTokenConfigured
      || (!config.approvalRequiredForAll && config.requireApprovalFor.length === 0
        && !config.destructiveRequiresApproval)
      ? 'pass' : 'warn',
    summary: 'Policy configuration loaded.',
    details: options.policyStatus(),
    remediation: ['Set COMPUTER_USE_APPROVAL_TOKEN when enabling approval-gated tools. Use COMPUTER_USE_ALLOWED_APPS / COMPUTER_USE_BLOCKED_APPS to constrain app control.'],
  })
  add({
    id: 'audit', status: options.auditEnabled ? 'pass' : 'warn',
    summary: options.auditEnabled
      ? `Audit JSONL enabled at ${options.auditLogPath}.`
      : 'Audit logging disabled.',
    remediation: ['Set COMPUTER_USE_AUDIT_LOG=/path/to/audit.jsonl to enable structured audit logging, or COMPUTER_USE_AUDIT_LOG=false to disable explicitly.'],
  })
  try {
    const overlay = options.native.agentPointerOverlayStatus?.()
    add({
      id: 'native_agent_pointer_overlay', status: overlay ? 'pass' : 'warn',
      summary: overlay
        ? 'Native non-activating overlay pointer is available.'
        : 'Native overlay pointer is not exposed by this native binary.',
      details: overlay,
      remediation: ['Rebuild or reinstall the native module. The virtual pointer state and screenshot overlay remain available as a fallback.'],
    })
  } catch (error) {
    add({
      id: 'native_agent_pointer_overlay', status: 'warn', summary: failure(error),
      remediation: ['Rebuild or reinstall the native module. The virtual pointer state and screenshot overlay remain available as a fallback.'],
    })
  }

  const count = (status: DoctorStatus) => checks.filter(check => check.status === status).length
  return {
    ok: count('fail') === 0,
    summary: { passed: count('pass'), warned: count('warn'), failed: count('fail'), skipped: count('skip') },
    platform: {
      os: platform,
      arch: options.arch ?? process.arch,
      node: options.nodeVersion ?? process.version,
    },
    checks,
  }
}
