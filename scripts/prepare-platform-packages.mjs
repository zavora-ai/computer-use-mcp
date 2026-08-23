// Prepare the per-platform native packages (PR-15): stamp each package version to
// match the root package and copy the built `.node` binary into it. Binaries are
// gitignored (built per-platform on CI); this runs before `npm pack`/publish.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = rootPkg.version

const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']

let prepared = 0
for (const target of TARGETS) {
  const dir = path.join(root, 'packages', `computer-use-mcp-${target}`)
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    console.error(`missing package manifest for ${target}: ${pkgPath}`)
    process.exitCode = 1
    continue
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (pkg.version !== version) {
    pkg.version = version
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  }
  const binary = `computer-use-napi.${target}.node`
  const src = path.join(root, binary)
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(dir, binary))
    prepared++
    console.log(`prepared ${target} @ ${version} (binary copied)`)
  } else {
    console.log(`prepared ${target} @ ${version} (binary ${binary} not present — build on the ${target} runner)`)
  }
}
console.log(`platform packages stamped to ${version}; ${prepared}/${TARGETS.length} binaries present locally`)
