import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface LegacyPolicyConfig {
  allowedApps: string[]
  blockedApps: string[]
  sensitiveApps: string[]
  requireApprovalFor: string[]
  approvalRequiredForAll: boolean
  destructiveRequiresApproval: boolean
  approvalTokenConfigured: boolean
}

export type LegacyPolicyDecision =
  | {
      allowed: true
      approval: 'not_required' | 'approved'
      reasons: string[]
      targetApp?: string
      destructive: boolean
    }
  | {
      allowed: false
      approval: 'required' | 'denied'
      reasons: string[]
      targetApp?: string
      destructive: boolean
      remediation: string[]
    }

export interface LegacyPolicyRuntime {
  policyConfig: LegacyPolicyConfig
  auditEnabled: boolean
  auditLogPath: string
  status(): Record<string, unknown>
  evaluate(tool: string, args: Record<string, unknown>, mutates: boolean): LegacyPolicyDecision
  digestText(value: string): string
  redactAuditValue(key: string, value: unknown): unknown
  writeAudit(record: Record<string, unknown>): void
}

function list(env: NodeJS.ProcessEnv, name: string, fallback: string[] = []): string[] {
  const raw = env[name]
  return raw !== undefined ? raw.split(',').map(value => value.trim()).filter(Boolean) : [...fallback]
}

/** Collapse to comparable identifier characters so quoting and spacing cannot hide a name. */
const identifierChars = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * Identifier fragments that plausibly name `app` inside script source. Bundle
 * IDs contribute their trailing segment (`com.apple.keychainaccess` →
 * `keychainaccess`) because scripts address apps by display name, not bundle ID.
 * Executable names drop their extension (`1Password.exe` → `1password`).
 */
function appMatchTokens(app: string): string[] {
  const withoutExtension = app.toLowerCase().replace(/\.(exe|app)$/, '')
  const segments = withoutExtension.split('.')
  const tokens = new Set([withoutExtension])
  const tail = segments[segments.length - 1]
  if (segments.length > 1 && tail) tokens.add(tail)
  return [...tokens].map(identifierChars).filter(token => token.length >= 4)
}

export interface ScriptApplicationScope {
  /** Blocked apps named in the script body. */
  blocked: string[]
  /** Sensitive apps named in the script body. */
  sensitive: string[]
  /**
   * True when an allowlist is configured. A script can address any application,
   * so membership cannot be proven the way it can for a `target_app` argument.
   */
  unverifiable: boolean
}

/**
 * Best-effort scope analysis for `run_script`.
 *
 * `run_script` accepts no target argument, so the app-scoped rules that protect
 * every other mutating tool have nothing to match against — without this a
 * script could drive Keychain Access while the policy saw no target at all.
 * Name matching is deliberately conservative and is defense in depth, not a
 * sandbox: a determined script can compose an app name at runtime. Configure
 * COMPUTER_USE_REQUIRE_APPROVAL_FOR=run_script (or
 * COMPUTER_USE_DESTRUCTIVE_REQUIRES_APPROVAL=true) when unconditional consent
 * is required.
 */
export function scriptApplicationScope(
  args: Record<string, unknown>,
  config: Pick<LegacyPolicyConfig, 'sensitiveApps' | 'blockedApps' | 'allowedApps'>,
): ScriptApplicationScope {
  const body = identifierChars(typeof args.script === 'string' ? args.script : '')
  const named = (apps: string[]) =>
    apps.filter(app => appMatchTokens(app).some(token => body.includes(token)))
  return {
    blocked: named(config.blockedApps),
    sensitive: named(config.sensitiveApps),
    unverifiable: config.allowedApps.length > 0,
  }
}

function destructive(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'run_script') return true
  if (tool === 'process_kill') return args.mode === 'kill'
  if (tool === 'registry') return args.mode === 'set' || args.mode === 'delete'
  if (tool === 'filesystem') return ['write', 'copy', 'move', 'delete'].includes(String(args.mode))
  return false
}

