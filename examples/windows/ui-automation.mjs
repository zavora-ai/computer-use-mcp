/**
 * Windows UI Automation demo: inspect Notepad's UI tree, find elements, interact.
 *
 * Run: node examples/windows/ui-automation.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const outDir = path.join(os.tmpdir(), 'cu-uia')
fs.mkdirSync(outDir, { recursive: true })

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  console.log(`+ ${(await client.listTools()).length} tools\n`)

  // 1. Open Notepad
  console.log('1. Opening Notepad...')
  await client.callTool('run_script', { language: 'powershell', script: 'Start-Process notepad' })
  await client.wait(2)

  // 2. Find Notepad window
  const winsRaw = JSON.parse((await client.listWindows()).content[0].text)
  const wins = Array.isArray(winsRaw) ? winsRaw : (winsRaw.windows ?? [])
  const notepad = wins.find(w => w.bundleId?.toLowerCase().includes('notepad'))
  if (!notepad) { console.log('Notepad not found'); return }
  console.log(`2. Found Notepad: [${notepad.windowId}] "${notepad.title}"`)

  // 3. Get UI tree
  console.log('\n3. UI Tree (depth=3):')
  const tree = JSON.parse((await client.getUiTree(notepad.windowId, 3)).content[0].text)
  printTree(tree, 0)

  // 4. Find specific elements
  console.log('\n4. Finding buttons...')
  const buttons = JSON.parse((await client.findElement(notepad.windowId, { role: 'AXButton' })).content[0].text)
  buttons.forEach(b => console.log(`  [${b.role}] "${b.label}" at (${b.bounds.x},${b.bounds.y}) ${b.bounds.width}x${b.bounds.height}`))

  // 5. Find the text field
  console.log('\n5. Finding text field...')
  const fields = JSON.parse((await client.findElement(notepad.windowId, { role: 'AXTextField' })).content[0].text)
  fields.forEach(f => console.log(`  [${f.role}] "${f.label}" value="${(f.value || '').slice(0, 50)}"`))

  // 6. Type some text (targeted at the Notepad window)
  console.log('\n6. Typing via UI...')
  await client.type(
    'Hello from UI Automation!\n' +
    'This text was typed into the AXTextField element.\n',
    undefined, { targetWindowId: notepad.windowId, focusStrategy: 'strict' },
  )
  await client.wait(0.5)

  // 7. Get focused element
  console.log('\n7. Focused element:')
  const focused = JSON.parse((await client.getFocusedElement()).content[0].text)
  console.log(`  [${focused.role}] "${focused.label}" value="${(focused.value || '').slice(0, 50)}"`)

  // 8. Zoom into the text area
  console.log('\n8. Zooming into text area...')
  if (fields[0]) {
    const b = fields[0].bounds
    const zoom = await client.callTool('zoom', {
      region: [b.x, b.y, b.x + b.width, b.y + Math.min(b.height, 150)]
    })
    const img = zoom.content.find(c => c.type === 'image')
    if (img) {
      const ext = img.mimeType === 'image/png' ? 'png' : 'jpg'
      fs.writeFileSync(path.join(outDir, `zoom-text.${ext}`), Buffer.from(img.data, 'base64'))
      console.log(`  saved: zoom-text.${ext}`)
    }
  }

  // 9. Screenshot with annotation
  console.log('\n9. Annotated snapshot...')
  const snap = await client.callTool('snapshot', {
    use_vision: true, use_annotation: true, width: 800
  })
  const snapImg = snap.content.find(c => c.type === 'image')
  if (snapImg) {
    const ext = snapImg.mimeType === 'image/png' ? 'png' : 'jpg'
    fs.writeFileSync(path.join(outDir, `annotated.${ext}`), Buffer.from(snapImg.data, 'base64'))
    console.log(`  saved: annotated.${ext}`)
  }

  // 10. Close just this tab without saving (preserves other tabs)
  console.log('\n10. Closing the Notepad tab...')
  await client.key('ctrl+w', undefined, { targetWindowId: notepad.windowId, focusStrategy: 'strict' })
  await client.wait(0.6)
  // Notepad prompts to save the modified tab — decline.
  await client.pressButton(notepad.windowId, "Don't save")
  await client.wait(0.5)

  await client.close()
  console.log(`\n+ Done -- check ${outDir}`)
}

function printTree(node, depth) {
  if (depth > 3) return
  const indent = '  '.repeat(depth)
  const label = node.label ? `"${node.label}"` : ''
  const value = node.value ? ` = "${String(node.value).slice(0, 30)}"` : ''
  const actions = node.actions?.length ? ` [${node.actions.join(',')}]` : ''
  console.log(`${indent}${node.role} ${label}${value}${actions}`)
  if (node.children) {
    node.children.slice(0, 5).forEach(c => printTree(c, depth + 1))
    if (node.children.length > 5) console.log(`${indent}  ... +${node.children.length - 5} more`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
