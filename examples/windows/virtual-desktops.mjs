/**
 * Windows virtual desktop demo: create desktop, open app, work, switch back, cleanup.
 *
 * Run: node examples/windows/virtual-desktops.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const outDir = path.join(os.tmpdir(), 'cu-vdesktop')
fs.mkdirSync(outDir, { recursive: true })

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  console.log(`+ ${(await client.listTools()).length} tools\n`)

  // 1. List current desktops
  let spaces = JSON.parse((await client.listSpaces()).content[0].text)
  const initialCount = spaces.displays[0]?.spaces?.length || 0
  console.log(`1. Current desktops: ${initialCount}`)
  spaces.displays[0]?.spaces?.forEach(s => console.log(`   * ${s.name} (${s.uuid})`))

  // 2. Create a new desktop
  console.log('\n2. Creating new desktop...')
  const created = JSON.parse((await client.createAgentSpace()).content[0].text)
  console.log(`   ${created.created ? '+ Created' : 'x Failed'}: ${created.name}`)

  // 3. Verify
  spaces = JSON.parse((await client.listSpaces()).content[0].text)
  console.log(`   Now: ${spaces.displays[0]?.spaces?.length} desktops`)

  // 4. Open Notepad on the new desktop
  console.log('\n3. Opening Notepad on new desktop...')
  await client.callTool('run_script', { language: 'powershell', script: 'Start-Process notepad' })
  await client.wait(2)

  // 5. Type a message
  console.log('4. Typing message...')
  await client.type('This was written on a virtual desktop created by computer-use-mcp!\n\n')
  await client.type('Desktop automation across virtual desktops works seamlessly.\n')
  await client.wait(0.5)

  // 6. Screenshot on the new desktop
  console.log('5. Screenshot on new desktop...')
  const img = (await client.screenshot({ width: 800 })).content.find(c => c.type === 'image')
  if (img) {
    fs.writeFileSync(path.join(outDir, 'new-desktop.jpg'), Buffer.from(img.data, 'base64'))
    console.log('   saved: new-desktop.jpg')
  }

  // 7. Save the file
  console.log('6. Saving file...')
  const savePath = path.join(outDir, 'vdesktop-note.txt')
  await client.key('ctrl+s')
  await client.wait(1)
  await client.type(savePath, undefined, { focusStrategy: 'none' })
  await client.key('return')
  await client.wait(1)
  await client.key('return') // handle replace dialog
  await client.wait(0.5)
  await client.key('alt+f4')
  await client.wait(0.5)

  // 8. Switch back to original desktop
  console.log('\n7. Switching back to original desktop...')
  for (let i = 0; i < 5; i++) {
    await client.key('ctrl+win+left')
    await client.wait(0.3)
  }

  // 9. Verify file from original desktop
  if (fs.existsSync(savePath)) {
    console.log(`8. File verified: ${fs.readFileSync(savePath, 'utf-8').slice(0, 60)}...`)
  }

  // 10. Navigate to new desktop and close it
  console.log('\n9. Cleaning up -- closing new desktop...')
  for (let i = 0; i < 5; i++) {
    await client.key('ctrl+win+right')
    await client.wait(0.3)
  }
  await client.callTool('destroy_space', { space_id: 0 })
  await client.wait(0.5)

  // 11. Verify cleanup
  spaces = JSON.parse((await client.listSpaces()).content[0].text)
  console.log(`10. Final desktops: ${spaces.displays[0]?.spaces?.length} (was ${initialCount})`)

  await client.close()
  console.log(`\n+ Done -- check ${outDir}`)
}

main().catch(e => { console.error(e); process.exit(1) })
