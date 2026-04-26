// Validate the Mission Control gesture technique for creating a user-visible
// macOS Space. Snapshot Space count, fire Ctrl+Up + mouse dance, snapshot
// again, report whether we got a new Space.

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const native = require('./computer-use-napi.node')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const text = r => r.content.find(c => c.type === 'text')?.text ?? ''

function snapshot() {
  const s = native.listSpaces()
  const all = s.displays.flatMap(d => d.spaces.map(sp => ({ ...sp, display: d.display_id })))
  return { active: s.active_space_id, count: all.length, spaces: all }
}

async function main() {
  console.log('━'.repeat(60))
  console.log('  Mission Control gesture — live Space creation test')
  console.log('━'.repeat(60))

  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  const display = JSON.parse(text(await client.getDisplaySize()))
  console.log(`\nDisplay: ${display.width}×${display.height} (logical)`)

  const before = snapshot()
  console.log(`\nBefore: ${before.count} space(s), active=${before.active}`)
  before.spaces.forEach(s => console.log(`  id=${s.id} type=${s.type}`))

  // ── Step 1: Open Mission Control via Control+Up ─────────────────────────
  console.log('\n[1] Opening Mission Control (Control+Up)...')
  await client.key('control+up', undefined, { focusStrategy: 'none' })
  await sleep(1200)  // wait for animation

  // ── Step 2: Move mouse to upper-right corner to reveal the "+" button ───
  // The "+" only appears when hovering near the top-right.
  const hoverX = display.width - 10
  const hoverY = 10
  console.log(`[2] Hovering at (${hoverX}, ${hoverY}) to reveal "+" button...`)
  await client.moveMouse(hoverX, hoverY, undefined, { focusStrategy: 'none' })
  await sleep(1500)  // let the "+" button fade in (macOS animates this slowly)

  // ── Step 3: Click the "+" button ─────────────────────────────────────────
  // The "+" appears at the top-right corner of the screen when hovering there.
  console.log(`[3] Clicking "+" button...`)
  await client.click(hoverX, hoverY, undefined, { focusStrategy: 'none' })
  await sleep(1500)  // let the new Space thumbnail animate in

  // ── Step 4: Close Mission Control ────────────────────────────────────────
  console.log('[4] Closing Mission Control (Control+Up)...')
  await client.key('control+up', undefined, { focusStrategy: 'none' })
  await sleep(1200)

  // ── Verify ───────────────────────────────────────────────────────────────
  const after = snapshot()
  console.log(`\nAfter: ${after.count} space(s), active=${after.active}`)
  after.spaces.forEach(s => console.log(`  id=${s.id} type=${s.type}`))

  const newSpaces = after.spaces.filter(a => !before.spaces.some(b => b.id === a.id))
  console.log('\n' + '━'.repeat(60))
  if (after.count > before.count) {
    console.log(`  ✓ SUCCESS — ${newSpaces.length} new Space(s) created via gesture:`)
    newSpaces.forEach(s => console.log(`    id=${s.id}`))
    console.log('  ✓ These Spaces are user-visible (unlike CGSSpaceCreate orphans)')
  } else if (after.count === before.count) {
    console.log(`  ✗ NO CHANGE — Space count is still ${before.count}`)
    console.log('  The click probably missed the "+" button.')
    console.log('  Possible causes:')
    console.log('    • "+" button position differs on your macOS version')
    console.log('    • Mission Control didn\'t fully open before we hovered')
    console.log('    • Hover needs more time for "+" to fade in')
  } else {
    console.log(`  ⚠ Space count DECREASED (${before.count} → ${after.count})`)
    console.log('  We may have accidentally clicked a close button. Oops.')
  }
  console.log('━'.repeat(60))

  await client.close()
}

main().catch(e => {
  console.error('FATAL:', e.message)
  process.exit(1)
})
