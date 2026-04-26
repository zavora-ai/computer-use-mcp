// Interactive coordinate capture.
//
// 1. We open Mission Control.
// 2. You hover your mouse over the "+" button (but DO NOT click it).
// 3. After 6 seconds we read the cursor position and report it.
// 4. We close Mission Control.

import { execFileSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const native = require('./computer-use-napi.node')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('━'.repeat(60))
  console.log('  Space + button coordinate capture')
  console.log('━'.repeat(60))

  console.log('\n[1] Opening Mission Control in 2 seconds...')
  await sleep(2000)
  execFileSync('osascript', ['-e', 'tell application "Mission Control" to launch'])

  console.log('[2] Mission Control open. HOVER over the "+" button NOW.')
  console.log('    You have 8 seconds. Do NOT click — just hover.')

  // Countdown + sample cursor each second so we can see if you're still moving
  const samples = []
  for (let i = 8; i > 0; i--) {
    await sleep(1000)
    const p = native.cursorPosition()
    samples.push({ t: 9 - i, ...p })
    process.stdout.write(`\r    ${i}s remaining   cursor=(${p.x}, ${p.y})     `)
  }
  console.log('')

  // Take a screenshot right now while the cursor is parked on the + button
  const p = native.cursorPosition()
  execFileSync('screencapture', ['-x', '-R', `${Math.max(0, p.x - 150)},${Math.max(0, p.y - 80)},300,160`, '/tmp/plus-capture.png'])
  execFileSync('sips', ['-s', 'format', 'jpeg', '/tmp/plus-capture.png', '--out', '/tmp/plus-capture.jpg'])

  // Close MC
  console.log('[3] Closing Mission Control...')
  execFileSync('osascript', ['-e', 'tell application "Mission Control" to launch'])

  console.log('\n━'.repeat(60))
  console.log('  Cursor position samples over the last 8 seconds:')
  for (const s of samples) console.log(`    t=${s.t}s  (${s.x}, ${s.y})`)
  console.log(`\n  Final cursor position: (${p.x}, ${p.y})`)
  console.log(`  Screenshot saved to /tmp/plus-capture.jpg (shows area around cursor)`)
  console.log('━'.repeat(60))
}

main().catch(e => { console.error(e); process.exit(1) })
