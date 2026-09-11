// The console host: the process that lets a person and an agent look at the same
// run. Binds loopback on an ephemeral port and injects a fake desktop, so this
// needs no real screen and no API key.

import assert from 'node:assert/strict'
import test from 'node:test'
import { serve } from '../dist/run-console-host.js'

/** A desktop that always returns the same frame, so captures are deterministic. */
const fakeSession = () => ({
  async dispatch(tool) {
    assert.equal(tool, 'screenshot')
    return { content: [{ type: 'image', data: 'ZmFrZS1mcmFtZQ==', mimeType: 'image/png' }] }
  },
})

async function withHost(run) {
  const host = await serve({ port: 0, session: fakeSession() })
  try {
    return await run(host)
  } finally {
    await host.close()
  }
}

const post = async (host, path, body) => {
  const response = await fetch(`${host.url.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
const parse = result => JSON.parse(result.content.find(block => block.type === 'text').text)

/** Call a tool over the host's MCP endpoint, the way an agent does. */
async function mcp(host, method, params, id = 1) {
  const response = await fetch(host.mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const raw = await response.text()
  // Streamable HTTP may answer as an SSE frame; the payload is the same either way.
  const match = /data:\s*(\{.*\})/s.exec(raw)
  return JSON.parse(match ? match[1] : raw).result
}

test('the host serves the app, the page and an MCP endpoint together', async () => {
  await withHost(async host => {
    const page = await fetch(host.url)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<iframe id="frame" src="\/app"/, 'the host embeds the app')

    const app = await fetch(`${host.url}app`)
    assert.match(await app.text(), /id="composer"/, 'the app itself is served')

    const tools = (await mcp(host, 'tools/list', {})).tools.map(tool => tool.name)
    for (const name of ['run_start', 'run_plan', 'run_progress', 'run_say', 'run_console']) {
      assert.ok(tools.includes(name), `${name} is reachable over /mcp`)
    }
    assert.ok(tools.includes('screenshot'), 'and so are the desktop tools, from the same server')
  })
})

test('the first message opens the run, and the page cannot fake an agent turn', async () => {
  await withHost(async host => {
    assert.equal(await fetch(`${host.url}run-id`).then(r => r.text()), '',
      'there is no conversation until someone speaks')

    // Asking to speak as the agent must not work: the host pins the role.
    const opened = await post(host, '/rpc', {
      name: 'run_say',
      arguments: { text: 'model a chair', role: 'agent' },
    })
    assert.equal(opened.status, 200)
    const run = parse(opened.body)
    assert.equal(run.prompt, 'model a chair', 'the run is opened from the person\'s own words')
    assert.deepEqual(run.messages.map(message => message.role), ['user'])

    const runId = await fetch(`${host.url}run-id`).then(r => r.text())
    assert.equal(runId, run.runId)

    // A later message is appended to the same conversation, still as the person.
    const second = await post(host, '/rpc', { name: 'run_say', arguments: { text: 'now a table' } })
    assert.deepEqual(parse(second.body).messages.map(message => message.role), ['user', 'user'])
    assert.equal(parse(second.body).runId, runId, 'one run carries the whole conversation')
  })
})

test('the page may only read the run and add a turn to it', async () => {
  await withHost(async host => {
    await post(host, '/rpc', { name: 'run_say', arguments: { text: 'start' } })
    for (const name of ['run_progress', 'run_plan', 'run_start', 'screenshot', 'run_script']) {
      const attempt = await post(host, '/rpc', { name, arguments: {} })
      assert.equal(attempt.status, 403, `${name} must be refused to the page`)
      assert.equal(attempt.body.isError, true)
      assert.match(attempt.body.content[0].text, /may not be called from the app/)
    }
    // Blank messages are refused rather than recorded.
    const blank = await post(host, '/rpc', { name: 'run_say', arguments: { text: '   ' } })
    assert.equal(blank.body.isError, true)
  })
})

test('the page and an agent see one run: plan and frames cross between them', async () => {
  await withHost(async host => {
    const opened = await post(host, '/rpc', { name: 'run_say', arguments: { text: 'build it' } })
    const runId = parse(opened.body).runId

    // The agent plans and captures through /mcp...
    await mcp(host, 'tools/call', {
      name: 'run_plan',
      arguments: { runId, tasks: [{ id: 'a', title: 'Do the thing' }] },
    })
    await mcp(host, 'tools/call', {
      name: 'run_progress',
      arguments: { runId, taskId: 'a', status: 'done', narration: 'Did it.', capture: true, caption: 'a frame' },
    }, 2)

    // ...and the page sees all of it, frame bytes included, because it draws them.
    const seen = parse((await post(host, '/rpc', { name: 'run_console', arguments: {} })).body)
    assert.deepEqual(seen.tasks.map(task => [task.id, task.status]), [['a', 'done']])
    assert.equal(seen.narration, 'Did it.')
    assert.equal(seen.screenshot.data, 'ZmFrZS1mcmFtZQ==')
    assert.equal(seen.screenshot.caption, 'a frame')
    assert.deepEqual(seen.messages.map(message => message.role), ['user', 'agent'])
  })
})

test('a driver can report a turn that died before the agent could speak', async () => {
  await withHost(async host => {
    // Nothing to report against until a conversation exists.
    const early = await post(host, '/driver', { state: 'failed', narration: 'boom' })
    assert.equal(early.status, 409)

    await post(host, '/rpc', { name: 'run_say', arguments: { text: 'go' } })
    const reported = await post(host, '/driver', {
      state: 'failed',
      narration: 'This turn stopped before I could finish: the model refused.',
    })
    assert.equal(reported.status, 200)

    const seen = parse((await post(host, '/rpc', { name: 'run_console', arguments: {} })).body)
    assert.equal(seen.state, 'failed', 'the person is told, instead of watching a spinner forever')
    assert.match(seen.narration, /stopped before I could finish/)
  })
})

test('an unknown path is a 404 rather than a stack trace', async () => {
  await withHost(async host => {
    const missing = await fetch(`${host.url}nope`)
    assert.equal(missing.status, 404)
  })
})
