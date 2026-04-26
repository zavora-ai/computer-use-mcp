// Verify: when we open TextEdit from the current Space, does its window
// land in the current Space or elsewhere?
//
// Uses CGSCopySpacesForWindows to read the exact Space assignment of the
// new window, and compares it to the active Space at the time of launch.

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const native = require('./computer-use-napi.node')

// We need CGSCopySpacesForWindows (not yet exposed via our NAPI). Shell out
// to a tiny helper binary instead — faster to write than another FFI layer.
import { execFileSync, execFile } from 'child_process'
import { writeFileSync, chmodSync, existsSync, unlinkSync } from 'fs'

function buildSpaceProbe() {
  const src = `
#include <stdio.h>
#include <stdint.h>
#include <dlfcn.h>
#include <CoreFoundation/CoreFoundation.h>
int main(int argc, char **argv) {
    uint32_t wid = (uint32_t)atoi(argv[1]);
    void *h = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY);
    uint32_t (*mainConn)(void) = dlsym(h, "CGSMainConnectionID");
    CFArrayRef (*copy)(uint32_t, int, CFArrayRef) = dlsym(h, "CGSCopySpacesForWindows");
    uint32_t cid = mainConn();
    CFNumberRef widN = CFNumberCreate(NULL, kCFNumberSInt32Type, &wid);
    CFArrayRef wins = CFArrayCreate(NULL, (const void**)&widN, 1, &kCFTypeArrayCallBacks);
    CFArrayRef spaces = copy(cid, 0x7, wins);
    if (!spaces) { printf("[]"); return 0; }
    printf("[");
    for (CFIndex i = 0; i < CFArrayGetCount(spaces); i++) {
        int64_t sid = 0;
        CFNumberGetValue(CFArrayGetValueAtIndex(spaces, i), kCFNumberSInt64Type, &sid);
        printf("%s%lld", i ? "," : "", sid);
    }
    printf("]");
    return 0;
}
`
  writeFileSync('/tmp/cu-space-probe.c', src)
  execFileSync('clang', ['/tmp/cu-space-probe.c', '-o', '/tmp/cu-space-probe',
    '-framework', 'CoreFoundation'])
}

function spacesForWindow(windowId) {
  if (!existsSync('/tmp/cu-space-probe')) buildSpaceProbe()
  const out = execFileSync('/tmp/cu-space-probe', [String(windowId)]).toString()
  return JSON.parse(out)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('━'.repeat(60))
  console.log('  Space assignment probe — where does TextEdit land?')
  console.log('━'.repeat(60))

  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // ── 1. Record active Space BEFORE launching anything ────────────────────
  const before = native.getActiveSpace()
  const listBefore = native.listSpaces()
  console.log(`\nActive Space (before launch):  ${before}`)
  console.log(`User-visible Spaces on this display:`)
  for (const d of listBefore.displays) {
    for (const s of d.spaces) {
      console.log(`  • id=${s.id} type=${s.type} uuid=${s.uuid || '(none)'}`)
    }
  }

  // ── 2. Snapshot TextEdit windows before launch ───────────────────────────
  const teBefore = new Set(
    JSON.parse((await client.listWindows('com.apple.TextEdit')).content[0].text)
      .map(w => w.windowId),
  )
  console.log(`\nTextEdit windows before launch: ${teBefore.size}`)

  // ── 3. Launch TextEdit + create a new document ──────────────────────────
  console.log('\nLaunching TextEdit + creating a document...')
  const t0 = Date.now()
  const r = await client.runScript('applescript', `
    tell application "TextEdit"
      activate
      set newDoc to make new document
      set text of newDoc to "Space probe — which Space did I land in?"
      return name of newDoc
    end tell
  `, 5000)
  console.log(`  runScript: ${r.content[0].text} (${Date.now()-t0}ms)`)

  // Give the window server a beat to register the new window.
  await sleep(600)

  // ── 4. Record active Space AFTER (did macOS switch?) ─────────────────────
  const after = native.getActiveSpace()
  console.log(`\nActive Space (after launch):   ${after}`)
  if (after !== before) {
    console.log(`  ⚠ macOS SWITCHED you from Space ${before} to Space ${after}!`)
  } else {
    console.log(`  ✓ Active Space unchanged — you stayed where you were.`)
  }

  // ── 5. Find the new window and check its Space assignment ────────────────
  const teAfter = JSON.parse((await client.listWindows('com.apple.TextEdit')).content[0].text)
  const newWins = teAfter.filter(w => !teBefore.has(w.windowId))
  console.log(`\nTextEdit windows after launch:  ${teAfter.length} (${newWins.length} new)`)

  if (newWins.length === 0) {
    console.log('  ⚠ No new TextEdit window appeared on-screen!')
    console.log('  That means the new window is on a DIFFERENT Space than you.')
    // Search all Spaces — maybe the window exists but isn't on-screen.
    // Try listWindows without the on-screen filter... we can't from JS yet,
    // but the spacesForWindow probe works on any window id if we know it.
    // Alternative: query AXWindows for TextEdit via AXUIElement.
    console.log('\n  Looking up TextEdit AX windows (which include off-Space windows)...')
    // Use get_ui_tree... actually, the simplest: osascript name of documents
    const docs = await client.runScript('applescript',
      'tell application "TextEdit" to return name of every document', 3000)
    console.log(`  document names: ${docs.content[0].text}`)
  } else {
    for (const w of newWins) {
      const spaces = spacesForWindow(w.windowId)
      console.log(`  new window: id=${w.windowId} title="${w.title}"`)
      console.log(`    bounds: ${JSON.stringify(w.bounds)}`)
      console.log(`    assigned to Spaces: [${spaces.join(', ')}]`)
      if (spaces.includes(before)) {
        console.log(`    ✓ Window is in your original Space (${before})`)
      } else if (spaces.includes(after)) {
        console.log(`    → Window is in Space ${after} (macOS moved you to it)`)
      } else {
        console.log(`    ⚠ Window is in a Space you are not on!`)
      }
    }
  }

  // ── 6. Cleanup ───────────────────────────────────────────────────────────
  console.log('\nCleanup — closing test document...')
  await client.runScript('applescript', `
    tell application "TextEdit"
      if (count of documents) > 0 then close document 1 saving no
    end tell
  `, 3000)

  await client.close()
  console.log('\n' + '━'.repeat(60))
  console.log('  Verdict:')
  if (after === before && newWins.some(w => spacesForWindow(w.windowId).includes(before))) {
    console.log('  ✓ Computer use operations stayed in your Space.')
  } else if (after !== before) {
    console.log('  ✗ macOS switched Spaces on launch. This is the bad case.')
  } else {
    console.log('  ~ You stayed in place, but the window landed elsewhere.')
  }
  console.log('━'.repeat(60))
}

main().catch(e => {
  console.error('FATAL:', e.message)
  console.error(e.stack)
  process.exit(1)
})
