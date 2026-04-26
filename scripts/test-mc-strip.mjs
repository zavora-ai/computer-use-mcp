// Target the Space strip at the very top of the Mission Control view.
// From earlier screenshot: the "Desktop 1" / "Desktop 2" labels live at roughly
// y=8-15. Hovering on the strip reveals spacing and the "+" at the right edge.

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'
import { execFileSync } from 'child_process'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  const d = JSON.parse((await client.getDisplaySize()).content[0].text)

  console.log('opening MC...')
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1500)

  // Hover near the top-center first (revealing the strip)
  const cx = Math.floor(d.width / 2)
  console.log(`hover top-center (${cx}, 5)...`)
  await client.moveMouse(cx, 5, undefined, { focusStrategy: 'none' })
  await sleep(1500)
  execFileSync('screencapture', ['-x', '/tmp/strip-1-center.jpg'])

  // Now scan horizontally along y=30 — the strip's vertical middle when expanded
  for (const frac of [0.50, 0.55, 0.58, 0.60, 0.62, 0.65, 0.70]) {
    const x = Math.floor(d.width * frac)
    await client.moveMouse(x, 30, undefined, { focusStrategy: 'none' })
    await sleep(600)
    execFileSync('screencapture', ['-x', `/tmp/strip-y30-x${x}.jpg`])
    console.log(`  snapped at (${x}, 30)`)
  }

  // Close MC
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1000)
  await client.close()
}

main().catch(e => { console.error(e); process.exit(1) })
