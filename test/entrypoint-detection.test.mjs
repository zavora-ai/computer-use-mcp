import assert from 'node:assert/strict'
import test from 'node:test'
import { isStdioEntrypoint, isModuleEntrypoint } from '../dist/entrypoint.js'

// Regression: prior to this fix, the standalone entrypoint guard used
// `endsWith('/server.js')` and friends — broken on Windows where Node
// normalizes process.argv[1] to use backslashes. The server silently exited
// without starting StdioServerTransport, breaking `node dist/server.js` and
// `npx @zavora-ai/computer-use-mcp` on every Windows host.

test('isStdioEntrypoint accepts POSIX-style server.js path', () => {
  assert.equal(isStdioEntrypoint('/usr/local/bin/server.js'), true)
  assert.equal(isStdioEntrypoint('/home/user/project/dist/server.js'), true)
})

test('isStdioEntrypoint accepts Windows-style server.js path', () => {
  assert.equal(isStdioEntrypoint('C:\\Users\\Jeff\\node_modules\\@zavora-ai\\computer-use-mcp\\dist\\server.js'), true)
  assert.equal(isStdioEntrypoint('D:\\projects\\app\\dist\\server.js'), true)
})

test('isStdioEntrypoint accepts POSIX-style server.ts path (tsx dev mode)', () => {
  assert.equal(isStdioEntrypoint('/repo/src/server.ts'), true)
})

test('isStdioEntrypoint accepts Windows-style server.ts path (tsx dev mode)', () => {
  assert.equal(isStdioEntrypoint('C:\\repo\\src\\server.ts'), true)
})

test('isStdioEntrypoint accepts POSIX-style bin-name path', () => {
  assert.equal(isStdioEntrypoint('/usr/local/bin/computer-use-mcp'), true)
})

test('isStdioEntrypoint accepts Windows-style bin-name path', () => {
  assert.equal(isStdioEntrypoint('C:\\Users\\Jeff\\AppData\\Roaming\\npm\\computer-use-mcp'), true)
})

test('isStdioEntrypoint rejects unrelated entry points', () => {
  assert.equal(isStdioEntrypoint('/usr/local/bin/client.js'), false)
  assert.equal(isStdioEntrypoint('C:\\repo\\dist\\demo.js'), false)
  assert.equal(isStdioEntrypoint('/path/to/some-other-tool'), false)
})

test('isStdioEntrypoint handles undefined argv[1] gracefully', () => {
  assert.equal(isStdioEntrypoint(undefined), false)
})

test('isStdioEntrypoint handles empty string gracefully', () => {
  assert.equal(isStdioEntrypoint(''), false)
})

// ── isModuleEntrypoint ──────────────────────────────────────────────────────
//
// npm installs a bin as a symlink under node_modules/.bin, so argv[1] is that
// link while import.meta.url is the real file. Comparing the two directly is
// false for every packaged CLI, which makes the command exit successfully
// having done nothing — the failure mode this guards against.

test('isModuleEntrypoint sees through a bin symlink', async () => {
  const { mkdtemp, writeFile, symlink } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')

  const directory = await mkdtemp(join(tmpdir(), 'entrypoint-'))
  const real = join(directory, 'run-console-host.js')
  const link = join(directory, 'computer-use-mcp-console')
  await writeFile(real, '// a packaged bin\n')
  await symlink(real, link)

  const moduleUrl = pathToFileURL(real).href
  assert.equal(isModuleEntrypoint(moduleUrl, link), true,
    'invoked through the symlink npm created')
  assert.equal(isModuleEntrypoint(moduleUrl, real), true, 'invoked directly')
  assert.equal(isModuleEntrypoint(moduleUrl, join(directory, 'other.js')), false,
    'a different file is not the entrypoint')
})

test('isModuleEntrypoint reports false rather than throwing on bad input', async () => {
  const { pathToFileURL } = await import('node:url')
  const url = pathToFileURL(process.argv[1] ?? '/tmp/x').href
  assert.equal(isModuleEntrypoint(url, undefined), false)
  assert.equal(isModuleEntrypoint(url, ''), false)
  // A path that does not exist cannot be resolved, so it is not the entrypoint.
  assert.equal(isModuleEntrypoint(url, '/nonexistent/path/that/cannot/resolve'), false)
})
