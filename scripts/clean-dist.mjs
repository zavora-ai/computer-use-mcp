import { rmSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const output = resolve(process.cwd(), 'dist')
if (basename(output) !== 'dist' || output === resolve('/')) {
  throw new Error(`refusing to clean unexpected output path: ${output}`)
}
rmSync(output, { recursive: true, force: true })
