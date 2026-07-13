import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash, type Hash } from 'node:crypto'
import { fsRootsViolation } from './fs-jail.js'
import type { SpawnBounded } from './spawn.js'
import { errJson, ok, type ToolResult } from '../result.js'

export interface AdminHandlerContext {
  platform?: NodeJS.Platform
  homeDirectory?: string
  spawnBounded: SpawnBounded
  getPowerShellExe(): string
  signal?: AbortSignal
  onProgress?: (update: { progress: number; total?: number; message?: string }) => void
  fetch?: typeof globalThis.fetch
}

function requiredString(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new Error(`Invalid ${key}: expected string`)
  return args[key]
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function powershellEncodedArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function framedHash(hash: Hash, kind: string, value: string | Buffer): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  hash.update(kind).update('\0').update(String(bytes.length)).update(':').update(bytes)
}

function fileContentDigest(filePath: string, signal?: AbortSignal): string {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('filesystem digest aborted')
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (length === 0) break
      hash.update(buffer.subarray(0, length))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return `sha256:${hash.digest('hex')}`
}

/** Canonical, path-independent digest for a directory tree or symlink. */
function filesystemContentDigest(filePath: string, signal?: AbortSignal): string {
  const root = fs.lstatSync(filePath)
  if (root.isFile()) return fileContentDigest(filePath, signal)
  const hash = createHash('sha256')
  const visit = (absolute: string, relative: string): void => {
    if (signal?.aborted) throw signal.reason ?? new Error('filesystem digest aborted')
    const stat = fs.lstatSync(absolute)
    if (stat.isDirectory()) {
      framedHash(hash, 'directory', relative)
      const names = fs.readdirSync(absolute)
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      for (const name of names) visit(path.join(absolute, name), relative ? `${relative}/${name}` : name)
      return
    }
    if (stat.isFile()) {
      framedHash(hash, 'file', relative)
      framedHash(hash, 'size', String(stat.size))
      framedHash(hash, 'digest', fileContentDigest(absolute, signal))
      return
    }
    if (stat.isSymbolicLink()) {
      framedHash(hash, 'symlink', relative)
      framedHash(hash, 'target', fs.readlinkSync(absolute))
      return
    }
    framedHash(hash, 'other', relative)
    framedHash(hash, 'size', String(stat.size))
  }
  visit(filePath, '')
  return `sha256:${hash.digest('hex')}`
}

