// Agent run console: an MCP App that shows a person the plan, narration and
// screenshots while an agent works. No network, no browser, no API key.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { RunStore, newRunId, RUN_CONSOLE_URI } from '../dist/agent-run.js'
import { RUN_CONSOLE_HTML, runConsoleHtml, ANALYTICS_BRAND } from '../dist/run-console.js'

const parse = result => JSON.parse(result.content.find(block => block.type === 'text').text)

async function connect(options = {}) {
  return connectInProcess(createComputerUseServer({ runConsole: true, ...options }))
}

// ── Store semantics ─────────────────────────────────────────────────────────

test('a plan revision preserves the status of tasks that keep their id', () => {
  const store = new RunStore()
  const run = store.start('build a scene', 'run_test')
  assert.equal(run.state, 'planning')
  store.plan('run_test', [{ id: 'a', title: 'First' }, { id: 'b', title: 'Second' }])
  store.progress('run_test', { taskId: 'a', status: 'done', note: 'took 3s' })

  // Reword one task, add another: progress already made must survive.
  const revised = store.plan('run_test', [
    { id: 'a', title: 'First, reworded' },
    { id: 'b', title: 'Second' },
    { id: 'c', title: 'Third, added mid-run' },
  ])
  assert.equal(revised.state, 'working', 'declaring a plan moves the run out of planning')
  assert.deepEqual(revised.tasks.map(task => [task.id, task.status]),
    [['a', 'done'], ['b', 'pending'], ['c', 'pending']])
  assert.equal(revised.tasks[0].title, 'First, reworded')
  assert.equal(revised.tasks[0].note, 'took 3s', 'the note survives a rewording')
})

test('a plan declared after the run finished starts the next turn clean', () => {
  // Multi-turn: the same run carries the whole conversation, and agents reuse
  // obvious task ids like "capture" between requests. Inheriting the last turn's
  // status would show the new request's steps as already done.
  const store = new RunStore()
  store.start('make it blue', 'r')
  store.plan('r', [{ id: 'colour', title: 'Colour it' }, { id: 'show', title: 'Show you' }])
  store.progress('r', { taskId: 'colour', status: 'done', note: 'blue' })
  store.progress('r', { taskId: 'show', status: 'done', note: 'captured' })
  store.progress('r', { state: 'done' })

  const next = store.plan('r', [{ id: 'shape', title: 'Add a cone' }, { id: 'show', title: 'Show you again' }])
  assert.equal(next.state, 'working', 'a new plan reopens a finished run')
  assert.deepEqual(next.tasks.map(task => [task.id, task.status]), [['shape', 'pending'], ['show', 'pending']],
    'nothing is inherited across a turn boundary')
  assert.equal(next.tasks[1].note, undefined, 'and no stale note is carried over')

  // Mid-turn revision still behaves the old way, which is what it is for.
  store.progress('r', { taskId: 'shape', status: 'done', note: 'cone added' })
  const revised = store.plan('r', [{ id: 'shape', title: 'Add a cone' }, { id: 'show', title: 'Show you again' }])
  assert.equal(revised.tasks[0].status, 'done', 'a revision while working keeps progress')
  assert.equal(revised.tasks[0].note, 'cone added')
})

test('exactly one task is active, so the console never shows two current steps', () => {
  const store = new RunStore()
  store.start('x', 'r')
  store.plan('r', [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])
  store.progress('r', { taskId: 'a', status: 'active' })
  const moved = store.progress('r', { taskId: 'b', status: 'active' })
  assert.deepEqual(moved.tasks.filter(task => task.status === 'active').map(task => task.id), ['b'])
  assert.equal(moved.tasks.find(task => task.id === 'a').status, 'pending')
})

