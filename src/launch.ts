#!/usr/bin/env node
/**
 * Self-checking stdio launcher.
 *
 * `node dist/server.js` dies at import when `node_modules/` or the native addon is missing (ESM imports are
 * hoisted, so no code in server.ts runs first), and the host sees only "connection closed". This file imports
 * nothing but Node built-ins, checks the install, names the fix on stderr, and only then loads the server.
 * It is the package's `bin` and the recommended `command` for stdio hosts.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')

export interface InstallCheck {
  ok: boolean
  problems: string[]
}

/** Pure check used by the launcher and by `doctor`. */
export function checkInstall(root: string = packageRoot, platform: NodeJS.Platform = process.platform, arch: string = process.arch): InstallCheck {
  const problems: string[] = []
  const require = createRequire(join(root, 'package.json'))
  for (const dep of ['zod', '@modelcontextprotocol/server']) {
    // `exports` maps hide `<dep>/package.json` from require.resolve, so check the bare specifier and the directory.
    let present = existsSync(join(root, 'node_modules', dep, 'package.json'))
    if (!present) { try { require.resolve(dep); present = true } catch { /* missing */ } }
    if (!present) problems.push(`dependency ${dep} is not installed (node_modules missing or incomplete): run \`npm ci\` in ${root}`)
  }
  if (!existsSync(join(root, 'dist', 'server.js'))) {
    problems.push(`dist/server.js is missing: run \`npm run build:ts\` in ${root}`)
  }
  const override = process.env.COMPUTER_USE_NATIVE_PATH
  const candidates = override ? [override] : [
    join(root, `computer-use-napi.${platform}-${arch}.node`),
    join(root, 'computer-use-napi.node'),
  ]
  if (!candidates.some(path => existsSync(path))) {
    let optionalPackage = false
    try { require.resolve(`@zavora-ai/computer-use-mcp-${platform}-${arch}/package.json`); optionalPackage = true } catch { /* not installed */ }
    if (!optionalPackage) {
      problems.push(`native addon for ${platform}-${arch} is missing (tried ${candidates.join(', ')}): run \`npm run build:native\` in ${root}, or set COMPUTER_USE_NATIVE_PATH`)
    }
  }
  return { ok: problems.length === 0, problems }
}

const isEntry = (() => {
  const argv1 = process.argv[1]
  if (!argv1) return false
  return argv1.replace(/\\/g, '/').endsWith('/launch.js') || argv1.replace(/\\/g, '/').endsWith('/computer-use-mcp')
})()

if (isEntry) {
  const check = checkInstall()
  if (!check.ok) {
    for (const problem of check.problems) console.error(`[computer-use-mcp] install check failed: ${problem}`)
    process.exit(2)
  }
  await import('./server.js')
}
