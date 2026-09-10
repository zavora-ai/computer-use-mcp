import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { connectStdio, type ComputerUseClient } from './client.js'

/** Start a host-built Linux desktop image over stdio, with no host filesystem or network access. */
export async function connectIsolatedWorker(options: { image: string; lifetimeMs?: number }): Promise<ComputerUseClient> {
  if (!options.image || /\s/.test(options.image)) throw new Error('A host-built worker image is required')
  const lifetime = options.lifetimeMs ?? 900000
  if (!Number.isInteger(lifetime) || lifetime < 1000 || lifetime > 3600000) throw new Error('Worker lifetime must be 1 second..1 hour')
  const name = 'computer-desktop-' + randomUUID()
  const cleanup = () => {
    const child = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' })
    child.on('error', () => {})
  }
  const timer = setTimeout(cleanup, lifetime)
  timer.unref()
  try {
    const client = await connectStdio('docker', ['run', '--rm', '-i', '--name', name,
      '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=256', '--memory=1g', '--cpus=2', '--shm-size=256m', '--user=1000:1000',
      '--tmpfs', '/tmp:rw,nosuid,size=256m', '--tmpfs', '/workspace:rw,nosuid,size=256m,uid=1000,gid=1000',
      '--env', 'COMPUTER_USE_FS_ROOTS=/workspace', options.image])
    return { ...client, close: async () => { clearTimeout(timer); cleanup(); await client.close() } }
  } catch (error) { clearTimeout(timer); cleanup(); throw error }
}
