#!/usr/bin/env node
/**
 * 8.0 probe: does a mutating call close an open Blender pie menu, and which part of the mutating path does it?
 *
 * Reported from a live Blender 5.3 run: `click_text` right after Ctrl+Tab closed the mode pie before its own OCR ran,
 * while read-only calls left the pie open. A mutating call differs from a read-only one before its handler runs in
 * five places: keep-awake, the status card, the take-over watch, the live watcher flag, and the desktop lock, whose
 * pump drains this process's run loop every millisecond while the lock is held. This opens a pie, makes one call that
 * clicks nothing (`click_text` for text that is not there: OCR only), and reads whether the pie is still open, with
 * each suspect turned off in turn.
 *
 * It drives the real desktop: its own Blender (factory settings, scratch user resources), closed at the end.
 *   node scripts/probes/blender-pie-probe.mjs
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'

const BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const body = result => result.structuredContent ?? JSON.parse(result.content.find(block => block.type === 'text')?.text ?? 'null')
const log = message => process.stderr.write(`[pie-probe] ${message}\n`)

const VARIANTS = [
  { name: 'read-only call (control)', call: 'read' },
  // The card launches on the first mutating call of the process and then stays up, so its first launch is isolated:
  // card off first, then card on (it launches here), then card on again (already up).
  { name: 'mutating call, status card off', call: 'mutate', env: { COMPUTER_USE_STATUS_CARD: 'false' } },
  { name: 'mutating call, everything on (the card launches)', call: 'mutate' },
  { name: 'mutating call, everything on (the card already up)', call: 'mutate' },
  { name: 'mutating call, no desktop lock or run-loop pump', call: 'mutate', options: { disableSessionLock: true } },
  { name: 'mutating call, no take-over watch', call: 'mutate', env: { COMPUTER_USE_TAKEOVER: 'false' } },
  { name: 'mutating call, no keep-awake', call: 'mutate', env: { COMPUTER_USE_KEEP_AWAKE: 'false' } },
]

/** The mode pie shows these labels; two of them read means it is open. */
const PIE = [/Object Mode/i, /Edit Mode/i, /Sculpt Mode/i, /Vertex Paint/i, /Weight Paint/i, /Texture Paint/i]
async function pieOpen(client, windowId) {
  const lines = (body(await client.callTool('read_window_text', { target_window_id: windowId })).lines ?? []).map(line => line.text)
  return PIE.filter(pattern => lines.some(line => pattern.test(line))).length >= 2
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'cu-pie-probe-'))
  mkdirSync(join(scratch, 'blender-user'), { recursive: true })
  const child = spawn(BLENDER, ['--factory-startup'], {
    env: { ...process.env, BLENDER_USER_RESOURCES: join(scratch, 'blender-user') }, stdio: 'ignore', detached: true,
  })
  child.unref()
  const rows = []
  try {
    for (const variant of VARIANTS) {
      const saved = {}
      for (const [key, value] of Object.entries(variant.env ?? {})) { saved[key] = process.env[key]; process.env[key] = value }
      const client = await connectInProcess(createComputerUseServer({ profile: 'desktop', ...(variant.options ?? {}) }))
      try {
        let window
        for (let tries = 0; tries < 120 && !window; tries++) {
          window = (body(await client.callTool('list_windows', { bundle_id: 'org.blenderfoundation.blender' })).windows ?? [])
            .find(candidate => candidate.pid === child.pid)
          if (!window) await sleep(500)
        }
        if (!window) throw new Error('the probe Blender opened no window')
        await client.callTool('set_target', { window_id: window.windowId })
        await client.callTool('wait_for_stable', { target_window_id: window.windowId, quiet_ms: 1_000, timeout_ms: 20_000 })
        // the viewport, then the mode pie
        await client.callTool('mouse_move', { coordinate: [window.bounds.x + window.bounds.width * 0.45, window.bounds.y + window.bounds.height * 0.5] })
        await client.callTool('key', { text: 'ctrl+tab' })
        await sleep(700)
        const before = await pieOpen(client, window.windowId)
        const started = Date.now()
        const reply = variant.call === 'read'
          ? await client.callTool('read_window_text', { target_window_id: window.windowId })
          : await client.callTool('click_text', { text: 'zz-not-on-screen-zz', target_window_id: window.windowId })
        const callMs = Date.now() - started
        const outcome = body(reply)?.error ?? 'ok'
        const after = await pieOpen(client, window.windowId)
        rows.push({ variant: variant.name, pieOpenBefore: before, pieOpenAfter: after, callMs, outcome })
        log(`${variant.name}: before ${before}, after ${after}`)
        await client.callTool('key', { text: 'escape' })
        await sleep(500)
      } finally {
        await client.close()
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      }
    }
  } finally {
    try { process.kill(child.pid, 'SIGTERM') } catch { /* gone */ }
  }
  console.log('| Variant | Pie open before | Pie open after the call | Call ms | Call result |')
  console.log('|---|---|---|---:|---|')
  for (const row of rows) console.log(`| ${row.variant} | ${row.pieOpenBefore ? 'yes' : 'no'} | ${row.pieOpenAfter ? 'yes' : 'no'} | ${row.callMs} | ${row.outcome} |`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
