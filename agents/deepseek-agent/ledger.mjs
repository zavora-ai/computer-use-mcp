/**
 * Local ledger app for the DeepSeek Flash showcase.
 *
 * The receipt is generated here and drawn into a canvas by the page, so its
 * values exist only as pixels: they never enter the DOM, and therefore never
 * appear in the accessibility tree that MCP exposes. The only way to read them is
 * to look at a screenshot. Scoring also stays here, so the agent cannot grade
 * itself — `/verify` returns which fields are wrong and never what they should be.
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Deterministic RNG so a seed reproduces a scan exactly. */
export function seededRandom(seed) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state / 0x100000000
  }
}

const VENDORS = [
  ['Harbourline Supply Co.', 'HRB'], ['Nordvik Paper & Print', 'NVP'],
  ['Copperfield Hardware', 'CFH'], ['Ashgrove Timber Ltd.', 'AGT'],
  ['Lantern Bay Provisions', 'LBP'],
]
const GOODS = [
  ['Kraft mailer boxes', 'ea'], ['Thermal label rolls', 'roll'], ['Cotton twine spool', 'spool'],
  ['Recycled tissue ream', 'ream'], ['Wax seal beads', 'bag'], ['Corner protectors', 'pack'],
  ['Archival ink cartridge', 'ea'], ['Linen tape roll', 'roll'],
]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const money = value => value.toFixed(2)

/**
 * Build one receipt plus the answer key.
 *
 * Every answer is derivable from the drawn pixels alone: totals are printed, and
 * the two chart fields are readable from the labelled bars.
 */
export function buildScan(seed) {
  const random = seededRandom(seed)
  const pick = list => list[Math.floor(random() * list.length)]

  const [vendor, prefix] = pick(VENDORS)
  const invoiceNumber = `${prefix}-${1000 + Math.floor(random() * 8999)}`
  const month = 1 + Math.floor(random() * 12)
  const day = 1 + Math.floor(random() * 28)
  const invoiceDate = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  const itemCount = 4 + Math.floor(random() * 3)
  const chosen = []
  while (chosen.length < itemCount) {
    const candidate = pick(GOODS)
    if (!chosen.some(item => item[0] === candidate[0])) chosen.push(candidate)
  }
  const items = chosen.map(([description, unit]) => {
    const quantity = 1 + Math.floor(random() * 12)
    const unitPrice = Number((2 + random() * 40).toFixed(2))
    return { description, unit, quantity, unitPrice, amount: Number((quantity * unitPrice).toFixed(2)) }
  })
  // A unique maximum keeps "largest line item" unambiguous.
  const sorted = [...items].sort((a, b) => b.amount - a.amount)
  if (sorted.length > 1 && sorted[0].amount === sorted[1].amount) {
    sorted[0].amount = Number((sorted[0].amount + 1.37).toFixed(2))
  }
  const subtotal = Number(items.reduce((sum, item) => sum + item.amount, 0).toFixed(2))
  const tax = Number((subtotal * 0.085).toFixed(2))
  const total = Number((subtotal + tax).toFixed(2))

  const start = Math.floor(random() * 7)
  const bars = Array.from({ length: 6 }, (_, index) => ({
    label: MONTHS[(start + index) % 12],
    value: Number((120 + random() * 880).toFixed(0)),
  }))
  const peakIndex = bars.reduce((best, bar, index) => bar.value > bars[best].value ? index : best, 0)
  // Separate the peak so the tallest bar is visually unmistakable.
  bars[peakIndex].value = Number((Math.max(...bars.map(b => b.value)) * 1.25).toFixed(0))

  const answers = {
    vendor,
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    item_count: String(itemCount),
    largest_item: sorted[0].description,
    subtotal: money(subtotal),
    tax: money(tax),
    total: money(total),
    peak_month: bars[peakIndex].label,
    peak_amount: String(bars[peakIndex].value),
  }

  const lines = []
  const rules = []
  let y = 46
  lines.push({ text: vendor, x: 40, y, size: 22, weight: 'bold' })
  y += 30
  lines.push({ text: 'Invoice', x: 40, y, size: 14, faint: true })
  lines.push({ text: invoiceNumber, x: 580, y, size: 14, align: 'right', mono: true })
  y += 20
  lines.push({ text: 'Issued', x: 40, y, size: 14, faint: true })
  lines.push({ text: invoiceDate, x: 580, y, size: 14, align: 'right', mono: true })
  y += 26
  rules.push({ x: 40, y, width: 540 })
  y += 14
  lines.push({ text: 'Description', x: 40, y, size: 12, faint: true })
  lines.push({ text: 'Qty', x: 330, y, size: 12, faint: true, align: 'right' })
  lines.push({ text: 'Unit', x: 440, y, size: 12, faint: true, align: 'right' })
  lines.push({ text: 'Amount', x: 580, y, size: 12, faint: true, align: 'right' })
  y += 20
  for (const item of items) {
    lines.push({ text: item.description, x: 40, y, size: 14 })
    lines.push({ text: `${item.quantity} ${item.unit}`, x: 330, y, size: 13, align: 'right', mono: true })
    lines.push({ text: money(item.unitPrice), x: 440, y, size: 13, align: 'right', mono: true })
    lines.push({ text: money(item.amount), x: 580, y, size: 13, align: 'right', mono: true })
    y += 24
  }
  y += 6
  rules.push({ x: 300, y, width: 280 })
  y += 14
  for (const [label, value] of [['Subtotal', subtotal], ['Tax 8.5%', tax], ['Total due', total]]) {
    lines.push({ text: label, x: 440, y, size: 14, align: 'right', faint: label !== 'Total due' })
    lines.push({ text: money(value), x: 580, y, size: 14, align: 'right', mono: true, weight: label === 'Total due' ? 'bold' : 'normal' })
    y += 22
  }

  const grain = Array.from({ length: 1400 }, () => [
    Math.floor(random() * 620), Math.floor(random() * 700), Number((0.05 + random() * 0.16).toFixed(3)),
  ])

  return {
    scan: {
      rotation: (random() - 0.5) * 0.022,
      lines, rules, grain,
      chart: { title: 'Spend by month (USD)', x: 40, y: y + 60, height: 110, barWidth: 62, bars },
    },
    answers,
  }
}

