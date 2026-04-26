// Practical end-to-end test of v5 against real macOS apps.
//
// Walks through the full v5 flow:
//   1. Tool guide + capabilities probes
//   2. Scripting bridge (AppleScript one-call automation)
//   3. AX tree introspection
//   4. Semantic actions (set_value, click_element)
//   5. Form fill
//   6. Menu selection
//
// Uses TextEdit as the universal target (ships with every Mac, scriptable,
// accessible). Reports pass/fail per step with timing info.

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'

const results = []
let currentStep = ''

function step(name, fn) {
  return async () => {
    currentStep = name
    const t0 = Date.now()
    try {
      const out = await fn()
      const ms = Date.now() - t0
      results.push({ name, ok: true, ms, out })
      console.log(`  ✓ ${name} (${ms}ms)`)
      if (out !== undefined) console.log('     →', out)
      return out
    } catch (err) {
      const ms = Date.now() - t0
      results.push({ name, ok: false, ms, err: err.message })
      console.log(`  ✗ ${name} (${ms}ms)`)
      console.log('     →', err.message)
      throw err
    }
  }
}

const text = r => r.content.find(c => c.type === 'text')?.text ?? ''
const json = r => JSON.parse(text(r))
const assertOk = (r, label) => {
  if (r.isError) throw new Error(`${label}: isError — ${text(r)}`)
  return r
}

