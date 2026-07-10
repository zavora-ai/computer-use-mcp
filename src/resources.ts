/**
 * MCP resources — live desktop context without tool calls (P1 §3 / PR-9).
 * Screenshot resource is cache-only (K15) — never captures on read.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Session } from './session.js'
import type { ProfileName } from './tool-catalog.js'
import { TOOL_CATALOG, toolInProfile } from './tool-catalog.js'

export interface ResourceContext {
  session: Session
  profile: ProfileName
  /** Last screenshot structured metadata (optional; never auto-captures). */
  getLastScreenshot?: () => { mimeType: string; data: string; capturedAt: number } | undefined
  getPolicyStatus?: () => Promise<Record<string, unknown>> | Record<string, unknown>
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
}
