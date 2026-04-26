// Approach the "+" button from below to avoid the Notification Center
// top-right hot zone that dismisses Mission Control.

import { execFileSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const native = require('./computer-use-napi.node')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function snapshot() {
  const s = native.listSpaces()
  return {
    count: s.displays[0].spaces.length,
    ids: s.displays[0].spaces.map(sp => sp.id),
  }
}

async function attempt(name, steps) {
  const before = snapshot()
  console.log(`\n── ${name}`)
  console.log(`   before: ${before.count} spaces ${JSON.stringify(before.ids)}`)

  execFileSync('osascript', ['-e', 'tell application "Mission Control" to launch'])
  await sleep(1500)

  for (const [desc, fn] of steps) {
    console.log(`   · ${desc}`)
    await fn()
  }

  execFileSync('osascript', ['-e', 'tell application "Mission Control" to launch'])
  await sleep(1200)

  const after = snapshot()
  const delta = after.count - before.count
  console.log(`   after:  ${after.count} spaces ${JSON.stringify(after.ids)}  ${delta > 0 ? '✓ NEW SPACE!' : delta < 0 ? '✗ LOST SPACE!' : '✗ no change'}`)
  return delta > 0
}

async function main() {
  console.log('━'.repeat(60))
  console.log('  Approaching "+" from below to avoid NC hot zone')
  console.log('━'.repeat(60))

  // Strategy A: approach the + from directly below (y=200 → y=72)
  await attempt('A: approach from directly below then click', [
    ['hover in center of strip area to reveal +', async () => {
      await native.mouseMove(1280, 200)
      await sleep(1000)
    }],
    ['slide up+right to the + button', async () => {
      await native.mouseMove(2527, 200)
      await sleep(500)
      await native.mouseMove(2527, 72)
      await sleep(800)
    }],
    ['click', async () => {
      await native.mouseClick(2527, 72, 'left', 1)
      await sleep(1000)
    }],
  ])

  // Strategy B: target a slightly lower y so we stay out of the NC hot zone
  await attempt('B: click at y=85 (further from NC hot zone)', [
    ['hover in strip', async () => {
      await native.mouseMove(1280, 200)
      await sleep(1000)
    }],
    ['move to + at y=85', async () => {
      await native.mouseMove(2527, 85)
      await sleep(800)
    }],
    ['click at y=85', async () => {
      await native.mouseClick(2527, 85, 'left', 1)
      await sleep(1000)
    }],
  ])

  // Strategy C: click at x slightly less than 2527 (step back from right edge)
  await attempt('C: click at (2480, 72) — further from right edge', [
    ['hover in strip', async () => {
      await native.mouseMove(1280, 200)
      await sleep(1000)
    }],
    ['move near + but not right edge', async () => {
      await native.mouseMove(2480, 72)
      await sleep(800)
    }],
    ['click', async () => {
      await native.mouseClick(2480, 72, 'left', 1)
      await sleep(1000)
    }],
  ])

  // Strategy D: click-down and up with a deliberate settle
  await attempt('D: press/release explicitly at (2500, 80)', [
    ['hover strip', async () => {
      await native.mouseMove(1280, 200)
      await sleep(1000)
    }],
    ['approach +', async () => {
      await native.mouseMove(2500, 80)
      await sleep(1000)
    }],
    ['press-release', async () => {
      await native.mouseButton('press', 2500, 80)
      await sleep(80)
      await native.mouseButton('release', 2500, 80)
      await sleep(1000)
    }],
  ])

  console.log('\n' + '━'.repeat(60))
}

main().catch(e => { console.error(e); process.exit(1) })
