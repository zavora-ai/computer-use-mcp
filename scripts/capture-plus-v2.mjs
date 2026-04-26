// Interactive coordinate capture v2 — clearer instructions + longer window.

import { execFileSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const native = require('./computer-use-napi.node')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('━'.repeat(60))
  console.log('  Space + button capture (v2)')
  console.log('━'.repeat(60))
  console.log('')
  console.log('  STEPS:')
  console.log('  1. In 3 seconds I will open Mission Control.')
  console.log('  2. While MC is open (15 sec window), hover mouse over the "+" button.')
  console.log('  3. Leave cursor parked on it — don\'t click.')
  console.log('  4. I will screenshot around the cursor and read its position.')
  console.log('')
  console.log('  Starting in 3...')
  await sleep(1000)
  console.log('            2...')
  await sleep(1000)
  console.log('            1...')
  await sleep(1000)

  execFileSync('osascript', ['-e', 'tell application "Mission Control" to launch'])
  console.log('\n  >>> Mission Control is now open. HOVER the "+" button. <<<')

  // Sample every 500ms for 15 sec — show you the live cursor position
  // so you can see when you're hovering still.
  for (let i = 30; i > 0; i--) {
    await sleep(500)
    const p = native.cursorPosition()
    process.stdout.write(`\r    ${Math.ceil(i/2)}s remaining   cursor=(${p.x}, ${p.y})          `)
  }
  console.log('')

  const p = native.cursorPosition()
  // Wider screenshot so we can clearly see what you're pointing at
  const x0 = Math.max(0, p.x - 200)
  const y0 = Math.max(0, p.y - 120)
  execFileSync('screencapture', ['-x', '-R', `${x0},${y0},400,240`, '/tmp/plus-v2.png'])
  execFileSync('sips', ['-s', 'format', 'jpeg', '/tmp/plus-v2.png', '--out', '/tmp/plus-v2.jpg'])

  // Also capture the full top strip to orient
  execFileSync('screencapture', ['-x', '-R', '0,0,2560,150', '/tmp/plus-v2-strip.png'])
  execFileSync('sips', ['-s', 'format', 'jpeg', '/tmp/plus-v2-strip.png', '--out', '/tmp/plus-v2-strip.jpg'])

  execFileSync('osascript', ['-e', 'tell application "Mission Control" to launch'])

  console.log('\n━'.repeat(60))
  console.log(`  Final cursor position: (${p.x}, ${p.y})`)
  console.log('  Screenshots:')
  console.log(`    /tmp/plus-v2.jpg        — 400x240 box around cursor`)
  console.log(`    /tmp/plus-v2-strip.jpg  — full top strip at capture time`)
  console.log('━'.repeat(60))
}

main().catch(e => { console.error(e); process.exit(1) })
