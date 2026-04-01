/**
 * Browser test v2: use clipboard paste for URL entry (reliable with address bars).
 */

import { createComputerUseServer } from './server.js'
import { connectInProcess } from './client.js'
import { writeFile } from 'fs/promises'

const safari = 'com.apple.Safari'

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  console.log('✓ Connected\n')

  // 1. Open Safari
  console.log('1. Opening Safari...')
  await client.openApp(safari)
  await client.wait(1)

  // 2. Screenshot current state
  console.log('2. Screenshot (before)...')
  await save(await client.screenshot(), '/tmp/cu-browser-1.jpg')

  // 3. Navigate via clipboard paste (reliable with address bars)
  console.log('3. Navigating to example.com...')
  await client.key('command+l', safari)       // focus address bar
  await client.wait(0.3)
  await client.writeClipboard('https://example.com')
  await client.key('command+v', safari)       // paste URL
  await client.wait(0.3)
  await client.key('return', safari)          // go
  await client.wait(2.5)                      // let page load

  // 4. Screenshot
  console.log('4. Screenshot (example.com)...')
  await save(await client.screenshot(), '/tmp/cu-browser-2.jpg')

  // 5. Copy page text
  console.log('5. Selecting and copying page text...')
  await client.key('command+a', safari)
  await client.wait(0.2)
  await client.key('command+c', safari)
  await client.wait(0.3)
  const clip = await client.readClipboard()
  const text = clip.content[0]?.text ?? ''
  console.log(`   Copied ${text.length} chars: "${text.slice(0, 100).replace(/\n/g, ' ')}..."`)

  // 6. New tab → github.com
  console.log('6. New tab → github.com...')
  await client.key('command+t', safari)
  await client.wait(0.5)
  await client.writeClipboard('https://github.com')
  await client.key('command+v', safari)
  await client.wait(0.3)
  await client.key('return', safari)
  await client.wait(3)

  // 7. Screenshot
  console.log('7. Screenshot (github.com)...')
  await save(await client.screenshot(), '/tmp/cu-browser-3.jpg')

  await client.close()
  console.log('\n✓ Done — check /tmp/cu-browser-*.jpg')
}

async function save(result: any, path: string) {
  const img = result.content.find((c: any) => c.type === 'image')
  const txt = result.content.find((c: any) => c.type === 'text')
  if (img?.data) {
    await writeFile(path, Buffer.from(img.data, 'base64'))
    console.log(`   ${txt?.text} → ${path}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
