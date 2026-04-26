/**
 * Windows system info demo: display, windows, processes, registry, filesystem.
 * Shows the non-GUI tools that work without any visual interaction.
 *
 * Run: node examples/windows/system-info.mjs
 */
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  const tools = await client.listTools()
  console.log('+ ' + tools.length + ' tools\n')

  // Display info
  console.log('=== Display ===')
  const disp = JSON.parse((await client.getDisplaySize()).content[0].text)
  console.log('Resolution: ' + disp.width + 'x' + disp.height + ' (' + disp.pixelWidth + 'x' + disp.pixelHeight + ' physical)')
  console.log('Scale: ' + disp.scaleFactor + 'x, Display ID: ' + disp.displayId)

  const displays = JSON.parse((await client.listDisplays()).content[0].text)
  console.log('Monitors: ' + displays.length)

  // Frontmost app
  console.log('\n=== Frontmost App ===')
  const front = JSON.parse((await client.getFrontmostApp()).content[0].text)
  console.log(front.bundleId + ' -- ' + front.displayName + ' (PID ' + front.pid + ')')

  // Running apps
  console.log('\n=== Running Apps ===')
  const apps = JSON.parse((await client.listRunningApps()).content[0].text)
  apps.slice(0, 8).forEach(function(a) { console.log('  ' + a.bundleId + ' (PID ' + a.pid + ')' + (a.isHidden ? ' [hidden]' : '')) })
  console.log('  ... ' + apps.length + ' total')

  // Windows
  console.log('\n=== Windows ===')
  const wins = JSON.parse((await client.listWindows()).content[0].text)
  wins.filter(function(w) { return w.title }).slice(0, 8).forEach(function(w) {
    console.log('  [' + w.windowId + '] ' + w.bundleId + ' -- ' + w.title)
  })
  console.log('  ... ' + wins.length + ' total')

  // Virtual desktops
  console.log('\n=== Virtual Desktops ===')
  const spaces = JSON.parse((await client.listSpaces()).content[0].text)
  var spaceList = spaces.displays[0] && spaces.displays[0].spaces ? spaces.displays[0].spaces : []
  spaceList.forEach(function(s) { console.log('  ' + s.name + ' (' + s.uuid + ')') })

  // Processes (top 10 by memory)
  console.log('\n=== Top Processes ===')
  const procs = await client.callTool('process_kill', { mode: 'list', limit: 10 })
  console.log(procs.content[0].text.slice(0, 500))

  // Registry
  console.log('\n=== Registry (Windows Version) ===')
  const regPath = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
  for (const name of ['ProductName', 'CurrentBuild', 'DisplayVersion']) {
    const r = await client.callTool('registry', { mode: 'get', path: regPath, name: name })
    console.log('  ' + name + ': ' + (r.isError ? 'N/A' : r.content[0].text))
  }

  // Filesystem
  console.log('\n=== Desktop Files ===')
  const desktop = await client.callTool('filesystem', {
    mode: 'list',
    path: 'C:\\Users\\Administrator\\Desktop'
  })
  console.log(desktop.content[0].text.split('\n').slice(0, 10).join('\n'))

  // Tool guide
  console.log('\n=== Tool Guide ===')
  for (const task of ['read small text on screen', 'copy files to desktop', 'edit registry key']) {
    const guide = JSON.parse((await client.getToolGuide(task)).content[0].text)
    console.log('  "' + task + '" -> ' + guide.toolSequence.join(' -> '))
  }

  // App capabilities
  console.log('\n=== App Capabilities ===')
  for (const app of ['notepad.exe', 'chrome.exe', 'explorer.exe']) {
    const caps = JSON.parse((await client.getAppCapabilities(app)).content[0].text)
    console.log('  ' + app + ': running=' + caps.running + ', accessible=' + caps.accessible + ', windows=' + caps.topLevelCount)
  }

  await client.close()
  console.log('\n+ Done')
}

main().catch(function(e) { console.error(e); process.exit(1) })
