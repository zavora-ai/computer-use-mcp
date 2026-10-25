#!/usr/bin/env node
// Live check of 7.7.0 on a Linux desktop (X11, or a Wayland session through XWayland, sway or Hyprland). Run it from a
// terminal on the desktop you are testing, not over SSH, and do not touch the mouse or keyboard while it runs (about a
// minute). It opens a zenity text window, types into it, copies the text back, and closes it. Nothing is written
// outside the temp directory.
//
//   npm ci && npm run build && node scripts/linux-check.mjs              (from a source checkout)
//   node scripts/linux-check.mjs --takeover                               (adds a step where you move the mouse)
//   node scripts/linux-check.mjs --skip-input                             (no input route: SKIP the input checks)
//
// CI runs it unattended on headless desktops through scripts/ci-linux-desktop.sh (Xvfb with xfwm4 or openbox, and
// sway's headless backend, where there is no input device, so --skip-input).
//
// Every check prints PASS or FAIL with what it saw. Send the whole output back, with the doctor block it prints first.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'linux') {
  console.error('This check is for Linux. On macOS run scripts/integration-status-card.mjs.')
  process.exit(2)
}

const { createComputerUseServer } = await import('../dist/server.js')
const { connectInProcess } = await import('../dist/client.js')

const takeover = process.argv.includes('--takeover')
const skipInput = process.argv.includes('--skip-input')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).slice(0, 240)}` : ''}`)
}
const skip = (name, reason) => console.log(`SKIP  ${name}  — ${reason}`)
const text = r => r.content.find(c => c.type === 'text')?.text ?? ''
const parse = r => { try { return JSON.parse(text(r)) } catch { return { raw: text(r) } } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const has = tool => spawnSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' }).status === 0

const client = await connectInProcess(createComputerUseServer({ profile: 'full' }))
const scratch = mkdtempSync(join(tmpdir(), 'cu-linux-check-'))
const TITLE = `cu-linux-check-${process.pid}`
let zenity

try {
  // 1. Environment and doctor.
  console.log(`session: ${process.env.XDG_SESSION_TYPE ?? '?'} · desktop: ${process.env.XDG_CURRENT_DESKTOP ?? '?'} · display: ${process.env.DISPLAY ?? '-'} · wayland: ${process.env.WAYLAND_DISPLAY ?? '-'}`)
  const doctor = parse(await client.callTool('doctor', { include_remediation: true }))
  const backends = doctor.checks?.find(c => c.id === 'linux_backends')
  console.log('--- doctor ---')
  for (const c of doctor.checks ?? []) console.log(`  ${c.status.padEnd(4)} ${c.id}: ${String(c.summary ?? '').slice(0, 160)}`)
  console.log('--------------')
  check('doctor platform check passes on Linux (7.7)', doctor.checks?.find(c => c.id === 'platform')?.status === 'pass')
  check('doctor names the Linux backends (7.7)', Boolean(backends), backends?.summary)

  // 4. A window to drive: zenity's editable text box. We own the process.
  if (!has('zenity')) throw new Error('zenity is not installed: sudo apt install zenity')
  zenity = spawn('zenity', ['--text-info', '--editable', `--title=${TITLE}`, '--width=640', '--height=420'], { stdio: ['ignore', 'pipe', 'ignore'] })
  // The app id differs by backend (the process name on X11, the Wayland app id on sway and Hyprland), so find the
  // window by its title first, then wait on it through its app id.
  let found
  for (let i = 0; i < 60 && !found; i++) {
    const all = parse(await client.callTool('list_windows', {}))
    found = (Array.isArray(all.windows) ? all.windows : []).find(w => w.title === TITLE)
    if (!found) await sleep(250)
  }
  check('the zenity window is listed by its title', Boolean(found), found ? `app ${found.bundleId}, window ${found.windowId}` : 'not seen in 15 s')
  if (!found) throw new Error('no zenity window; cannot continue')

  // Windows carry real geometry (7.6 reported every X11 window at 0,0 sized 0x0). Listed once zenity's window
  // exists, so an otherwise empty desktop (a headless CI one, or GNOME on Wayland with no XWayland windows) is not a
  // false failure.
  const listed = parse(await client.callTool('list_windows', {}))
  const windows = Array.isArray(listed.windows) ? listed.windows : Array.isArray(listed) ? listed : []
  const sized = windows.filter(w => w.bounds?.width > 0 && w.bounds?.height > 0)
  check('list_windows returns windows', windows.length > 0, `${windows.length} windows`)
  check('windows have real bounds, not 0x0 (L3)', sized.length > 0, sized.slice(0, 3).map(w => `${w.bundleId} ${w.bounds.width}x${w.bounds.height}`).join(', '))

  // Full-screen captures, and JPEG quality honoured (L3), with zenity on screen: an empty desktop is one flat colour,
  // which compresses to the same size at any quality.
  const low = await client.callTool('screenshot', { full_screen: true, quality: 20, width: 1024 })
  const high = await client.callTool('screenshot', { full_screen: true, quality: 95, width: 1024, resend: true })
  const size = r => r.content.find(c => c.type === 'image')?.data?.length ?? 0
  check('full-screen screenshot returns an image', size(low) > 0, text(low).split('\n')[0])
  check('JPEG quality is honoured (quality 95 is larger than 20)', size(high) > size(low) * 1.3, `${size(low)} vs ${size(high)} base64 bytes`)
  const appeared = parse(await client.callTool('wait_for_window', { target_app: found.bundleId, title: TITLE, timeout_ms: 5000 }))
  check('wait_for_window finds it', appeared.found === true, JSON.stringify(appeared.window ?? appeared).slice(0, 160))
  const win = appeared.window ?? found
  check('the window has real bounds', win.bounds?.width > 0 && win.bounds?.height > 0, JSON.stringify(win.bounds))

  const activated = parse(await client.callTool('activate_window', { window_id: win.windowId }))
  check('activate_window brings it to the front, effect: verified (K1)', activated.activated === true && activated.effect === 'verified', `activated ${activated.activated}, effect ${activated.effect}`)

  const shot = await client.callTool('screenshot', { target_window_id: win.windowId })
  check('a window screenshot returns an image', size(shot) > 0, text(shot).split('\n')[0])

  // 5. Input: one run_steps call clicks into the text box and types (K2); the coordinate is sent as text (A1).
  if (skipInput) {
    for (const name of ['run_steps clicked and typed in one call (K2, A1)', 'run_steps reports route batch and an effect (K1)', 'the typed text reads back exactly']) {
      skip(name, '--skip-input: this desktop has no input route here')
    }
  } else {
    const cx = Math.round(win.bounds.x + win.bounds.width / 2)
    const cy = Math.round(win.bounds.y + win.bounds.height / 2)
    const phrase = 'computer-use 7.7 on linux'
    const steps = parse(await client.callTool('run_steps', {
      target_window_id: win.windowId,
      steps: [
        { tool: 'click', args: { coordinate: `${cx},${cy}` } },
        { tool: 'type', args: { text: phrase } },
      ],
    }))
    check('run_steps clicked and typed in one call (K2, A1)', steps.completed === 2, JSON.stringify(steps).slice(0, 200))
    check('run_steps reports route batch and an effect (K1)', steps.route === 'batch' && typeof steps.effect === 'string', `route ${steps.route}, effect ${steps.effect}`)

    // Read the text back through the clipboard: select all, copy, read.
    await client.callTool('key', { text: 'ctrl+a', target_window_id: win.windowId })
    await client.callTool('key', { text: 'ctrl+c', target_window_id: win.windowId })
    await sleep(300)
    const copied = text(await client.callTool('read_clipboard', {}))
    check('the typed text reads back exactly', copied.includes(phrase), JSON.stringify(copied.slice(0, 80)))
  }

  // 6. Optional: a person taking over pauses the agent (X11 counts physical input through XInput 2).
  if (takeover && !skipInput) {
    console.log('\n>>> In 3 seconds a 6-second hold starts. When you see GO, move the mouse for two seconds. <<<')
    await sleep(3000)
    const started = Date.now()
    const held = client.callTool('hold_key', { keys: ['shift'], duration: 6, target_window_id: win.windowId })
    await sleep(500)
    console.log('GO: move the mouse now')
    const heldResult = await held
    const status = parse(await client.callTool('control_status', {}))
    check('your mouse movement paused the agent (taken_over)', status.state === 'paused' && status.reason === 'takeover', `state ${status.state} (${status.reason}) after ${Date.now() - started} ms; hold: ${text(heldResult).slice(0, 80)}`)
    let resumed = status
    for (let i = 0; i < 40 && resumed.state !== 'running'; i++) { await sleep(250); resumed = parse(await client.callTool('control_status', {})) }
    check('the agent resumed by itself after you stopped', resumed.state === 'running', `state ${resumed.state}`)
  }

  // 7. A missing tool is named (L2): the same window list with an empty PATH.
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { createSession } = await import(${JSON.stringify(new URL('../dist/session.js', import.meta.url).href)})
    const session = createSession({ macosHelper: null, disableSessionLock: true })
    const result = await session.dispatch('list_windows', {})
    console.log(result.content.find(c => c.type === 'text')?.text ?? '')
    session.close()
  `], { env: { ...process.env, PATH: join(scratch, 'empty') }, encoding: 'utf8', timeout: 30000 })
  const said = `${probe.stdout}${probe.stderr}`
  check('a missing tool is an error that names it (L2)', /is not installed/.test(said), said.trim().split('\n').pop())
} catch (error) {
  check('no unexpected error', false, error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  try { zenity?.kill() } catch { /* already gone */ }
  await client.close()
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
