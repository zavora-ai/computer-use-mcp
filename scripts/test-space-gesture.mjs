// Gesture-based Space creation: open Mission Control, click the "+" button.
// Coordinates derived from the actual UI (see /tmp/mc-strip-only.jpg):
//   × button at x=1295, y=27 (to close Desktop 1's thumbnail)
//   + button at x=2395, y=70 (on a 2560-wide display)
// The "+" sits at roughly (display_width - 165, 70).

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const native = require('./computer-use-napi.node')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function snapshot() {
  const s = native.listSpaces()
  const all = s.displays.flatMap(d => d.spaces.map(sp => ({ ...sp, display: d.display_id })))
  return { active: s.active_space_id, count: all.length, spaces: all }
}

async function main() {
  console.log('━'.repeat(60))
  console.log('  Gesture-based Space creation — attempt 2')
  console.log('━'.repeat(60))

  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  const d = JSON.parse((await client.getDisplaySize()).content[0].text)
  console.log(`\nDisplay: ${d.width}x${d.height}`)

  const before = snapshot()
  console.log(`\nBefore: ${before.count} space(s), active=${before.active}`)
  before.spaces.forEach(s => console.log(`  id=${s.id} type=${s.type}`))

  // The + button sits at (display_width - 165, 70). Validated visually.
  const plusX = d.width - 165
  const plusY = 70

  console.log(`\n[1] Opening Mission Control via \`open -a\`...`)
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1500)  // wait for animation to settle

  console.log(`[2] Hovering in Space strip zone at (${Math.floor(d.width/2)}, 20) to reveal buttons...`)
  await client.moveMouse(Math.floor(d.width / 2), 20, undefined, { focusStrategy: 'none' })
  await sleep(1500)  // hover dwell — "+" fades in

  console.log(`[3] Clicking "+" button at (${plusX}, ${plusY})...`)
  await client.click(plusX, plusY, undefined, { focusStrategy: 'none' })
  await sleep(1500)  // new Space thumbnail animates in

  console.log(`[4] Closing Mission Control...`)
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1500)

  // Verify
  const after = snapshot()
  console.log(`\nAfter: ${after.count} space(s), active=${after.active}`)
  after.spaces.forEach(s => console.log(`  id=${s.id} type=${s.type}`))

  const newSpaces = after.spaces.filter(a => !before.spaces.some(b => b.id === a.id))
  console.log('\n' + '━'.repeat(60))
  if (after.count > before.count) {
    console.log(`  ✓ SUCCESS — ${newSpaces.length} new user-visible Space(s):`)
    newSpaces.forEach(s => console.log(`    id=${s.id} type=${s.type}`))
  } else if (after.count === before.count) {
    console.log(`  ✗ No change (still ${before.count})`)
  } else {
    console.log(`  ⚠ Count DECREASED (${before.count} → ${after.count})`)
  }
  console.log('━'.repeat(60))

  await client.close()
}

main().catch(e => { console.error(e); process.exit(1) })
