import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { BrowserBackend } from '../dist/browser.js'

test('isolated browser enforces ownership, origins, selectors, sensitive input and real images', {
  skip: process.env.COMPUTER_USE_BROWSER_TESTS !== 'true' && 'Opt-in local browser integration',
}, async () => {
  const { chromium } = await import('playwright')
  const server = createServer((req, res) => {
    if (req.url === '/download') { res.setHeader('Content-Disposition', 'attachment; filename=fixture.txt'); res.end('download fixture'); return }
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://example.com' }); res.end(); return }
    res.setHeader('content-type', 'text/html')
    res.end('<!doctype html><title>Fixture</title><label>Name<input aria-label="Name"></label><label>Password<input type="password" value="private-password" aria-label="Password"></label><button onclick="document.getElementById(\'result\').textContent=\'Saved\'">Save</button><p id="result">Waiting</p><a href="/download">Download</a>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const downloadRoot = mkdtempSync(join(tmpdir(), 'cu-download-test-'))
  const browser = new BrowserBackend({ downloadRoot, origins: [origin], launch: () => chromium.launch({
    chromiumSandbox: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  }) })
  try {
    const { tabId } = await browser.open('alice', origin)
    await assert.rejects(browser.inspect('bob', tabId), /unavailable/)
    await browser.fill('alice', tabId, { role: 'textbox', name: 'Name' }, 'Ada')
    await assert.rejects(browser.fill('alice', tabId, { role: 'textbox', name: 'Password' }, 'secret'), /Sensitive/)
    await browser.click('alice', tabId, { role: 'button', name: 'Save' })
    const observation = await browser.inspect('alice', tabId)
    assert.ok(JSON.stringify(observation).includes('Saved'))
    assert.ok(!JSON.stringify(observation).includes('private-password'))
    assert.ok((await browser.screenshot('alice', tabId)).content[0].data.length > 100)
    const download = await browser.download('alice', tabId, { role: 'link', name: 'Download' })
    assert.equal(readFileSync(download.path, 'utf8'), 'download fixture')
    await assert.rejects(browser.navigate('alice', tabId, 'https://example.com'), /denied/)
    await assert.rejects(browser.navigate('alice', tabId, origin+'/redirect'))
  } finally { await browser.close(); rmSync(downloadRoot, { recursive: true, force: true }); await new Promise(resolve => server.close(resolve)) }
})
