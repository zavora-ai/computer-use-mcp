export const V8_MIGRATION_REPORT_VERSION = 1 as const

export interface V8MigrationReport {
  version: typeof V8_MIGRATION_REPORT_VERSION
  compatibilityMode: boolean
  unsafeDefaults: {
    unrestrictedFilesystemMutation: boolean
    openWorldScrape: boolean
  }
  warnings: string[]
  environment: Record<string, string>
}

const PASSTHROUGH_KEYS = [
  'COMPUTER_USE_FS_ROOTS',
  'COMPUTER_USE_ALLOWED_APPS',
  'COMPUTER_USE_BLOCKED_APPS',
  'COMPUTER_USE_CREDENTIAL_APPS',
  'COMPUTER_USE_V8_ALLOWED_DOMAINS',
  'COMPUTER_USE_V8_REGISTRY_HIVES',
  'COMPUTER_USE_V8_BLOCKED_PROCESSES',
  'COMPUTER_USE_EMERGENCY_STOP_CHORD',
] as const

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

/**
 * Produce the exact safer v8 environment corresponding to the caller's
 * current non-secret boundaries. Credentials, socket tokens, persistence
 * paths, and process-global control-plane values are deliberately excluded.
 */
export function generateV8MigrationReport(
  env: NodeJS.ProcessEnv = process.env,
): V8MigrationReport {
  const compatibilityMode = env.COMPUTER_USE_V7_COMPAT === 'true'
  const unrestrictedFilesystemMutation = compatibilityMode && !present(env.COMPUTER_USE_FS_ROOTS)
  const openWorldScrape = compatibilityMode || env.COMPUTER_USE_V8_ALLOW_SCRAPE === 'true'
  const environment: Record<string, string> = {
    COMPUTER_USE_V8: 'true',
    COMPUTER_USE_ACTIVE_PROFILE: 'v8-safe',
    COMPUTER_USE_V7_COMPAT: 'false',
    COMPUTER_USE_V8_ALLOW_SCRAPE: 'false',
    COMPUTER_USE_AUDIT_LOG: env.COMPUTER_USE_AUDIT_LOG === 'true' ? 'true' : 'false',
  }
  for (const key of PASSTHROUGH_KEYS) {
    if (present(env[key])) environment[key] = env[key]!.trim()
  }

  const warnings: string[] = []
  if (compatibilityMode) {
    warnings.push('COMPUTER_USE_V7_COMPAT restores legacy unsafe defaults for one migration cycle')
  }
  if (unrestrictedFilesystemMutation) {
    warnings.push('v7 compatibility permits filesystem mutation without configured roots')
  }
  if (openWorldScrape) {
    warnings.push('open-world scrape is enabled and may make network requests')
  }

  return {
    version: V8_MIGRATION_REPORT_VERSION,
    compatibilityMode,
    unsafeDefaults: { unrestrictedFilesystemMutation, openWorldScrape },
    warnings,
    environment,
  }
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function renderV8MigrationShell(
  report: V8MigrationReport,
  shell: 'posix' | 'powershell',
): string {
  return Object.entries(report.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => shell === 'powershell'
      ? `$env:${key} = ${powershellQuote(value)}`
      : `export ${key}=${posixQuote(value)}`)
    .join('\n')
}

/** Disclosure-safe messages for stdio startup; never embeds configured values. */
export function v8StartupWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const report = generateV8MigrationReport(env)
  if (!report.compatibilityMode) return []
  return [
    ...report.warnings,
    'run computer-use-migrate-v8 --shell to print an exact safer configuration',
  ]
}
