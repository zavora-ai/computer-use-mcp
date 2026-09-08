import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync, mkdtempSync, rmSync, chmodSync } from 'node:fs'
import type { Browser, BrowserContext, Page, Locator, Frame } from 'playwright'
import { fsRootsViolation } from './session/fs-jail.js'

export interface BrowserOptions {
  /** Exact allowed origins, supplied by the host. No wildcards or model-issued grants. */
  origins: readonly string[]
  authorize?: (owner: string, url: string, operation: string) => Promise<void> | void
  launch?: () => Promise<Browser>
  uploadRoots?: readonly string[]
  downloadRoot?: string
  maxTabs?: number
}
interface Tab { owner: string; context: BrowserContext; page: Page; events: unknown[]; expectingDownload?: boolean; tail: Promise<unknown> }
export interface BrowserLocator { role: string; name: string; frameName?: string }

/** Isolated contexts only. Existing authenticated profiles are intentionally never attached. */
export class BrowserBackend {
  readonly #tabs = new Map<string, Tab>()
  #browser?: Promise<Browser>
  constructor(readonly options: BrowserOptions) {
    if (!options.origins.length || options.origins.some(origin => new URL(origin).origin !== origin)) throw new Error('Provide exact browser origins')
  }
  async #allow(owner: string, url: string, operation: string) {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !this.options.origins.includes(parsed.origin)) throw new Error('Browser origin denied')
    await this.options.authorize?.(owner, url, operation)
  }
  async open(owner: string, url: string) {
    await this.#allow(owner, url, 'open')
    if (this.#tabs.size >= (this.options.maxTabs ?? 8)) throw new Error('Browser tab limit reached')
    this.#browser ??= this.options.launch ? this.options.launch() : import('playwright').then(p => p.chromium.launch({ chromiumSandbox: true }))
    const browser = await this.#browser
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: Boolean(this.options.downloadRoot) })
    // Block redirects rather than let a redirect chain bypass origin checks.
    await context.route('**/*', async route => {
      try {
        await this.#allow(owner, route.request().url(), 'network')
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10000 })
        if (response.status() >= 300 && response.status() < 400) { await route.abort('blockedbyclient'); return }
        const bytes = await response.body()
        if (bytes.length > 8_388_608) { await route.abort('blockedbyclient'); return }
        await route.fulfill({ response, body: bytes })
      } catch { await route.abort('blockedbyclient').catch(() => {}) }
    })
    await context.routeWebSocket('**/*', socket => socket.close())
    const page = await context.newPage()
    page.setDefaultTimeout(10000)
    context.on('page', popup => { if (popup !== page) void popup.close() })
    page.on('dialog', dialog => { void dialog.dismiss() })
    const events: unknown[] = []
    const append = (event: unknown) => { events.push(event); if (events.length > 100) events.shift() }
    page.on('console', event => append({ type: 'console', level: event.type(), text: event.text().slice(0, 1000) }))
    page.on('requestfailed', request => append({ type: 'requestfailed', url: request.url().split('?')[0], error: request.failure()?.errorText }))
    const id = 'tab_' + randomUUID()
    const tab: Tab = { owner, context, page, events, tail: Promise.resolve() }
    this.#tabs.set(id, tab)
    page.on('download', download => { if (!tab.expectingDownload) void download.cancel() })
    try { await page.goto(url, { waitUntil: 'domcontentloaded' }); return { tabId: id, url: page.url(), backend: 'playwright-isolated' } }
    catch (error) { this.#tabs.delete(id); await context.close(); throw error }
  }
  async #run<T>(owner: string, id: string, operation: string, run: (tab: Tab) => Promise<T>): Promise<T> {
    const tab = this.#tabs.get(id)
    if (!tab || tab.owner !== owner) throw new Error('Browser tab unavailable')
    const task = tab.tail.then(async () => { await this.#allow(owner, tab.page.url(), operation); return run(tab) })
    tab.tail = task.catch(() => {})
    return task
  }
  async #locator(tab: Tab, target: BrowserLocator): Promise<Locator> {
    let frame: Page | Frame = tab.page
    if (target.frameName) {
      const matches = tab.page.frames().filter(f => f.name() === target.frameName)
      if (matches.length !== 1) throw new Error('Frame unavailable or ambiguous')
      frame = matches[0]
      await this.#allow(tab.owner, frame.url(), 'frame')
    }
    const locator = frame.getByRole(target.role as Parameters<Page['getByRole']>[0], { name: target.name, exact: true })
    if (await locator.count() !== 1) throw new Error('Control unavailable or ambiguous')
    return locator
  }
  navigate(owner: string, id: string, url: string) {
    return this.#run(owner, id, 'navigate', async tab => {
      await this.#allow(owner, url, 'navigate')
      await tab.page.goto(url, { waitUntil: 'domcontentloaded' })
      return { url: tab.page.url(), status: 'executed' }
    })
  }
  inspect(owner: string, id: string) {
    return this.#run(owner, id, 'observe', async tab => {
      // Raw ariaSnapshot includes password values in some Chromium versions.
      // Build a value-free DOM projection without changing the live page.
      const observation = await tab.page.locator('body').evaluate(body => {
        const cleanText = (element: Element) => {
          const copy = element.cloneNode(true) as Element
          copy.querySelectorAll('input,textarea,select,script,style').forEach(node => node.remove())
          return (copy.textContent ?? '').trim()
        }
        const all = [...body.querySelectorAll('button,input,textarea,select,a,[role]')]
        const nodes = all.slice(0, 100).map(node => {
          const label = node.getAttribute('aria-label') ?? ((node as HTMLInputElement).labels?.[0] ? cleanText((node as HTMLInputElement).labels![0]) : undefined) ?? cleanText(node)
          const type = node.getAttribute('type') ?? ''
          const sensitive = /password|secret|credential|token|one.time|credit.card/i.test(label + ' ' + type)
          return { role: node.getAttribute('role') ?? node.tagName.toLowerCase(), label: label.slice(0, 256),
            value: null, sensitive, disabled: node.hasAttribute('disabled') }
        })
        const text = cleanText(body)
        return { text: text.slice(0, 8000), nodes, truncated: all.length > 100 || text.length > 8000 }
      })
      return { url: tab.page.url(), title: await tab.page.title(), ...observation,
        frames: tab.page.frames().map(f => ({ name: f.name(), url: f.url() })), events: [...tab.events] }
    })
  }

  screenshot(owner: string, id: string) {
    return this.#run(owner, id, 'screenshot', async tab => ({ content: [{ type: 'image' as const, mimeType: 'image/png',
      data: (await tab.page.screenshot({ type: 'png', fullPage: false })).toString('base64') }] }))
  }
  click(owner: string, id: string, target: BrowserLocator, options: { button?: 'left' | 'right' | 'middle'; modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[] } = {}) {
    return this.#run(owner, id, 'click', async tab => { await (await this.#locator(tab, target)).click(options); return { status: 'executed' } })
  }
  fill(owner: string, id: string, target: BrowserLocator, value: string) {
    return this.#run(owner, id, 'fill', async tab => {
      const locator = await this.#locator(tab, target)
      if (await locator.getAttribute('type') === 'password' || /password|secret|token|credit.card/i.test(target.name)) throw new Error('Sensitive field requires direct user input')
      await locator.fill(value); return { status: 'executed' }
    })
  }
  wait(owner: string, id: string, target: BrowserLocator, state: 'visible' | 'hidden', timeoutMs = 10000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid wait timeout')
    return this.#run(owner, id, 'wait', async tab => { await (await this.#locator(tab, target)).waitFor({ state, timeout: timeoutMs }); return { status: 'verified', state } })
  }
  upload(owner: string, id: string, target: BrowserLocator, path: string) {
    return this.#run(owner, id, 'upload', async tab => {
      const file = realpathSync(path)
      if (fsRootsViolation(file, this.options.uploadRoots ?? [])) throw new Error('Upload path denied')
      if (statSync(file).size > 8_388_608) throw new Error('Upload exceeds 8 MiB')
      const buffer = readFileSync(file)
      await (await this.#locator(tab, target)).setInputFiles({ name: file.split(/[\\/]/).at(-1)!, mimeType: 'application/octet-stream', buffer })
      return { status: 'executed' }
    })
  }
  download(owner: string, id: string, target: BrowserLocator) {
    return this.#run(owner, id, 'download', async tab => {
      if (!this.options.downloadRoot) throw new Error('Downloads require a host-issued directory')
      const root = realpathSync(this.options.downloadRoot)
      if (!statSync(root).isDirectory() || fsRootsViolation(root, [root])) throw new Error('Download directory denied')
      const locator = await this.#locator(tab, target)
      const directory = mkdtempSync(join(root, 'computer-download-'))
      chmodSync(directory, 0o700)
      const path = join(directory, 'artifact')
      tab.expectingDownload = true
      try {
        const [download] = await Promise.all([tab.page.waitForEvent('download', { timeout: 10000 }), locator.click()])
        tab.expectingDownload = false
        await this.#allow(owner, download.url(), 'download')
        await download.saveAs(path)
        if (statSync(path).size > 8_388_608) throw new Error('Download exceeds 8 MiB')
        chmodSync(path, 0o600)
        return { status: 'verified', path, bytes: statSync(path).size, suggestedFilename: download.suggestedFilename() }
      } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
      finally { tab.expectingDownload = false }
    })
  }
  async closeTab(owner: string, id: string) {
    const tab = this.#tabs.get(id)
    if (!tab || tab.owner !== owner) throw new Error('Browser tab unavailable')
    this.#tabs.delete(id); await tab.context.close()
  }
  async close() { for (const tab of this.#tabs.values()) await tab.context.close(); this.#tabs.clear(); await (await this.#browser)?.close() }
}
