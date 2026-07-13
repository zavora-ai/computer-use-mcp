/**
 * MCP resources — live desktop context without tool calls (P1 §3 / PR-9).
 * Screenshot resource is cache-only (K15) — never captures on read.
 */

import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Session } from './session.js'
import { AUDIT_EXPORT_SCHEMA, AUDIT_EXPORT_SCHEMA_DIGEST } from './session/event-schema.js'
import type { RuntimeCoordinator } from './runtime/coordinator.js'
import { createCapabilityManifest, type CapabilityManifestOptions } from './runtime/manifest.js'
import type { ProfileName, SurfaceProfileName } from './tool-catalog.js'
import { TOOL_CATALOG, toolInProfile } from './tool-catalog.js'

export interface ResourceContext {
  session: Session
  profile: ProfileName
  /** Last screenshot structured metadata (optional; never auto-captures). */
  getLastScreenshot?: () => { mimeType: string; data: string; capturedAt: number } | undefined
  getPolicyStatus?: () => Promise<Record<string, unknown>> | Record<string, unknown>
  /** Enforced v8 lifecycle, when enabled. Session resources are never backed by the legacy dispatcher. */
  runtime?: RuntimeCoordinator
  principalId?: string
  capabilityManifest?: Omit<CapabilityManifestOptions, 'runtime' | 'maximumProfile' | 'activeProfile'> & {
    getActiveProfile(): SurfaceProfileName
  }
}

function textResource(uri: string, name: string, text: string, mimeType = 'application/json') {
  return {
    contents: [{ uri, mimeType, text, name }],
  }
}

