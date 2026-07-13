import { createHash } from 'node:crypto'
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
  rememberApproval(tool: string, targetApp?: string): void
  digestText(value: string): string
  redactAuditValue(key: string, value: unknown): unknown
  writeAudit(record: Record<string, unknown>): void
}

function list(env: NodeJS.ProcessEnv, name: string, fallback: string[] = []): string[] {
  const raw = env[name]
  return raw ? raw.split(',').map(value => value.trim()).filter(Boolean) : [...fallback]
}

function destructive(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'run_script') return true
  if (tool === 'process_kill') return args.mode === 'kill'
  if (tool === 'registry') return args.mode === 'set' || args.mode === 'delete'
  if (tool === 'filesystem') return ['write', 'move', 'delete'].includes(String(args.mode))
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
  const auditLogPath = auditSetting && auditSetting !== 'true' && auditSetting !== 'false'
    ? auditSetting
    : path.join(options.homeDirectory ?? os.homedir(), '.computer-use-mcp', 'audit.jsonl')
  const approvals = new Set<string>()

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
    const targetApp = options.targetApp(args)
    const isDestructive = destructive(tool, args)
    const reasons: string[] = []
    if (targetApp && policyConfig.blockedApps.includes(targetApp)) {
      return {
        allowed: false, approval: 'denied', reasons: [`target_app_blocked:${targetApp}`],
        targetApp, destructive: isDestructive,
        remediation: [`Remove ${targetApp} from COMPUTER_USE_BLOCKED_APPS only if this app should be controllable.`],
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
    const needsApproval = policyConfig.approvalRequiredForAll
      || policyConfig.requireApprovalFor.includes(tool)
      || (isDestructive && policyConfig.destructiveRequiresApproval)
      || Boolean(targetApp && policyConfig.sensitiveApps.includes(targetApp))
    if (!needsApproval) {
      return { allowed: true, approval: 'not_required', reasons, targetApp, destructive: isDestructive }
    }
    reasons.push(
      policyConfig.approvalRequiredForAll ? 'approval_required_for_all'
        : policyConfig.requireApprovalFor.includes(tool) ? `tool_requires_approval:${tool}`
          : isDestructive && policyConfig.destructiveRequiresApproval ? 'destructive_requires_approval'
            : targetApp ? `sensitive_app:${targetApp}` : 'approval_required',
    )
    const expected = env.COMPUTER_USE_APPROVAL_TOKEN
    if (expected && args.approval_token === expected) {
      return { allowed: true, approval: 'approved', reasons, targetApp, destructive: isDestructive }
    }
    if (approvals.has(`${tool}:${targetApp ?? ''}`) || approvals.has('*')) {
      return {
        allowed: true, approval: 'approved', reasons: [...reasons, 'session_remembered'],
        targetApp, destructive: isDestructive,
      }
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
    if (typeof value === 'string' && (
      lower.includes('token') || ['text', 'content', 'script', 'value', 'message'].includes(lower)
    )) {
      return {
        redacted: true,
        length: value.length,
        sha256: createHash('sha256').update(value).digest('hex'),
      }
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
    rememberApproval: (tool, targetApp) => approvals.add(`${tool}:${targetApp ?? ''}`),
    digestText: value => createHash('sha256').update(value).digest('hex'),
    redactAuditValue,
    writeAudit(record) {
      if (!auditEnabled) return
      try {
        fs.mkdirSync(path.dirname(auditLogPath), { recursive: true })
        fs.appendFileSync(auditLogPath, `${JSON.stringify(record)}\n`, 'utf8')
      } catch { /* diagnostics report audit configuration; legacy execution stays available */ }
    },
  }
}
