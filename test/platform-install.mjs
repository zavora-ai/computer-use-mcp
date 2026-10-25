// Real npm optional-dependency resolution against a disposable loopback registry.
// No npm publication, global configuration, GUI access or native input is used.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { TARGETS } from '../scripts/prepare-platform-packages.mjs'
import { npmCommand } from '../scripts/npm-command.mjs'

const execute = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = `${process.platform}-${process.arch}`
assert.ok(TARGETS.includes(target), `Unsupported test host: ${target}`)
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const directory = fs.mkdtempSync(path.join(tmpdir(), 'computer-use-native-install-'))
const env = { ...process.env }
delete env.COMPUTER_USE_NATIVE_PATH
const runNpm = async (args, cwd) => {
  const command = npmCommand(args)
  return execute(command.command, command.args, { cwd, env, maxBuffer: 8 * 1024 * 1024 })
}

function tarFiles(archive) {
  const data = gunzipSync(archive)
  const files = new Map()
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '')
    if (!name) break
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0
    files.set(name, data.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

const packed = JSON.parse(fs.readFileSync(path.join(root, 'release', 'platform', 'packages.json'), 'utf8'))
assert.equal(packed.length, TARGETS.length)
const packages = new Map()
for (const entry of packed) {
  const archive = fs.readFileSync(path.join(root, 'release', 'platform', entry.filename))
  assert.equal('sha512-' + createHash('sha512').update(archive).digest('base64'), entry.integrity)
  const files = tarFiles(archive)
  const pkg = JSON.parse(files.get('package/package.json').toString())
  const [os, cpu] = entry.target.split('-')
  const binary = `computer-use-napi.${entry.target}.node`
  assert.ok(TARGETS.includes(entry.target))
  assert.equal(pkg.name, entry.name)
  assert.equal(pkg.version, rootPkg.version)
  assert.deepEqual(pkg.os, [os])
  assert.deepEqual(pkg.cpu, [cpu])
  assert.deepEqual([...files.keys()].sort(), ['package/LICENSE', `package/${binary}`, 'package/package.json'].sort())
  assert.ok(files.get(`package/${binary}`).length > 0)
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.scripts, undefined)
  packages.set(pkg.name, { entry, pkg, archive })
}
assert.equal(packages.size, TARGETS.length)
console.log('All six packed manifests, versions, os/cpu gates, binaries and licenses verified')

