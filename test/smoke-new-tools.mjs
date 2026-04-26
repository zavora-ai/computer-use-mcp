/**
 * Smoke test for new Windows-parity tools.
 */
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const server = createComputerUseServer()
const client = await connectInProcess(server)

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); console.log(`  PASS: ${name}`); passed++ }
  catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); failed++ }
}
function assert(c, m) { if (!c) throw new Error(m) }

console.log('New tools smoke test\n')

// Tool count should be higher now
await check('tool count >= 48', async () => {
  const tools = await client.listTools()
  assert(tools.length >= 48, `got ${tools.length}`)
})

// FileSystem: write + read round-trip
const tmpFile = path.join(os.tmpdir(), `cu-test-${Date.now()}.txt`)
await check('filesystem write', async () => {
  const r = await client.callTool('filesystem', { mode: 'write', path: tmpFile, content: 'hello world' })
  assert(!r.isError, r.content[0]?.text)
})
await check('filesystem read', async () => {
  const r = await client.callTool('filesystem', { mode: 'read', path: tmpFile })
  assert(!r.isError, r.content[0]?.text)
  assert(r.content[0]?.text === 'hello world', `got: ${r.content[0]?.text}`)
})
await check('filesystem info', async () => {
  const r = await client.callTool('filesystem', { mode: 'info', path: tmpFile })
  assert(!r.isError, r.content[0]?.text)
  const info = JSON.parse(r.content[0]?.text)
  assert(info.type === 'file', `got: ${info.type}`)
  assert(info.size > 0, `size: ${info.size}`)
})
await check('filesystem list tmpdir', async () => {
  const r = await client.callTool('filesystem', { mode: 'list', path: os.tmpdir() })
  assert(!r.isError, r.content[0]?.text)
  assert(r.content[0]?.text.length > 0, 'empty list')
})
await check('filesystem delete', async () => {
  const r = await client.callTool('filesystem', { mode: 'delete', path: tmpFile })
  assert(!r.isError, r.content[0]?.text)
  assert(!fs.existsSync(tmpFile), 'file still exists')
})

// Process list
await check('process_kill list', async () => {
  const r = await client.callTool('process_kill', { mode: 'list' })
  assert(!r.isError, r.content[0]?.text)
  assert(r.content[0]?.text.length > 10, 'too short')
})

// Registry (Windows only)
if (process.platform === 'win32') {
  await check('registry list HKCU', async () => {
    const r = await client.callTool('registry', { mode: 'list', path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion' })
    assert(!r.isError, r.content[0]?.text)
  })
}

// Notification (Windows only) — just verify it doesn't crash
if (process.platform === 'win32') {
  await check('notification sends', async () => {
    const r = await client.callTool('notification', { title: 'Test', message: 'From computer-use-mcp benchmark' })
    // May fail if notifications are disabled, but shouldn't crash
    console.log('    notification result:', r.content[0]?.text?.slice(0, 60))
  })
}

// MultiSelect / MultiEdit — verify they dispatch without error
await check('multi_select dispatches', async () => {
  const r = await client.callTool('multi_select', { locs: [[100, 100], [200, 200]], press_ctrl: false })
  assert(!r.isError, r.content[0]?.text)
})

await check('multi_edit dispatches', async () => {
  // Just verify it doesn't crash — we're not targeting a real field
  const r = await client.callTool('multi_edit', { locs: [[100, 100, 'test']] })
  assert(!r.isError, r.content[0]?.text)
})

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed}`)
await client.close()
process.exit(failed > 0 ? 1 : 0)