test('the store rejects input that would make the console lie', () => {
  const store = new RunStore()
  store.start('x', 'r')
  store.plan('r', [{ id: 'a', title: 'A' }])
  assert.throws(() => store.get('missing'), /Unknown runId/)
  assert.throws(() => store.progress('r', { taskId: 'ghost', status: 'done' }), /Unknown taskId/)
  assert.throws(() => store.progress('r', { status: 'done' }), /status applies to a task/)
  assert.throws(() => store.plan('r', [{ id: 'a', title: 'A' }, { id: 'a', title: 'dup' }]), /unique/)
  const huge = 'A'.repeat(5 * 1024 * 1024)
  assert.throws(() => store.progress('r', { screenshot: { data: huge, mimeType: 'image/png' } }), /over the/)
})

test('a supplied run store is shared by every server built from it', async () => {
  // The HTTP handler builds a server per request. Without a shared store each
  // request would begin with an empty transcript, so a runId handed to the agent
  // on one request would be unknown on the next.
  const store = new RunStore()
  const first = await connect({ runStore: store })
  const second = await connect({ runStore: store })
  try {
    const { runId } = parse(await first.callTool('run_start', { prompt: 'model a chair' }))
    await first.callTool('run_plan', { runId, tasks: [{ id: 'seat', title: 'Block out the seat' }] })

    // A different server instance must find the run and be able to advance it.
    const seen = parse(await second.callTool('run_console', { runId }))
    assert.equal(seen.prompt, 'model a chair')
    assert.deepEqual(seen.tasks.map(task => task.id), ['seat'])

    await second.callTool('run_progress', { runId, taskId: 'seat', status: 'done' })
    assert.equal(parse(await first.callTool('run_console', { runId })).tasks[0].status, 'done',
      'progress reported through one server is visible through the other')
  } finally {
    await first.close()
    await second.close()
  }
})

test('without a shared store each server starts empty', async () => {
  const first = await connect()
  const second = await connect()
  try {
    const { runId } = parse(await first.callTool('run_start', { prompt: 'x' }))
    const missed = await second.callTool('run_console', { runId })
    assert.equal(missed.isError, true, 'a run is private to the server that recorded it')
    assert.match(parse(missed).message, /Unknown runId/)
  } finally {
    await first.close()
    await second.close()
  }
})

test('the store is bounded and status returns a copy', () => {
  const store = new RunStore()
  for (let i = 0; i < 40; i++) store.start(`prompt ${i}`, `run_${i}`)
  assert.throws(() => store.get('run_0'), /Unknown runId/, 'oldest runs are evicted')
  store.plan('run_39', [{ id: 'a', title: 'A' }])
  const snapshot = store.status('run_39')
  snapshot.tasks[0].status = 'done'
  assert.equal(store.status('run_39').tasks[0].status, 'pending', 'status must not hand out live state')
  assert.match(newRunId(), /^run_[a-z0-9]{16}$/)
})

// ── Tool surface ────────────────────────────────────────────────────────────

test('the transcript records the request, what the agent said, and mid-run asks', () => {
  const store = new RunStore()
  const run = store.start('Model a still life', 'r')
  assert.deepEqual(run.messages.map(m => [m.role, m.text]), [['user', 'Model a still life']],
    'the run opens with the request, so the transcript reads as a conversation')

  store.plan('r', [{ id: 'a', title: 'A' }])
  store.progress('r', { taskId: 'a', status: 'active', narration: 'Adding the table.' })
  // A polling agent repeats its narration; the transcript must not repeat with it.
  store.progress('r', { taskId: 'a', narration: 'Adding the table.' })
  store.progress('r', { narration: 'Now the bottle.' })
  const steered = store.say('r', 'user', '  make it taller  ')

  assert.deepEqual(steered.messages.map(m => [m.role, m.text]), [
    ['user', 'Model a still life'],
    ['agent', 'Adding the table.'],
    ['agent', 'Now the bottle.'],
    ['user', 'make it taller'],
  ])
  assert.throws(() => store.say('r', 'user', '   '), /needs text/)
})

