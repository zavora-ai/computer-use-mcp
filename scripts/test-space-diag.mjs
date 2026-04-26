// Diagnostic: screenshot at each step to trace where the click lands.

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'
import { execFileSync } from 'child_process'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  const d = JSON.parse((await client.getDisplaySize()).content[0].text)

  const plusX = d.width - 165
  const plusY = 70

  console.log('[1] open MC')
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1500)

  console.log('[2] hover center-top')
  await client.moveMouse(Math.floor(d.width / 2), 20, undefined, { focusStrategy: 'none' })
  await sleep(1500)
  execFileSync('screencapture', ['-x', '-R', '0,0,2560,150', '/tmp/diag-1-hover.png'])

  // Now move the cursor *to* the plus position and screenshot BEFORE clicking
  console.log(`[3] move cursor to (${plusX}, ${plusY}) — do not click yet`)
  await client.moveMouse(plusX, plusY, undefined, { focusStrategy: 'none' })
  await sleep(800)
  execFileSync('screencapture', ['-x', '-R', '0,0,2560,150', '/tmp/diag-2-on-plus.png'])

  // Click
  console.log('[4] click')
  await client.click(plusX, plusY, undefined, { focusStrategy: 'none' })
  await sleep(1500)
  execFileSync('screencapture', ['-x', '-R', '0,0,2560,150', '/tmp/diag-3-after-click.png'])

  console.log('[5] close MC')
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1000)

  // Convert PNG to JPEG for display
  for (const n of [1, 2, 3]) {
    execFileSync('sips', ['-s', 'format', 'jpeg', `/tmp/diag-${n}-${['hover','on-plus','after-click'][n-1]}.png`, '--out', `/tmp/diag-${n}.jpg`])
  }

  await client.close()
  console.log('\nWrote diag-1.jpg (hover), diag-2.jpg (on-plus before click), diag-3.jpg (after click)')
}

main().catch(e => { console.error(e); process.exit(1) })