/** Extracted compatibility policy/audit service used only by the v7 facade. */
export function createLegacyPolicyRuntime(options: {
  activeProfile: string
  nativeInjected: boolean
  isWindows: boolean
  hasElicitation: boolean
  targetApp(args: Record<string, unknown>): string | undefined
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
}): LegacyPolicyRuntime {
  const env = options.env ?? process.env
  const auditKey = randomBytes(32)
  let auditPermissionsChecked = false
  const defaultSensitiveApps = options.isWindows
    ? ['1Password.exe', 'CredentialUIBroker.exe', 'KeePassXC.exe']
    : ['com.apple.keychainaccess', 'com.apple.Passwords', 'com.1password.1password', 'com.agilebits.onepassword7']
  const policyConfig: LegacyPolicyConfig = {
    allowedApps: list(env, 'COMPUTER_USE_ALLOWED_APPS'),
    blockedApps: list(env, 'COMPUTER_USE_BLOCKED_APPS'),
    sensitiveApps: list(env, 'COMPUTER_USE_CREDENTIAL_APPS', defaultSensitiveApps),
    requireApprovalFor: list(env, 'COMPUTER_USE_REQUIRE_APPROVAL_FOR'),
    approvalRequiredForAll: env.COMPUTER_USE_REQUIRE_APPROVAL === 'true',
    destructiveRequiresApproval: env.COMPUTER_USE_DESTRUCTIVE_REQUIRES_APPROVAL === 'true',
    approvalTokenConfigured: Boolean(env.COMPUTER_USE_APPROVAL_TOKEN),
  }
  const auditSetting = env.COMPUTER_USE_AUDIT_LOG
  const auditEnabled = auditSetting === 'false' ? false : auditSetting ? true : !options.nativeInjected
  const explicitAuditPath = Boolean(auditSetting && auditSetting !== 'true' && auditSetting !== 'false')
  const auditLogPath = explicitAuditPath
    ? auditSetting!
    : path.join(options.homeDirectory ?? os.homedir(), '.computer-use-mcp', 'audit.jsonl')
  const status = (): Record<string, unknown> => ({
    allowed_apps: policyConfig.allowedApps,
    blocked_apps: policyConfig.blockedApps,
    sensitive_apps: policyConfig.sensitiveApps,
    require_approval_for: policyConfig.requireApprovalFor,
    approval_required_for_all: policyConfig.approvalRequiredForAll,
    destructive_requires_approval: policyConfig.destructiveRequiresApproval,
    approval_token_configured: policyConfig.approvalTokenConfigured,
    audit: { enabled: auditEnabled, path: auditEnabled ? auditLogPath : null },
    profile: options.activeProfile,
  })

  const evaluate = (
    tool: string,
    args: Record<string, unknown>,
    mutates: boolean,
  ): LegacyPolicyDecision => {
    const targetApp = tool === 'run_script' ? undefined : options.targetApp(args)
    const scriptScope = tool === 'run_script'
      ? scriptApplicationScope(args, policyConfig)
      : undefined
    const isDestructive = destructive(tool, args)
    const reasons: string[] = []
    if (targetApp && policyConfig.blockedApps.includes(targetApp)) {
      return {
        allowed: false, approval: 'denied', reasons: [`target_app_blocked:${targetApp}`],
        targetApp, destructive: isDestructive,
        remediation: [`Remove ${targetApp} from COMPUTER_USE_BLOCKED_APPS only if this app should be controllable.`],
      }
    }
    if (scriptScope && scriptScope.blocked.length > 0) {
      return {
        allowed: false, approval: 'denied',
        reasons: scriptScope.blocked.map(app => `script_targets_blocked_app:${app}`),
        destructive: isDestructive,
        remediation: [
          `The script names ${scriptScope.blocked.join(', ')}, which COMPUTER_USE_BLOCKED_APPS forbids.`,
          'Remove the app from the script, or from COMPUTER_USE_BLOCKED_APPS only if it should be controllable.',
        ],
      }
    }
    if (mutates && targetApp && policyConfig.allowedApps.length > 0
      && !policyConfig.allowedApps.includes(targetApp)) {
      return {
        allowed: false, approval: 'denied', reasons: [`target_app_not_allowed:${targetApp}`],
        targetApp, destructive: isDestructive,
        remediation: [`Add ${targetApp} to COMPUTER_USE_ALLOWED_APPS if this app should be controllable.`],
      }
    }
    const scriptSensitive = scriptScope?.sensitive ?? []
    const needsApproval = policyConfig.approvalRequiredForAll
      || policyConfig.requireApprovalFor.includes(tool)
      || (isDestructive && policyConfig.destructiveRequiresApproval)
      || Boolean(targetApp && policyConfig.sensitiveApps.includes(targetApp))
      || scriptSensitive.length > 0
      || scriptScope?.unverifiable === true
    if (!needsApproval) {
      return { allowed: true, approval: 'not_required', reasons, targetApp, destructive: isDestructive }
    }
    reasons.push(
      policyConfig.approvalRequiredForAll ? 'approval_required_for_all'
        : policyConfig.requireApprovalFor.includes(tool) ? `tool_requires_approval:${tool}`
          : isDestructive && policyConfig.destructiveRequiresApproval ? 'destructive_requires_approval'
            : targetApp ? `sensitive_app:${targetApp}`
              : scriptSensitive.length > 0 ? `script_targets_sensitive_app:${scriptSensitive[0]}`
                : scriptScope?.unverifiable ? 'script_scope_unverifiable'
                  : 'approval_required',
    )
    const expected = env.COMPUTER_USE_APPROVAL_TOKEN
    const supplied = typeof args.approval_token === 'string' ? Buffer.from(args.approval_token) : undefined
    const expectedBytes = expected ? Buffer.from(expected) : undefined
    if (expectedBytes && supplied && supplied.length === expectedBytes.length && timingSafeEqual(supplied, expectedBytes)) {
      return { allowed: true, approval: 'approved', reasons, targetApp, destructive: isDestructive }
    }
    return {
      allowed: false, approval: 'required', reasons, targetApp, destructive: isDestructive,
      remediation: expected
        ? ['Pass the configured approval_token for this call after user approval, or approve via host elicitation.']
        : options.hasElicitation
          ? ['Host will request interactive approval, or set COMPUTER_USE_APPROVAL_TOKEN for headless use.']
          : ['Set COMPUTER_USE_APPROVAL_TOKEN to a private token, then pass approval_token after user approval.'],
    }
  }

  const redactAuditValue = (key: string, value: unknown): unknown => {
    const lower = key.toLowerCase()
    if (lower.includes('token') || lower.includes('password') || lower.includes('secret')
      || /api[_-]?key|authorization|credential|passcode|pin|otp/.test(lower)
      || ['text', 'content', 'script', 'value', 'message'].includes(lower)) {
      return { redacted: true }
    }
    if (Array.isArray(value)) return value.map((entry, index) => redactAuditValue(String(index), entry))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([entryKey, entry]) => [entryKey, redactAuditValue(entryKey, entry)]),
      )
    }
    return value
  }

  return {
    policyConfig,
    auditEnabled,
    auditLogPath,
    status,
    evaluate,
    digestText: value => createHmac('sha256', auditKey).update(value).digest('hex'),
    redactAuditValue,
    writeAudit(record) {
      if (!auditEnabled) return
      try {
        fs.mkdirSync(path.dirname(auditLogPath), { recursive: true, mode: 0o700 })
        fs.appendFileSync(auditLogPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
        // `mode` only applies at creation, so a log written by an older version
        // keeps its permissive bits. Narrow group/other once per runtime for the
        // path we own; a caller-specified path stays under the caller's control.
        if (!explicitAuditPath && !auditPermissionsChecked) {
          auditPermissionsChecked = true
          for (const target of [path.dirname(auditLogPath), auditLogPath]) {
            const current = fs.statSync(target).mode & 0o777
            if (current & 0o077) fs.chmodSync(target, current & 0o700)
          }
        }
      } catch { /* diagnostics report audit configuration; legacy execution stays available */ }
    },
  }
}