/**
 * Every string the page will draw into the canvas.
 *
 * Used by the answerability check: a field the agent is asked for must be legible
 * somewhere in these pixels, or the task is impossible for any model no matter how
 * well it reads. `item_count` is the one exception — it is counted, not printed.
 */
export function drawnText(scan) {
  return [
    ...scan.lines.map(line => line.text),
    scan.chart.title,
    ...scan.chart.bars.flatMap(bar => [bar.label, String(bar.value)]),
  ]
}

/** Fields answerable only by counting rows rather than reading a printed value. */
export const DERIVED_FIELDS = new Set(['item_count'])

/**
 * Confirm a generated scan actually contains every answer.
 *
 * Returns the fields whose value appears nowhere in the drawn text. A non-empty
 * result means the scenario is unwinnable and the generator is at fault.
 */
export function unanswerableFields({ scan, answers }) {
  const drawn = drawnText(scan)
  const haystack = drawn.join('\u0000')
  return Object.entries(answers)
    .filter(([name, value]) => !DERIVED_FIELDS.has(name) && !haystack.includes(value))
    .map(([name]) => name)
}

/**
 * Real receipts from Wikimedia Commons, chosen for legibility and variety:
 * supermarket tapes, restaurant bills, fuel, laundry, postal.
 *
 * Referenced by title and fetched at run time rather than bundled, so nothing in
 * this repository redistributes them and the licence and author recorded in the
 * artifact always come from Commons itself.
 */
export const COMMONS_RECEIPTS = [
  'Polish supermarket receipt.jpg',
  'Save Mart recipt 2010-10-23.jpg',
  'Tesco grocery receipt Finchley 1994.jpg',
  'Shell-Gas-Station-Receipt-MasterCard.jpg',
  'Croatia pizza receipt.jpg',
  'Laundry receipt Oaxaca.jpg',
  'USPS Receipt - 2002-01-31.jpg',
  'A fine bill for a fine meal!.jpg',
  'Receipt in Paris, 21 December 2011.jpg',
  'Omni receipt.jpg',
  'Kassabon1.jpg',
  'Tchotchke receipt.jpg',
]

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php'
const USER_AGENT = 'computer-use-mcp-deepseek-example/1.0 (https://github.com/zavora-ai/computer-use-mcp)'

/**
 * Fetch one real receipt and its provenance.
 *
 * Returns the image bytes plus the licence, author and description page, which
 * the run records so a CC BY / CC BY-SA image is always attributed.
 */
