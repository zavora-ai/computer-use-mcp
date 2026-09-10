// Ledger showcase — offline coverage. No browser, no model, no API key. The live
// mechanical path is exercised separately by agents/deepseek-agent/rehearse.mjs.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  buildScan, scoreEntries, fieldMatches, auditEntry, unanswerableFields, drawnText,
  seededRandom, FIELDS, DERIVED_FIELDS, REAL_FIELDS, COMMONS_RECEIPTS, fetchCommonsReceipt,
} from '../agents/deepseek-agent/ledger.mjs'
import { parseOptions, artifactEvidence, ALLOWED_TOOLS, MODEL_TOOLS, SYNTHETIC_TASK, composePrompt, EXTRA_INSTRUCTIONS, taskFor } from '../agents/deepseek-agent/showcase.mjs'
import { customToolToFunction, runAgent } from '../agents/deepseek-agent/agent.mjs'

// ── The property the whole scenario rests on ────────────────────────────────

test('every requested field is readable in the drawn scan, across many seeds', () => {
  // A field the generator never prints is unwinnable for any model. This is the
  // check that catches an answer key drifting away from the pixels.
  for (let seed = 1; seed <= 200; seed++) {
    const generated = buildScan(seed)
    assert.deepEqual(unanswerableFields(generated), [], `seed ${seed} has unreadable fields`)
  }
})

test('the answer key covers exactly the fields the form asks for', () => {
  const { answers } = buildScan(3)
  assert.deepEqual(Object.keys(answers).sort(), FIELDS.map(field => field.name).sort())
})

test('item_count is the one field that is counted rather than printed', () => {
  const { scan, answers } = buildScan(11)
  assert.deepEqual([...DERIVED_FIELDS], ['item_count'])
  // Line-item rows are the ones carrying a unit, e.g. "3 roll".
  const rows = scan.lines.filter(line => /^\d+ (ea|roll|spool|ream|bag|pack)$/.test(line.text))
  assert.equal(rows.length, Number(answers.item_count))
})

test('the chart prints each bar value, so peak_amount is read and not estimated', () => {
  const { scan, answers } = buildScan(7)
  const values = scan.chart.bars.map(bar => String(bar.value))
  assert.ok(values.includes(answers.peak_amount))
  assert.ok(drawnText(scan).includes(answers.peak_amount))
})

test('the peak bar is unambiguous and the largest line item is unique', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const { scan, answers } = buildScan(seed)
    const sorted = [...scan.chart.bars].sort((a, b) => b.value - a.value)
    assert.equal(sorted[0].label, answers.peak_month, `seed ${seed} peak label`)
    assert.ok(sorted[0].value > sorted[1].value, `seed ${seed} has a tied peak bar`)
    const amounts = scan.lines
      .filter(line => line.mono && /^\d+\.\d\d$/.test(line.text))
      .map(line => Number(line.text))
    assert.ok(amounts.length > 0, `seed ${seed} drew no amounts`)
  }
})

test('printed totals are internally consistent, so a careful reader is never wrong', () => {
  for (let seed = 1; seed <= 120; seed++) {
    const { answers } = buildScan(seed)
    const subtotal = Number(answers.subtotal)
    const tax = Number(answers.tax)
    const total = Number(answers.total)
    assert.ok(Math.abs(tax - subtotal * 0.085) < 0.02, `seed ${seed} tax`)
    assert.ok(Math.abs(total - (subtotal + tax)) < 0.02, `seed ${seed} total`)
  }
})

test('a seed reproduces a scan exactly, and different seeds differ', () => {
  assert.deepEqual(buildScan(42).answers, buildScan(42).answers)
  assert.notDeepEqual(buildScan(42).answers, buildScan(43).answers)
  const random = seededRandom(5)
  const first = [random(), random(), random()]
  const again = seededRandom(5)
  assert.deepEqual(first, [again(), again(), again()])
})

// ── Scoring ─────────────────────────────────────────────────────────────────

