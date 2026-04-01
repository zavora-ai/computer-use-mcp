/**
 * End-to-end demo: open Calculator, clear it, compute 42+58, verify result.
 * All in-process via Rust NAPI — no focus stealing.
 */

import { createComputerUseServer } from './server.js'
import { connectInProcess } from './client.js'
import { writeFile } from 'fs/promises'

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  const tools = await client.listTools()
  console.log(`✓ ${tools.length} tools registered\n`)

  // 1. Open Calculator
  console.log('1. Opening Calculator...')
  await client.openApp('com.apple.calculator')
  await client.wait(1) // let it fully launch

  // 2. Screenshot to see current state
  console.log('2. Screenshot (before)...')
  let shot = await client.screenshot()
  await saveScreenshot(shot, '/tmp/cu-demo-before.jpg')

  // 3. Clear — press C twice (first = C, second = AC)
  console.log('3. Clearing Calculator...')
  const calc = 'com.apple.calculator'
  await client.key('escape', calc)
  await client.wait(0.1)
  await client.key('escape', calc)
  await client.wait(0.2)

  // 4. Type 42 + 58 =
  console.log('4. Computing 42 + 58...')
  await client.type('4', calc); await client.wait(0.05)
  await client.type('2', calc); await client.wait(0.05)
  await client.key('shift+=', calc); await client.wait(0.1)  // +
  await client.type('5', calc); await client.wait(0.05)
  await client.type('8', calc); await client.wait(0.05)
  await client.key('return', calc)
  await client.wait(0.5)

  // 5. Screenshot to see result
  console.log('5. Screenshot (after)...')
  shot = await client.screenshot()
  await saveScreenshot(shot, '/tmp/cu-demo-after.jpg')

  // 6. Read cursor position
  const pos = await client.cursorPosition()
  console.log(`   Cursor: ${pos.content[0]?.text}`)

  // 7. Clipboard round-trip
  console.log('6. Clipboard test...')
  await client.writeClipboard('NAPI works!')
  const clip = await client.readClipboard()
  console.log(`   Clipboard: "${clip.content[0]?.text}"`)

  // 8. Close Calculator
  console.log('7. Closing Calculator...')
  await client.key('command+q', calc)

  await client.close()
  console.log('\n✓ Demo complete — check /tmp/cu-demo-*.jpg')
}

async function saveScreenshot(result: any, path: string) {
  const img = result.content.find((c: any) => c.type === 'image')
  const txt = result.content.find((c: any) => c.type === 'text')
  if (img?.data) {
    await writeFile(path, Buffer.from(img.data, 'base64'))
    console.log(`   ${txt?.text} → ${path}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
