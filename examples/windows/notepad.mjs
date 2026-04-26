/**
 * Windows demo: open Notepad, type text, save, screenshot, clipboard, zoom.
 * Equivalent of demo.ts but for Windows.
 *
 * Run: node examples/demo-windows.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const outDir = path.join(os.tmpdir(), 'cu-demo')
fs.mkdirSync(outDir, { recursive: true })

function save(name, result) {
  const img = result.content.find(c => c.type === 'image')
  if (img) {
    const ext = img.mimeType === 'image/png' ? 'png' : 'jpg'
    const file = path.join(outDir, `${name}.${ext}`)
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'))
    const txt = result.content.find(c => c.type === 'text')?.text || ''
    console.log(`  saved: ${file} (${txt})`)
  }
}

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  const tools = await client.listTools()
  console.log(`+ ${tools.length} tools registered\n`)

  // 1. Screenshot before
  console.log('1. Screenshot (before)...')
  save('01-before', await client.screenshot({ width: 800 }))

  // 2. Open Notepad
  console.log('2. Opening Notepad...')
  await client.callTool('run_script', { language: 'powershell', script: 'Start-Process notepad' })
  await client.wait(2)

  // 3. Type some text
  console.log('3. Typing text...')
  await client.type('Hello from computer-use-mcp v6!\n\n')
  await client.type('This is a cross-platform demo running on Windows.\n')
  await client.type('Features: screenshot, mouse, keyboard, clipboard, UI automation.\n')
  await client.wait(0.5)

  // 4. Screenshot after typing
  console.log('4. Screenshot (after typing)...')
  save('02-after-type', await client.screenshot({ width: 800 }))

  // 5. Zoom into the Notepad text area
  console.log('5. Zooming into text area...')
  const wins = JSON.parse((await client.listWindows()).content[0].text)
  const notepad = wins.find(w => w.bundleId?.includes('notepad'))
  if (notepad) {
    const b = notepad.bounds
    save('03-zoom-text', await client.callTool('zoom', {
      region: [b.x + 10, b.y + 60, b.x + b.width - 10, b.y + Math.min(b.height, 200)]
    }))
  }

  // 6. Clipboard round-trip
  console.log('6. Clipboard test...')
  await client.writeClipboard('Rust NAPI clipboard works!')
  const clip = await client.readClipboard()
  console.log(`  clipboard: "${clip.content[0]?.text}"`)

  // 7. Get display info
  const disp = JSON.parse((await client.getDisplaySize()).content[0].text)
  console.log(`7. Display: ${disp.width}x${disp.height} (scale: ${disp.scaleFactor})`)

  // 8. List windows
  console.log('8. Windows:')
  wins.slice(0, 5).forEach(w => console.log(`  [${w.windowId}] ${w.bundleId} -- ${w.title || '(no title)'}`))

  // 9. Virtual desktops
  const spaces = JSON.parse((await client.listSpaces()).content[0].text)
  console.log(`9. Virtual desktops: ${spaces.displays[0]?.spaces?.length || 0}`)

  // 10. Snapshot (combined)
  console.log('10. Snapshot (combined)...')
  const snap = await client.callTool('snapshot', { use_vision: true, width: 600 })
  const snapImg = snap.content.find(c => c.type === 'image')
  if (snapImg) save('04-snapshot', snap)

  // 11. Save and close Notepad
  console.log('11. Saving and closing Notepad...')
  const savePath = path.join(outDir, 'demo-output.txt')
  await client.key('ctrl+s')
  await client.wait(1)
  await client.type(savePath, undefined, { focusStrategy: 'none' })
  await client.key('return')
  await client.wait(1)
  // Handle "replace?" dialog if it appears
  await client.key('return')
  await client.wait(0.5)
  await client.key('alt+f4')
  await client.wait(0.5)

  // 12. Verify file was saved
  if (fs.existsSync(savePath)) {
    const content = fs.readFileSync(savePath, 'utf-8')
    console.log(`12. File saved: ${savePath} (${content.length} chars)`)
  }

  // 13. Screenshot after
  console.log('13. Screenshot (after)...')
  save('05-after', await client.screenshot({ width: 800 }))

  await client.close()
  console.log(`\n+ Demo complete -- check ${outDir}`)
}

main().catch(e => { console.error(e); process.exit(1) })