test('the transcript is bounded but keeps the opening request', () => {
  const store = new RunStore()
  store.start('the original ask', 'r')
  for (let i = 0; i < 400; i++) store.say('r', 'agent', `line ${i}`)
  const run = store.status('r')
  assert.equal(run.messages.length, 200)
  assert.equal(run.messages[0].text, 'the original ask', 'the ask is the run context; it must not be evicted')
  assert.equal(run.messages.at(-1).text, 'line 399')
})

test('the run tools are reachable and report a live plan', async () => {
  const client = await connect()
  try {
    const names = (await client.listTools()).map(tool => tool.name)
    for (const name of ['run_start', 'run_plan', 'run_progress', 'run_say', 'run_console']) {
      assert.ok(names.includes(name), `${name} must be advertised`)
    }

    const { runId } = parse(await client.callTool('run_start', { prompt: 'Render a still life' }))
    const planned = parse(await client.callTool('run_plan', {
      runId, tasks: [{ id: 'model', title: 'Model it' }, { id: 'render', title: 'Render it' }],
    }))
    assert.equal(planned.tasks.length, 2)

    await client.callTool('run_progress', { runId, taskId: 'model', status: 'active', narration: 'Modelling' })
    const finished = parse(await client.callTool('run_progress', {
      runId, taskId: 'model', status: 'done', note: 'two objects', state: 'working',
    }))
    assert.equal(finished.tasks.find(task => task.id === 'model').status, 'done')
    assert.equal(finished.narration, 'Modelling')

    // A note sent from the console reaches the agent in its next reply, without
    // the agent having to poll for it.
    await client.callTool('run_say', { runId, text: 'use warmer lighting', role: 'user' })
    const next = parse(await client.callTool('run_progress', { runId, taskId: 'render', status: 'active' }))
    assert.equal(next.messages.at(-1).text, 'use warmer lighting')
    assert.equal(next.messages.at(-1).role, 'user')

    const view = parse(await client.callTool('run_console', { runId }))
    assert.equal(view.prompt, 'Render a still life')
    assert.equal(view.state, 'working')
    assert.equal(view.messages[0].role, 'user')
    assert.equal(parse(await client.callTool('run_say', { runId, text: 'noted' })).messages.at(-1).role,
      'agent', 'role defaults to the agent speaking')
  } finally {
    await client.close()
  }
})

test('run tools are absent unless the console is enabled', async () => {
  const client = await connectInProcess(createComputerUseServer())
  try {
    const names = (await client.listTools()).map(tool => tool.name)
    // `run_script` is a base tool and shares the prefix, so check exact names.
    for (const name of ['run_start', 'run_plan', 'run_progress', 'run_say', 'run_console']) {
      assert.ok(!names.includes(name), `${name} must be opt-in`)
    }
    assert.ok(names.includes('run_script'), 'the base catalog is unaffected')
  } finally {
    await client.close()
  }
})

test('errors come back as structured tool results, not thrown faults', async () => {
  const client = await connect()
  try {
    const result = await client.callTool('run_console', { runId: 'run_doesnotexist' })
    assert.equal(result.isError, true)
    assert.equal(parse(result).error, 'run_console_error')
    assert.match(parse(result).message, /Unknown runId/)
  } finally {
    await client.close()
  }
})

