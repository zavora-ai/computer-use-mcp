import { createHash } from 'node:crypto'
import {
  TOOL_CATALOG,
  toolInProfile,
  type ProfileName,
  type SurfaceProfileName,
} from '../tool-catalog.js'
import type { RuntimeCoordinator } from './coordinator.js'

export interface CapabilityManifestOptions {
  runtime: RuntimeCoordinator
  maximumProfile: ProfileName
  activeProfile: SurfaceProfileName
  experimentalTasks: boolean
  durableSessions: boolean
  durableReceipts: boolean
  durableEvents: boolean
  supervisorIpcConfigured: boolean
  supervisorFramesEnabled?: boolean
  browserBridgeConfigured?: boolean
  physicalInputRequiresAttributedMonitor?: boolean
  inputMonitor?: {
    supported: boolean
    backend: string
    distinguishesInjected: boolean
    recommendedPollMs: number
    reason?: string
  }
  platform?: NodeJS.Platform
  architecture?: string
  generatedAt?: Date
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Disclosure-safe, machine-readable host capability contract. */
export function createCapabilityManifest(options: CapabilityManifestOptions) {
  const activeProfile = options.activeProfile
  const actuators = Object.entries(TOOL_CATALOG)
    .filter(([, metadata]) => toolInProfile(metadata, options.maximumProfile))
    .map(([tool, metadata]) => ({
      tool,
      exposed: activeProfile !== 'v8-safe' && toolInProfile(metadata, activeProfile),
      mutates: metadata.mutates,
      capabilities: options.runtime.getExecutionCapabilities(tool),
    }))
    .sort((left, right) => left.tool.localeCompare(right.tool))
  if (options.browserBridgeConfigured) {
    actuators.push({
      tool: 'browser_action', exposed: false, mutates: true,
      capabilities: options.runtime.getExecutionCapabilities('browser_action'),
    })
    actuators.sort((left, right) => left.tool.localeCompare(right.tool))
  }
  const body = {
    schemaVersion: 1,
    runtimeApiVersion: 8,
    compatibility: { v7WireToolCount: Object.keys(TOOL_CATALOG).length, additiveV8: true },
    host: {
      platform: options.platform ?? process.platform,
      architecture: options.architecture ?? process.arch,
      maximumProfile: options.maximumProfile,
      activeProfile,
    },
    executionModes: ['shadow', 'background', 'foreground'] as const,
    features: {
      lifecycle: true,
      targetEvidence: true,
      policyV2: true,
      leases: true,
      receipts: true,
      sessionResources: true,
      supervisorLocalIpc: true,
      supervisorIpcConfigured: options.supervisorIpcConfigured,
      supervisorFramesEnabled: options.supervisorFramesEnabled ?? false,
      browserBridgeConfigured: options.browserBridgeConfigured ?? false,
      physicalInputRequiresAttributedMonitor: options.physicalInputRequiresAttributedMonitor ?? false,
      experimentalMcpTasks: options.experimentalTasks,
      remoteSidecar: {
        available: true,
        configured: false,
        defaultBind: 'loopback',
        publicIngressSupported: false,
      },
      durableSessions: options.durableSessions,
      durableReceipts: options.durableReceipts,
      durableEvents: options.durableEvents,
    },
    inputMonitor: options.inputMonitor ?? {
      supported: false,
      backend: 'unavailable',
      distinguishesInjected: false,
      recommendedPollMs: 50,
      reason: 'native input-monitor capability was not available to the host',
    },
    actuators,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
  }
  return {
    ...body,
    manifestDigest: `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`,
  }
}
