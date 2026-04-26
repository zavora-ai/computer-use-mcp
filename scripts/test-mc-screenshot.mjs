// Open Mission Control, hover top-right, screenshot it, close.
// So we can see what the UI actually looks like on this macOS version
// and figure out where the "+" button is.

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'
import { writeFileSync } from 'fs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  const display = JSON.parse(client.content?.[0]?.text ?? '{}')
  const displayInfo = JSON.parse((await client.getDisplaySize()).content[0].text)
  console.log('display:', displayInfo)

  // Open Mission Control
  console.log('opening MC...')
  await client.key('control+up', undefined, { focusStrategy: 'none' })
  await sleep(1500)

  // Screenshot without hovering first
  console.log('screenshot 1 (no hover)...')
  let shot = await client.screenshot({ width: 1280, quality: 60 })
  const img1 = shot.content.find(c => c.type === 'image')
  if (img1) writeFileSync('/tmp/mc-1-no-hover.jpg', Buffer.from(img1.data, 'base64'))

  // Move mouse to top-right
  const hx = displayInfo.width - 10, hy = 10
  console.log(`hovering at (${hx}, ${hy})...`)
  await client.moveMouse(hx, hy, undefined, { focusStrategy: 'none' })
  await sleep(2000)  // longer dwell

  // Screenshot with hover
  console.log('screenshot 2 (after hover)...')
  shot = await client.screenshot({ width: 1280, quality: 60 })
  const img2 = shot.content.find(c => c.type === 'image')
  if (img2) writeFileSync('/tmp/mc-2-hover.jpg', Buffer.from(img2.data, 'base64'))

  // Also try hovering at the top-center to see if the thumbnail strip appears
  console.log(`hovering at (${Math.floor(displayInfo.width/2)}, 5)...`)
  await client.moveMouse(Math.floor(displayInfo.width/2), 5, undefined, { focusStrategy: 'none' })
  await sleep(1500)
  shot = await client.screenshot({ width: 1280, quality: 60 })
  const img3 = shot.content.find(c => c.type === 'image')
  if (img3) writeFileSync('/tmp/mc-3-top-center.jpg', Buffer.from(img3.data, 'base64'))

  // Close MC
  await client.key('control+up', undefined, { focusStrategy: 'none' })
  await sleep(1000)

  console.log('\nWrote:')
  console.log('  /tmp/mc-1-no-hover.jpg')
  console.log('  /tmp/mc-2-hover.jpg')
  console.log('  /tmp/mc-3-top-center.jpg')

  await client.close()
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
