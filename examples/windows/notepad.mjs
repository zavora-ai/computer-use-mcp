/**
 * Windows demo: open Notepad, type text, save, screenshot, clipboard, zoom.
 * Equivalent of demo.ts but for Windows.
 *
 * Windows 11 Notepad is single-instance + tabbed. To avoid disturbing any
 * document you already have open, this demo detects an existing Notepad window
 * and opens a NEW TAB (Ctrl+N) to work in, then closes only that tab (Ctrl+W)
 * instead of Alt+F4. If no Notepad is running it launches a fresh instance.
 *
 * Run: node examples/windows/notepad.mjs
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

/** List only Notepad windows, tolerant of the v7 { windows: [...] } shape. */
async function notepadWindows(client) {
  const raw = JSON.parse((await client.listWindows()).content[0].text)
  const arr = Array.isArray(raw) ? raw : (raw.windows ?? [])
  return arr.filter(w => w.bundleId?.toLowerCase().includes('notepad'))
}

/**
 * Return the window id of a Notepad window with a fresh, empty scratch tab.
 * - If Notepad is already open: activate it and open a new tab (Ctrl+N) so we
 *   never type into an existing document.
 * - If not: launch a fresh instance (its single Untitled tab is our scratch).
 */
async function openScratchTab(client) {
  const existing = await notepadWindows(client)
  if (existing.length > 0) {
    const winId = existing[0].windowId
    await client.activateWindow(winId)
    await client.wait(0.3)
    await client.key('ctrl+n', undefined, { targetWindowId: winId, focusStrategy: 'strict' })
    await client.wait(0.6)
    return winId
  }
  await client.callTool('run_script', { language: 'powershell', script: 'Start-Process notepad' })
  await client.wait(2)
  const fresh = await notepadWindows(client)
  return fresh[0]?.windowId
}

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  const tools = await client.listTools()
  console.log(`+ ${tools.length} tools registered\n`)

  // 1. Screenshot before
  console.log('1. Screenshot (before)...')
  save('01-before', await client.screenshot({ width: 800 }))

  // 2. Open a fresh Notepad scratch tab (never touches existing tabs)
  console.log('2. Opening a fresh Notepad tab...')
  const winId = await openScratchTab(client)
  if (!winId) { console.log('   Notepad window not found'); await client.close(); return }
  console.log(`   working in window [${winId}]`)

  // 3. Type some text into the scratch tab (targeted at our window).
  // Type the whole block in ONE call: multi-line text routes through the
  // clipboard internally, which is reliable and preserves line breaks.
  // (Rapid back-to-back type calls can race the clipboard, so prefer one call.)
  console.log('3. Typing text...')
  const opts = { targetWindowId: winId, focusStrategy: 'strict' }
  await client.type(
    'Hello from computer-use-mcp v7!\n\n' +
    'This is a cross-platform demo running on Windows.\n' +
    'Features: screenshot, mouse, keyboard, clipboard, UI automation.\n',
    undefined, opts,
  )
  await client.wait(0.5)

  // 4. Screenshot after typing
  console.log('4. Screenshot (after typing)...')
  save('02-after-type', await client.screenshot({ width: 800 }))

  // 5. Zoom into the Notepad text area
  console.log('5. Zooming into text area...')
  const wins = await notepadWindows(client)
  const notepad = wins.find(w => w.windowId === winId) ?? wins[0]
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
  console.log('8. Notepad windows:')
  wins.slice(0, 5).forEach(w => console.log(`  [${w.windowId}] ${w.bundleId} -- ${w.title || '(no title)'}`))

  // 9. Virtual desktops
  const spaces = JSON.parse((await client.listSpaces()).content[0].text)
  console.log(`9. Virtual desktops: ${spaces.displays[0]?.spaces?.length || 0}`)

  // 10. Snapshot (combined)
  console.log('10. Snapshot (combined)...')
  const snap = await client.callTool('snapshot', { use_vision: true, width: 600 })
  const snapImg = snap.content.find(c => c.type === 'image')
  if (snapImg) save('04-snapshot', snap)

  // 11. Save the scratch tab, then close just that tab (Ctrl+W, not Alt+F4).
  // Drive the Save As dialog via accessibility: set the "File name:" field and
  // press "Save". This is far more reliable than typing/pasting into the dialog.
  console.log('11. Saving and closing the scratch tab...')
  const savePath = path.join(outDir, 'demo-output.txt')
  await client.key('ctrl+s', undefined, opts)
  await client.wait(1.2)
  await client.setValue(winId, 'AXTextField', 'File name:', savePath)
  await client.wait(0.4)
  await client.pressButton(winId, 'Save')
  await client.wait(1.2)
  // If the file already existed, confirm the overwrite prompt.
  await client.pressButton(winId, 'Yes')
  await client.wait(0.5)
  // Close only our tab — preserves any other tabs the user had open.
  await client.key('ctrl+w', undefined, { targetWindowId: winId, focusStrategy: 'strict' })
  await client.wait(0.5)

  // 12. Verify file was saved
  if (fs.existsSync(savePath)) {
    const content = fs.readFileSync(savePath, 'utf-8')
    console.log(`12. File saved: ${savePath} (${content.length} chars)`)
  } else {
    console.log(`12. File NOT found at ${savePath}`)
  }

  // 13. Screenshot after
  console.log('13. Screenshot (after)...')
  save('05-after', await client.screenshot({ width: 800 }))

  await client.close()
  console.log(`\n+ Demo complete -- check ${outDir}`)
}

main().catch(e => { console.error(e); process.exit(1) })
