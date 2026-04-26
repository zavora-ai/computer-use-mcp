/**
 * v4 Window-Aware Demo
 *
 * Real-world scenario: open TextEdit and Safari side by side, then use
 * window-level targeting to type into TextEdit while Safari stays open.
 * Demonstrates:
 *   - list_windows / get_window / get_cursor_window
 *   - activate_app / activate_window with structured diagnostics
 *   - target_window_id on input tools
 *   - focus_strategy (strict / best_effort / none)
 *   - screenshot of a specific window by ID
 *   - FocusFailure recovery pattern
 *
 * Run: npx tsx examples/demo-v4.ts
 */

import { createComputerUseServer } from '../src/server.js'
import { connectInProcess, type ToolResult } from '../src/client.js'
import { writeFile } from 'fs/promises'

// ── Helpers ───────────────────────────────────────────────────────────────────

function text(result: ToolResult): string {
  const c = result.content.find(c => c.type === 'text')
  return c?.type === 'text' ? c.text : ''
}

function json(result: ToolResult): unknown {
  return JSON.parse(text(result))
}

async function saveScreenshot(result: ToolResult, path: string) {
  const img = result.content.find(c => c.type === 'image')
  const txt = result.content.find(c => c.type === 'text')
  if (img?.type === 'image') {
    await writeFile(path, Buffer.from(img.data, 'base64'))
    console.log(`   ${txt?.type === 'text' ? txt.text : ''} → ${path}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  const tools = await client.listTools()
  console.log(`✓ ${tools.length} tools registered (v4)\n`)

  // ── Step 1: Open TextEdit and Safari ────────────────────────────────────

  console.log('1. Opening TextEdit and Safari...')
  await client.openApp('com.apple.TextEdit')
  await client.wait(1.5)

  // Create a new document in TextEdit
  await client.key('command+n', 'com.apple.TextEdit')
  await client.wait(0.5)

  await client.openApp('com.apple.Safari')
  await client.wait(1.5)

  // ── Step 2: List all windows ────────────────────────────────────────────

  console.log('\n2. Listing all on-screen windows...')
  const allWindows = json(await client.listWindows()) as Array<{
    windowId: number; bundleId: string; title: string | null; displayId: number
  }>
  console.log(`   Found ${allWindows.length} windows:`)
  for (const w of allWindows.slice(0, 8)) {
    console.log(`   • [${w.windowId}] ${w.bundleId ?? 'unknown'} — "${w.title ?? '(untitled)'}" (display ${w.displayId})`)
  }

  // ── Step 3: Find TextEdit and Safari windows ────────────────────────────

  console.log('\n3. Finding TextEdit and Safari windows...')
  const textEditWindows = json(await client.listWindows('com.apple.TextEdit')) as Array<{
    windowId: number; title: string | null; bounds: { x: number; y: number; width: number; height: number }
  }>
  const safariWindows = json(await client.listWindows('com.apple.Safari')) as Array<{
    windowId: number; title: string | null; bounds: { x: number; y: number; width: number; height: number }
  }>

  const teWin = textEditWindows[0]
  const safWin = safariWindows[0]

  if (teWin) {
    console.log(`   TextEdit window: [${teWin.windowId}] "${teWin.title ?? '(untitled)'}" at (${teWin.bounds.x}, ${teWin.bounds.y})`)
  } else {
    console.log('   ⚠ No TextEdit window found — skipping window-targeted steps')
  }
  if (safWin) {
    console.log(`   Safari window:   [${safWin.windowId}] "${safWin.title ?? '(untitled)'}" at (${safWin.bounds.x}, ${safWin.bounds.y})`)
  } else {
    console.log('   ⚠ No Safari window found')
  }

  // ── Step 4: Get window details by ID ────────────────────────────────────

  if (teWin) {
    console.log(`\n4. Looking up TextEdit window by ID (${teWin.windowId})...`)
    const detail = json(await client.getWindow(teWin.windowId)) as Record<string, unknown>
    console.log(`   bundleId:   ${detail.bundleId}`)
    console.log(`   title:      ${detail.title}`)
    console.log(`   isOnScreen: ${detail.isOnScreen}`)
    console.log(`   isFocused:  ${detail.isFocused}`)
    console.log(`   displayId:  ${detail.displayId}`)
  }

  // ── Step 5: Get cursor window ───────────────────────────────────────────

  console.log('\n5. Checking which window is under the cursor...')
  const cursorWin = json(await client.getCursorWindow()) as Record<string, unknown> | null
  if (cursorWin) {
    console.log(`   Cursor is over: [${cursorWin.windowId}] ${cursorWin.bundleId} — "${cursorWin.title}"`)
  } else {
    console.log('   Cursor is over the desktop (no window)')
  }

  // ── Step 6: activate_app with structured diagnostics ────────────────────

  console.log('\n6. Activating TextEdit with structured diagnostics...')
  const activateResult = json(await client.activateApp('com.apple.TextEdit')) as {
    requestedBundleId: string; frontmostBefore: string | null
    frontmostAfter: string | null; activated: boolean; reason: string | null
  }
  console.log(`   requestedBundleId: ${activateResult.requestedBundleId}`)
  console.log(`   frontmostBefore:   ${activateResult.frontmostBefore}`)
  console.log(`   frontmostAfter:    ${activateResult.frontmostAfter}`)
  console.log(`   activated:         ${activateResult.activated}`)
  console.log(`   reason:            ${activateResult.reason ?? '(none)'}`)
  await client.wait(0.3)

  // ── Step 7: Type into TextEdit using target_window_id ───────────────────

  if (teWin) {
    console.log(`\n7. Typing into TextEdit window [${teWin.windowId}] using target_window_id + strict focus...`)

    await client.type(
      'Hello from computer-use-mcp v4!\n\n',
      undefined,
      { targetWindowId: teWin.windowId, focusStrategy: 'strict' },
    )
    await client.wait(0.2)

    await client.type(
      'This text was typed using window-level targeting.\n',
      undefined,
      { targetWindowId: teWin.windowId, focusStrategy: 'strict' },
    )
    await client.wait(0.2)

    await client.type(
      'The focus_strategy is "strict" — keystrokes only go here if this window is confirmed frontmost.',
      undefined,
      { targetWindowId: teWin.windowId, focusStrategy: 'strict' },
    )
    await client.wait(0.3)

    console.log('   ✓ Text typed into TextEdit via window ID')
  }

  // ── Step 8: Screenshot a specific window by ID ──────────────────────────

  if (teWin) {
    console.log(`\n8. Screenshotting TextEdit window [${teWin.windowId}] by ID...`)
    const shot = await client.screenshot({ target_window_id: teWin.windowId })
    if (shot.isError) {
      console.log(`   ⚠ Screenshot failed: ${text(shot)}`)
    } else {
      await saveScreenshot(shot, '/tmp/cu-v4-textedit.jpg')
    }
  }

  if (safWin) {
    console.log(`   Screenshotting Safari window [${safWin.windowId}] by ID...`)
    const shot = await client.screenshot({ target_window_id: safWin.windowId })
    if (shot.isError) {
      console.log(`   ⚠ Screenshot failed: ${text(shot)}`)
    } else {
      await saveScreenshot(shot, '/tmp/cu-v4-safari.jpg')
    }
  }

  // ── Step 9: activate_window to raise Safari ─────────────────────────────

  if (safWin) {
    console.log(`\n9. Raising Safari window [${safWin.windowId}] using activate_window...`)
    const raiseResult = json(await client.activateWindow(safWin.windowId)) as {
      windowId: number; activated: boolean; frontmostAfter: string | null; reason: string | null
    }
    console.log(`   windowId:       ${raiseResult.windowId}`)
    console.log(`   activated:      ${raiseResult.activated}`)
    console.log(`   frontmostAfter: ${raiseResult.frontmostAfter}`)
    console.log(`   reason:         ${raiseResult.reason ?? '(none)'}`)
    await client.wait(0.5)
  }

  // ── Step 10: Demonstrate focus_strategy: none ───────────────────────────

  console.log('\n10. Demonstrating focus_strategy: "none" (skip activation)...')
  const frontBefore = json(await client.getFrontmostApp()) as { bundleId: string }
  console.log(`    Frontmost app: ${frontBefore.bundleId}`)
  console.log('    Clicking at (400, 400) with focus_strategy: none — no app switching...')
  await client.click(400, 400, undefined, { focusStrategy: 'none' })
  const frontAfter = json(await client.getFrontmostApp()) as { bundleId: string }
  console.log(`    Frontmost app after click: ${frontAfter.bundleId}`)

  // ── Step 11: Full-screen screenshot ─────────────────────────────────────

  console.log('\n11. Full-screen screenshot...')
  const fullShot = await client.screenshot({ width: 1024 })
  await saveScreenshot(fullShot, '/tmp/cu-v4-fullscreen.jpg')

  // ── Step 12: FocusFailure recovery demo ─────────────────────────────────

  console.log('\n12. Demonstrating FocusFailure recovery pattern...')
  if (teWin) {
    await client.hideApp('com.apple.TextEdit')
    await client.wait(0.3)

    console.log('    TextEdit is hidden. Trying strict keyboard input...')
    const failResult = await client.key('a', undefined, {
      targetWindowId: teWin.windowId,
      focusStrategy: 'strict',
    })

    if (failResult.isError) {
      const failure = JSON.parse(text(failResult))
      console.log(`    ✓ Got FocusFailure as expected:`)
      console.log(`      error:              ${failure.error}`)
      console.log(`      requestedWindowId:   ${failure.requestedWindowId}`)
      console.log(`      targetHidden:        ${failure.targetHidden}`)
      console.log(`      suggestedRecovery:   ${failure.suggestedRecovery}`)

      console.log(`    Following suggestedRecovery: "${failure.suggestedRecovery}"...`)
      if (failure.suggestedRecovery === 'unhide_app') {
        await client.unhideApp('com.apple.TextEdit')
        await client.wait(0.5)
        await client.activateWindow(teWin.windowId)
        await client.wait(0.3)
        await client.key('a', undefined, {
          targetWindowId: teWin.windowId,
          focusStrategy: 'strict',
        })
        console.log('    ✓ Recovery succeeded — keystroke delivered')
      }
    } else {
      console.log('    (TextEdit was not hidden — focus succeeded directly)')
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  console.log('\n13. Cleaning up...')
  await client.activateApp('com.apple.TextEdit')
  await client.wait(0.3)
  await client.key('command+w', 'com.apple.TextEdit')
  await client.wait(0.5)
  await client.key('command+d', 'com.apple.TextEdit')
  await client.wait(0.3)

  await client.close()
  console.log('\n✓ v4 demo complete — check /tmp/cu-v4-*.jpg')
}

main().catch(e => { console.error(e); process.exit(1) })