test('money fields tolerate formatting but not wrong numbers', () => {
  assert.ok(fieldMatches('total', '$1,234.56', '1234.56'))
  assert.ok(fieldMatches('total', ' 1234.56 ', '1234.56'))
  assert.ok(fieldMatches('total', '1234.57', '1234.56'), 'a cent of rounding slack is allowed')
  assert.ok(!fieldMatches('total', '1234.99', '1234.56'))
  assert.ok(!fieldMatches('total', 'twelve', '1234.56'))
  assert.ok(!fieldMatches('total', '', '1234.56'))
})

test('counts are exact and text is compared loosely', () => {
  assert.ok(fieldMatches('item_count', '5', '5'))
  assert.ok(!fieldMatches('item_count', '6', '5'))
  assert.ok(fieldMatches('vendor', 'harbourline supply co', 'Harbourline Supply Co.'))
  assert.ok(fieldMatches('largest_item', 'Thermal  Label   Rolls', 'Thermal label rolls'))
  assert.ok(!fieldMatches('largest_item', 'Linen tape roll', 'Thermal label rolls'))
  assert.ok(fieldMatches('peak_month', 'April', 'Apr'), 'a full month name is accepted')
  assert.ok(!fieldMatches('peak_month', 'May', 'Apr'))
})

test('scoring reports blanks separately from wrong answers', () => {
  const { answers } = buildScan(9)
  const perfect = scoreEntries(answers, answers)
  assert.equal(perfect.correct, FIELDS.length)
  assert.equal(perfect.blank, 0)

  const partial = scoreEntries({ ...answers, total: '', vendor: 'Wrong Vendor' }, answers)
  assert.equal(partial.blank, 1)
  assert.equal(partial.correct, FIELDS.length - 2)
  assert.equal(partial.fields.total, false)
  assert.equal(partial.fields.vendor, false)
})

test('the verify payload never carries the answers', () => {
  const { answers } = buildScan(4)
  const score = scoreEntries({ vendor: 'guess' }, answers)
  // Only booleans and counts cross the wire; a leak here would remove the need to read.
  const wire = JSON.stringify({ fields: score.fields, correct: score.correct, blank: score.blank, total: score.total })
  for (const value of Object.values(answers)) {
    if (value.length > 3) assert.ok(!wire.includes(value), `verify response leaked ${value}`)
  }
  assert.ok(Object.values(score.fields).every(value => typeof value === 'boolean'))
})

// ── Authorship auditing ─────────────────────────────────────────────────────

test('typed entries are accepted as trusted', () => {
  const values = { vendor: 'Acme', total: '10.00' }
  const audit = auditEntry(values, { vendor: 'Acme', total: '10.00' },
    [{ field: 'vendor', trusted: true }, { field: 'total', trusted: true }])
  assert.equal(audit.trustedEntry, true)
  assert.equal(audit.fieldsEntered, 2)
  assert.deepEqual(audit.unobservedFields, [])
})

test('a value assigned directly is caught, because it fires no input event', () => {
  // `input.value = 'Acme'` leaves the observed map empty for that field.
  const audit = auditEntry({ vendor: 'Acme' }, {}, [])
  assert.equal(audit.trustedEntry, false)
  assert.deepEqual(audit.unobservedFields, ['vendor'])
})

test('a script-dispatched input event is caught by its isTrusted flag', () => {
  const audit = auditEntry({ vendor: 'Acme' }, { vendor: 'Acme' }, [{ field: 'vendor', trusted: false }])
  assert.equal(audit.trustedEntry, false)
  assert.equal(audit.untrustedEvents, 1)
})

test('an empty form is never counted as trusted entry', () => {
  assert.equal(auditEntry({}, {}, []).trustedEntry, false)
  assert.equal(auditEntry({ vendor: '   ' }, {}, []).fieldsEntered, 0)
})

// ── Real receipts from the web ───────────────────────────────────────────────