export function registerResources(server: McpServer, ctx: ResourceContext): void {
  server.registerResource(
    'display-main',
    'computer://display/main',
    {
      title: 'Main display',
      description: 'Main display dimensions and scale factor',
      mimeType: 'application/json',
    },
    async (uri) => {
      const r = await ctx.session.dispatch('get_display_size', {})
      const text = r.content.find(c => c.type === 'text')?.text ?? '{}'
      return textResource(uri.href, 'display-main', text)
    },
  )

  server.registerResource(
    'windows',
    'computer://windows',
    {
      title: 'Visible windows',
      description: 'List of visible on-screen windows',
      mimeType: 'application/json',
    },
    async (uri) => {
      const r = await ctx.session.dispatch('list_windows', {})
      const text = r.content.find(c => c.type === 'text')?.text ?? '{"windows":[]}'
      return textResource(uri.href, 'windows', text)
    },
  )

  server.registerResource(
    'frontmost',
    'computer://frontmost',
    {
      title: 'Frontmost app',
      description: 'Currently frontmost application',
      mimeType: 'application/json',
    },
    async (uri) => {
      const r = await ctx.session.dispatch('get_frontmost_app', {})
      const text = r.content.find(c => c.type === 'text')?.text ?? '{"app":null}'
      return textResource(uri.href, 'frontmost', text)
    },
  )

  server.registerResource(
    'policy',
    'computer://policy',
    {
      title: 'Active policy',
      description: 'Policy and audit configuration (no secrets)',
      mimeType: 'application/json',
    },
    async (uri) => {
      if (ctx.getPolicyStatus) {
        const status = await ctx.getPolicyStatus()
        return textResource(uri.href, 'policy', JSON.stringify(status))
      }
      const r = await ctx.session.dispatch('policy_status', {})
      const text = r.content.find(c => c.type === 'text')?.text ?? '{}'
      return textResource(uri.href, 'policy', text)
    },
  )

  server.registerResource(
    'profile-tools',
    'computer://profile/tools',
    {
      title: 'Active profile tools',
      description: 'Tools available under the current COMPUTER_USE_PROFILE',
      mimeType: 'application/json',
    },
    async (uri) => {
      const tools = Object.entries(TOOL_CATALOG)
        .filter(([, meta]) => toolInProfile(meta, ctx.profile))
        .map(([name, meta]) => ({ name, ...meta }))
      return textResource(uri.href, 'profile-tools', JSON.stringify({
        profile: ctx.profile,
        count: tools.length,
        tools,
      }))
    },
  )

  server.registerResource(
    'screenshot-latest',
    'computer://screenshot/latest',
    {
      title: 'Latest screenshot (cache only)',
      description: 'Last captured screenshot if available. Never captures on read (privacy).',
      mimeType: 'application/json',
    },
    async (uri) => {
      const cached = ctx.getLastScreenshot?.()
      if (!cached) {
        return textResource(uri.href, 'screenshot-latest', JSON.stringify({
          available: false,
          reason: 'no_cached_screenshot',
          note: 'Call the screenshot tool first. This resource never captures (K15).',
        }))
      }
      // Return metadata + note; hosts can also use image from last tool result.
      return {
        contents: [{
          uri: uri.href,
          mimeType: cached.mimeType,
          blob: cached.data,
          name: 'screenshot-latest',
        }],
      }
    },
  )

  if (ctx.runtime && ctx.principalId) {
    const runtime = ctx.runtime
    const principalId = ctx.principalId
    server.registerResource(
      'capability-manifest',
      'computer://capabilities/manifest',
      {
        title: 'Computer-use capability manifest',
        description: 'Machine-readable v8 modes, persistence, monitor limits, and per-actuator interference contracts',
        mimeType: 'application/json',
      },
      async uri => textResource(uri.href, 'capability-manifest', JSON.stringify(createCapabilityManifest({
        runtime,
        maximumProfile: ctx.profile,
        activeProfile: ctx.capabilityManifest?.getActiveProfile() ?? ctx.profile,
        experimentalTasks: ctx.capabilityManifest?.experimentalTasks ?? false,
        durableSessions: ctx.capabilityManifest?.durableSessions ?? false,
        durableReceipts: ctx.capabilityManifest?.durableReceipts ?? false,
        durableEvents: ctx.capabilityManifest?.durableEvents ?? false,
        supervisorIpcConfigured: ctx.capabilityManifest?.supervisorIpcConfigured ?? false,
        browserBridgeConfigured: ctx.capabilityManifest?.browserBridgeConfigured ?? false,
        ...(ctx.capabilityManifest?.inputMonitor ? { inputMonitor: ctx.capabilityManifest.inputMonitor } : {}),
      }))),
    )
    server.registerResource(
      'audit-schema',
      'computer://audit/schema',
      {
        title: 'Computer-use v8 audit export schema',
        description: 'Stable JSON Schema and digest for paginated, redacted session-event exports',
        mimeType: 'application/schema+json',
      },
      async uri => textResource(uri.href, 'audit-schema', JSON.stringify({
        schema: AUDIT_EXPORT_SCHEMA,
        digest: AUDIT_EXPORT_SCHEMA_DIGEST,
      }), 'application/schema+json'),
    )
    server.registerResource(
      'session-current',
      'computer://session/current',
      {
        title: 'Current computer-use session',
        description: 'Most recently updated v8 session owned by the authenticated host principal',
        mimeType: 'application/json',
      },
      async uri => {
        const [current] = await runtime.listSessions(principalId)
        return textResource(uri.href, 'session-current', JSON.stringify(current
          ? { available: true, session: current }
          : { available: false, reason: 'no_owned_session' }))
      },
    )

    server.registerResource(
      'session-by-id',
      new ResourceTemplate('computer://session/{sessionId}', {
        list: async () => ({
          resources: (await runtime.listSessions(principalId)).map(session => ({
            uri: `computer://session/${encodeURIComponent(session.sessionId)}`,
            name: `session-${session.sessionId}`,
            title: `Computer-use session (${session.state})`,
            description: 'Principal-owned v8 lifecycle state and completion evidence',
            mimeType: 'application/json',
          })),
        }),
        complete: {
          sessionId: async value => (await runtime.listSessions(principalId))
            .map(session => session.sessionId)
            .filter(sessionId => sessionId.startsWith(value)),
        },
      }),
      {
        title: 'Computer-use session by ID',
        description: 'Read a principal-owned v8 session without exposing another principal’s lifecycle',
        mimeType: 'application/json',
      },
      async (uri, variables) => {
        const sessionId = String(variables.sessionId)
        const session = await runtime.getSession(sessionId, principalId)
        return textResource(uri.href, `session-${sessionId}`, JSON.stringify({ session }))
      },
    )
  }
}
