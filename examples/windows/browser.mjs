/**
 * Windows browser demo: open Chrome/Edge, navigate, copy text, multi-tab.
 *
 * Run: node examples/windows/browser.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const outDir = path.join(os.tmpdir(), 'cu-browser')
fs.mkdirSync(outDir, { recursive: true })

function save(name, result) {
  const img = result.content.find(c => c.type === 'image')
  if (img) {
    const ext = img.mimeType === 'image/png' ? 'png' : 'jpg'
    fs.writeFileSync(path.join(outDir, `${name}.${ext}`), Buffer.from(img.data, 'base64'))
    console.log(`  saved: ${name}.${ext}`)
  }
}

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  console.log(`+ ${(await client.listTools()).length} tools\n`)

  // 1. Open browser via PowerShell
  console.log('1. Opening browser...')
  await client.callTool('run_script', {
    language: 'powershell',
    script: 'Start-Process "https://example.com"'
  })
  await client.wait(3)

  // 2. Screenshot
  console.log('2. Screenshot (example.com)...')
  save('01-example', await client.screenshot({ width: 800 }))

  // 3. Zoom into the page content
  console.log('3. Zooming into page content...')
  const disp = JSON.parse((await client.getDisplaySize()).content[0].text)
  save('02-zoom-content', await client.callTool('zoom', {
    region: [100, 200, 800, 500]
  }))

  // 4. Copy page text via Ctrl+A, Ctrl+C
  console.log('4. Copying page text...')
  await client.key('ctrl+a')
  await client.wait(0.2)
  await client.key('ctrl+c')
  await client.wait(0.3)
  const clip = await client.readClipboard()
  console.log(`  copied: ${clip.content[0]?.text?.slice(0, 80)}...`)

  // 5. Open new tab
  console.log('5. New tab -> github.com...')
  await client.key('ctrl+t')
  await client.wait(0.5)
  await client.writeClipboard('https://github.com')
  await client.key('ctrl+v')
  await client.wait(0.3)
  await client.key('return')
  await client.wait(3)

  // 6. Screenshot
  console.log('6. Screenshot (github.com)...')
  save('03-github', await client.screenshot({ width: 800 }))

  // 7. Scrape the page
  console.log('7. Scraping github.com...')
  const scrape = await client.callTool('scrape', { url: 'https://github.com' })
  console.log(`  scraped: ${scrape.content[0]?.text?.slice(0, 100)}...`)

  await client.close()
  console.log(`\n+ Done -- check ${outDir}`)
}

main().catch(e => { console.error(e); process.exit(1) })