let available = true
const downloads = []
const server = createServer((request, response) => {
  const route = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1)
  const native = packages.get(route)
  const archive = [...packages.values()].find(value => route === `tarballs/${value.entry.filename}`)
  if (!available || (!native && !archive)) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'Not found' }))
  } else if (archive) {
    downloads.push(archive.entry.target)
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(archive.archive)
  } else {
    const { pkg, entry } = native
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ name: pkg.name, 'dist-tags': { latest: pkg.version }, versions: {
      [pkg.version]: { ...pkg, dist: { integrity: entry.integrity,
        tarball: `http://127.0.0.1:${server.address().port}/tarballs/${entry.filename}` } },
    } }))
  }
})

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { stdout } = await runNpm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], root)
  const [main] = JSON.parse(stdout)
  const archive = path.join(directory, main.filename)
  const nativeName = `@zavora-ai/computer-use-mcp-${target}`
  const binaryName = `computer-use-napi.${target}.node`

  async function install(name, args = []) {
    const probe = path.join(directory, name)
    fs.mkdirSync(probe)
    fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'native-install-probe', version: '1.0.0', private: true }))
    const config = path.join(probe, '.npmrc')
    fs.writeFileSync(config, `registry=https://registry.npmjs.org\n@zavora-ai:registry=http://127.0.0.1:${server.address().port}\ncache=${path.join(probe, 'cache').replaceAll('\\', '/')}\n`)
    env.NPM_CONFIG_USERCONFIG = config
    await runNpm(['install', archive, '--ignore-scripts', '--no-audit', '--no-fund', ...args], probe)
    return probe
  }

  async function check(probe, expected, override) {
    const code = `
      const { resolveAddonPath, loadNative } = await import('@zavora-ai/computer-use-mcp/host-native');
      const assert = (await import('node:assert/strict')).default;
      const { realpathSync } = await import('node:fs');
      assert.equal(realpathSync(resolveAddonPath()), realpathSync(${JSON.stringify(expected)}));
      const addon = loadNative();
      assert.equal(typeof addon.getDisplaySize, 'function');
      console.log('Native loaded from:', resolveAddonPath(), 'exports:', Object.keys(addon).length);
    `
    const result = await execute(process.execPath, ['--input-type=module', '-e', code], {
      cwd: probe, env: { ...env, ...(override ? { COMPUTER_USE_NATIVE_PATH: override } : {}) },
    })
    console.log(result.stdout.trim())
  }

  const probe = await install('automatic')
  const optionalBinary = path.join(probe, 'node_modules', nativeName, binaryName)
  assert.ok(fs.existsSync(optionalBinary), 'npm install must automatically fetch the compatible optional native package')
  assert.deepEqual(downloads, [target], 'npm must download only the matching os/cpu tarball')
  await check(probe, optionalBinary)
  const installedRoot = path.join(probe, 'node_modules', rootPkg.name)
  // 7.7.0: the main package is thin, as Claude Code, Codex and esbuild ship: no binary of its own.
  assert.deepEqual(fs.readdirSync(installedRoot).filter(name => name.endsWith('.node')), [], 'the main package ships no native binary')
  const overrideBinary = path.join(probe, `override-${binaryName}`)
  fs.copyFileSync(optionalBinary, overrideBinary)
  await check(probe, overrideBinary, overrideBinary)

  // A source checkout under the probe resolves the already installed platform package.
  // Its freshly built root binary must win when source validation explicitly selects it.
  const source = path.join(probe, 'source-checkout')
  fs.mkdirSync(path.join(source, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ type: 'module' }))
  fs.copyFileSync(path.join(root, 'dist', 'native.js'), path.join(source, 'dist', 'native.js'))
  const currentBinary = path.join(source, binaryName)
  fs.copyFileSync(path.join(root, binaryName), currentBinary)
  const sourceCheck = `
    import { verifyLocalNative } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts', 'verify-local-native.mjs')).href)};
    await verifyLocalNative(${JSON.stringify(binaryName)}, ${JSON.stringify(source)});
  `
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', sourceCheck], {
    cwd: probe, env,
  }), error => error.stderr.includes('must select the current build artifact'))
  const current = await execute(process.execPath, ['--input-type=module', '-e', sourceCheck], {
    cwd: probe, env: { ...env, COMPUTER_USE_NATIVE_PATH: currentBinary },
  })
  console.log(current.stdout.trim())
  console.log('Source checkout uses the current build artifact with an installed platform package present')

  console.log('The platform package loads; the main package carries no binary; an explicit override retains precedence')

  // Without the platform package there is no addon: the install succeeds, and loading names the package and the fix.
  async function missing(probe) {
    const code = `
      const { resolveAddonPath } = await import('@zavora-ai/computer-use-mcp/host-native');
      try { resolveAddonPath(); console.log('RESOLVED') } catch (error) { console.log(error.message) }
    `
    const result = await execute(process.execPath, ['--input-type=module', '-e', code], { cwd: probe, env })
    assert.match(result.stdout, new RegExp(`Native binary missing for ${target}`))
    assert.ok(result.stdout.includes(`optional package ${nativeName}`), result.stdout)
    assert.ok(result.stdout.includes('--omit=optional'), result.stdout)
  }
  const omitted = await install('omitted', ['--omit=optional'])
  assert.equal(fs.existsSync(path.join(omitted, 'node_modules', nativeName)), false)
  await missing(omitted)
  available = false
  const unavailable = await install('unavailable')
  assert.equal(fs.existsSync(path.join(unavailable, 'node_modules', nativeName)), false, 'npm skips an optional package the registry lacks')
  await missing(unavailable)
  console.log(`PASS ${target}: automatic npm install of the matching package only, native load, override, and a named fix when the platform package is omitted or unavailable`)
} finally {
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(directory, { recursive: true, force: true })
}
