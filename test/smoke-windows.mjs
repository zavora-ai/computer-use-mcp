/**
 * Windows smoke test — verifies end-to-end MCP server + native module.
 */
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'

const server = createComputerUseServer()
const client = await connectInProcess(server)

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    console.log(`  PASS: ${name}`)
    passed++
  } catch (e) {
    console.log(`  FAIL: ${name} — ${e.message}`)
    failed++
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

console.log('Windows smoke test\n')

await check('listTools returns 40+ tools', async () => {
  const tools = await client.listTools()
  assert(tools.length >= 40, `expected >= 40 tools, got ${tools.length}`)
})

await check('screenshot returns image', async () => {
  const r = await client.screenshot({ width: 400 })
  assert(!r.isError, 'screenshot returned error')
  const img = r.content.find(c => c.type === 'image')
  assert(img, 'no image in response')
  assert(img.data.length > 100, 'image data too small')
})

await check('cursor_position returns coordinates', async () => {
  const r = await client.cursorPosition()
  const text = r.content[0]?.text
  assert(text.includes(','), `unexpected format: ${text}`)
})

await check('clipboard round-trip', async () => {
  await client.writeClipboard('smoke-test-123')
  const r = await client.readClipboard()
  assert(r.content[0]?.text === 'smoke-test-123', `got: ${r.content[0]?.text}`)
})

await check('get_display_size returns dimensions', async () => {
  const r = await client.getDisplaySize()
  const d = JSON.parse(r.content[0]?.text)
  assert(d.width > 0 && d.height > 0, `bad dimensions: ${d.width}x${d.height}`)
})

await check('list_windows returns windows', async () => {
  const r = await client.listWindows()
  const wins = JSON.parse(r.content[0]?.text)
  assert(Array.isArray(wins) && wins.length > 0, `expected windows, got ${wins.length}`)
})

await check('get_frontmost_app returns app info', async () => {
  const r = await client.getFrontmostApp()
  const app = JSON.parse(r.content[0]?.text)
  assert(app && app.bundleId, `no bundleId: ${JSON.stringify(app)}`)
})

await check('list_running_apps returns apps', async () => {
  const r = await client.listRunningApps()
  const apps = JSON.parse(r.content[0]?.text)
  assert(Array.isArray(apps) && apps.length > 0, `expected apps, got ${apps.length}`)
})

await check('run_script with powershell works', async () => {
  const r = await client.callTool('run_script', {
    language: 'powershell',
    script: 'Write-Output "Hello from PowerShell"',
  })
  assert(!r.isError, `error: ${r.content[0]?.text}`)
  assert(r.content[0]?.text.includes('Hello from PowerShell'), `unexpected: ${r.content[0]?.text}`)
})

await check('run_script rejects applescript on Windows', async () => {
  const r = await client.callTool('run_script', {
    language: 'applescript',
    script: 'display dialog "hi"',
  })
  assert(r.isError, 'expected error for applescript on Windows')
  assert(r.content[0]?.text.includes('not supported on Windows'), `unexpected: ${r.content[0]?.text}`)
})

await check('get_app_dictionary returns platform_unsupported on Windows', async () => {
  const r = await client.callTool('get_app_dictionary', { bundle_id: 'test' })
  assert(r.isError, 'expected error')
  assert(r.content[0]?.text.includes('platform_unsupported'), `unexpected: ${r.content[0]?.text}`)
})

await check('list_spaces returns structured response', async () => {
  const r = await client.listSpaces()
  const data = JSON.parse(r.content[0]?.text)
  assert('supported' in data, `missing supported field`)
})

await check('get_tool_metadata works', async () => {
  const r = await client.callTool('get_tool_metadata', { tool_name: 'screenshot' })
  assert(!r.isError, 'error')
  const meta = JSON.parse(r.content[0]?.text)
  assert(meta.focusRequired === 'none', `unexpected: ${meta.focusRequired}`)
})

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed}`)
await client.close()
process.exit(failed > 0 ? 1 : 0)
