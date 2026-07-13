#!/usr/bin/env node

import { generateV8MigrationReport, renderV8MigrationShell } from './v8.js'

function usage(): never {
  console.error('Usage: computer-use-migrate-v8 [--json | --shell[=posix|powershell]]')
  process.exit(2)
}

const args = process.argv.slice(2)
if (args.length > 1) usage()
const option = args[0] ?? '--json'
const report = generateV8MigrationReport()

if (option === '--json') {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else if (option === '--shell' || option === '--shell=posix') {
  process.stdout.write(`${renderV8MigrationShell(report, 'posix')}\n`)
} else if (option === '--shell=powershell') {
  process.stdout.write(`${renderV8MigrationShell(report, 'powershell')}\n`)
} else {
  usage()
}