/** Extracted filesystem, process, registry, notification, and scrape handlers. */
export async function handleAdminTool(
  tool: string,
  args: Record<string, unknown>,
  context: AdminHandlerContext,
): Promise<ToolResult | undefined> {
  const platform = context.platform ?? process.platform
  const isWindows = platform === 'win32'
  const isLinux = platform === 'linux'

  if (tool === 'filesystem') {
    const mode = requiredString(args, 'mode')
    const home = context.homeDirectory ?? os.homedir()
    let filePath = requiredString(args, 'path')
    if (!path.isAbsolute(filePath)) filePath = path.join(home, 'Desktop', filePath)
    let destination = typeof args.destination === 'string' ? args.destination : undefined
    if (destination && !path.isAbsolute(destination)) destination = path.join(home, 'Desktop', destination)
    for (const candidate of [filePath, destination]) {
      if (!candidate) continue
      const violation = fsRootsViolation(candidate)
      if (violation) return errJson(violation)
    }
    const encoding = (typeof args.encoding === 'string' ? args.encoding : 'utf-8') as BufferEncoding
    if (mode === 'read') {
      if (!fs.existsSync(filePath)) return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true }
      const lines = fs.readFileSync(filePath, encoding).split('\n')
      const offset = typeof args.offset === 'number' ? args.offset : 0
      const limit = typeof args.limit === 'number' ? args.limit : lines.length
      return ok(lines.slice(offset, offset + limit).join('\n'))
    }
    if (mode === 'write') {
      const content = typeof args.content === 'string' ? args.content : ''
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      if (args.append) fs.appendFileSync(filePath, content, encoding)
      else fs.writeFileSync(filePath, content, encoding)
      return ok(`Written to ${filePath}`)
    }
    if (mode === 'copy') {
      if (!destination) return { content: [{ type: 'text', text: 'destination required for copy' }], isError: true }
      fs.cpSync(filePath, destination, { recursive: true, force: Boolean(args.overwrite) })
      return ok(`Copied ${filePath} → ${destination}`)
    }
    if (mode === 'move') {
      if (!destination) return { content: [{ type: 'text', text: 'destination required for move' }], isError: true }
      fs.renameSync(filePath, destination)
      return ok(`Moved ${filePath} → ${destination}`)
    }
    if (mode === 'delete') {
      if (!fs.existsSync(filePath)) return { content: [{ type: 'text', text: `Not found: ${filePath}` }], isError: true }
      if (fs.statSync(filePath).isDirectory()) fs.rmSync(filePath, { recursive: Boolean(args.recursive), force: true })
      else fs.unlinkSync(filePath)
      return ok(`Deleted ${filePath}`)
    }
    if (mode === 'list') {
      if (!fs.existsSync(filePath)) return { content: [{ type: 'text', text: `Directory not found: ${filePath}` }], isError: true }
      const entries = fs.readdirSync(filePath, { withFileTypes: true })
        .filter(entry => args.show_hidden || !entry.name.startsWith('.'))
        .map(entry => `${entry.isDirectory() ? 'd' : 'f'} ${entry.name}`)
      return ok(entries.join('\n') || '(empty)')
    }
    if (mode === 'search') {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '*'
      const matches: string[] = []
      let scanned = 0
      const walk = (directory: string) => {
        if (context.signal?.aborted) return
        try {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (context.signal?.aborted) return
            const full = path.join(directory, entry.name)
            scanned += 1
            if (context.onProgress && scanned % 25 === 0) {
              context.onProgress({ progress: scanned, message: `scanned ${scanned} entries, ${matches.length} matches` })
            }
            if (pattern === '*' || entry.name.includes(pattern.replace(/\*/g, ''))) matches.push(full)
            if (entry.isDirectory() && args.recursive) walk(full)
          }
        } catch { /* inaccessible directory */ }
      }
      walk(filePath)
      context.onProgress?.({
        progress: scanned,
        total: scanned,
        message: `search complete: scanned ${scanned} entries, ${matches.length} matches`,
      })
      return ok(matches.slice(0, 100).join('\n') || 'No matches')
    }
    if (mode === 'info') {
      if (!fs.existsSync(filePath)) return { content: [{ type: 'text', text: `Not found: ${filePath}` }], isError: true }
      const stat = fs.statSync(filePath)
      return ok(JSON.stringify({
        path: filePath, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size,
        created: stat.birthtime.toISOString(), modified: stat.mtime.toISOString(),
        ...(args.include_digest === true
          ? { contentDigest: filesystemContentDigest(filePath, context.signal) }
          : {}),
      }))
    }
    return { content: [{ type: 'text', text: `Unknown filesystem mode: ${mode}` }], isError: true }
  }

  if (tool === 'process_kill') {
    const mode = requiredString(args, 'mode')
    if (mode === 'list') {
      if (isWindows) {
        const result = await context.spawnBounded('powershell', ['-NoProfile', '-Command',
          'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 Id,ProcessName,@{N="MemMB";E={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json'], 10_000)
        return result.code === 0 ? ok(result.stdout) : { content: [{ type: 'text', text: result.stderr }], isError: true }
      }
      const result = await context.spawnBounded('ps', isLinux ? ['aux', '--sort=-%mem'] : ['aux', '-r'], 5_000)
      return ok(result.stdout.split('\n').slice(0, 21).join('\n'))
    }
    if (mode === 'kill') {
      const name = typeof args.name === 'string' ? args.name : undefined
      const pid = typeof args.pid === 'number' ? args.pid : undefined
      if (!name && !pid) return { content: [{ type: 'text', text: 'name or pid required' }], isError: true }
      if (isWindows) {
        const result = await context.spawnBounded(
          'taskkill', [pid ? `/PID ${pid}` : `/IM ${name}`, args.force ? '/F' : ''].filter(Boolean), 10_000,
        )
        return result.code === 0 ? ok(result.stdout.trim() || 'Process terminated')
          : { content: [{ type: 'text', text: result.stderr || result.stdout }], isError: true }
      }
      const signal = args.force ? 'SIGKILL' : 'SIGTERM'
      if (pid) { process.kill(pid, signal); return ok(`Sent ${signal} to PID ${pid}`) }
      const result = await context.spawnBounded('pkill', [args.force ? '-9' : '-15', name!], 5_000)
      return result.code === 0 ? ok(`Killed ${name}`)
        : { content: [{ type: 'text', text: result.stderr || 'No matching process' }], isError: true }
    }
    return { content: [{ type: 'text', text: `Unknown process mode: ${mode}` }], isError: true }
  }

  if (tool === 'registry') {
    if (!isWindows) return { content: [{ type: 'text', text: 'registry is Windows-only. Use `defaults` via run_script on macOS.' }], isError: true }
    const mode = requiredString(args, 'mode')
    const registryPath = requiredString(args, 'path')
    const name = typeof args.name === 'string' ? args.name : undefined
    const executable = context.getPowerShellExe()
    let script: string
    let success: string | undefined
    if (mode === 'get') {
      if (!name) return { content: [{ type: 'text', text: 'name required for get' }], isError: true }
      script = `Get-ItemPropertyValue -Path ${powershellLiteral(registryPath)} -Name ${powershellLiteral(name)}`
    } else if (mode === 'set') {
      if (!name) return { content: [{ type: 'text', text: 'name required for set' }], isError: true }
      const value = typeof args.value === 'string' ? args.value : ''
      const type = typeof args.type === 'string' ? args.type : 'String'
      script = `New-ItemProperty -Path ${powershellLiteral(registryPath)} -Name ${powershellLiteral(name)} -Value ${powershellLiteral(value)} -PropertyType ${type} -Force`
      success = `Set ${registryPath}\\${name}`
    } else if (mode === 'delete') {
      script = name
        ? `Remove-ItemProperty -Path ${powershellLiteral(registryPath)} -Name ${powershellLiteral(name)} -Force`
        : `Remove-Item -Path ${powershellLiteral(registryPath)} -Recurse -Force`
      success = `Deleted ${name ? `${registryPath}\\${name}` : registryPath}`
    } else if (mode === 'list') {
      const literal = powershellLiteral(registryPath)
      script = `Get-Item -Path ${literal} | Select-Object -ExpandProperty Property; Get-ChildItem -Path ${literal} -Name`
    } else {
      return { content: [{ type: 'text', text: `Unknown registry mode: ${mode}` }], isError: true }
    }
    const result = await context.spawnBounded(executable, powershellEncodedArgs(script), 10_000)
    if (result.code !== 0) return { content: [{ type: 'text', text: result.stderr }], isError: true }
    return ok(success ?? (result.stdout.trim() || '(empty)'))
  }

  if (tool === 'notification') {
    if (!isWindows) return { content: [{ type: 'text', text: 'notification is Windows-only. Use osascript via run_script on macOS.' }], isError: true }
    const title = xmlEscape(requiredString(args, 'title'))
    const message = xmlEscape(requiredString(args, 'message'))
    const appId = typeof args.app_id === 'string' ? args.app_id : 'Windows.SystemToastNotification'
    const xml = `<toast><visual><binding template="ToastText02"><text id="1">${title}</text><text id="2">${message}</text></binding></visual></toast>`
    const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml(${powershellLiteral(xml)})
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${powershellLiteral(appId)}).Show($toast)
`
    const result = await context.spawnBounded(context.getPowerShellExe(), powershellEncodedArgs(script), 10_000)
    return result.code === 0 ? ok('Notification sent')
      : { content: [{ type: 'text', text: result.stderr || 'Failed to send notification' }], isError: true }
  }

  if (tool === 'scrape') {
    const url = requiredString(args, 'url')
    if (args.use_dom) return { content: [{ type: 'text', text: 'use_dom mode requires a browser tab open with the URL. This feature is not yet implemented.' }], isError: true }
    try {
      const response = await (context.fetch ?? globalThis.fetch)(url, {
        headers: { 'User-Agent': 'computer-use-mcp/7.0.0' }, signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) return { content: [{ type: 'text', text: `HTTP ${response.status}: ${response.statusText}` }], isError: true }
      const html = await response.text()
      const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim()
      return ok(`URL: ${url}\nContent:\n${text.length > 8000 ? `${text.slice(0, 8000)}...` : text}`)
    } catch (error) {
      return { content: [{ type: 'text', text: `Scrape failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true }
    }
  }

  return undefined
}
