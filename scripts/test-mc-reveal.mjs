// Reveal the "+" button by hovering near the top-right of the Space strip.
// The strip is centered, so "+" appears to the right of the last thumbnail.

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'
import { writeFileSync } from 'fs'
import { execFileSync } from 'child_process'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  const d = JSON.parse((await client.getDisplaySize()).content[0].text)
  console.log('display:', d.width, 'x', d.height)

  // Open MC properly
  console.log('opening Mission Control via `open -a`...')
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1500)

  // Try moving along the top edge, stopping at several x positions and
  // screenshotting each. Looking for where the "+" button appears.
  const probeXs = [
    Math.floor(d.width * 0.55),  // just right of center (where Desktop 2 sits)
    Math.floor(d.width * 0.60),
    Math.floor(d.width * 0.65),
    Math.floor(d.width * 0.70),
    Math.floor(d.width * 0.75),
    Math.floor(d.width * 0.80),
    Math.floor(d.width * 0.90),
    d.width - 100,
    d.width - 10,
  ]

  for (const x of probeXs) {
    await client.moveMouse(x, 40, undefined, { focusStrategy: 'none' })
    await sleep(800)
    execFileSync('screencapture', ['-x', `/tmp/mc-probe-x${x}.jpg`])
    console.log(`  snapped at x=${x}`)
  }

  // Close MC
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1000)

  console.log('\nImages written to /tmp/mc-probe-x*.jpg')
  await client.close()
}

main().catch(e => { console.error(e); process.exit(1) })
