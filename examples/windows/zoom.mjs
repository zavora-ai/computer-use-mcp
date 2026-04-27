/**
 * Zoom demo -- captures full screen, then zooms into specific regions
 * to demonstrate full-resolution inspection.
 *
 * Run: node examples/zoom-demo.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import * as fs from 'fs'
import * as path from 'path'

const outDir = path.join(process.cwd(), 'zoom-output', 'windows')
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
  console.log(`  ${name}: ${(buf.length / 1024).toFixed(0)}KB ${ext} -- ${text}`)
}

console.log('=== Zoom Demo ===\n')

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
console.log(`\nDisplay: ${disp.width}x${disp.height}\n`)

// 4. Zoom into top-left corner (taskbar area on Windows)
console.log('3. Zoom: top-left 300x100 (taskbar/start area):')
const z1 = await client.callTool('zoom', { region: [0, 0, 300, 100] })
saveImage('03-zoom-topleft', z1.content)

// 5. Zoom into center of screen
const cx = Math.floor(disp.width / 2)
const cy = Math.floor(disp.height / 2)
console.log(`4. Zoom: center 400x300 (${cx-200},${cy-150} to ${cx+200},${cy+150}):`)
const z2 = await client.callTool('zoom', { region: [cx - 200, cy - 150, cx + 200, cy + 150] })
saveImage('04-zoom-center', z2.content)

// 6. Zoom into bottom-right (system tray area)
console.log('5. Zoom: bottom-right 400x50 (system tray):')
const z3 = await client.callTool('zoom', {
  region: [disp.width - 400, disp.height - 50, disp.width, disp.height]
})
saveImage('05-zoom-systray', z3.content)

// 7. Zoom with JPEG quality for comparison
console.log('6. Zoom: center 400x300 as JPEG q=90:')
const z4 = await client.callTool('zoom', {
  region: [cx - 200, cy - 150, cx + 200, cy + 150],
  quality: 90,
})
saveImage('06-zoom-center-jpeg', z4.content)

// 8. Tiny zoom -- read a specific UI element
console.log('7. Zoom: tiny 100x30 region (pixel-level detail):')
const z5 = await client.callTool('zoom', { region: [10, 10, 110, 40] })
saveImage('07-zoom-tiny', z5.content)

console.log(`\nAll images saved to: ${outDir}`)
console.log('Open them to compare full screenshot vs zoomed regions.')

await client.close()
process.exit(0)
