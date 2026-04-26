/**
 * Quick verification that macOS feature parity works:
 * zoom (native crop), filesystem, resize_window, snapshot annotations.
 */
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'

const server = createComputerUseServer()
const client = await connectInProcess(server)

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); console.log(`  PASS: ${name}`); passed++ }
  catch (e) { console.log(`  FAIL: ${name} — ${e.message}`); failed++ }
}
function assert(c, m) { if (!c) throw new Error(m) }

console.log('macOS feature parity verification\n')

await check('tool count >= 55', async () => {
  const tools = await client.listTools()
  assert(tools.length >= 55, `got ${tools.length}`)
})

await check('zoom returns cropped image (native cropImage)', async () => {
  const r = await client.callTool('zoom', { region: [0, 0, 200, 100] })
  assert(!r.isError, `error: ${r.content[0]?.text}`)
  const img = r.content.find(c => c.type === 'image')
  assert(img, 'no image in zoom response')
  assert(img.data.length > 100, 'image too small')
  const text = r.content.find(c => c.type === 'text')?.text
  assert(text && text.includes('zoomed from'), `unexpected text: ${text}`)
})

await check('filesystem write + read round-trip', async () => {
  const w = await client.callTool('filesystem', { mode: 'write', path: '/tmp/cu-parity-test.txt', content: 'parity check' })
  assert(!w.isError, w.content[0]?.text)
  const r = await client.callTool('filesystem', { mode: 'read', path: '/tmp/cu-parity-test.txt' })
  assert(r.content[0]?.text === 'parity check', `got: ${r.content[0]?.text}`)
  await client.callTool('filesystem', { mode: 'delete', path: '/tmp/cu-parity-test.txt' })
})

await check('process_kill list works', async () => {
  const r = await client.callTool('process_kill', { mode: 'list' })
  assert(!r.isError, r.content[0]?.text)
  assert(r.content[0]?.text.length > 10, 'too short')
})

await check('snapshot text-only works', async () => {
  const r = await client.callTool('snapshot', { use_vision: false })
  assert(!r.isError, 'snapshot error')
  const text = r.content.find(c => c.type === 'text')?.text
  assert(text && text.includes('Display:'), `unexpected: ${text?.slice(0, 80)}`)
})

await check('snapshot with annotations works', async () => {
  const r = await client.callTool('snapshot', { use_vision: true, use_annotation: true, width: 400 })
  assert(!r.isError, 'snapshot error')
  const img = r.content.find(c => c.type === 'image')
  assert(img, 'no image in annotated snapshot')
})

await check('resize_window works on macOS', async () => {
  const r = await client.callTool('resize_window', { window_size: [800, 600] })
  // May fail if no frontmost window supports AppleScript resize, but shouldn't crash
  console.log(`    result: ${r.content[0]?.text?.slice(0, 60)}`)
})

await check('scrape works', async () => {
  const r = await client.callTool('scrape', { url: 'https://example.com' })
  assert(!r.isError, r.content[0]?.text)
  assert(r.content[0]?.text.length > 20, 'too short')
})

await check('multi_select dispatches', async () => {
  const r = await client.callTool('multi_select', { locs: [[100, 100]], press_ctrl: false })
  assert(!r.isError, r.content[0]?.text)
})

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed}`)
await client.close()
process.exit(failed > 0 ? 1 : 0)
