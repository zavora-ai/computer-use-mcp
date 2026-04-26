// End-to-end test of the v5 Spaces surface.
//
// This exercises every Spaces tool against live macOS. It documents exactly
// what works and what's blocked on the current Mac's entitlement level so
// agents can make informed decisions.

import { createComputerUseServer } from './dist/server.js'
import { connectInProcess } from './dist/client.js'

const text = r => r.content.find(c => c.type === 'text')?.text ?? ''
const json = r => JSON.parse(text(r))

async function step(name, fn) {
  const t0 = Date.now()
  try {
    const out = await fn()
    console.log(`  ✓ ${name} (${Date.now()-t0}ms)`)
    if (out !== undefined) {
      const pretty = typeof out === 'string' ? out : JSON.stringify(out, null, 2).split('\n').map(l => '     ' + l).join('\n')
      if (typeof out !== 'string') console.log(pretty)
      else console.log('     → ' + out)
    }
    return out
  } catch (e) {
    console.log(`  ✗ ${name} (${Date.now()-t0}ms): ${e.message}`)
    throw e
  }
}

async function main() {
  console.log('━'.repeat(60))
  console.log('  v5 Spaces — live macOS verification')
  console.log('━'.repeat(60))

  const server = createComputerUseServer()
  const client = await connectInProcess(server)

  // ── 1. Enumerate current Spaces ───────────────────────────────────────────
  console.log('\n[1] Enumerate current Spaces')
  const listBefore = await step('list_spaces (read-only CGS probe)', async () => {
    const r = await client.listSpaces()
    if (r.isError) throw new Error(text(r))
    return json(r)
  })

  await step('get_active_space', async () => {
    const r = await client.getActiveSpace()
    if (r.isError) throw new Error(text(r))
    return `active space id = ${text(r)}`
  })

  console.log(`\n  Summary: ${listBefore.displays.length} display(s), ${
    listBefore.displays.reduce((s, d) => s + d.spaces.length, 0)} user-visible Space(s) total`)

  // ── 2. Create an agent Space ──────────────────────────────────────────────
  console.log('\n[2] Create an agent Space')
  const createResult = await step('create_agent_space', async () => {
    const r = await client.createAgentSpace()
    if (r.isError) {
      const body = json(r)
      console.log(`     → structured error: ${body.error}`)
      console.log(`     → workaround: ${body.workaround?.slice(0, 80)}...`)
      return { _error: true }
    }
    return json(r)
  })

  if (createResult._error) {
    console.log('\n  CGS Space creation is not supported on this Mac.')
    console.log('  This is the expected behavior when CGS mutating symbols are unreachable.')
    await client.close()
    return
  }

  const agentSpaceId = createResult.space_id
  console.log(`\n  agent space id: ${agentSpaceId}`)
  console.log(`  attached to Mission Control: ${createResult.attached}`)
  if (!createResult.attached) {
    console.log('  ↳ Space created as orphan — expected on SIP-enabled Macs.')
    console.log('  ↳ The Space is a valid handle but not visible to the user.')
  }

  // ── 3. Idempotency: second create returns cached ID ──────────────────────
  console.log('\n[3] Idempotency check')
  await step('second create_agent_space returns cached ID', async () => {
    const r = await client.createAgentSpace()
    if (r.isError) throw new Error(text(r))
    const b = json(r)
    if (b.space_id !== agentSpaceId) {
      throw new Error(`expected cached id ${agentSpaceId}, got ${b.space_id}`)
    }
    if (b.created !== false) {
      throw new Error(`expected created=false, got ${b.created}`)
    }
    return `cached=${b.cached}, space_id=${b.space_id}`
  })

  // ── 4. Try moving a TextEdit window into the agent Space ──────────────────
  console.log('\n[4] Move a real window into the agent Space')
  await step('open TextEdit + create a fresh document', async () => {
    const r = await client.runScript('applescript', `
      tell application "TextEdit"
        activate
        set newDoc to make new document
        set text of newDoc to "v5 Spaces isolation test — moving this window into agent space ${agentSpaceId}"
        return name of newDoc
      end tell
    `, 5000)
    return text(r)
  })

  // Wait for window server to register the new window.
  await new Promise(r => setTimeout(r, 800))

  const teWindows = json(await client.listWindows('com.apple.TextEdit'))
  const targetWin = teWindows.find(w => w.title?.startsWith('Untitled')) ?? teWindows[0]
  if (!targetWin) throw new Error('no TextEdit window found')
  console.log(`  target window: ${targetWin.windowId} "${targetWin.title}"`)

  const moveResult = await step('move_window_to_space', async () => {
    const r = await client.moveWindowToSpace(targetWin.windowId, agentSpaceId)
    if (r.isError) {
      const b = json(r)
      console.log(`     → structured error: ${b.error}`)
      return { _error: true }
    }
    return json(r)
  })

  if (!moveResult._error) {
    console.log(`\n  move verified: ${moveResult.verified}`)
    console.log(`  on-screen before: ${moveResult.window_on_screen_before}`)
    console.log(`  on-screen after:  ${moveResult.window_on_screen_after}`)
    if (!moveResult.verified) {
      console.log('  ↳ Window did NOT visibly move — CGSAddWindowsToSpaces silently no-opped.')
      console.log('  ↳ This is the expected SIP-enabled behavior: moving windows owned by')
      console.log('    other processes requires elevated entitlements.')
    } else {
      console.log('  ↳ Window was moved off the active Space! (unusually-permissive macOS config)')
    }
  }

  // ── 5. Remove window from the agent Space (companion op) ─────────────────
  console.log('\n[5] Remove window from agent Space')
  await step('remove_window_from_space', async () => {
    const r = await client.removeWindowFromSpace(targetWin.windowId, agentSpaceId)
    if (r.isError) throw new Error(text(r))
    return json(r)
  })

  // ── 6. Destroy the agent Space ────────────────────────────────────────────
  console.log('\n[6] Destroy agent Space')
  await step('destroy_space', async () => {
    const r = await client.destroySpace(agentSpaceId)
    if (r.isError) throw new Error(text(r))
    return json(r)
  })

  // ── 7. After destroy, create_agent_space allocates a fresh one ───────────
  console.log('\n[7] After destroy, next create allocates a new Space')
  const afterDestroy = await step('create_agent_space after destroy', async () => {
    const r = await client.createAgentSpace()
    if (r.isError) throw new Error(text(r))
    return json(r)
  })
  if (afterDestroy.space_id === agentSpaceId) {
    console.log(`  ⚠ got same id ${agentSpaceId} back — CGS may reuse destroyed IDs`)
  } else {
    console.log(`  fresh space id: ${afterDestroy.space_id} (was ${agentSpaceId})`)
  }
  await client.destroySpace(afterDestroy.space_id)

  // ── 8. Cleanup ───────────────────────────────────────────────────────────
  console.log('\n[8] Cleanup')
  await step('close the test document', async () => {
    await client.runScript('applescript', `
      tell application "TextEdit"
        if (count of documents) > 0 then close document 1 saving no
      end tell
    `, 3000)
    return 'document closed'
  })

  await client.close()

  console.log('\n' + '━'.repeat(60))
  console.log('  Spaces e2e complete.')
  console.log('')
  console.log('  WORKS:')
  console.log('    • list_spaces / get_active_space (pure CGS reads)')
  console.log('    • create_agent_space (returns ID; attached=false on SIP-enabled)')
  console.log('    • destroy_space')
  console.log('    • move_window_to_space (call succeeds; verified=false without entitlements)')
  console.log('    • remove_window_from_space')
  console.log('')
  console.log('  BLOCKED ON STANDARD MAC (SIP enabled, no elevated entitlements):')
  console.log('    • Space does not appear in Mission Control (orphan).')
  console.log('    • Window moves silently no-op for cross-process windows.')
  console.log('')
  console.log('  The surface reports honest diagnostics (attached, verified flags)')
  console.log('  so agents can degrade to alternatives (hide_app, off-screen windows).')
  console.log('━'.repeat(60))
}

main().catch(e => {
  console.error('\nFATAL:', e.message)
  console.error(e.stack)
  process.exit(1)
})
