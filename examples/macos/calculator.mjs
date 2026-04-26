/**
 * macOS demo: open Calculator, compute 42+58, screenshot, clipboard.
 *
 * Run: node examples/macos-calculator.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { writeFile } from 'fs/promises'

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  console.log(`✓ ${(await client.listTools()).length} tools\n`)

  const calc = 'com.apple.calculator'

  console.log('1. Opening Calculator...')
  await client.openApp(calc)
  await client.wait(1)

  console.log('2. Screenshot (before)...')
  const before = await client.screenshot()
  await saveImg(before, '/tmp/cu-calc-before.jpg')

  console.log('3. Clearing...')
  await client.key('escape', calc)
  await client.wait(0.2)

  console.log('4. Computing 42 + 58...')
  for (const k of ['4', '2']) { await client.type(k, calc); await client.wait(0.05) }
  await client.key('shift+=', calc); await client.wait(0.1)
  for (const k of ['5', '8']) { await client.type(k, calc); await client.wait(0.05) }
  await client.key('return', calc)
  await client.wait(0.5)

  console.log('5. Screenshot (after)...')
  await saveImg(await client.screenshot(), '/tmp/cu-calc-after.jpg')

  console.log('6. Clipboard test...')
  await client.writeClipboard('NAPI works!')
  const clip = await client.readClipboard()
  console.log(`   "${clip.content[0]?.text}"`)

  console.log('7. Closing Calculator...')
  await client.key('command+q', calc)

  await client.close()
  console.log('\n✓ Done — check /tmp/cu-calc-*.jpg')
}

async function saveImg(result, path) {
  const img = result.content.find(c => c.type === 'image')
  if (img) {
    await writeFile(path, Buffer.from(img.data, 'base64'))
    const txt = result.content.find(c => c.type === 'text')?.text || ''
    console.log(`   ${txt} → ${path}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
