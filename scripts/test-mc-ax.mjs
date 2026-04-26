// Inspect Mission Control's AX tree to find the "+" / "Add desktop" button.
// Mission Control is rendered by Dock.app; its controls are under Dock's AX
// tree when MC is open.

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const native = require('./computer-use-napi.node')

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // Open Mission Control
  console.log('opening MC...')
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1500)

  // List Dock windows — MC renders inside Dock process
  const dockWins = native.listWindows('com.apple.dock')
  console.log(`\nDock windows (${dockWins.length}):`)
  for (const w of dockWins) {
    console.log(`  id=${w.windowId} title=${JSON.stringify(w.title)} bounds=${JSON.stringify(w.bounds)} onScreen=${w.isOnScreen}`)
  }

  // Probe each Dock window for AXButtons
  for (const w of dockWins) {
    if (!w.isOnScreen) continue
    try {
      console.log(`\n  AX tree for Dock window ${w.windowId} "${w.title}":`)
      const tree = native.getUiTree(w.windowId, 4)
      walkAndPrint(tree, 0)

      // Also look for buttons by role
      const buttons = native.findElement(w.windowId, 'AXButton', undefined, undefined, 50)
      console.log(`  buttons in this window: ${buttons.length}`)
      for (const b of buttons) {
        console.log(`    [AXButton] label=${JSON.stringify(b.label)} value=${JSON.stringify(b.value)} bounds=${JSON.stringify(b.bounds)} path=[${b.path.join(',')}]`)
      }
    } catch (e) {
      console.log(`  (error: ${e.message})`)
    }
  }

  // Close MC
  execFileSync('open', ['-a', 'Mission Control'])
  await sleep(1000)

  await client.close()
}

function walkAndPrint(node, depth) {
  const indent = '  '.repeat(depth + 2)
  const labelPart = node.label ? ` "${node.label}"` : ''
  const boundsPart = node.bounds ? ` @(${node.bounds.x},${node.bounds.y} ${node.bounds.width}x${node.bounds.height})` : ''
  console.log(`${indent}${node.role}${labelPart}${boundsPart}${node.actions?.length ? ` actions=[${node.actions.join(',')}]` : ''}`)
  if (node.children) {
    for (const c of node.children) walkAndPrint(c, depth + 1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