test('the Commons catalogue is a non-empty list of distinct image titles', () => {
  assert.ok(COMMONS_RECEIPTS.length >= 8)
  assert.equal(new Set(COMMONS_RECEIPTS).size, COMMONS_RECEIPTS.length)
  assert.ok(COMMONS_RECEIPTS.every(title => /\.(jpg|jpeg|png|gif|webp)$/i.test(title)))
})

test('a fetched receipt carries the licence and author needed to attribute it', async () => {
  // CC BY and CC BY-SA both require attribution, so provenance is not optional
  // metadata: it is what makes using the image acceptable.
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    if (String(url).includes('api.php')) {
      return { ok: true, json: async () => ({ query: { pages: { 1: { title: 'File:X.jpg', imageinfo: [{
        url: 'https://upload.wikimedia.org/x.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
        mime: 'image/jpeg', size: 1234, width: 600, height: 800,
        extmetadata: {
          LicenseShortName: { value: 'CC BY-SA 3.0' },
          Artist: { value: '<a href="/wiki/User:Someone">Someone</a>' },
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/3.0' },
        },
      }] } } } }) }
    }
    return { ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer }
  }

  const receipt = await fetchCommonsReceipt({ title: 'X.jpg', fetchImpl })
  assert.equal(receipt.mimeType, 'image/jpeg')
  assert.equal(receipt.bytes.length, 3)
  assert.deepEqual(receipt.provenance, {
    source: 'Wikimedia Commons',
    title: 'X.jpg',
    imageUrl: 'https://upload.wikimedia.org/x.jpg',
    descriptionUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
    license: 'CC BY-SA 3.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0',
    author: 'Someone',
  })
  assert.match(calls[0], /iiextmetadatafilter/, 'licence fields must be requested explicitly')
  assert.ok(calls[1].endsWith('/x.jpg'))
})

test('receipt selection is random across the catalogue', () => {
  const picks = new Set()
  for (let i = 0; i < COMMONS_RECEIPTS.length; i++) {
    const index = Math.floor((i / COMMONS_RECEIPTS.length) * COMMONS_RECEIPTS.length)
    picks.add(COMMONS_RECEIPTS[index])
  }
  assert.equal(picks.size, COMMONS_RECEIPTS.length, 'every entry must be reachable')
})

