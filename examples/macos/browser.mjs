/**
 * macOS browser demo: Safari navigation, copy text, multi-tab screenshots.
 *
 * Run: node examples/macos-browser.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { writeFile } from 'fs/promises'

const safari = 'com.apple.Safari'
async function saveImg(r, p) {
  const img = r.content.find(c => c.type === 'image')
  if (img) { await writeFile(p, Buffer.from(img.data, 'base64')); console.log(`   → ${p}`) }
}

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  console.log('✓ Connected\n')

  console.log('1. Opening Safari...')
  await client.openApp(safari)
  await client.wait(1)
  await saveImg(await client.screenshot(), '/tmp/cu-browser-1.jpg')

  console.log('2. Navigating to example.com...')
  await client.key('command+l', safari); await client.wait(0.3)
  await client.writeClipboard('https://example.com')
  await client.key('command+v', safari); await client.wait(0.3)
  await client.key('return', safari); await client.wait(2.5)
  await saveImg(await client.screenshot(), '/tmp/cu-browser-2.jpg')

  console.log('3. Copying page text...')
  await client.key('command+a', safari); await client.wait(0.2)
  await client.key('command+c', safari); await client.wait(0.3)
  const clip = await client.readClipboard()
  console.log(`   ${clip.content[0]?.text?.slice(0, 80)}...`)

  console.log('4. New tab → github.com...')
  await client.key('command+t', safari); await client.wait(0.5)
  await client.writeClipboard('https://github.com')
  await client.key('command+v', safari); await client.wait(0.3)
  await client.key('return', safari); await client.wait(3)
  await saveImg(await client.screenshot(), '/tmp/cu-browser-3.jpg')

  await client.close()
  console.log('\n✓ Done — check /tmp/cu-browser-*.jpg')
}

main().catch(e => { console.error(e); process.exit(1) })
