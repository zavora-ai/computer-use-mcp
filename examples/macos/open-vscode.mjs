/**
 * macOS demo: open VS Code, create a new file, type some code, and screenshot.
 *
 * Run: node examples/macos/open-vscode.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { writeFile } from 'fs/promises'

const vscode = 'com.microsoft.VSCode'

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // 1. Open VS Code
  console.log('1. Opening VS Code...')
  await client.openApp(vscode)
  await client.wait(3)

  // 2. Screenshot the initial state
  console.log('2. Screenshot (initial)...')
  let shot = await client.screenshot({ target_app: vscode, width: 1024 })
  let img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/vscode-1-initial.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/vscode-1-initial.jpg')
  }

  // 3. Create a new untitled file
  console.log('3. Creating new file...')
  await client.key('command+n', vscode)
  await client.wait(1)

  // 4. Type some code
  console.log('4. Typing code...')
  const code = `/**
 * computer-use-mcp demo — typed by desktop automation
 * This code was written by an AI agent controlling VS Code
 * via the computer-use-mcp MCP server.
 */

interface DesktopAction {
  tool: string
  args: Record<string, unknown>
  timestamp: number
}

async function automateDesktop(actions: DesktopAction[]): Promise<void> {
  for (const action of actions) {
    console.log(\`Executing: \${action.tool}\`)
    // Each action is dispatched through the MCP server
    // which calls the Rust NAPI native module
    await dispatch(action.tool, action.args)
  }
  console.log(\`Completed \${actions.length} actions\`)
}

// Example: click a button, type text, take a screenshot
const workflow: DesktopAction[] = [
  { tool: 'screenshot', args: {}, timestamp: Date.now() },
  { tool: 'left_click', args: { coordinate: [100, 200] }, timestamp: Date.now() },
  { tool: 'type', args: { text: 'Hello from computer-use-mcp!' }, timestamp: Date.now() },
]

automateDesktop(workflow)
`

  await client.writeClipboard(code)
  await client.key('command+v', vscode)
  await client.wait(1)

  // 5. Set language mode to TypeScript for syntax highlighting
  console.log('5. Setting language to TypeScript...')
  await client.key('command+k m', vscode)
  await client.wait(0.5)
  await client.type('typescript', vscode)
  await client.wait(0.5)
  await client.key('return', vscode)
  await client.wait(1)

  // 6. Screenshot the result
  console.log('6. Screenshot (with code)...')
  shot = await client.screenshot({ target_app: vscode, width: 1024 })
  img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/vscode-2-code.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/vscode-2-code.jpg')
  }

  // 7. Open the command palette and show it
  console.log('7. Opening command palette...')
  await client.key('command+shift+p', vscode)
  await client.wait(1)

  shot = await client.screenshot({ target_app: vscode, width: 1024 })
  img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/vscode-3-palette.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/vscode-3-palette.jpg')
  }

  // Close the palette
  await client.key('escape', vscode)
  await client.wait(0.3)

  await client.close()
  console.log('\n✓ Done — check /tmp/vscode-*.jpg')
}

main().catch(e => { console.error(e); process.exit(1) })
