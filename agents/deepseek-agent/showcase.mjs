/**
 * Long-running DeepSeek Flash showcase: read a scanned receipt and enter it.
 *
 * The receipt exists only as canvas pixels, so this cannot be completed from the
 * accessibility tree — the model has to look. Scoring lives in the ledger host,
 * so the agent cannot grade itself, and the submission is refused unless the
 * values arrived through real input events.
 *
 * Bounded three ways, because it drives a real desktop and makes paid API calls:
 * turns, tokens, and wall-clock minutes. Whichever trips first ends the run.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { runAgent } from './agent.mjs'
import { startLedger, fetchCommonsReceipt, FIELDS, REAL_FIELDS, COMMONS_RECEIPTS } from './ledger.mjs'

/**
 * The smallest surface the model needs, and no more.
 *
 * Every schema is forwarded on every turn, so the tool list is a recurring cost:
 * the 15-tool set this replaced spent about 3,700 tokens per call against roughly
 * 1,500 for this one. It is also accessibility-first — read with screenshot/zoom,
 * write with set_value, act with press_button — so the model never needs a
 * coordinate, and `command+a`-then-type (which appends rather than replaces)
 * never comes up.
 */
export const MODEL_TOOLS = [
  'get_window', 'screenshot', 'zoom',
  'find_element', 'set_value', 'press_button', 'type', 'wait',
]

/**
 * What the session permits at all. The harness locates the ledger window with
 * `list_windows` before the agent starts, so that one is authorized but never
 * advertised. Scripting and filesystem access are absent by design.
 */
export const ALLOWED_TOOLS = [...MODEL_TOOLS, 'list_windows']

export function parseOptions(argv) {
  const options = { turns: 45, tokens: 600000, minutes: 12, seed: 1, detail: 'original', output: undefined, compactAbove: 24000, prompt: undefined, receipt: undefined }
  const numeric = { '--turns': 'turns', '--tokens': 'tokens', '--minutes': 'minutes', '--seed': 'seed', '--compact-above': 'compactAbove' }
  const list = [...argv]
  while (list.length) {
    const flag = list.shift()
    if (flag === '--output') { options.output = list.shift(); continue }
    if (flag === '--detail') { options.detail = list.shift(); continue }
    if (flag === '--prompt') { options.prompt = list.shift(); continue }
    if (flag === '--receipt') { options.receipt = list.shift(); continue }
    const field = numeric[flag]
    if (!field || !list.length) throw new Error('Unknown or missing option: ' + flag)
    options[field] = Number(list.shift())
  }
  for (const [field, min, max] of [['turns', 1, 200], ['tokens', 1000, 2000000], ['minutes', 1, 60], ['seed', 1, 2 ** 31 - 1], ['compactAbove', 2000, 200000]]) {
    if (!Number.isInteger(options[field]) || options[field] < min || options[field] > max) {
      throw new Error(`Invalid ${field}: expected an integer from ${min} to ${max}`)
    }
  }
  if (!['low', 'high', 'original', 'auto'].includes(options.detail)) throw new Error('Invalid detail')
  if (options.output !== undefined && !options.output) throw new Error('--output needs a path')
  if (options.prompt !== undefined && !String(options.prompt).trim()) throw new Error('--prompt needs text')
  if (options.receipt !== undefined) {
    const wanted = String(options.receipt)
    if (wanted !== 'random' && !COMMONS_RECEIPTS.includes(wanted)) {
      throw new Error(`--receipt must be "random" or one of: ${COMMONS_RECEIPTS.join(', ')}`)
    }
  }
  return options
}

/** Independent check that the artifacts on disk are what they claim to be. */
export function artifactEvidence(directory) {
  return ['ledger-scan.png', 'ledger-entries.json'].map(name => {
    const path = join(directory, name)
    if (!existsSync(path)) return { name, present: false }
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024) return { name, present: false, error: 'Invalid artifact' }
    const data = readFileSync(path)
    const signatureValid = name.endsWith('.png')
      ? data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
      : (() => { try { JSON.parse(data.toString('utf8')); return true } catch { return false } })()
    return { name, present: true, bytes: stat.size, signatureValid }
  })
}

export const SYNTHETIC_TASK = `Transcribe the scanned invoice in the MCP Ledger window into the form beside it.

The scan on the left is an image: its text is not in the accessibility tree, so read
it from screenshots. Use zoom on the scan region for the small monospaced figures
rather than guessing from a full-desktop capture.

Fill all ${FIELDS.length} fields: ${FIELDS.map(field => field.name).join(', ')}.
Money fields take plain decimals such as 128.40 with no currency symbol. The date is
YYYY-MM-DD. peak_month and peak_amount come from the bar chart below the totals:
peak_month is the label of the tallest bar and peak_amount is the number printed
above it.

Then click Verify. It reports how many fields are correct and outlines the wrong ones
in red without telling you the right answers, so re-read the scan for those and fix
them. Repeat Verify until every field is correct, then call submit_ledger.

Enter the values through the UI. Do not try to read the answers from the page or call
the ledger host directly; neither will work, and the submission records how the values
arrived.`

/**
 * Compose the prompt the agent actually receives.
 *
 * The objective is a prompt — `--prompt` replaces it outright — and the facts the
 * agent cannot guess are appended. Nothing about how to solve the task is encoded
 * in code: the model decides what to look at, in what order, and when it is done.
 */
