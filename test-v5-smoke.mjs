// Quick end-to-end smoke test — verifies the v5 server boots, all 44 tools
// register, and the read-only surfaces work. Runs in <1s, no destructive
// actions. Meant to be called after `npm run build` before publishing or as
// a post-install sanity check.

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'

const t0 = Date.now()
const server = createComputerUseServer()
const client = await connectInProcess(server)

const pass = []
const fail = []
const probe = async (name, fn) => {
  const t = Date.now()
  try {
    const r = await fn()
    pass.push({ name, ms: Date.now() - t, r })
    console.log(`  ✓ ${name} (${Date.now() - t}ms)`)
  } catch (e) {
    fail.push({ name, err: e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

const text = r => r.content.find(c => c.type === 'text')?.text ?? ''
const parse = r => { try { return JSON.parse(text(r)) } catch { return text(r) } }

const EXPECTED_TOOL_COUNT = 44

console.log('\n━━━ v5 smoke test ━━━')

console.log('\n[1] tool listing')
await probe(`listTools returns ${EXPECTED_TOOL_COUNT} tools`, async () => {
  const res = await client.listTools()
  const tools = Array.isArray(res) ? res : (res.tools ?? [])
  if (tools.length !== EXPECTED_TOOL_COUNT) {
    throw new Error(`expected ${EXPECTED_TOOL_COUNT}, got ${tools.length}`)
  }
  return tools.length
})

console.log('\n[2] v5 discovery')
await probe('get_tool_guide', async () => {
  const r = await client.getToolGuide('reply to the selected email in Mail')
  return parse(r)
})
await probe('get_app_capabilities(com.apple.Finder)', async () => {
  const r = await client.getAppCapabilities('com.apple.Finder')
  return parse(r)
})

console.log('\n[3] v5 observation (read-only)')
await probe('get_frontmost_app', async () => parse(await client.getFrontmostApp()))
await probe('list_running_apps', async () => {
  const apps = parse(await client.listRunningApps())
  return `${apps.length} apps running`
})
await probe('list_windows', async () => {
  const w = parse(await client.listWindows())
  return `${w.length} visible windows`
})
await probe('list_displays', async () => parse(await client.listDisplays()))
await probe('cursor_position', async () => parse(await client.cursorPosition()))

console.log('\n[4] v5 Spaces read-only')
await probe('list_spaces', async () => parse(await client.listSpaces()))
await probe('get_active_space', async () => parse(await client.getActiveSpace()))

console.log('\n[5] v5 scripting bridge')
await probe('run_script (applescript echo)', async () => {
  const r = await client.runScript({
    language: 'applescript',
    script: 'return "hello from v5"',
  })
  return text(r).trim()
})

console.log('\n[6] v5 accessibility tree walk on frontmost app')
await probe('get_ui_tree', async () => {
  const front = parse(await client.getFrontmostApp())
  const r = await client.getUiTree({ target_app: front.bundleId, max_depth: 2 })
  const tree = parse(r)
  return `root role=${tree.role ?? 'n/a'} children=${(tree.children || []).length}`
})

console.log('\n━━━ summary ━━━')
console.log(`  pass: ${pass.length}`)
console.log(`  fail: ${fail.length}`)
console.log(`  total: ${Date.now() - t0}ms`)
if (fail.length) console.log('  failures:', fail)

await client.close()
process.exit(fail.length ? 1 : 0)
