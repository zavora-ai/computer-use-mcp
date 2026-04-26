// Accessibility-based approach — no coordinate guessing.
//
// Strategy 1: Open MC, then walk Dock's AXUIElement tree for a button labeled
//   "Add Space", "New Desktop", or similar — press it by accessibility.
// Strategy 2: Use AppleScript's System Events to invoke the button by
//   accessibility role+title, which is how Apple's own automations do it.

import { execFileSync } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const native = require('./computer-use-napi.node')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function snapshot() {
  const s = native.listSpaces()
  return { count: s.displays[0].spaces.length, ids: s.displays[0].spaces.map(sp => sp.id) }
}

async function dumpDockAX() {
  // Dock's PID is reachable even when we can't list its windows via CG.
  // We need a fresh helper: walk the application-level AX tree, not a window tree.
  const apps = native.listRunningApps()
  const dock = apps.find(a => a.bundleId === 'com.apple.dock')
  if (!dock) { console.log('  Dock not found'); return }
  console.log(`  Dock pid=${dock.pid}`)

  // We don't currently expose an "app-level AX tree" API. But we can try:
  // - Use System Events to inspect Dock's UI via AppleScript.
  // This returns JSON we can parse.
  const script = `
    tell application "System Events"
      tell process "Dock"
        set groupList to every UI element
        set output to ""
        repeat with g in groupList
          set output to output & (class of g as string) & ": " & (properties of g as string) & linefeed
        end repeat
        return output
      end tell
    end tell
  `
  const r = execFileSync('osascript', ['-e', script], { encoding: 'utf8' })
  console.log('  Dock process top-level UI elements:')
  console.log(r.split('\n').map(l => '    ' + l).join('\n'))
}

async function tryViaSystemEvents() {
  console.log('\n── Strategy 1: System Events UI scripting against Dock')
  const before = snapshot()
  console.log(`   before: ${before.count} spaces`)

  execFileSync('osascript', ['-e', 'tell application "Mission Control" to launch'])
  await sleep(1500)

  // Inspect Dock's UI elements while MC is open
  console.log('   probing Dock AX tree via System Events...')
  try {
    const script = `
      tell application "System Events"
        tell process "Dock"
          set windowList to every window
          set output to (count of windowList as string) & " windows" & linefeed
          repeat with w in windowList
            try
              set output to output & "win: " & (name of w as string) & linefeed
              set btnList to every button of w
              repeat with b in btnList
                set output to output & "  btn: " & (name of b as string) & " | desc: " & (description of b as string) & linefeed
              end repeat
            end try
          end repeat
          return output
        end tell
      end tell
    `
    const r = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 5000 })
    console.log('   Dock windows / buttons:')
    r.split('\n').forEach(line => line && console.log('     ' + line))
  } catch (e) {
    console.log('   System Events inspection failed:', e.message.split('\n')[0])
  }

  execFileSync('osascript', ['-e', 'tell application "Mission Control" to launch'])
  await sleep(1000)

  const after = snapshot()
  console.log(`   after: ${after.count} spaces (unchanged, just observation)`)
}

async function tryViaDockAXDirect() {
  console.log('\n── Strategy 2: walk Dock AX tree via our native AX functions')
  // Our native functions (get_ui_tree, find_element) take a CGWindowID, but
  // Dock's MC overlay isn't exposed as a CG window. However, the AXUIElement
  // tree still starts at AXUIElementCreateApplication(pid). We don't currently
  // expose that entry point. Let me see if Dock has ANY on-screen window.

  const apps = native.listRunningApps()
  const dock = apps.find(a => a.bundleId === 'com.apple.dock')
  console.log(`   Dock pid: ${dock?.pid}`)

  execFileSync('osascript', ['-e', 'tell application "Mission Control" to launch'])
  await sleep(1500)

  const wins = native.listWindows('com.apple.dock')
  console.log(`   Dock windows via CG: ${wins.length}`)
  for (const w of wins) {
    console.log(`     id=${w.windowId} title=${JSON.stringify(w.title)} bounds=${JSON.stringify(w.bounds)}`)
  }

  execFileSync('osascript', ['-e', 'tell application "Mission Control" to launch'])
  await sleep(1000)
}

async function main() {
  console.log('━'.repeat(60))
  console.log('  Accessibility-first Space creation')
  console.log('━'.repeat(60))

  await tryViaSystemEvents()
  await tryViaDockAXDirect()
}

main().catch(e => { console.error(e); process.exit(1) })
