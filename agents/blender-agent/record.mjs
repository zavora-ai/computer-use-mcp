/**
 * Record the Blender studio agent while it works.
 *
 * Captures the real screen but crops to Blender's window, so nothing else on the
 * desktop is written to the file. Runs the ADK-Rust agent as a child process and
 * stops the capture when it exits.
 *
 * Usage:
 *   BLENDER_MCP_BIN=... ADK_RUST=... node agents/blender-agent/record.mjs "<task>"
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'

const even = value => Math.max(2, Math.floor(value / 2) * 2)

/**
 * Put Blender alone in front of the camera.
 *
 * The process driving this runs from a terminal, and the terminal takes focus back
 * the moment it prints — so a capture cropped to Blender's rectangle would record
 * whatever is sitting on top of it. Hiding the other regular apps is what
 * `focus_strategy: "prepare_display"` does internally; doing it explicitly here
 * means the recorder can also put them back afterwards.
 */
async function clearScreenFor(client, keep = 'org.blenderfoundation.blender') {
  const listed = await client.callTool('list_running_apps', {})
  const apps = listed.structuredContent?.apps
    ?? JSON.parse(listed.content.find(b => b.type === 'text')?.text ?? '{}').apps ?? []
  const hidden = []
  for (const app of apps) {
    if (!app.bundleId || app.bundleId === keep || app.isHidden) continue
    const result = await client.callTool('hide_app', { bundle_id: app.bundleId })
    if (!result.isError) hidden.push(app.bundleId)
  }
  await client.callTool('activate_app', { bundle_id: keep })
  await client.callTool('wait', { duration: 1 })
  return hidden
}

async function restoreScreen(client, hidden) {
  for (const bundleId of hidden) {
    await client.callTool('unhide_app', { bundle_id: bundleId }).catch(() => {})
  }
}

/** Wait for Blender's window and return its bounds. */
async function blenderWindow({ timeoutMs = 90000 } = {}) {
  const client = await connectInProcess(createComputerUseServer())
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const listed = await client.callTool('list_windows', { bundle_id: 'org.blenderfoundation.blender' })
      const windows = listed.structuredContent?.windows
        ?? JSON.parse(listed.content.find(b => b.type === 'text')?.text ?? '{}').windows ?? []
      const target = windows.find(w => w.title?.includes('Blender'))
      if (target?.bounds?.width) return target
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('Blender window did not appear')
  } finally {
    await client.close()
  }
}

/** Processes and screen state that must be undone even if the run is interrupted. */
const cleanup = { ffmpeg: null, control: null, hidden: [] }
let cleaningUp = false

async function cleanUpNow() {
  if (cleaningUp) return
  cleaningUp = true
  // Kill the capture first: an orphaned ffmpeg keeps recording the screen.
  if (cleanup.ffmpeg && cleanup.ffmpeg.exitCode === null) {
    try { cleanup.ffmpeg.stdin.write('q'); cleanup.ffmpeg.stdin.end() } catch { /* already gone */ }
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { cleanup.ffmpeg.kill('SIGKILL') } catch {} ; resolve() }, 2000)
      cleanup.ffmpeg.once('close', () => { clearTimeout(timer); resolve() })
    })
  }
  if (cleanup.control) {
    try { await restoreScreen(cleanup.control, cleanup.hidden) } catch { /* best effort */ }
    try { await cleanup.control.close() } catch { /* best effort */ }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.error(`\n[record] ${signal} — stopping capture and restoring the screen`)
    void cleanUpNow().finally(() => process.exit(130))
  })
}

/**
 * Which AVFoundation input is the screen.
 *
 * This used to be hardcoded to `1:`, which is right on one machine by coincidence:
 * here device 0 is an OBS virtual camera and 1 is the screen. Without OBS installed
 * the screen is device 0, and the recorder would have captured a webcam. So ask
 * ffmpeg and match on the label it prints.
 */
function findScreenDevice() {
  const listing = spawnSync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    encoding: 'utf8',
  })
  // ffmpeg writes the device list to stderr and exits non-zero; that is expected.
  const output = `${listing.stderr ?? ''}${listing.stdout ?? ''}`
  const match = output.match(/\[(\d+)\]\s+Capture screen/i)
  if (!match) {
    throw new Error(
      'No AVFoundation "Capture screen" device found. Grant Screen Recording permission to '
      + 'the terminal running this, or set RECORD_SCREEN_DEVICE to the index ffmpeg lists for '
      + `your screen. ffmpeg reported:\n${output.split('\n').filter(line => line.includes('[')).join('\n')}`,
    )
  }
  return match[1]
}

/**
 * Convert a window rectangle in logical points to capture pixels.
 *
 * AVFoundation captures the framebuffer, which on a Retina display holds two pixels
 * per logical point, while `get_window` reports logical points. Cropping with the
 * logical numbers therefore took a quarter of the intended area from the top-left
 * corner. `get_display_size` reports both, so the ratio is measured rather than
 * assumed — and it is 1 on a non-Retina screen, where this becomes a no-op.
 */
