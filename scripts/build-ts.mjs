// Non-destructive TypeScript build: compile into dist.next, then swap it into place.
// The old `rm -rf dist && tsc` left a window with no dist/ at all, so a server starting mid-build died at import.
import { execFileSync } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const root = process.cwd()
const dist = resolve(root, 'dist')
const next = resolve(root, 'dist.next')
const old = resolve(root, 'dist.old')
for (const dir of [dist, next, old]) {
  if (basename(dir).startsWith('dist') === false || dir === resolve('/')) throw new Error(`refusing to touch ${dir}`)
}
rmSync(next, { recursive: true, force: true })
rmSync(old, { recursive: true, force: true })
execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '--outDir', next], { stdio: 'inherit', cwd: root })
if (existsSync(dist)) renameSync(dist, old)
renameSync(next, dist)
rmSync(old, { recursive: true, force: true })
