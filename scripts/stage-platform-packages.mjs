// Stage only the exact tested/attested tarballs, before staging the main package.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGETS } from './prepare-platform-packages.mjs'
import { npmCommand } from './npm-command.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
function runNpm(args) {
  const command = npmCommand(args)
  const result = spawnSync(command.command, command.args, { encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}
function errorCode(result) {
  try { return JSON.parse(result.stdout).error?.code } catch { return undefined }
}
/** An E404 for a version of a package that exists ("No match found for version"), not for a name npm has never seen. */
function isMissingVersion(result) {
  try { return /No match found for version/i.test(JSON.parse(result.stdout).error?.summary ?? '') } catch { return false }
}
/** E409 for a version that is staged and awaiting approval, which staging again cannot replace. */
function alreadyStaged(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return errorCode(result) === 'E409' && /already staged|Cannot stage previously published version/i.test(text)
}

export function stagePlatformPackages(directory = root, npm = runNpm, env = process.env) {
  const rootPkg = readJson(join(directory, 'package.json'))
  const version = rootPkg.version
  const packages = readJson(join(directory, 'release', 'platform', 'packages.json'))
  if (packages.length !== TARGETS.length || new Set(packages.map(pkg => pkg.target)).size !== TARGETS.length) {
    throw new Error('Release must contain all six distinct native packages')
  }
  // Complete local and registry preflight before staging any package.
  const local = packages.map(pkg => {
    if (!TARGETS.includes(pkg.target) || pkg.version !== version ||
        pkg.name !== `@zavora-ai/computer-use-mcp-${pkg.target}` ||
        pkg.filename !== `zavora-ai-computer-use-mcp-${pkg.target}-${version}.tgz`) {
      throw new Error(`Invalid native release metadata: ${pkg.name}`)
    }
    const archive = join(directory, 'release', 'platform', pkg.filename)
    const integrity = 'sha512-' + createHash('sha512').update(readFileSync(archive)).digest('base64')
    if (integrity !== pkg.integrity) throw new Error(`Tarball integrity mismatch: ${pkg.name}`)
    return { pkg, archive, integrity }
  })
  // 7.6.2: a push after a release is not a release. The main version already on npm already chose its native
  // dependencies, so nothing is staged; without this, every later push re-checked (and, with non-reproducible Windows
  // builds, failed on) packages that cannot change, and a version from before the native packages existed tried to
  // create them.
  const mainSpec = `${rootPkg.name ?? '@zavora-ai/computer-use-mcp'}@${version}`
  const main = npm(['view', mainSpec, 'version', '--json'])
  if (main.status === 0 && main.stdout.trim()) {
    console.log(`${mainSpec} is already published; no native packages to stage`)
    return
  }
  if (main.status !== 0 && errorCode(main) !== 'E404') throw new Error(`Cannot check ${mainSpec}: ${main.stderr || main.stdout}`)
  const pending = []
  for (const { pkg, archive, integrity } of local) {
    const spec = `${pkg.name}@${version}`
    const existing = npm(['view', spec, 'dist.integrity', '--json'])
    if (existing.status === 0) {
      // 7.6.2: a published version is immutable, and Windows binaries differ from build to build, so a different
      // tarball is not a reason to fail the release: nothing is staged for it, as the main package step does.
      if (JSON.parse(existing.stdout) !== integrity) {
        console.warn(`::warning::${spec} is already published and this build's tarball differs; nothing staged for it. Bump the version to publish again.`)
      } else console.log(`${spec} already published with identical integrity — skipping`)
    } else {
      if (errorCode(existing) !== 'E404') throw new Error(`Cannot check ${spec}: ${existing.stderr || existing.stdout}`)
      pending.push({ spec, archive, integrity, created: !isMissingVersion(existing) })
    }
  }
  // 7.7.0: trusted publishing (OIDC) cannot create a package name, so the first release of a native package needs the
  // stage-only bootstrap token. Without it npm answers ENEEDAUTH, which does not say that a secret is missing.
  const created = pending.filter(entry => entry.created).map(entry => entry.spec)
  if (created.length && !env.NODE_AUTH_TOKEN) {
    throw new Error(
      `${created.join(', ')} ${created.length === 1 ? 'is a new package name' : 'are new package names'} on npm, ` +
      'and trusted publishing cannot create a name. Add the NPM_NATIVE_STAGE_TOKEN secret (a granular "Read and write ' +
      '(stage only)" token for @zavora-ai) and run the release again; see "First release of new package names" in ' +
      'docs/NATIVE-PACKAGES.md. Nothing was staged.',
    )
  }
  for (const { spec, archive, integrity } of pending) {
    const result = npm(['stage', 'publish', archive, '--access', 'public', '--provenance', '--ignore-scripts', '--json'])
    if (result.status !== 0 && alreadyStaged(result)) {
      // A version staged and awaiting approval (E409) is not an error either: staging again cannot replace it, and the
      // maintainer compares the pending tarball with this run's release evidence before approving (7.6.1 behaviour).
      console.warn(`::warning::${spec} is already staged and awaiting approval; nothing staged again. Compare it with release evidence ${integrity} before approving.`)
      continue
    }
    if (result.status !== 0) {
      const git = process.env.GITHUB_SHA ? undefined : spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: directory, encoding: 'utf8', timeout: 5000,
      })
      const commit = process.env.GITHUB_SHA || (git?.status === 0 ? git.stdout.trim() : 'unavailable')
      throw new Error(
        `Cannot stage ${spec} (${errorCode(result) ?? `exit ${result.status}`}): ${result.stderr || result.stdout}\n` +
        `Commit: ${commit}\nArtifact: ${archive}\nIntegrity: ${integrity}\n` +
        `Release evidence: release-evidence-${commit}\n` +
        'Staging stopped; verify any pending tarball against this release evidence before approval.',
      )
    }
    console.log(result.stdout)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) stagePlatformPackages()
