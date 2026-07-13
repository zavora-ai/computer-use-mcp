#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { pathToFileURL } from 'node:url'
import { connectInProcess } from '../client.js'
import { createComputerUseServer } from '../server.js'
import { runTerminalOnboarding, type TerminalOnboardingOptions } from './terminal.js'

function parseArgs(argv: string[]): TerminalOnboardingOptions {
  const options: TerminalOnboardingOptions = {}
  const roots: string[] = []
  const apps: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    const next = () => {
      const found = argv[++index]
      if (!found) throw new TypeError(`${value} requires a value`)
      return found
    }
    if (value === '--resume') options.onboardingId = next()
    else if (value === '--window-id') options.windowId = Number(next())
    else if (value === '--filesystem-root') roots.push(next())
    else if (value === '--allow-app') apps.push(next())
    else if (value === '--allow-scrape') options.allowScrape = true
    else if (value === '--no-audit') options.persistAudit = false
    else if (value === '--pointer-confirmed') options.pointerConfirmed = true
    else if (value === '--emergency-stop-acknowledged') options.emergencyStopAcknowledged = true
    else if (value === '--non-interactive') options.nonInteractive = true
    else throw new TypeError(`unknown option: ${value}`)
  }
  if (roots.length) options.filesystemRoots = roots
  if (apps.length) options.allowedAppIds = apps
  return options
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  const readline = createInterface({ input: stdin, output: stdout })
  const io = {
    write: (message: string) => { stdout.write(`${message}\n`) },
    prompt: async (message: string, fallback = '') => (await readline.question(`${message}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback,
    confirm: async (message: string, fallback = false) => {
      const answer = (await readline.question(`${message} [${fallback ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase()
      return answer ? answer === 'y' || answer === 'yes' : fallback
    },
  }
  const client = await connectInProcess(createComputerUseServer({
    enableV8: true, profile: 'full', activeProfile: 'v8-safe',
  }))
  try { await runTerminalOnboarding(client, io, options) }
  finally { readline.close(); await client.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
}
