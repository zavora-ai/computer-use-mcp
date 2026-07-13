import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ActionClass } from '../runtime/action.js'
import type { ActionEnvelope } from '../runtime/types.js'
import type { PolicyDecision, PolicyEvaluator } from './evaluate.js'

export interface PolicyV2Config {
  allowedAppIds?: string[]
  blockedAppIds?: string[]
  confirmAppIds?: string[]
  filesystemRoots?: string[]
  registryHives?: string[]
  allowedDomains?: string[]
  blockedProcesses?: string[]
  denyClasses?: ActionClass[]
  confirmClasses?: ActionClass[]
  minimumTargetConfidence?: number
  disabledTools?: string[]
  requireFilesystemRootsForMutation?: boolean
}

function inside(root: string, candidate: string): boolean {
  if (!isAbsolute(root) || !isAbsolute(candidate)) return false
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function domainMatches(rule: string, domain: string): boolean {
  const normalized = rule.toLowerCase().replace(/^\*\./, '')
  return domain === normalized || domain.endsWith(`.${normalized}`)
}

/** Deterministic operation-aware boundary policy. Host policy can compose around it. */
export class PolicyV2Engine {
  readonly config: Readonly<PolicyV2Config>
  readonly policyDigest: string

  constructor(config: PolicyV2Config = {}) {
    this.config = structuredClone(config)
    const canonicalConfig = Object.fromEntries(
      Object.entries(this.config).sort(([a], [b]) => a.localeCompare(b)),
    )
    this.policyDigest = `sha256:${createHash('sha256').update(JSON.stringify(canonicalConfig)).digest('hex')}`
  }

  readonly evaluate: PolicyEvaluator = (envelope): PolicyDecision => {
    const deny = (reason: string): PolicyDecision => ({
      decision: 'deny', policyDigest: this.policyDigest, reasons: [reason],
    })
    if (this.config.disabledTools?.includes(envelope.tool)) return deny(`disabled_tool:${envelope.tool}`)
    const target = envelope.target
    const targetAppId = target?.appId ?? envelope.resource?.targetAppId
    const appMatches = (values: readonly string[] | undefined, appId: string) =>
      values?.some(value => value.toLowerCase() === appId.toLowerCase()) ?? false
    if (targetAppId && appMatches(this.config.blockedAppIds, targetAppId)) return deny(`blocked_app:${targetAppId}`)
    if (targetAppId && this.config.allowedAppIds?.length && !appMatches(this.config.allowedAppIds, targetAppId)) {
      return deny(`app_outside_allowlist:${targetAppId}`)
    }
    if (target && target.confidence < (this.config.minimumTargetConfidence ?? 0)) {
      return deny(`target_confidence:${target.confidence}`)
    }
    const resource = envelope.resource
    if (envelope.tool === 'filesystem' && envelope.actionClass !== 'observe'
      && this.config.requireFilesystemRootsForMutation && !this.config.filesystemRoots?.length) {
      return deny('filesystem_mutation_unconfigured')
    }
    for (const path of [resource?.filesystemPath, resource?.filesystemDestination].filter(Boolean) as string[]) {
      if (this.config.filesystemRoots?.length && !this.config.filesystemRoots.some(root => inside(root, path))) {
        return deny(`filesystem_outside_roots:${path}`)
      }
    }
    if (resource?.registryPath && this.config.registryHives?.length) {
      const path = resource.registryPath.toLowerCase()
      if (!this.config.registryHives.some(hive => path.startsWith(hive.toLowerCase()))) {
        return deny(`registry_outside_hives:${resource.registryPath}`)
      }
    }
    if (resource?.browserDomain) {
      if (this.config.allowedDomains?.length && !this.config.allowedDomains.some(rule => domainMatches(rule, resource.browserDomain!))) {
        return deny(`domain_outside_allowlist:${resource.browserDomain}`)
      }
    }
    if (resource?.processName && this.config.blockedProcesses?.some(name => name.toLowerCase() === resource.processName!.toLowerCase())) {
      return deny(`blocked_process:${resource.processName}`)
    }
    if (this.config.denyClasses?.includes(envelope.actionClass)) return deny(`denied_class:${envelope.actionClass}`)
    if (envelope.provenance?.untrustedInstruction && envelope.actionClass !== 'observe') {
      if (['authentication', 'financial', 'destructive', 'privilege_change'].includes(envelope.actionClass)) {
        return deny(`untrusted_instruction:${envelope.actionClass}`)
      }
      return {
        decision: 'confirm', policyDigest: this.policyDigest,
        reasons: [`untrusted_instruction_boundary:${envelope.actionClass}`],
      }
    }
    const confirm = new Set<ActionClass>(this.config.confirmClasses ?? [
      'communicate_external', 'authentication', 'financial', 'destructive', 'privilege_change', 'secret_access',
    ])
    const confirmApp = Boolean(targetAppId && appMatches(this.config.confirmAppIds, targetAppId))
    if (confirmApp || confirm.has(envelope.actionClass)
      || (envelope.actionClass === 'edit_reversible' && envelope.externalSideEffect)
      || envelope.dataLabels.some(label => label === 'credential' || label === 'payment')) {
      return {
        decision: 'confirm', policyDigest: this.policyDigest,
        reasons: [confirmApp ? `confirm_app:${targetAppId}` : `confirm:${envelope.actionClass}`],
      }
    }
    return { decision: 'allow', policyDigest: this.policyDigest, reasons: [`allow:${envelope.actionClass}`] }
  }
}

export function createPolicyV2Evaluator(config: PolicyV2Config = {}): PolicyEvaluator {
  return new PolicyV2Engine(config).evaluate
}

export function createDefaultV8PolicyFromEnvironment(env: NodeJS.ProcessEnv = process.env): PolicyEvaluator {
  const list = (name: string, fallback: string[] = []) =>
    env[name]?.split(',').map(value => value.trim()).filter(Boolean) ?? fallback
  const filesystemRoots = list('COMPUTER_USE_FS_ROOTS')
  const defaultSensitiveApps = process.platform === 'win32'
    ? ['1Password.exe', 'CredentialUIBroker.exe', 'KeePassXC.exe']
    : ['com.apple.keychainaccess', 'com.apple.Passwords', 'com.1password.1password', 'com.agilebits.onepassword7']
  return createPolicyV2Evaluator({
    ...(filesystemRoots?.length ? { filesystemRoots } : {}),
    allowedAppIds: list('COMPUTER_USE_ALLOWED_APPS'),
    blockedAppIds: list('COMPUTER_USE_BLOCKED_APPS'),
    confirmAppIds: list('COMPUTER_USE_CREDENTIAL_APPS', defaultSensitiveApps),
    allowedDomains: list('COMPUTER_USE_V8_ALLOWED_DOMAINS'),
    registryHives: list('COMPUTER_USE_V8_REGISTRY_HIVES'),
    blockedProcesses: list('COMPUTER_USE_V8_BLOCKED_PROCESSES'),
    requireFilesystemRootsForMutation: env.COMPUTER_USE_V7_COMPAT !== 'true',
    disabledTools: env.COMPUTER_USE_V8_ALLOW_SCRAPE === 'true' ? [] : ['scrape'],
  })
}
