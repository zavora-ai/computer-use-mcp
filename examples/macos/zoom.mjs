/**
 * macOS zoom demo — captures full screen, then zooms into specific regions
 * to demonstrate full-resolution inspection.
 *
 * Comparable to examples/windows/zoom.mjs — same structure, macOS-specific
 * regions (menu bar, Dock, Spotlight).
 *
 * Run: node examples/macos/zoom.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import * as fs from 'fs'
import * as path from 'path'

const outDir = path.join(process.cwd(), 'zoom-output', 'macos')
fs.mkdirSync(outDir, { recursive: true })

const server = createComputerUseServer()
const client = await connectInProcess(server)

function saveImage(name, content) {
  const img = content.find(c => c.type === 'image')
  if (!img) { console.log(`  ${name}: no image`); return }
  const ext = img.mimeType === 'image/png' ? 'png' : 'jpg'
  const buf = Buffer.from(img.data, 'base64')
  const file = path.join(outDir, `${name}.${ext}`)
  fs.writeFileSync(file, buf)
  const text = content.find(c => c.type === 'text')?.text || ''
  console.log(`  ${name}: ${(buf.length / 1024).toFixed(0)}KB ${ext} — ${text}`)
}

console.log('=== macOS Zoom Demo ===\n')

// 1. Full screenshot (resized to 800px, JPEG)
console.log('1. Full screenshot (800px JPEG):')
const full = await client.screenshot({ width: 800, quality: 80 })
saveImage('01-full-jpeg', full.content)

// 2. Full screenshot (PNG lossless)
console.log('2. Full screenshot (800px PNG):')
const fullPng = await client.screenshot({ width: 800, quality: 0 })
saveImage('02-full-png', fullPng.content)

// 3. Get display size for reference
const dispResult = await client.getDisplaySize()
const disp = JSON.parse(dispResult.content[0].text)
console.log(`\nDisplay: ${disp.width}x${disp.height} (scale: ${disp.scaleFactor}x)\n`)

// 4. Zoom into the menu bar (top of screen, macOS-specific)
console.log('3. Zoom: menu bar (top 300x25):')
const z1 = await client.callTool('zoom', { region: [0, 0, 300, 25] })
saveImage('03-zoom-menubar', z1.content)

// 5. Zoom into the top-right (clock, Wi-Fi, battery, Control Center)
console.log('4. Zoom: status bar top-right 400x25:')
const z2 = await client.callTool('zoom', {
  region: [disp.width - 400, 0, disp.width, 25]
})
saveImage('04-zoom-statusbar', z2.content)

// 6. Zoom into center of screen
const cx = Math.floor(disp.width / 2)
const cy = Math.floor(disp.height / 2)
console.log(`5. Zoom: center 400x300 (${cx - 200},${cy - 150} to ${cx + 200},${cy + 150}):`)
const z3 = await client.callTool('zoom', {
  region: [cx - 200, cy - 150, cx + 200, cy + 150]
})
saveImage('05-zoom-center', z3.content)

// 7. Zoom into the Dock (bottom center of screen)
const dockY = disp.height - 80
console.log(`6. Zoom: Dock area (bottom center 600x80):`)
const z4 = await client.callTool('zoom', {
  region: [cx - 300, dockY, cx + 300, disp.height]
})
saveImage('06-zoom-dock', z4.content)

// 8. Zoom with JPEG quality for comparison
console.log('7. Zoom: center 400x300 as JPEG q=90 (compare with PNG):')
const z5 = await client.callTool('zoom', {
  region: [cx - 200, cy - 150, cx + 200, cy + 150],
  quality: 90,
})
saveImage('07-zoom-center-jpeg', z5.content)

// 9. Tiny zoom — pixel-level detail (Apple logo area)
console.log('8. Zoom: tiny 100x25 region (Apple menu, pixel-level):')
const z6 = await client.callTool('zoom', { region: [0, 0, 100, 25] })
saveImage('08-zoom-apple-menu', z6.content)

// 10. Zoom into a specific app window if one is open
console.log('9. Zoom: frontmost app title bar area:')
const front = await client.getFrontmostApp()
const frontData = JSON.parse(front.content[0]?.text || '{}')
const wins = JSON.parse((await client.listWindows(frontData.bundleId)).content[0]?.text || '[]')
if (wins.length > 0 && wins[0].bounds) {
  const b = wins[0].bounds
  // Zoom into the title bar of the frontmost window
  const z7 = await client.callTool('zoom', {
    region: [b.x, b.y, b.x + Math.min(b.width, 500), b.y + 40]
  })
  saveImage('09-zoom-titlebar', z7.content)
  console.log(`   (${frontData.bundleId} — "${wins[0].title}")`)
} else {
  console.log('   (no frontmost window found)')
}

console.log(`\nAll images saved to: ${outDir}`)
console.log('Open them to compare full screenshot vs zoomed regions.')
console.log('\nKey differences from Windows zoom demo:')
console.log('  • Menu bar at top (vs taskbar at bottom)')
console.log('  • Dock at bottom center (vs taskbar icons)')
console.log('  • Status bar icons top-right (vs system tray bottom-right)')
console.log('  • Retina display: logical vs physical pixels')

await client.close()
process.exit(0)
