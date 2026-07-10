import assert from 'node:assert/strict'
import test from 'node:test'
import { isStdioEntrypoint } from '../dist/entrypoint.js'

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