export async function fetchCommonsReceipt({ title, random = Math.random, fetchImpl = fetch, signal } = {}) {
  const chosen = title ?? COMMONS_RECEIPTS[Math.floor(random() * COMMONS_RECEIPTS.length)]
  const query = new URL(COMMONS_API)
  query.search = new URLSearchParams({
    action: 'query', format: 'json', prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiextmetadatafilter: 'LicenseShortName|Artist|LicenseUrl',
    titles: `File:${chosen}`,
  }).toString()

  const metadata = await fetchImpl(query, { headers: { 'User-Agent': USER_AGENT }, ...(signal ? { signal } : {}) })
  if (!metadata.ok) throw new Error(`Commons metadata request failed: ${metadata.status}`)
  const payload = await metadata.json()
  const page = Object.values(payload?.query?.pages ?? {})[0]
  const info = page?.imageinfo?.[0]
  if (!info?.url) throw new Error(`Commons has no image for "${chosen}"`)
  if (!SUPPORTED_IMAGE_TYPES.includes(info.mime)) {
    throw new Error(`${chosen} is ${info.mime}; DeepSeek accepts ${SUPPORTED_IMAGE_TYPES.join(', ')}`)
  }
  if (info.size > 24 * 1024 * 1024) throw new Error(`${chosen} is ${info.size} bytes, too large for this example`)

  const download = await fetchImpl(info.url, { headers: { 'User-Agent': USER_AGENT }, ...(signal ? { signal } : {}) })
  if (!download.ok) throw new Error(`Commons image download failed: ${download.status}`)
  const bytes = Buffer.from(await download.arrayBuffer())

  const extra = info.extmetadata ?? {}
  const plain = value => String(value ?? '').replace(/<[^>]*>/g, '').trim()
  return {
    bytes,
    mimeType: info.mime,
    width: info.width,
    height: info.height,
    provenance: {
      source: 'Wikimedia Commons',
      title: chosen,
      imageUrl: info.url,
      descriptionUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(chosen)}`,
      license: plain(extra.LicenseShortName?.value) || 'see description page',
      licenseUrl: plain(extra.LicenseUrl?.value) || null,
      author: plain(extra.Artist?.value) || 'see description page',
    },
  }
}

const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

/**
 * Fields collected from a real receipt.
 *
 * There is no answer key for an arbitrary photograph, so a real-receipt run is
 * an extraction run: the values are recorded for review, not scored. The field
 * set is deliberately different from the synthetic one — real receipts have no
 * bar chart, but they do have a currency and a payment method.
 */
export const REAL_FIELDS = [
  { name: 'merchant', label: 'Merchant name' },
  { name: 'receipt_number', label: 'Receipt or invoice number' },
  { name: 'date', label: 'Date as printed' },
  { name: 'currency', label: 'Currency' },
  { name: 'subtotal', label: 'Subtotal' },
  { name: 'tax', label: 'Tax' },
  { name: 'total', label: 'Total' },
  { name: 'item_count', label: 'Number of line items' },
  { name: 'largest_item', label: 'Largest line item (description)' },
  { name: 'payment_method', label: 'Payment method' },
]

export const FIELDS = [
  { name: 'vendor', label: 'Vendor name', placeholder: 'As printed at the top' },
  { name: 'invoice_number', label: 'Invoice number' },
  { name: 'invoice_date', label: 'Invoice date (YYYY-MM-DD)' },
  { name: 'item_count', label: 'Number of line items' },
  { name: 'largest_item', label: 'Largest line item (description)' },
  { name: 'subtotal', label: 'Subtotal' },
  { name: 'tax', label: 'Tax' },
  { name: 'total', label: 'Total due' },
  { name: 'peak_month', label: 'Peak month in the chart' },
  { name: 'peak_amount', label: 'Peak month amount' },
]

/** Compare one entry to the key, tolerating harmless formatting differences. */
export function fieldMatches(name, entered, expected) {
  const value = String(entered ?? '').trim()
  if (!value) return false
  // No expected value means this field has no answer to match, which is not a
  // match rather than a crash — scoreEntries may be handed a different field set.
  if (expected === undefined || expected === null) return false
  const loose = text => text.toLowerCase().replace(/[\s.,''"-]+/g, '')
  if (['subtotal', 'tax', 'total', 'peak_amount', 'item_count'].includes(name)) {
    const number = Number(value.replace(/[$,\s]/g, ''))
    if (!Number.isFinite(number)) return false
    // A cent of slack absorbs rounding; counts must be exact.
    return Math.abs(number - Number(expected)) <= (name === 'item_count' ? 0 : 0.011)
  }
  if (name === 'peak_month') return loose(value).startsWith(loose(expected).slice(0, 3))
  return loose(value) === loose(expected)
}

/** Score a whole submission. Returns per-field booleans, never the answers. */
export function scoreEntries(values, answers, fieldSet = FIELDS) {
  const fields = {}
  let correct = 0
  let blank = 0
  for (const field of fieldSet) {
    const entered = values?.[field.name]
    if (!String(entered ?? '').trim()) blank += 1
    const ok = fieldMatches(field.name, entered, answers[field.name])
    fields[field.name] = ok
    if (ok) correct += 1
  }
  return { fields, correct, blank, total: fieldSet.length }
}

/**
 * Decide whether the entries were actually typed into the UI.
 *
 * A value that differs from the last value seen through an `input` event was set
 * by assigning `.value`, which fires no event. An event with `isTrusted === false`
 * was dispatched by script. Neither is data entry, and both are reported rather
 * than silently accepted.
 */
export function auditEntry(values, observed, journal) {
  const entries = Object.entries(values ?? {}).filter(([, value]) => String(value ?? '').trim())
  const unobserved = entries
    .filter(([name, value]) => String(observed?.[name] ?? '').trim() !== String(value).trim())
    .map(([name]) => name)
  const untrustedEvents = (journal ?? []).filter(event => event.trusted !== true).length
  return {
    fieldsEntered: entries.length,
    inputEvents: journal?.length ?? 0,
    untrustedEvents,
    unobservedFields: unobserved,
    trustedEntry: unobserved.length === 0 && untrustedEvents === 0 && entries.length > 0,
  }
}

/**
 * Start the app.
 *
 * Returns the page URL, an `evidence()` reader, and a `finisher` MCP tool that
 * clicks the real Submit button and refuses to report success unless the host
 * actually recorded an accepted submission.
 */
export async function startLedger(directory, { seed = 1, receipt, launch } = {}) {
  const token = randomBytes(24).toString('hex')
  // A real photograph has no answer key, so that mode records an extraction for
  // review instead of scoring it. The synthetic mode is the verifiable one.
  const scored = !receipt
  const fields = scored ? FIELDS : REAL_FIELDS
  const { scan, answers } = scored ? buildScan(seed) : { scan: null, answers: {} }
  const html = readFileSync(new URL('./ledger-app.html', import.meta.url))
  let evidence = null
  let verifyCount = 0

  const payload = scored
    ? { scan, fields, scored: true }
    : {
      scan: null,
      fields,
      scored: false,
      imageDataUrl: `data:${receipt.mimeType};base64,${receipt.bytes.toString('base64')}`,
      provenance: receipt.provenance,
    }

  const readBody = async request => {
    let bytes = 0
    const chunks = []
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) throw new Error('Body too large')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  }
  const json = (response, payload) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(payload))
  }

  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method === 'GET' && request.url === '/') {
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
          return
        }
        const routes = ['/scan/', '/verify/', '/submit/']
        const route = routes.find(prefix => request.url === prefix.slice(0, -1) + '/' + token)
        if (request.method !== 'POST' || !route) {
          response.writeHead(404)
          response.end()
          return
        }
        const body = await readBody(request)
        if (route === '/scan/') {
          json(response, payload)
          return
        }
        if (route === '/verify/') {
          verifyCount += 1
          if (!scored) {
            json(response, { scored: false, total: fields.length,
              filled: fields.filter(field => String(body.values?.[field.name] ?? '').trim()).length })
            return
          }
          const score = scoreEntries(body.values, answers, fields)
          json(response, { scored: true, fields: score.fields, correct: score.correct, blank: score.blank, total: score.total })
          return
        }
        const audit = auditEntry(body.values, body.observed, body.journal)
        if (typeof body.image !== 'string' || !body.image.startsWith('data:image/png;base64,')) {
          json(response, { accepted: false, reason: 'missing scan image' })
          return
        }
        const png = Buffer.from(body.image.slice('data:image/png;base64,'.length), 'base64')
        if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
          json(response, { accepted: false, reason: 'invalid PNG' })
          return
        }
        writeFileSync(join(directory, 'ledger-scan.png'), png, { mode: 0o600 })

        if (!scored) {
          writeFileSync(join(directory, 'ledger-entries.json'), JSON.stringify({
            scored: false, submitted: body.values, audit, verifyCount, provenance: receipt.provenance,
          }, null, 2), { mode: 0o600 })
          evidence = {
            artifactSaved: true, scored: false,
            total: fields.length,
            filled: fields.filter(field => String(body.values?.[field.name] ?? '').trim()).length,
            verifyCalls: verifyCount, provenance: receipt.provenance, ...audit,
          }
          json(response, { accepted: true, scored: false, filled: evidence.filled, total: evidence.total })
          return
        }

        const score = scoreEntries(body.values, answers, fields)
        writeFileSync(join(directory, 'ledger-entries.json'), JSON.stringify({
          scored: true, submitted: body.values, fields: score.fields, audit, verifyCount,
        }, null, 2), { mode: 0o600 })
        evidence = {
          artifactSaved: true,
          scored: true,
          correct: score.correct,
          total: score.total,
          blank: score.blank,
          accuracy: Number((score.correct / score.total).toFixed(2)),
          wrongFields: Object.entries(score.fields).filter(([, ok]) => !ok).map(([name]) => name),
          verifyCalls: verifyCount,
          ...audit,
        }
        json(response, { accepted: true, scored: true, correct: score.correct, total: score.total })
      } catch {
        response.writeHead(400)
        response.end('Bad request')
      }
    })()
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    const { chromium } = await import('playwright')
    browser = await (launch?.() ?? chromium.launch({
      headless: false, chromiumSandbox: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
      args: ['--force-renderer-accessibility'],
    }))
    const page = await browser.newPage({ viewport: { width: 1080, height: 780 } })
    await page.goto(`http://127.0.0.1:${server.address().port}/#${token}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('#entry input')

    const layout = await page.evaluate(() => {
      const box = element => {
        const rect = element.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      const border = (window.outerWidth - window.innerWidth) / 2
      return {
        border,
        toolbar: window.outerHeight - window.innerHeight - border,
        scan: box(document.querySelector('#scan')),
        verify: box(document.querySelector('#verify')),
        submit: box(document.querySelector('#submit')),
        inputs: Object.fromEntries(Array.from(document.querySelectorAll('#entry input'),
          input => [input.name, box(input)])),
      }
    })

    return {
      url: page.url(),
      layout,
      answers,
      scored,
      fields,
      provenance: receipt?.provenance ?? null,
      evidence: () => evidence,
      /** Screen rectangle of the scan, for a zoom that reads only the receipt. */
      scanRegion: window => [
        Math.round(window.bounds.x + layout.border + layout.scan.x),
        Math.round(window.bounds.y + layout.toolbar + layout.scan.y),
        Math.round(window.bounds.x + layout.border + layout.scan.x + layout.scan.width),
        Math.round(window.bounds.y + layout.toolbar + layout.scan.y + layout.scan.height),
      ],
      finisher: (client, windowId) => ({
        schema: {
          type: 'function', name: 'submit_ledger', strict: false,
          description: 'Press the ledger Submit button, confirm the host accepted the submission, and return the scored result with a final screenshot. Call this only after Verify reports every field correct.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
        execute: async (_args, signal) => {
          const pressed = await client.callTool('press_button',
            { window_id: windowId, label: 'Submit ledger' }, { signal })
          if (pressed.isError) return pressed
          for (let attempt = 0; attempt < 40 && !evidence; attempt++) {
            signal?.throwIfAborted()
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          if (!evidence) throw new Error('Submission was not recorded by the ledger host')
          if (!evidence.trustedEntry) {
            throw new Error('Entries were not typed into the form: '
              + JSON.stringify({ unobservedFields: evidence.unobservedFields, untrustedEvents: evidence.untrustedEvents }))
          }
          const shot = await client.callTool('screenshot', { target_window_id: windowId }, { signal })
          return { content: [{ type: 'text', text: JSON.stringify(evidence) }, ...(shot.isError ? [] : shot.content)] }
        },
      }),
      close: async () => {
        try {
          if (!evidence) {
            await page.screenshot({ path: join(directory, 'recovered-ledger.png') })
            writeFileSync(join(directory, 'ledger-unsubmitted.json'),
              JSON.stringify({ reason: 'no accepted submission', verifyCount }, null, 2), { mode: 0o600 })
          }
        } finally {
          await browser.close()
          await new Promise(resolve => server.close(resolve))
        }
      },
    }
  } catch (error) {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
    throw error
  }
}