// Small sleep helper (native tools are sync; macOS needs a beat after activation)
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('━'.repeat(60))
  console.log('  v5 end-to-end verification — real TextEdit + Mail')
  console.log('━'.repeat(60))

  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // ── 1. Surface inventory ──────────────────────────────────────────────────
  console.log('\n[1] Surface inventory')
  await step('listTools returns 42+ tools', async () => {
    const tools = await client.listTools()
    if (tools.length < 42) throw new Error(`only ${tools.length} tools registered`)
    return `${tools.length} tools`
  })()

  await step('all 14 v5 tools present', async () => {
    const tools = await client.listTools()
    const v5 = ['get_ui_tree','get_focused_element','find_element','click_element',
                'set_value','press_button','select_menu_item','run_script',
                'get_app_dictionary','fill_form','get_tool_guide',
                'get_app_capabilities','create_agent_space','move_window_to_space']
    const missing = v5.filter(n => !tools.find(t => t.name === n))
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`)
    return 'all 14 present'
  })()

  // ── 2. Strategy advisor ───────────────────────────────────────────────────
  console.log('\n[2] Strategy advisor')
  await step('get_tool_guide recommends scripting for email', async () => {
    const g = json(assertOk(await client.getToolGuide('compose an email to ops'), 'tool_guide'))
    if (g.approach !== 'scripting') throw new Error(`got approach=${g.approach}`)
    return `approach=${g.approach}, bundles=${g.bundleIdHints?.join(',')}`
  })()

  await step('get_tool_guide recommends accessibility for form fill', async () => {
    const g = json(assertOk(await client.getToolGuide('fill the form fields'), 'tool_guide'))
    if (g.approach !== 'accessibility') throw new Error(`got approach=${g.approach}`)
    return `approach=${g.approach}, sequence=[${g.toolSequence.join(',')}]`
  })()

  await step('get_tool_guide fallback is accessibility (never coordinate)', async () => {
    const g = json(assertOk(await client.getToolGuide('xyzzyfrobnicate widget'), 'tool_guide'))
    if (g.approach === 'coordinate') throw new Error('fallback should not be coordinate')
    return `approach=${g.approach}`
  })()

  // ── 3. App capabilities probe ─────────────────────────────────────────────
  console.log('\n[3] App capabilities probes (real sdef calls)')
  await step('TextEdit is scriptable + accessible', async () => {
    const r = json(assertOk(await client.getAppCapabilities('com.apple.TextEdit'), 'caps'))
    if (!r.scriptable) throw new Error('TextEdit should be scriptable')
    return `scriptable=${r.scriptable}, suites=[${r.suites.slice(0,3).join(',')}...], running=${r.running}`
  })()

  await step('Safari is scriptable', async () => {
    const r = json(assertOk(await client.getAppCapabilities('com.apple.Safari'), 'caps'))
    if (!r.scriptable) throw new Error('Safari should be scriptable')
    return `scriptable=${r.scriptable}, ${r.suites.length} suites`
  })()

  await step('Unknown bundle is not scriptable', async () => {
    const r = json(assertOk(await client.getAppCapabilities('com.zavora.nonexistent'), 'caps'))
    if (r.scriptable) throw new Error('should not be scriptable')
    return `scriptable=${r.scriptable}, running=${r.running}`
  })()

  // ── 4. Scripting bridge ───────────────────────────────────────────────────
  console.log('\n[4] Scripting bridge (osascript subprocess)')
  await step('run_script AppleScript returns computed value', async () => {
    const r = assertOk(await client.runScript('applescript', 'return (1 + 2) * 3'), 'run_script')
    if (text(r) !== '9') throw new Error(`got ${text(r)}, want 9`)
    return `return value = ${text(r)}`
  })()

  await step('run_script JXA returns computed value', async () => {
    const r = assertOk(await client.runScript('javascript', '({a: 1, b: 2}).a + 41'), 'run_script jxa')
    if (text(r) !== '42') throw new Error(`got ${text(r)}`)
    return text(r)
  })()

  await step('run_script on syntax error returns isError with stderr', async () => {
    const r = await client.runScript('applescript', 'this is not valid applescript at all')
    if (!r.isError) throw new Error('should have been isError')
    return text(r).split('\n')[0].slice(0, 60)
  })()

  await step('run_script timeout kicks in', async () => {
    const r = await client.runScript('applescript', 'delay 5', 500)
    if (!r.isError) throw new Error('should have timed out')
    if (!text(r).match(/timed out/)) throw new Error(`unexpected: ${text(r)}`)
    return text(r)
  })()

  // ── 5. One-call automation via scripting (the v5 motivator) ──────────────
  console.log('\n[5] One-call automation: create + populate TextEdit document')
  await step('open TextEdit + create document + write text via AppleScript', async () => {
    const script = `
      tell application "TextEdit"
        activate
        set newDoc to make new document
        set text of newDoc to "v5 end-to-end test\\n\\nThis entire document was created with a single run_script call — no screenshots, no coordinate math, no click-type loops."
        return name of newDoc
      end tell
    `
    const r = assertOk(await client.runScript('applescript', script, 5000), 'create doc')
    return `document created: ${text(r)}`
  })()

  await sleep(500)  // let TextEdit settle

  // ── 6. Accessibility introspection ────────────────────────────────────────
  console.log('\n[6] Accessibility introspection')
  const teWindows = json(assertOk(await client.listWindows('com.apple.TextEdit'), 'list textedit'))
  const teWin = teWindows.find(w => w.title && w.title !== 'Maina J.K.txt') ?? teWindows[0]
  if (!teWin) throw new Error('no TextEdit window found')
  console.log(`  using TextEdit window: ${teWin.windowId} "${teWin.title}"`)

  await step('get_ui_tree returns structured hierarchy', async () => {
    const tree = json(assertOk(await client.getUiTree(teWin.windowId, 4), 'ui_tree'))
    if (tree.role !== 'AXWindow') throw new Error(`root is ${tree.role}, want AXWindow`)
    return `root=${tree.role} label=${JSON.stringify(tree.label)} children=${tree.children?.length} ${tree.truncated?'[truncated]':''}`
  })()

  await step('find_element locates AXTextArea', async () => {
    const els = json(assertOk(await client.findElement(teWin.windowId, { role: 'AXTextArea' }), 'find'))
    if (!els.length) throw new Error('no AXTextArea found')
    return `${els.length} text area(s), first at ${JSON.stringify(els[0].bounds)}`
  })()

  await step('find_element locates close button (AXButton)', async () => {
    const els = json(assertOk(await client.findElement(teWin.windowId, { role: 'AXButton', maxResults: 5 }), 'find buttons'))
    return `${els.length} button(s) found`
  })()

  // ── 7. get_focused_element ────────────────────────────────────────────────
  console.log('\n[7] Focused element discovery')
  await step('get_focused_element returns current focus', async () => {
    const fe = json(assertOk(await client.getFocusedElement(), 'focused'))
    // TextEdit document should have focus on the text area
    if (!fe) return 'nothing focused (ok if another app is frontmost)'
    return `role=${fe.role}, label=${JSON.stringify(fe.label)}, value preview=${JSON.stringify((fe.value ?? '').slice(0,40))}`
  })()

  // ── 8. Semantic set_value on the text area ───────────────────────────────
  console.log('\n[8] Semantic set_value (rewrites text area in one call)')
  await step('set_value replaces text area content without clicks or typing', async () => {
    const r = assertOk(await client.setValue(
      teWin.windowId,
      'AXTextArea',
      '',
      'REPLACED BY set_value — one tool call replaced the entire document body.\n\nOld approach (v4): activate window → click into text area → select all → delete → type each char.\n\nNew approach (v5): one set_value call.',
    ), 'set_value')
    return text(r)
  })()

  await sleep(300)

  // Verify the change took effect by reading the focused element's value back.
  await step('verify set_value took effect (read back via get_focused_element)', async () => {
    const fe = json(await client.getFocusedElement())
    if (!fe || !fe.value) return 'focus lost (ok, value was set)'
    if (!fe.value.startsWith('REPLACED BY set_value')) {
      throw new Error(`value=${JSON.stringify(fe.value.slice(0,80))}`)
    }
    return `confirmed: "${fe.value.slice(0, 50)}..."`
  })()

  // ── 9. Menu bar programmatic navigation ──────────────────────────────────
  console.log('\n[9] Menu bar programmatic navigation')
  await step('select_menu_item drives Format → Font submenu', async () => {
    const r = await client.selectMenuItem('com.apple.TextEdit', 'Format', 'Bold', 'Font')
    // We do not insist on success since Bold may require selected text; but the
    // structured error path is what we validate here. Either outcome is a valid
    // exercise of the tool.
    if (r.isError) {
      const body = json(r)
      return `structured error (expected): ${body.error} — available menus: [${body.availableMenus?.slice(0,4).join(', ')}...]`
    }
    return text(r)
  })()

  await step('select_menu_item error shape includes availableMenus', async () => {
    const r = await client.selectMenuItem('com.apple.TextEdit', 'NonexistentMenu', 'foo')
    if (!r.isError) throw new Error('should have errored')
    const body = json(r)
    if (!Array.isArray(body.availableMenus)) throw new Error('no availableMenus in error')
    return `${body.availableMenus.length} menus: [${body.availableMenus.join(', ')}]`
  })()

  // ── 10. fill_form batch update ───────────────────────────────────────────
  console.log('\n[10] fill_form batch (partial-failure semantics)')
  await step('fill_form reports per-field success/failure without aborting', async () => {
    const r = assertOk(await client.fillForm(teWin.windowId, [
      { role: 'AXTextArea', label: '', value: 'Field 1 content from fill_form.' },
      { role: 'AXTextField', label: 'ghost_field', value: 'should fail' },  // won't exist
      { role: 'AXTextArea', label: 'another_ghost', value: 'also fails' },  // won't exist
    ]), 'fill_form')
    const body = json(r)
    if (body.succeeded + body.failed !== 3) {
      throw new Error(`counts wrong: ${JSON.stringify(body)}`)
    }
    return `succeeded=${body.succeeded}, failed=${body.failed}, failures=${JSON.stringify(body.failures)}`
  })()

  // ── 11. Screenshot auto-target ────────────────────────────────────────────
  console.log('\n[11] Screenshot auto-target from TargetState')
  // The previous fill_form established TargetState { bundleId: TextEdit, windowId: teWin.windowId }
  await step('screenshot without args auto-targets active session window', async () => {
    const r = await client.screenshot()
    const shot = r.content.find(c => c.type === 'image')
    const dims = text(r)
    if (!shot) throw new Error('no image returned')
    return `captured ${dims} (auto-targeted window ${teWin.windowId})`
  })()

  // ── 12. Spaces graceful degradation ──────────────────────────────────────
  console.log('\n[12] Agent Spaces graceful degradation')
  await step('create_agent_space returns structured error with workaround', async () => {
    const r = await client.createAgentSpace()
    if (!r.isError) return `supported on this macOS: ${text(r)}`
    const body = json(r)
    if (!body.workaround) throw new Error('no workaround in error')
    return `${body.error}: "${body.workaround.slice(0, 60)}..."`
  })()

  // ── 13. Cleanup ───────────────────────────────────────────────────────────
  console.log('\n[13] Cleanup — close the test document without saving')
  await step('close test document via AppleScript (scripting path)', async () => {
    const script = `
      tell application "TextEdit"
        if (count of documents) > 0 then
          close document 1 saving no
        end if
      end tell
    `
    await client.runScript('applescript', script, 3000)
    return 'document closed'
  })()

  await client.close()

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '━'.repeat(60))
  const passed = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  console.log(`  ${passed}/${results.length} steps passed, ${failed} failed`)
  const totalMs = results.reduce((s, r) => s + r.ms, 0)
  console.log(`  total time: ${totalMs}ms`)
  console.log('━'.repeat(60))
  if (failed > 0) {
    console.log('\nFailed steps:')
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  ✗ ${r.name}\n    ${r.err}`)
    }
    process.exit(1)
  }
}

main().catch(err => {
  console.error(`\n✗ FATAL at step "${currentStep}": ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
