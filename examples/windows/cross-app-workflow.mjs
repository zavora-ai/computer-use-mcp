/**
 * Cross-app workflow: Scrape a web page -> save to file -> open in Notepad -> verify.
 * Demonstrates clipboard transfer, file system, and app orchestration.
 *
 * Run: node examples/windows/cross-app-workflow.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const outDir = path.join(os.tmpdir(), 'cu-crossapp')
fs.mkdirSync(outDir, { recursive: true })

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  console.log(`+ ${(await client.listTools()).length} tools\n`)

  // Step 1: Scrape a web page
  console.log('1. Scraping example.com...')
  const scrape = await client.callTool('scrape', { url: 'https://example.com' })
  const webContent = scrape.content[0]?.text || ''
  console.log(`   Got ${webContent.length} chars`)

  // Step 2: Save scraped content to a file
  const reportPath = path.join(outDir, 'web-report.txt')
  console.log('2. Saving to file...')
  await client.callTool('filesystem', {
    mode: 'write',
    path: reportPath,
    content: `Web Scrape Report\n${'='.repeat(40)}\nDate: ${new Date().toISOString()}\n\n${webContent}`
  })

  // Step 3: Read it back to verify
  const readBack = await client.callTool('filesystem', { mode: 'read', path: reportPath })
  console.log(`   Verified: ${readBack.content[0]?.text?.slice(0, 60)}...`)

  // Step 4: Open the file in Notepad
  console.log('3. Opening in Notepad...')
  await client.callTool('run_script', {
    language: 'powershell',
    script: `Start-Process notepad "${reportPath}"`
  })
  await client.wait(2)

  // Step 5: Screenshot Notepad showing the content
  console.log('4. Screenshot of Notepad...')
  const shot = await client.screenshot({ width: 800 })
  const img = shot.content.find(c => c.type === 'image')
  if (img) {
    const ext = img.mimeType === 'image/png' ? 'png' : 'jpg'
    fs.writeFileSync(path.join(outDir, `notepad-report.${ext}`), Buffer.from(img.data, 'base64'))
    console.log('   saved: notepad-report.' + ext)
  }

  // Step 6: Zoom into the report header to verify text
  console.log('5. Zooming into report header...')
  const wins = JSON.parse((await client.listWindows()).content[0].text)
  const np = wins.find(w => w.bundleId?.includes('notepad') && w.title?.includes('web-report'))
  if (np) {
    const zoom = await client.callTool('zoom', {
      region: [np.bounds.x + 5, np.bounds.y + 55, np.bounds.x + 500, np.bounds.y + 180]
    })
    const zImg = zoom.content.find(c => c.type === 'image')
    if (zImg) {
      fs.writeFileSync(path.join(outDir, 'zoom-header.png'), Buffer.from(zImg.data, 'base64'))
      console.log('   saved: zoom-header.png')
    }
  }

  // Step 7: Copy content from Notepad via clipboard
  console.log('6. Copying from Notepad via Ctrl+A, Ctrl+C...')
  await client.key('ctrl+a')
  await client.wait(0.2)
  await client.key('ctrl+c')
  await client.wait(0.3)
  const clip = await client.readClipboard()
  console.log(`   Clipboard: ${clip.content[0]?.text?.slice(0, 60)}...`)

  // Step 8: Close Notepad
  console.log('7. Closing Notepad...')
  await client.key('alt+f4')
  await client.wait(0.5)

  // Step 9: Get file info
  const info = await client.callTool('filesystem', { mode: 'info', path: reportPath })
  const meta = JSON.parse(info.content[0]?.text || '{}')
  console.log(`\n+ Report saved: ${reportPath}`)
  console.log(`  Size: ${meta.size} bytes, Modified: ${meta.modified}`)

  await client.close()
  console.log(`\n+ Done -- check ${outDir}`)
}

main().catch(e => { console.error(e); process.exit(1) })
