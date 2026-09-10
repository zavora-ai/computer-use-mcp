/**
 * Record the ledger showcase as it runs.
 *
 * Captures the real screen but crops to the ledger window, so nothing else on the
 * desktop is ever written to the file. The browser toolbar is cropped away too,
 * because the app URL carries the one-shot host token.
 *
 * Usage: node agents/deepseek-agent/record.mjs [showcase args...]
 *   node agents/deepseek-agent/record.mjs --seed 7 --turns 30
 *
 * Produces, in the run's output directory:
 *   ledger-run.mp4   the full capture
 *   ledger-run.gif   a sped-up, scaled version for embedding
 */

import { spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'

/** Height of the Chromium toolbar to crop away, in logical pixels. */
const TOOLBAR_HEIGHT = 88
/** h264 needs even dimensions. */
const even = value => Math.max(2, Math.floor(value / 2) * 2)

async function waitForLedgerWindow({ timeoutMs = 60000 } = {}) {
  const client = await connectInProcess(createComputerUseServer())
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const listed = await client.callTool('list_windows', {})
      const windows = listed.structuredContent?.windows
        ?? JSON.parse(listed.content.find(b => b.type === 'text')?.text ?? '{}').windows ?? []
      const target = windows.find(w => w.title?.includes('MCP Ledger'))
      if (target?.bounds?.width) return target
      await new Promise(r => setTimeout(r, 500))
    }
    throw new Error('The MCP Ledger window did not appear within the timeout')
  } finally {
    await client.close()
  }
}

function startCapture({ crop, output }) {
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'avfoundation', '-capture_cursor', '1', '-framerate', '15', '-i', '1:',
    '-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    output,
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
  return {
    ffmpeg,
    stop: async () => {
      // 'q' asks ffmpeg to finalise the container; killing it truncates the file.
      ffmpeg.stdin.write('q')
      ffmpeg.stdin.end()
      await new Promise(resolve => ffmpeg.once('close', resolve))
    },
  }
}

async function run(command, args) {
  const child = spawn(command, args, { stdio: 'inherit' })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
  })
}

export async function record(showcaseArgs = []) {
  const base = resolve('showcase-output')
  mkdirSync(base, { recursive: true })

  // The showcase picks its own timestamped directory, so read it from the report
  // it prints rather than guessing.
  let stdout = ''
  const showcase = spawn(process.execPath, ['agents/deepseek-agent/showcase.mjs', ...showcaseArgs], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  showcase.stdout.on('data', chunk => { stdout += chunk })

  const target = await waitForLedgerWindow()
  const crop = {
    x: even(Math.max(0, target.bounds.x)),
    y: even(Math.max(0, target.bounds.y + TOOLBAR_HEIGHT)),
    width: even(target.bounds.width),
    height: even(target.bounds.height - TOOLBAR_HEIGHT),
  }
  console.error(`[record] capturing ${crop.width}x${crop.height} at ${crop.x},${crop.y}`)

  const temporary = join(base, `ledger-capture-${process.pid}.mp4`)
  const capture = startCapture({ crop, output: temporary })

  const exitCode = await new Promise(resolve => showcase.once('close', resolve))
  await new Promise(r => setTimeout(r, 500))
  await capture.stop()

  const report = (() => { try { return JSON.parse(stdout) } catch { return null } })()
  const directory = report?.directory && existsSync(report.directory) ? report.directory : base
  const mp4 = join(directory, 'ledger-run.mp4')
  const gif = join(directory, 'ledger-run.gif')

  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', temporary, '-c', 'copy', mp4])
  // Speed up and scale down: a README needs a few seconds and a few hundred
  // kilobytes, not a full-length screen capture at native resolution.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', temporary,
    '-vf', 'setpts=PTS/3,fps=12,scale=720:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
    gif])
  await run('rm', ['-f', temporary])

  console.error(`[record] mp4: ${mp4}`)
  console.error(`[record] gif: ${gif}`)
  return { exitCode, report, mp4, gif }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await record(process.argv.slice(2))
  console.log(JSON.stringify({
    status: result.report?.status ?? 'unknown',
    evidence: result.report?.evidence ?? null,
    cache: result.report?.cache ?? null,
    mp4: result.mp4, gif: result.gif,
  }, null, 2))
  if (result.exitCode !== 0) process.exitCode = result.exitCode
}
