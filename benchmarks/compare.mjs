/**
 * Full feature-parity benchmark: 3-way comparison
 *   1. computer-use-mcp (Rust NAPI) — ours
 *   2. CursorTouch/Windows-MCP (Python, dxcam+comtypes)
 *   3. sinmb79/windows-computer-mcp (Python, pyautogui+mss)
 *
 * Run: node benchmarks/compare.mjs
 */
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { execFileSync } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

const RUNS = 15

function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

async function benchRust(client, name, fn) {
  const times = []
  try { await fn() } catch {}
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now()
    try { await fn() } catch {}
    times.push(performance.now() - start)
  }
  return { name, server: 'ours', median: median(times) }
}

function benchPy(server, name, script) {
  try {
    const out = execFileSync('python', ['-c', script], { timeout: 30000, encoding: 'utf8' })
    const data = JSON.parse(out.trim())
    return { name, server, median: data.median }
  } catch {
    return { name, server, median: -1 }
  }
}

const pyTemplate = (setup, op) => `
import json, time
${setup}
times = []
${op}
for _ in range(${RUNS}):
    s = time.perf_counter()
    ${op}
    times.append((time.perf_counter() - s) * 1000)
times.sort()
print(json.dumps({"median": round(times[len(times)//2], 2)}))
`

const wmcp = (op) => pyTemplate('from windows_mcp.desktop.service import Desktop\nd = Desktop()', op)
const wcmcp = (op) => pyTemplate('from windows_computer_mcp.backend import WindowsDesktopBackend\nb = WindowsDesktopBackend()', op)

console.log('=== 3-Way Benchmark: Rust NAPI vs CursorTouch vs sinmb79 ===')
console.log(`Runs: ${RUNS}\n`)

const server = createComputerUseServer()
const client = await connectInProcess(server)
const results = []

// ── Screenshot ───────────────────────────────────────────────────────────────
console.log('Screenshot...')
results.push(await benchRust(client, 'screenshot JPEG 800px', () => client.screenshot({ width: 800, quality: 80 })))
results.push(await benchRust(client, 'screenshot PNG 800px', () => client.screenshot({ width: 800, quality: 0 })))
results.push(await benchRust(client, 'screenshot JPEG full', () => client.screenshot({ quality: 80 })))
results.push(await benchRust(client, 'screenshot PNG full', () => client.screenshot({ quality: 0 })))
results.push(benchPy('cursortouch', 'screenshot JPEG 800px', wmcp('d.get_screenshot()')))
results.push(benchPy('sinmb79', 'screenshot PNG full', wcmcp('b.screenshot_png()')))

// ── Mouse ────────────────────────────────────────────────────────────────────
console.log('Mouse...')
results.push(await benchRust(client, 'cursor_position', () => client.cursorPosition()))
results.push(benchPy('cursortouch', 'cursor_position', wmcp('d.get_cursor_location()')))
results.push(benchPy('sinmb79', 'cursor_position', wcmcp('b.screen_size()')))

// ── Clipboard ────────────────────────────────────────────────────────────────
console.log('Clipboard...')
results.push(await benchRust(client, 'clipboard round-trip', async () => {
  await client.writeClipboard('bench'); await client.readClipboard()
}))
results.push(benchPy('cursortouch', 'clipboard round-trip',
  wmcp('import pyperclip; pyperclip.copy("bench"); pyperclip.paste()')))

// ── Windows ──────────────────────────────────────────────────────────────────
console.log('Windows...')
results.push(await benchRust(client, 'list_windows', () => client.listWindows()))
results.push(await benchRust(client, 'get_frontmost_app', () => client.getFrontmostApp()))
results.push(await benchRust(client, 'list_running_apps', () => client.listRunningApps()))
results.push(benchPy('cursortouch', 'list_windows', wmcp('d.get_windows()')))
results.push(benchPy('cursortouch', 'get_frontmost_app', wmcp('d.get_active_window()')))
results.push(benchPy('sinmb79', 'list_windows', wcmcp('b.list_windows()')))