function toCapturePixels(crop, display) {
  const scale = display?.pixelWidth && display?.width ? display.pixelWidth / display.width : 1
  const even = value => Math.max(2, Math.round(value * scale / 2) * 2) // h264 wants even dimensions
  return {
    x: Math.round(crop.x * scale),
    y: Math.round(crop.y * scale),
    width: even(crop.width),
    height: even(crop.height),
    scale,
  }
}

function startCapture({ crop, output, display }) {
  const device = process.env.RECORD_SCREEN_DEVICE ?? findScreenDevice()
  const box = toCapturePixels(crop, display)
  if (box.scale !== 1) {
    console.error(`[record] display scale ${box.scale}× — cropping ${box.width}×${box.height} capture pixels`)
  }
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'avfoundation', '-capture_cursor', '1', '-framerate', '12', '-i', `${device}:`,
    '-vf', `crop=${box.width}:${box.height}:${box.x}:${box.y}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p',
    output,
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
  cleanup.ffmpeg = ffmpeg

  // A spawn failure must surface here rather than as a silent absence of a file.
  let spawnError
  ffmpeg.once('error', error => { spawnError = error })

  return {
    stop: async () => {
      if (spawnError) throw new Error(`ffmpeg could not start: ${spawnError.message}`)
      // If ffmpeg has already gone, 'close' will never fire again and waiting for it
      // hangs the whole recorder. Check before listening.
      if (ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) {
        console.error(`[record] ffmpeg had already exited (${ffmpeg.exitCode ?? ffmpeg.signalCode})`)
        return
      }
      // 'q' finalises the container; killing ffmpeg truncates the file.
      try {
        ffmpeg.stdin.write('q')
        ffmpeg.stdin.end()
      } catch {
        // The pipe is gone, which means so is ffmpeg; fall through to the wait, which
        // will resolve on close or time out.
      }
      // Bounded, and escalating: a finalise that never completes must not hang a
      // recorder whose only remaining job is to restore the person's screen.
      const closed = new Promise(resolve => ffmpeg.once('close', resolve))
      const timedOut = new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000))
      if (await Promise.race([closed, timedOut]) === 'timeout') {
        console.error('[record] ffmpeg did not finalise in 10s — terminating it')
        ffmpeg.kill('SIGKILL')
        await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2_000))])
      }
    },
  }
}

const run = (command, args, options = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', ...options })
  child.once('error', reject)
  child.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)))
})

export async function record(task) {
  const adk = process.env.ADK_RUST ?? resolve('../../adk-rust')
  const blenderBin = process.env.BLENDER_MCP_BIN
  if (!blenderBin) throw new Error('Set BLENDER_MCP_BIN to the official blender-mcp binary')

  const directory = resolve('showcase-output')
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `blender-capture-${process.pid}.mp4`)
  const mp4 = join(directory, 'blender-studio.mp4')
  const gif = join(directory, 'blender-studio.gif')

  const control = await connectInProcess(createComputerUseServer())
  cleanup.control = control
  let hidden = []
  const window = await blenderWindow()
  const crop = {
    x: even(Math.max(0, window.bounds.x)),
    y: even(Math.max(0, window.bounds.y)),
    width: even(window.bounds.width),
    height: even(window.bounds.height),
  }
  console.error(`[record] Blender window ${crop.width}x${crop.height} at ${crop.x},${crop.y}`)
  // Measured, not assumed: the crop has to be in capture pixels, and the ratio between
  // those and logical points is 2 on a Retina display and 1 elsewhere.
  const display = JSON.parse(
    (await control.getDisplaySize()).content.find(part => part.type === 'text').text,
  )

  hidden = await clearScreenFor(control)
  cleanup.hidden = hidden
  console.error(`[record] hid ${hidden.length} app(s) so only Blender is on camera`)
  // Inside the guarded region, because startCapture can fail — no screen device, no
  // Screen Recording permission — and the apps are already hidden by this point.
  // Failing here used to leave the person's desktop emptied with nothing recording.
  let capture
  try {
    capture = startCapture({ crop, output: temporary, display })
    await run(process.execPath === '' ? 'cargo' : 'cargo',
      ['run', '-q', '--manifest-path', join(adk, 'examples/blender_studio/Cargo.toml'), '--', task],
      { cwd: adk, env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'error' } })
  } finally {
    await new Promise(r => setTimeout(r, 1500))
    // Stopping must never prevent restoring: a broken recorder that leaves half the
    // desktop hidden is a worse outcome than a lost video.
    if (capture) {
      try {
        await capture.stop()
      } catch (error) {
        console.error(`[record] could not finalise the capture: ${error.message}`)
      }
    }
    await cleanUpNow()
  }

  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', temporary, '-c', 'copy', mp4])
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', temporary,
    '-vf', 'setpts=PTS/6,fps=12,scale=900:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    gif])
  await run('rm', ['-f', temporary])
  console.error(`[record] mp4: ${mp4}\n[record] gif: ${gif}`)
  return { mp4, gif }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const task = process.argv.slice(2).join(' ')
  if (!task) throw new Error('Pass the task as an argument')
  await record(task)
}
