// Second diagnostic — avoid the menu bar zone.

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'
import { execFileSync } from 'child_process'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  const d = JSON.parse((await client.getDisplaySize()).content[0].text)

  console.log('[1] open MC')
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1500)

  // Hover BELOW the menu bar — y=60 is in the Space strip zone.
  console.log(`[2] hover at (${Math.floor(d.width/2)}, 60) — in strip, not menu bar`)
  await client.moveMouse(Math.floor(d.width / 2), 60, undefined, { focusStrategy: 'none' })
  await sleep(1500)
  execFileSync('screencapture', ['-x', '-R', '0,0,2560,150', '/tmp/diag2-hover.png'])
  execFileSync('sips', ['-s', 'format', 'jpeg', '/tmp/diag2-hover.png', '--out', '/tmp/diag2-hover.jpg'])

  console.log('[3] close MC')
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1000)
  await client.close()
}

main().catch(e => { console.error(e); process.exit(1) })