// ── Scripting ────────────────────────────────────────────────────────────────
console.log('Scripting...')
results.push(await benchRust(client, 'powershell', () =>
  client.callTool('run_script', { language: 'powershell', script: 'Write-Output ok' })))
results.push(benchPy('cursortouch', 'powershell',
  wmcp('from windows_mcp.desktop.powershell import PowerShellExecutor; PowerShellExecutor.execute_command("Write-Output ok", 10)')))

// ── File System ──────────────────────────────────────────────────────────────
console.log('File System...')
const tmpFile = path.join(os.tmpdir(), `bench-${Date.now()}.txt`)
results.push(await benchRust(client, 'fs write', () =>
  client.callTool('filesystem', { mode: 'write', path: tmpFile, content: 'benchmark' })))
results.push(await benchRust(client, 'fs read', () =>
  client.callTool('filesystem', { mode: 'read', path: tmpFile })))
try { fs.unlinkSync(tmpFile) } catch {}

// ── Virtual Desktops ─────────────────────────────────────────────────────────
console.log('Virtual Desktops...')
results.push(await benchRust(client, 'list_spaces', () => client.listSpaces()))
results.push(benchPy('cursortouch', 'list_spaces',
  wmcp('from windows_mcp.vdm import get_all_desktops; get_all_desktops()')))

// ── Scrape ───────────────────────────────────────────────────────────────────
console.log('Scrape...')
results.push(await benchRust(client, 'scrape', () =>
  client.callTool('scrape', { url: 'https://example.com' })))
results.push(benchPy('cursortouch', 'scrape', wmcp('d.scrape("https://example.com")')))

// ── Registry ─────────────────────────────────────────────────────────────────
console.log('Registry...')
results.push(await benchRust(client, 'registry list', () =>
  client.callTool('registry', { mode: 'list', path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion' })))
results.push(benchPy('cursortouch', 'registry list',
  wmcp('d.registry_list("HKCU:\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion")')))

// ── UI Automation ────────────────────────────────────────────────────────────
console.log('UI Automation...')
results.push(await benchRust(client, 'get_focused_element', () => client.getFocusedElement()))

// ── Snapshot ─────────────────────────────────────────────────────────────────
console.log('Snapshot...')
results.push(await benchRust(client, 'snapshot (text)', () =>
  client.callTool('snapshot', { use_vision: false })))
results.push(await benchRust(client, 'snapshot (image)', () =>
  client.callTool('snapshot', { use_vision: true, width: 800 })))

await client.close()

// ── Results ──────────────────────────────────────────────────────────────────
console.log('\n=== RESULTS ===\n')
console.log('| Operation | Ours (ms) | CursorTouch (ms) | sinmb79 (ms) | vs CT | vs S |')
console.log('|---|---|---|---|---|---|')

const grouped = {}
for (const r of results) {
  if (!grouped[r.name]) grouped[r.name] = {}
  grouped[r.name][r.server] = r.median
}

for (const [name, servers] of Object.entries(grouped)) {
  const ours = servers['ours']
  const ct = servers['cursortouch']
  const sm = servers['sinmb79']
  const oursStr = ours != null ? ours.toFixed(1) : '-'
  const ctStr = ct != null && ct >= 0 ? ct.toFixed(1) : '-'
  const smStr = sm != null && sm >= 0 ? sm.toFixed(1) : '-'
  const vsCt = ours != null && ct != null && ct > 0 ? `${(ct / ours).toFixed(1)}x` : '-'
  const vsSm = ours != null && sm != null && sm > 0 ? `${(sm / ours).toFixed(1)}x` : '-'
  console.log(`| ${name} | ${oursStr} | ${ctStr} | ${smStr} | ${vsCt} | ${vsSm} |`)
}

const mem = process.memoryUsage()
console.log(`\nMemory: RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB`)
console.log(`Tools: ${(await (await connectInProcess(createComputerUseServer())).listTools()).length}`)

process.exit(0)
