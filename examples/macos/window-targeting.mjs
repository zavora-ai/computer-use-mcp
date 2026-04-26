/**
 * macOS v4 demo: TextEdit + Safari side-by-side, window targeting, focus recovery.
 *
 * Run: node examples/macos-window-targeting.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { writeFile } from 'fs/promises'

function text(r) { return r.content.find(c => c.type === 'text')?.text || '' }
function json(r) { return JSON.parse(text(r)) }
async function saveImg(r, p) {
  const img = r.content.find(c => c.type === 'image')
  if (img) { await writeFile(p, Buffer.from(img.data, 'base64')); console.log(`   → ${p}`) }
}

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  console.log(`✓ ${(await client.listTools()).length} tools (v4)\n`)

  console.log('1. Opening TextEdit + Safari...')
  await client.openApp('com.apple.TextEdit')
  await client.wait(1.5)
  await client.key('command+n', 'com.apple.TextEdit')
  await client.wait(0.5)
  await client.openApp('com.apple.Safari')
  await client.wait(1.5)

  console.log('2. Listing windows...')
  const wins = json(await client.listWindows())
  wins.slice(0, 5).forEach(w => console.log(`   [${w.windowId}] ${w.bundleId} — "${w.title || ''}"`))

  const teWin = json(await client.listWindows('com.apple.TextEdit'))[0]
  if (teWin) {
    console.log(`\n3. Typing into TextEdit [${teWin.windowId}] with strict focus...`)
    await client.type('Hello from v4 window targeting!\n', undefined, { targetWindowId: teWin.windowId, focusStrategy: 'strict' })
    await saveImg(await client.screenshot({ target_window_id: teWin.windowId }), '/tmp/cu-v4-textedit.jpg')
  }

  console.log('\n4. Full screenshot...')
  await saveImg(await client.screenshot({ width: 1024 }), '/tmp/cu-v4-full.jpg')

  console.log('5. Cleanup...')
  await client.activateApp('com.apple.TextEdit')
  await client.wait(0.3)
  await client.key('command+w', 'com.apple.TextEdit')
  await client.wait(0.5)
  await client.key('command+d', 'com.apple.TextEdit')

  await client.close()
  console.log('\n✓ Done — check /tmp/cu-v4-*.jpg')
}

main().catch(e => { console.error(e); process.exit(1) })
