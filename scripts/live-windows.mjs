// Practical live test — drives REAL Windows tools through the MCP server
// in-process. Non-destructive: writes a temp file, reads it back, captures a
// screenshot to disk, round-trips the clipboard, and queries system state.
//
//   node scripts/live-windows.mjs
//
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'

const server = createComputerUseServer()
const client = await connectInProcess(server)

const text = r => r.content?.find(c => c.type === 'text')?.text ?? ''
const img = r => r.content?.find(c => c.type === 'image')
const parse = r => { try { return JSON.parse(text(r)) } catch { return text(r) } }
const short = (s, n = 160) => { const t = typeof s === 'string' ? s : JSON.stringify(s); return t.length > n ? t.slice(0, n) + '…' : t }

let pass = 0, fail = 0
const step = async (name, fn) => {
  const t = Date.now()
  try {
    const out = await fn()
    pass++
    console.log(`  \u2713 ${name} (${Date.now() - t}ms) ${out != null ? '\u2192 ' + short(out) : ''}`)
  } catch (e) {
    fail++
    console.log(`  \u2717 ${name}: ${e.message}`)
  }
}

const outDir = mkdtempSync(join(tmpdir(), 'cu-live-'))
console.log(`\n\u2501\u2501\u2501 live windows test  (artifacts: ${outDir}) \u2501\u2501\u2501\n`)

console.log('[1] discovery + version')
await step('listTools count', async () => {
  const tools = await client.listTools()
  return `${tools.length} tools`
})
await step('doctor', async () => {
  const d = parse(await client.doctor({ includeRemediation: true }))
  return short(d)
})

console.log('\n[2] system observation (read-only)')
await step('list_displays', async () => short(parse(await client.listDisplays())))
await step('get_display_size', async () => short(parse(await client.getDisplaySize())))
await step('cursor_position', async () => short(parse(await client.cursorPosition())))
await step('get_frontmost_app', async () => short(parse(await client.getFrontmostApp())))
await step('list_running_apps', async () => {
  const a = parse(await client.listRunningApps())
  return Array.isArray(a) ? `${a.length} apps` : short(a)
})
await step('list_windows', async () => {
  const w = parse(await client.listWindows())
  return Array.isArray(w) ? `${w.length} windows` : short(w)
})
await step('process_kill list (top 5 by memory)', async () => {
  const p = parse(await client.processKill('list', { sort_by: 'memory', limit: 5 }))
  return short(p)
})

console.log('\n[3] screenshot to disk')
await step('screenshot (PNG, lossless)', async () => {
  const r = await client.screenshot({ quality: 0 })
  const image = img(r)
  if (!image) throw new Error('no image returned')
  const file = join(outDir, 'screenshot.png')
  writeFileSync(file, Buffer.from(image.data, 'base64'))
  return `${image.mimeType} ${(image.data.length / 1024).toFixed(0)}KB \u2192 ${file}`
})

console.log('\n[4] clipboard round-trip')
await step('write_clipboard + read_clipboard', async () => {
  const marker = `cu-live ${Date.now()}`
  await client.writeClipboard(marker)
  const back = text(await client.readClipboard())
  if (!back.includes(marker)) throw new Error(`mismatch: got "${short(back)}"`)
  return `roundtrip ok ("${marker}")`
})

console.log('\n[5] filesystem tool (Windows built-in)')
await step('filesystem write + read', async () => {
  const file = join(outDir, 'note.txt')
  const content = 'hello from computer-use-mcp live test'
  await client.filesystem('write', file, { content })
  const back = parse(await client.filesystem('read', file))
  const got = typeof back === 'string' ? back : (back.content ?? JSON.stringify(back))
  if (!String(got).includes(content)) throw new Error(`read mismatch: ${short(got)}`)
  return `wrote + read ${file}`
})
await step('filesystem list outDir', async () => short(parse(await client.filesystem('list', outDir))))

console.log('\n[6] run_script (PowerShell)')
await step('powershell echo + compute', async () => {
  const r = await client.runScript('powershell', '$(2+2); Write-Output $env:COMPUTERNAME')
  if (r.isError) throw new Error(text(r))
  return short(text(r).trim())
})

console.log('\n[7] native agent_pointer overlay (virtual, does not move OS cursor)')
await step('agent_pointer move + get', async () => {
  await client.agentPointer('move', { coordinate: [200, 200], nativeOverlay: false })
  const g = parse(await client.agentPointer('get'))
  return short(g)
})

console.log('\n[8] MCP resources + prompts')
await step('listResources', async () => {
  const res = await client.listResources()
  return res.map(r => r.uri).join(', ')
})
await step('listPrompts', async () => {
  const p = await client.listPrompts()
  return p.map(x => x.name).join(', ')
})

console.log('\n\u2501\u2501\u2501 summary \u2501\u2501\u2501')
console.log(`  pass: ${pass}   fail: ${fail}`)
console.log(`  screenshot + artifacts in: ${outDir}`)

await client.close()
process.exit(fail ? 1 : 0)
