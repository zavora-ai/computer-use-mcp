/**
 * macOS demo: open Terminal, check disk space, capture the output.
 *
 * Uses both the scripting bridge (run_script) and UI automation approaches.
 *
 * Run: node examples/macos/terminal-disk-space.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { writeFile } from 'fs/promises'

const terminal = 'com.apple.Terminal'

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // 1. Get disk space info via shell (fast, no GUI needed)
  console.log('1. Checking disk space via shell...')
  const dfResult = await client.callTool('run_script', {
    language: 'applescript',
    script: 'do shell script "df -h / /System/Volumes/Data 2>/dev/null | head -5"',
    timeout_ms: 5000,
  })
  console.log('   ' + (dfResult.content[0]?.text || '(no output)').split('\n').join('\n   '))

  // 2. Get more detailed info
  console.log('\n2. Detailed storage breakdown...')
  const duResult = await client.callTool('run_script', {
    language: 'applescript',
    script: 'do shell script "du -sh ~/Desktop ~/Documents ~/Downloads ~/Pictures ~/Music ~/Movies 2>/dev/null | sort -rh"',
    timeout_ms: 5000,
  })
  console.log('   ' + (duResult.content[0]?.text || '(no output)').split('\n').join('\n   '))

  // 3. System storage overview
  console.log('\n3. System storage overview...')
  const storageResult = await client.callTool('run_script', {
    language: 'applescript',
    script: 'do shell script "diskutil info / | grep -E \'(Volume Name|Volume Free|Volume Used|Volume Total|File System)\'"',
    timeout_ms: 5000,
  })
  console.log('   ' + (storageResult.content[0]?.text || '(no output)').split('\n').join('\n   '))

  // 4. Now open Terminal and run it visually
  console.log('\n4. Opening Terminal...')
  await client.openApp(terminal)
  await client.wait(2)

  // 5. Type the disk space command
  console.log('5. Running df -h in Terminal...')
  await client.type('echo "=== Disk Space Report ===" && df -h && echo "" && echo "=== Volume Info ===" && diskutil info / | grep -E "Volume Name|Volume Free|Volume Used|File System"', terminal)
  await client.wait(0.3)
  await client.key('return', terminal)
  await client.wait(2)

  // 6. Screenshot the terminal output
  console.log('6. Taking screenshot...')
  const shot = await client.screenshot({ target_app: terminal, width: 1024 })
  const img = shot.content.find(c => c.type === 'image')
  if (img) {
    await writeFile('/tmp/terminal-disk-space.jpg', Buffer.from(img.data, 'base64'))
    console.log('   → /tmp/terminal-disk-space.jpg')
  }

  // 7. Zoom into the output for readability
  console.log('7. Zooming into terminal output...')
  const zoom = await client.callTool('zoom', { region: [0, 100, 800, 500] })
  const zoomImg = zoom.content.find(c => c.type === 'image')
  if (zoomImg) {
    const ext = zoomImg.mimeType === 'image/png' ? 'png' : 'jpg'
    await writeFile(`/tmp/terminal-disk-zoom.${ext}`, Buffer.from(zoomImg.data, 'base64'))
    console.log(`   → /tmp/terminal-disk-zoom.${ext}`)
  }

  await client.close()
  console.log('\n✓ Done — check /tmp/terminal-disk-*.jpg')
}

main().catch(e => { console.error(e); process.exit(1) })