test('a captured screenshot is a real frame from the session, not model text', async () => {
  // The capture goes through the session the agent drives, so the console cannot
  // be made to show an image the desktop never produced.
  const client = await connect({
    session: {
      async dispatch(tool) {
        assert.equal(tool, 'screenshot')
        return { content: [{ type: 'image', data: 'ZmFrZS1mcmFtZQ==', mimeType: 'image/png' }] }
      },
    },
  })
  try {
    const { runId } = parse(await client.callTool('run_start', { prompt: 'look' }))
    await client.callTool('run_plan', { runId, tasks: [{ id: 'look', title: 'Look' }] })
    const captured = await client.callTool('run_progress', {
      runId, taskId: 'look', status: 'active', capture: true, caption: 'the desktop',
    })

    // The frame comes back as an image, so capturing for the console is also how
    // the agent looks at the desktop: one call, one set of pixels.
    const image = captured.content.find(block => block.type === 'image')
    assert.ok(image, 'a capture returns the frame as an image block')
    assert.equal(image.data, 'ZmFrZS1mcmFtZQ==')
    assert.equal(image.mimeType, 'image/png')
    // ...and the JSON says how big it was instead of repeating those bytes.
    const updated = parse(captured)
    assert.match(updated.screenshot.data, /^<\d+ bytes of image, not repeated here>$/)
    assert.equal(updated.screenshot.caption, 'the desktop')
    assert.match(updated.screenshot.at, /^\d{4}-/)

    // The console itself still holds the real frame, which is what the page reads.
    const shown = parse(await client.callTool('run_console', { runId }))
    assert.equal(shown.screenshot.data, 'ZmFrZS1mcmFtZQ==')
    assert.equal(shown.screenshot.mimeType, 'image/png')

    // Without capture, the previous frame stays put rather than being cleared,
    // and its bytes are not re-sent to the model.
    const later = await client.callTool('run_progress', { runId, narration: 'still going' })
    assert.equal(later.content.some(block => block.type === 'image'), false,
      'an unrelated progress call does not re-send the last frame')
    assert.equal(parse(await client.callTool('run_console', { runId })).screenshot.data, 'ZmFrZS1mcmFtZQ==')
  } finally {
    await client.close()
  }
})

// ── The app itself ──────────────────────────────────────────────────────────

test('only the console reply carries the frame bytes', async () => {
  // A run holds its last screenshot. Repeating ~100 KB of base64 on every plan,
  // progress and message reply would send the same unreadable pixels back dozens
  // of times in one run, so agent-facing replies describe it instead.
  const frame = 'A'.repeat(4000)
  const client = await connect({
    session: {
      async dispatch() {
        return { content: [{ type: 'image', data: frame, mimeType: 'image/png' }] }
      },
    },
  })
  try {
    const { runId } = parse(await client.callTool('run_start', { prompt: 'look' }))
    await client.callTool('run_plan', { runId, tasks: [{ id: 'a', title: 'A' }] })
    await client.callTool('run_progress', { runId, taskId: 'a', status: 'active', capture: true })

    // Later calls must not drag the stored frame along.
    for (const [name, args] of [
      ['run_plan', { runId, tasks: [{ id: 'a', title: 'A' }] }],
      ['run_progress', { runId, narration: 'still going' }],
      ['run_say', { runId, text: 'a word' }],
    ]) {
      const result = await client.callTool(name, args)
      const text = result.content.find(block => block.type === 'text').text
      assert.equal(text.includes(frame), false, `${name} must not repeat the frame`)
      assert.match(parse(result).screenshot.data, /bytes of image, not repeated here/)
      assert.ok(text.length < 2000, `${name} reply should stay small, was ${text.length}`)
    }

    // The page still gets real pixels, because it has to draw them.
    assert.equal(parse(await client.callTool('run_console', { runId })).screenshot.data, frame)
  } finally {
    await client.close()
  }
})

