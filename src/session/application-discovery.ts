import { opendir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SpawnBounded } from './spawn.js'

export interface DiscoveredApplication {
  id: string; name: string; path?: string; targetApp: string | null
  installed: boolean | null; running: boolean; capabilities?: unknown
}
interface Options {
  platform: string; spawn: SpawnBounded; signal?: AbortSignal
  running: Array<{ bundleId: string; displayName: string }>
  roots?: string[]
  capabilities?: (id: string) => Promise<unknown>
}
const officeNames = /microsoft (word|excel|powerpoint|outlook|onenote|teams|access|publisher)|libreoffice|openoffice/i

/** Reads bounded application registrations, never executes an app or a desktop-file command. */
export async function discoverApplications(args: { query?: string; limit?: number; include_capabilities?: boolean }, options: Options) {
  const limit = args.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100')
  if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200)) throw new Error('query must be at most 200 characters')
  const query = (args.query ?? '').trim().toLowerCase()
  const matches = (app: DiscoveredApplication) => !query || `${app.name} ${app.id}`.toLowerCase().includes(query)
    || (['office', 'microsoft office', 'microsoft 365'].includes(query) && officeNames.test(app.name))
  const apps = new Map<string, DiscoveredApplication>()
  const warnings: string[] = []
  let scanned = 0, truncated = false
  const deadline = Date.now() + 15000
  const check = () => { options.signal?.throwIfAborted(); if (Date.now() >= deadline || scanned >= 2000) { truncated = true; return false } return true }
  const add = (app: DiscoveredApplication) => { if (!apps.has(app.id.toLowerCase())) apps.set(app.id.toLowerCase(), app) }
  if (options.platform === 'darwin' || options.platform === 'linux') {
    const roots = options.roots ?? (options.platform === 'darwin'
      ? [join(homedir(), 'Applications'), '/Applications', '/System/Applications']
      : [join(homedir(), '.local/share/applications'), '/usr/local/share/applications', '/usr/share/applications'])
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (!check()) return
      let entries
      try { entries = await opendir(directory) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Unable to read application directory: ${directory}`)
        return
      }
      for await (const entry of entries) {
        if (!check()) break
        scanned++
        const path = join(directory, entry.name)
        if (options.platform === 'darwin' && entry.isDirectory() && entry.name.endsWith('.app')) {
          const result = await options.spawn('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(path, 'Contents/Info.plist')], Math.min(1000, Math.max(1, deadline-Date.now())), options.signal)
          if (result.code !== 0) { warnings.push(`Unreadable application metadata: ${entry.name}`); continue }
          try {
            const info = JSON.parse(result.stdout)
            if (typeof info.CFBundleIdentifier === 'string') add({ id: info.CFBundleIdentifier,
              name: String(info.CFBundleDisplayName ?? info.CFBundleName ?? entry.name.slice(0,-4)), path,
              targetApp: info.CFBundleIdentifier, installed: true, running: false })
          } catch { warnings.push(`Invalid application metadata: ${entry.name}`) }
        } else if (options.platform === 'linux' && entry.isFile() && entry.name.endsWith('.desktop')) {
          try {
            const handle = await open(path, 'r')
            let file: string
            try {
              const buffer = Buffer.alloc(65537)
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
              file = buffer.subarray(0, bytesRead).toString('utf8')
            } finally { await handle.close() }
            if (Buffer.byteLength(file) > 65536) { warnings.push(`Oversized desktop registration: ${entry.name}`); continue }
            const main = file.split('[Desktop Entry]')[1]?.split(/\n\[/)[0] ?? ''
            const field = (name: string) => main.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim()
            if (field('Type') !== 'Application' || field('Hidden') === 'true' || field('NoDisplay') === 'true') continue
            add({ id: entry.name, name: field('Name') ?? entry.name, path, targetApp: null, installed: true, running: false })
          } catch { warnings.push(`Unreadable desktop registration: ${entry.name}`) }
        } else if (entry.isDirectory() && depth < 2 && !entry.name.startsWith('.')) await visit(path, depth+1)
      }
    }
    for (const root of roots) await visit(root, 0)
  } else if (options.platform === 'win32') {
    const result = await options.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-StartApps | Select-Object -First 2000 Name,AppID) | ConvertTo-Json -Compress'], 10000, options.signal)
    if (result.code !== 0) warnings.push('Windows Start-menu application discovery unavailable')
    else {
      const parsed = JSON.parse(result.stdout || '[]')
      const records = Array.isArray(parsed) ? parsed : [parsed]
      truncated = records.length >= 2000
      for (const app of records) if (typeof app.AppID === 'string' && typeof app.Name === 'string') add({
        id: app.AppID, name: app.Name, targetApp: null, installed: true, running: false })
    }
  } else warnings.push('Installed application discovery unsupported on this platform')
  options.signal?.throwIfAborted()
  for (const running of options.running) {
    const existing = apps.get(running.bundleId.toLowerCase())
      ?? [...apps.values()].find(app => app.name.toLowerCase() === running.displayName.toLowerCase())
    if (existing) { existing.running = true; existing.targetApp = running.bundleId }
    else add({ id: running.bundleId, name: running.displayName, targetApp: running.bundleId, installed: null, running: true })
  }
  const found = [...apps.values()].filter(matches).sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const selected = found.slice(0,limit)
  let probed = 0
  if (args.include_capabilities && options.capabilities) for (const app of selected) {
    if (!app.targetApp || probed >= 10 || !check()) continue
    options.signal?.throwIfAborted(); probed++
    app.capabilities = await options.capabilities(app.targetApp)
  }
  return { applications: selected, matched: found.length, truncated: truncated || found.length > limit,
    capabilitiesProbed: probed, warnings: warnings.slice(0,10),
    scope: 'Standard application registrations plus running apps; portable apps outside these locations may be absent.',
    ...(args.include_capabilities ? { capabilityNote: 'At most 10 targetable apps are probed. Missing capabilities are unknown; discovery never launches apps.' } : {}) }
}