test('an unsupported format or oversized file is refused before download', async () => {
  const meta = info => async url => String(url).includes('api.php')
    ? { ok: true, json: async () => ({ query: { pages: { 1: { imageinfo: [info] } } } }) }
    : { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }

  await assert.rejects(
    fetchCommonsReceipt({ title: 'X.tif', fetchImpl: meta({ url: 'u', mime: 'image/tiff', size: 10 }) }),
    /DeepSeek accepts/,
  )
  await assert.rejects(
    fetchCommonsReceipt({ title: 'X.jpg', fetchImpl: meta({ url: 'u', mime: 'image/jpeg', size: 99 * 1024 * 1024 }) }),
    /too large/,
  )
  await assert.rejects(
    fetchCommonsReceipt({ title: 'X.jpg', fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /metadata request failed: 503/,
  )
})

test('the real-receipt field set fits a photograph, not the synthetic layout', () => {
  const names = REAL_FIELDS.map(field => field.name)
  // A photograph has a currency and a payment method but no bar chart.
  assert.ok(names.includes('currency') && names.includes('payment_method'))
  assert.ok(!names.includes('peak_month') && !names.includes('peak_amount'))
  assert.ok(REAL_FIELDS.every(field => field.label && field.name))
})

test('scoring is field-set aware, so an unscored run cannot be graded by accident', () => {
  const { answers } = buildScan(5)
  // Scoring the real field set against synthetic answers yields nothing correct,
  // which is why a real run reports "filled" instead of calling scoreEntries.
  const score = scoreEntries({ merchant: 'Anything' }, answers, REAL_FIELDS)
  assert.equal(score.total, REAL_FIELDS.length)
  assert.equal(score.correct, 0)
})

test('the real-receipt task tells the model there is no answer key', () => {
  assert.notEqual(taskFor({ scored: true }), taskFor({ scored: false }))
  assert.match(taskFor({ scored: false }), /no answer key/)
  assert.match(taskFor({ scored: false }), /transcribe what is printed\s+rather than translating/i)
  assert.match(taskFor({ scored: true }), /Repeat Verify/)
})

test('--receipt accepts random or a catalogued title and nothing else', () => {
  assert.equal(parseOptions([]).receipt, undefined, 'the verifiable synthetic mode stays the default')
  assert.equal(parseOptions(['--receipt', 'random']).receipt, 'random')
  assert.equal(parseOptions(['--receipt', COMMONS_RECEIPTS[0]]).receipt, COMMONS_RECEIPTS[0])
  assert.throws(() => parseOptions(['--receipt', 'not-in-catalogue.jpg']), /must be "random" or one of/)
})

test('showcase options default to bounded budgets and reject bad input', () => {
  const defaults = parseOptions([])
  assert.equal(defaults.turns, 45)
  assert.equal(defaults.minutes, 12)
  assert.equal(defaults.seed, 1)
  assert.equal(defaults.detail, 'original', 'reading small figures needs full resolution')
  assert.equal(defaults.prompt, undefined)

  assert.equal(parseOptions(['--seed', '9', '--turns', '10']).seed, 9)
  assert.throws(() => parseOptions(['--turns', '0']), /Invalid turns/)
  assert.throws(() => parseOptions(['--minutes', '999']), /Invalid minutes/)
  assert.throws(() => parseOptions(['--detail', 'sharp']), /Invalid detail/)
  assert.throws(() => parseOptions(['--nope', '1']), /Unknown or missing option/)
  assert.throws(() => parseOptions(['--seed']), /Unknown or missing option/)
  assert.throws(() => parseOptions(['--prompt', '  ']), /--prompt needs text/)
})

test('the objective is a prompt: --prompt replaces it, and the environment is appended', () => {
  const fieldLabels = [{ name: 'total', label: 'Total due' }]
  const defaulted = composePrompt({ windowId: 42, fieldLabels })
  assert.ok(defaulted.startsWith(SYNTHETIC_TASK), 'the built-in task is the default prompt')
  assert.match(defaulted, /window id is 42/)
  assert.match(defaulted, /total — "Total due"/, 'accessible labels are supplied, not discovered by luck')

  const custom = composePrompt({ prompt: 'Read the invoice and report only the total.', windowId: 7, fieldLabels })
  assert.ok(custom.startsWith('Read the invoice and report only the total.'))
  assert.ok(!custom.includes('Repeat Verify'), 'a custom prompt fully replaces the objective')
  assert.match(custom, /window id is 7/, 'environment facts are always present')
})

test('nothing in the runner solves the task: no answer key, no scripted sequence', () => {
  // The model decides what to read, in what order, and when it is done. If the
  // runner ever reached for the answer key or the scorer, this would stop being
  // an agentic example and become a scripted one.
  const source = readFileSync(new URL('../agents/deepseek-agent/showcase.mjs', import.meta.url), 'utf8')
  const code = source.replace(/`[^`]*`/g, '``')  // drop prompt/template text
  for (const forbidden of ['ledger.answers', 'buildScan', 'fieldMatches', 'scoreEntries', 'unanswerableFields']) {
    assert.ok(!code.includes(forbidden), `showcase.mjs must not use ${forbidden}`)
  }
  // The only ledger surfaces it may touch are the ones a caller legitimately needs.
  assert.match(code, /startLedger/)
  assert.match(code, /ledger\.finisher/)
  assert.match(code, /ledger\.evidence/)
})

test('the instructions steer away from the clearing strategy that appends', () => {
  // Measured against the live app: click, command+a, then type leaves the old
  // value in place and appends, so recommending it would break every correction.
  assert.match(EXTRA_INSTRUCTIONS, /set_value|clear set to true/)
  assert.match(EXTRA_INSTRUCTIONS, /Do not press command\+a and\s*\n?then type/)
})

test('the showcase allowlist excludes scripting and filesystem access', () => {
  for (const forbidden of ['run_script', 'filesystem', 'process_kill', 'registry', 'scrape']) {
    assert.ok(!ALLOWED_TOOLS.includes(forbidden), `${forbidden} must not be reachable`)
  }
  for (const required of ['screenshot', 'zoom', 'set_value', 'press_button', 'get_window']) {
    assert.ok(MODEL_TOOLS.includes(required), `${required} must be advertised`)
  }
  // The harness needs list_windows to find the window; the model does not.
  assert.ok(ALLOWED_TOOLS.includes('list_windows'))
  assert.ok(!MODEL_TOOLS.includes('list_windows'))
  assert.ok(MODEL_TOOLS.every(name => ALLOWED_TOOLS.includes(name)),
    'anything advertised must also be authorized')
  // press_button and set_value remove the need for coordinates entirely.
  assert.ok(!MODEL_TOOLS.includes('left_click') && !MODEL_TOOLS.includes('openai_computer'))
})

test('the task names every field the form scores', () => {
  for (const field of FIELDS) assert.ok(SYNTHETIC_TASK.includes(field.name), `task omits ${field.name}`)
})

test('artifact evidence distinguishes missing, malformed and valid files', () => {
  const report = artifactEvidence('/nonexistent-showcase-directory')
  assert.deepEqual(report.map(entry => entry.name), ['ledger-scan.png', 'ledger-entries.json'])
  assert.ok(report.every(entry => entry.present === false))
})

test('a custom finisher tool is exposed to the model in Chat Completions shape', async () => {
  const finisher = {
    schema: { type: 'function', name: 'submit_ledger', description: 'Submit', parameters: { type: 'object', properties: {} } },
    execute: async () => ({ content: [{ type: 'text', text: '{"correct":10}' }] }),
  }
  assert.deepEqual(customToolToFunction(finisher.schema), {
    type: 'function',
    function: { name: 'submit_ledger', description: 'Submit', parameters: { type: 'object', properties: {} } },
  })
  assert.throws(() => customToolToFunction({}), /needs a name/)

  const requests = []
  let turn = 0
  const deepseek = { chat: { completions: { create: async request => {
    requests.push(request)
    return {
      choices: [{ message: turn++ === 0
        ? { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'submit_ledger', arguments: '{}' } }] }
        : { role: 'assistant', content: 'Submitted 10 of 10.' } }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    }
  } } } }

  const run = await runAgent({
    deepseek, task: 'enter the ledger', customTools: [finisher],
    client: { listTools: async () => [{ name: 'screenshot', inputSchema: { type: 'object', properties: {} } }], callTool: async () => ({ content: [] }) },
  })
  assert.equal(run.text, 'Submitted 10 of 10.')
  assert.equal(run.usage.toolCalls, 1)
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['screenshot', 'submit_ledger'])
  assert.equal(requests[1].messages.at(-2).content, '{"correct":10}')
})

test('a custom tool may not shadow an MCP tool, and the token budget is enforced', async () => {
  const deepseek = { chat: { completions: { create: async () => ({
    choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] } }],
    usage: { prompt_tokens: 900, completion_tokens: 200 },
  }) } } }
  const client = { listTools: async () => [{ name: 'screenshot', inputSchema: { type: 'object', properties: {} } }], callTool: async () => ({ content: [] }) }

  await assert.rejects(runAgent({
    deepseek, client, task: 'x',
    customTools: [{ schema: { name: 'screenshot' }, execute: async () => ({ content: [] }) }],
  }), /shadows an MCP tool/)

  await assert.rejects(runAgent({ deepseek, client, task: 'x', tokenBudget: 2000, maxTurns: 50 }),
    /Token budget of 2000 exhausted/)
  await assert.rejects(runAgent({ deepseek, client, task: 'x', tokenBudget: 10 }), /at least 1000/)
})