test('activity is recorded for the person, and kept away from the agent', async () => {
  const store = new RunStore()
  store.start('build it', 'run_fixture')
  const recorded = store.record('run_fixture', [
    { kind: 'thought', detail: '  I should look at the scene first  ' },
    { kind: 'tool', name: 'get_objects_summary', detail: '{}' },
    { kind: 'result', name: 'get_objects_summary', detail: '3 objects', ms: 51.7 },
    { kind: 'result', name: 'execute_blender_code', detail: 'boom', failed: true },
    { kind: 'thought', detail: '   ' },
  ])
  assert.equal(recorded.activity.length, 4, 'an empty thought with no tool name is not an event')
  assert.equal(recorded.activity[0].detail, 'I should look at the scene first', 'detail is trimmed')
  assert.equal(recorded.activity[2].ms, 52, 'durations are rounded to whole milliseconds')
  assert.equal(recorded.activity[3].failed, true)
  assert.equal(recorded.activity[1].failed, undefined, 'success carries no failed flag')

  // Bounded, because one turn can be dozens of calls.
  store.record('run_fixture', Array.from({ length: 500 }, (_, index) => ({ kind: 'tool', name: `t${index}`, detail: '' })))
  const bounded = store.status('run_fixture')
  assert.equal(bounded.activity.length, 400)
  assert.equal(bounded.activity.at(-1).name, 't499', 'the newest activity survives')

  // The agent must not be handed its own activity log back: it is large and circular.
  const client = await connect({ runStore: store })
  try {
    const reply = await client.callTool('run_say', { runId: 'run_fixture', text: 'still going' })
    const text = reply.content.find(block => block.type === 'text').text
    assert.equal('activity' in parse(reply), false, 'agent replies omit the activity log')
    assert.doesNotMatch(text, /I should look at the scene first/)
    // ...but the console still gets it, because that is who it is for.
    const shown = parse(await client.callTool('run_console', { runId: 'run_fixture' }))
    assert.equal(shown.activity.length, 400)
  } finally {
    await client.close()
  }
})

test('an attached image reaches the agent as a picture and as a path', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  // The host writes the upload to disk; the store only ever holds where it went.
  const directory = await mkdtemp(join(tmpdir(), 'run-attach-'))
  const path = join(directory, 'reference.png')
  const bytes = Buffer.from('ZmFrZS1pbWFnZQ==', 'base64')
  await writeFile(path, bytes)

  const store = new RunStore()
  store.start('match this reference', 'run_fixture')
  store.attach('run_fixture', { name: 'reference.png', mimeType: 'image/png', bytes: bytes.byteLength, path, at: new Date().toISOString() })
  assert.equal(store.attachments('run_fixture').length, 1)
  assert.equal(store.status('run_fixture').messages[0].attachment.name, 'reference.png',
    'an image can ride along with the opening request rather than a second empty turn')

  const client = await connect({ runStore: store })
  try {
    const result = await client.callTool('run_attachment', { runId: 'run_fixture' })
    const image = result.content.find(block => block.type === 'image')
    assert.ok(image, 'the agent gets the picture itself')
    assert.equal(Buffer.from(image.data, 'base64').toString(), 'fake-image')
    assert.equal(image.mimeType, 'image/png')
    // The path is the point: it is what lets an application open the file.
    const meta = parse(result)
    assert.equal(meta.path, path)
    assert.equal(meta.index, 0)
    assert.equal(meta.of, 1)

    const missing = await client.callTool('run_attachment', { runId: 'run_fixture', index: 4 })
    assert.equal(missing.isError, true)
    assert.match(parse(missing).message, /No attachment at index 4/)
  } finally {
    await client.close()
  }
})

test('run_attachment says so when nothing has been attached', async () => {
  const client = await connect()
  try {
    const { runId } = parse(await client.callTool('run_start', { prompt: 'x' }))
    const empty = await client.callTool('run_attachment', { runId })
    assert.equal(empty.isError, true)
    assert.match(parse(empty).message, /Nothing has been attached/)
  } finally {
    await client.close()
  }
})

