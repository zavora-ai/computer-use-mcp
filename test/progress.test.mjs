// PR-14 (progress half): filesystem search emits progress ONLY when the request
// carries a progressToken. Driven as an agent via the SDK client's onprogress.

import assert from 'node:assert/strict'
import test from 'node:test'

// v7.6: these tests describe the full v7 surface; the default profile is `desktop` since 7.6.
process.env.COMPUTER_USE_PROFILE ??= 'full'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

function makeTree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cu-prog-')))
  for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x')
  return root
}

async function withClient(fn) {
  const t = new StdioClientTransport({ command: 'node', args: ['dist/server.js'], env: { ...process.env } })
  const c = new Client({ name: 'progress-agent', version: '1.0.0' })
  await c.connect(t)
  try { return await fn(c) } finally { await c.close() }
}

test('filesystem search emits progress notifications when a progressToken is present', async () => {
  const root = makeTree()
  try {
    await withClient(async (c) => {
      const progress = []
      const r = await c.callTool(
        { name: 'filesystem', arguments: { mode: 'search', path: root, pattern: '*', recursive: true } },
        { onprogress: (p) => progress.push(p) },
      )
      assert.ok(!r.isError, 'search should succeed')
      assert.ok(progress.length >= 1, `expected >=1 progress notification, got ${progress.length}`)
      assert.equal(typeof progress[0].progress, 'number', 'progress carries a numeric progress value')
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// 7.7.0 (K10): the SDK client settles a response as soon as it reads it and handles notifications a microtask later,
// so progress that reaches it in the same read as the result was dropped as "unknown token". Holding the client's
// event loop once the call is sent makes the server's notifications and its result pile up into one read, which full-
// suite load used to cause about one run in three. The server must not write the result until the client has handled
// the progress.
test('progress written before the result survives a client that reads both at once', async () => {
  const root = makeTree()
  const t = new StdioClientTransport({ command: 'node', args: ['dist/server.js'], env: { ...process.env } })
  const send = t.send.bind(t)
  t.send = async (message, options) => {
    await send(message, options)
    if (message.method === 'tools/call') {
      const until = Date.now() + 500
      while (Date.now() < until) { /* busy: read nothing until the server has written everything */ }
    }
  }
  const c = new Client({ name: 'progress-agent', version: '1.0.0' })
  const errors = []
  c.onerror = error => errors.push(String(error?.message ?? error))
  await c.connect(t)
  try {
    const progress = []
    const r = await c.callTool(
      { name: 'filesystem', arguments: { mode: 'search', path: root, pattern: '*', recursive: true } },
      { onprogress: (p) => progress.push(p) },
    )
    assert.ok(!r.isError, 'search should succeed')
    assert.ok(progress.length >= 1, `expected >=1 progress notification, got ${progress.length}: ${errors.join('; ')}`)
    assert.deepEqual(errors.filter(e => e.includes('unknown token')), [])
  } finally {
    await c.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('filesystem search without a progressToken still returns results (no token → no progress path)', async () => {
  const root = makeTree()
  try {
    await withClient(async (c) => {
      // No onprogress → SDK sends no progressToken → server builds no reporter.
      const r = await c.callTool({ name: 'filesystem', arguments: { mode: 'search', path: root, pattern: '*', recursive: true } })
      assert.ok(!r.isError)
      const text = r.content.find(x => x.type === 'text')?.text ?? ''
      assert.ok(text.includes('f0.txt') || text.includes('f1.txt'), 'search returns matches')
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