export const REAL_TASK = `Transcribe the receipt photograph in the MCP Ledger window into the form beside it.

This is a real receipt, photographed or scanned. Its text is an image, not part of the
accessibility tree, so read it from screenshots and zoom in for small print. It may be
skewed, creased, faded, or in a language other than English; transcribe what is printed
rather than translating it.

Fill every field you can read and leave a field blank only if it is genuinely not
legible or not present on this receipt. There is no answer key: Verify reports how many
fields you have filled, and your entries are recorded for human review. Call
submit_ledger when you have read everything you can.

Enter the values through the UI.`

export function taskFor({ scored }) { return scored ? SYNTHETIC_TASK : REAL_TASK }

export function composePrompt({ prompt, windowId, fieldLabels, scored = true }) {
  return [
    prompt?.trim() || taskFor({ scored }),
    '',
    `The MCP Ledger window id is ${windowId}.`,
    'The form fields and their accessible labels are:',
    ...fieldLabels.map(({ name, label }) => `  ${name} — "${label}"`),
  ].join('\n')
}

/** Instructions appended to the agent's system prompt for this scenario. */
export const EXTRA_INSTRUCTIONS = `Work one region at a time: zoom into part of the scan, enter only the fields you
just read, then move on. Re-read before correcting a field that Verify marked wrong;
do not permute digits hoping to hit the answer.

To put a value in a field, either call set_value with the field's accessible label,
or click the field and call type with clear set to true. Do not press command+a and
then type — the selection is lost and your text is appended to the old value.

Verify is cheap. Use it after each group of fields rather than once at the end, and
read its red outlines to decide what to re-read.`

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv)
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('Set DEEPSEEK_API_KEY in your shell before running the showcase')
  const { default: OpenAI } = await import('openai')

  const base = resolve(options.output ?? 'showcase-output')
  mkdirSync(base, { recursive: true })
  const directory = mkdtempSync(join(base, 'ledger-'))

  const controller = new AbortController()
  const stop = () => controller.abort(new Error('User stopped showcase'))
  process.once('SIGINT', stop)
  const deadline = setTimeout(() => controller.abort(new Error('Showcase deadline exceeded')), options.minutes * 60000)

  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'
  const report = { scenario: 'ledger', model, seed: options.seed, status: 'running', directory, usage: null, evidence: null, artifacts: [] }
  const trace = event => appendFileSync(join(directory, 'events.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 })

  let ledger
  let client
  try {
    const receipt = options.receipt
      ? await fetchCommonsReceipt({
        ...(options.receipt === 'random' ? {} : { title: options.receipt }),
        signal: controller.signal,
      })
      : undefined
    if (receipt) trace({ type: 'receipt_fetched', provenance: receipt.provenance })
    ledger = await startLedger(directory, { seed: options.seed, ...(receipt ? { receipt } : {}) })
    report.scored = ledger.scored
    report.provenance = ledger.provenance
    trace({ type: 'ledger_started', url: ledger.url, seed: options.seed, scored: ledger.scored })

    const allowed = new Set(ALLOWED_TOOLS)
    client = await connectInProcess(createComputerUseServer({
      authorizeToolCall: ({ definition }) => {
        if (!allowed.has(definition.name)) throw new Error('Tool not permitted in this showcase: ' + definition.name)
      },
    }))

    const listed = await client.callTool('list_windows', {}, { signal: controller.signal })
    const windows = listed.structuredContent?.windows
      ?? JSON.parse(listed.content.find(block => block.type === 'text')?.text ?? '{}').windows ?? []
    const target = windows.find(window => window.title?.includes('MCP Ledger'))
    if (!target) throw new Error('The MCP Ledger window was not found on screen')
    trace({ type: 'window_located', windowId: target.windowId, title: target.windowId })

    const deepseek = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    })

    const finisher = ledger.finisher(client, target.windowId)
    const run = await runAgent({
      deepseek, client,
      task: composePrompt({
        prompt: options.prompt,
        windowId: target.windowId,
        scored: ledger.scored,
        fieldLabels: ledger.fields.map(field => ({ name: field.name, label: field.label })),
      }),
      model,
      maxTurns: options.turns,
      detail: options.detail,
      signal: controller.signal,
      extraInstructions: EXTRA_INSTRUCTIONS,
      advertiseTools: MODEL_TOOLS,
      tokenBudget: options.tokens,
      compactAboveTokens: options.compactAbove,
      customTools: [finisher],
      onProgress: event => {
        trace(event)
        if (event.type === 'tool') console.error(`→ ${event.name} ${JSON.stringify(event.args).slice(0, 140)}`)
        if (event.type === 'result') console.error(`← ${event.name}${event.isError ? ' (error)' : ''}${event.images ? ` +${event.images} image` : ''}`)
      },
    })

    report.usage = run.usage
    report.cache = run.cache
    report.evidence = ledger.evidence()
    report.status = report.evidence?.artifactSaved ? 'completed' : 'unverified'
    report.summary = run.text
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.message : String(error)
    report.evidence = ledger?.evidence() ?? null
  } finally {
    clearTimeout(deadline)
    process.removeListener('SIGINT', stop)
    await client?.close()
    await ledger?.close()
    report.artifacts = artifactEvidence(directory)
    appendFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  }

  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'completed') process.exitCode = 1
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