test('the console app is self-contained and cannot be made to run agent markup', async () => {
  const client = await connect()
  try {
    const listed = await client.listTools()
    assert.equal(listed.find(tool => tool.name === 'run_console')._meta?.ui?.resourceUri, RUN_CONSOLE_URI)
  } finally {
    await client.close()
  }

  // Everything the agent supplies — prompt, task titles, notes, narration — is
  // written with textContent. There is no innerHTML anywhere to inject into.
  assert.ok(!RUN_CONSOLE_HTML.includes('innerHTML'))
  assert.ok(RUN_CONSOLE_HTML.includes('textContent'))
  // No network: no remote origins, and the declared CSP allows no domains. That
  // rules out inline SVG too, since its namespace is a URL.
  assert.ok(!/https?:\/\//.test(RUN_CONSOLE_HTML), 'the app must not reference a remote origin')
  // It speaks the MCP Apps handshake rather than inventing a private protocol.
  for (const required of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/tool-result', 'ui/resource-teardown']) {
    assert.ok(RUN_CONSOLE_HTML.includes(required), `app must handle ${required}`)
  }
})

test('the console is branded and built from the two panels it promises', () => {
  for (const attribution of ['Blender Agent', 'ADK Rust', 'Computer Use MCP', 'DeepSeek Flash']) {
    assert.ok(RUN_CONSOLE_HTML.includes(attribution), `the console must credit ${attribution}`)
  }  // Left panel: the conversation and a composer that calls run_say.
  assert.ok(RUN_CONSOLE_HTML.includes('id="chat"'))
  assert.ok(RUN_CONSOLE_HTML.includes('id="composer"'))
  assert.ok(RUN_CONSOLE_HTML.includes("'run_say'"))
  // Right panel: the frame, with motion bound to run state rather than a timer.
  assert.ok(RUN_CONSOLE_HTML.includes('id="stage"'))
  assert.ok(RUN_CONSOLE_HTML.includes('id="shot"'))
  assert.ok(RUN_CONSOLE_HTML.includes('body[data-busy] #scan'))
  // Motion is a courtesy, not a requirement.
  assert.ok(RUN_CONSOLE_HTML.includes('prefers-reduced-motion'))
})

test('the console resource is served with the MCP App mime type and an empty CSP', async () => {
  const client = await connect()
  try {
    const read = await client.readResource(RUN_CONSOLE_URI)
    const entry = read.contents[0]
    assert.equal(entry.mimeType, 'text/html;profile=mcp-app')
    assert.equal(entry.text, RUN_CONSOLE_HTML)
    assert.deepEqual(entry._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: [] })
  } finally {
    await client.close()
  }
})

test('the default branding is exactly what it always was, so existing hosts are untouched', () => {
  // The header became a parameter; the published console must not have changed.
  assert.equal(runConsoleHtml(), RUN_CONSOLE_HTML)
  assert.ok(RUN_CONSOLE_HTML.includes('<title>Blender Agent</title>'))
  assert.ok(RUN_CONSOLE_HTML.includes('<h1>Blender Agent</h1>'))
  assert.ok(
    RUN_CONSOLE_HTML.includes(
      '<b>ADK Rust</b> \u00b7 <b>Computer Use MCP</b> \u00b7 running on <b>DeepSeek Flash</b>',
    ),
    'the byline must render exactly as before, with only the model emphasised',
  )
})

test('a host can name the agent without touching the console', () => {
  const analytics = runConsoleHtml(ANALYTICS_BRAND)
  assert.ok(analytics.includes('<title>Analytics Agent</title>'))
  assert.ok(analytics.includes('<h1>Analytics Agent</h1>'))
  assert.ok(analytics.includes('<b>Business Intelligence MCP</b>'))
  // The BI use case must not carry the Blender one's name anywhere.
  // Nothing of the other use case may survive — not the header, not the identity
  // the app announces itself under.
  assert.ok(!/blender/i.test(analytics), 'a rebranded console must not mention Blender at all')
  assert.ok(analytics.includes("name:'analytics-agent-run-console'"))
  assert.ok(RUN_CONSOLE_HTML.includes("name:'blender-agent-run-console'"), 'the default identity is unchanged')
  // Everything below the header is the same generic console.
  for (const shared of ['id="chat"', 'id="composer"', "'run_say'", 'id="acts"', 'id="plan"', 'id="shot"']) {
    assert.ok(analytics.includes(shared), `the rebranded console still has ${shared}`)
  }
})

test('a brand is escaped, because it is the one string interpolated as markup', () => {
  const injected = runConsoleHtml({
    name: '<script>alert(1)</script>',
    credits: [{ label: '"onload', value: '<img>' }],
  })
  assert.ok(!injected.includes('<script>alert(1)</script>'), 'markup in a brand must not survive')
  assert.ok(injected.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(injected.includes('&quot;onload'))
  assert.ok(injected.includes('&lt;img&gt;'))
})
