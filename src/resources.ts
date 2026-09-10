/**
 * MCP resources — live desktop context without tool calls (P1 §3 / PR-9).
 * Screenshot resource is cache-only (K15) — never captures on read.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { ResourceTemplate, isInputRequiredResult, type ServerContext, type McpServer } from '@modelcontextprotocol/server'
import type { ToolRegistry } from './registry/registry.js'
import type { Session } from './session.js'
import { fsRoots, fsRootsViolation } from './session/fs-jail.js'
import type { ProfileName } from './tool-catalog.js'
import { TOOL_CATALOG, toolInProfile } from './tool-catalog.js'
import { FILESYSTEM_RESOURCE_PREFIX } from './resource-links.js'

export interface ResourceContext {
  session: Session
  registry: ToolRegistry
  profile: ProfileName
  getActiveProfile?: () => ProfileName
  /** Last screenshot structured metadata (optional; never auto-captures). */
  getLastScreenshot?: () => { mimeType: string; data: string; capturedAt: number; targetArgs?: Record<string, unknown> } | undefined
  getPolicyStatus?: () => Promise<Record<string, unknown>> | Record<string, unknown>
  getClientRoots?: () => readonly string[] | undefined
}

function textResource(uri: string, name: string, text: string, mimeType = 'application/json') {
  return {
    contents: [{ uri, mimeType, text, name, annotations: { audience: ['assistant' as const], priority: 0.8 } }],
  }
}

const ASSISTANT_RESOURCE = { audience: ['assistant' as const], priority: 0.8 }

export function registerResources(server: McpServer, ctx: ResourceContext): void {
  server.registerResource(
    'display-main',
    'computer://display/main',
    {
      title: 'Main display',
      description: 'Main display dimensions and scale factor',
      mimeType: 'application/json',
      annotations: ASSISTANT_RESOURCE,
    },
    async (uri, extra) => {
      const r = await ctx.registry.executeRegistered('get_display_size', {}, extra)
      if (isInputRequiredResult(r)) return r
      if (r.isError) throw new Error(JSON.stringify(r.content))
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
      annotations: ASSISTANT_RESOURCE,
    },
    async (uri, extra) => {
      const r = await ctx.registry.executeRegistered('list_windows', {}, extra)
      if (isInputRequiredResult(r)) return r
      if (r.isError) throw new Error(JSON.stringify(r.content))
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
      annotations: ASSISTANT_RESOURCE,
    },
    async (uri, extra) => {
      const r = await ctx.registry.executeRegistered('get_frontmost_app', {}, extra)
      if (isInputRequiredResult(r)) return r
      if (r.isError) throw new Error(JSON.stringify(r.content))
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
      annotations: ASSISTANT_RESOURCE,
    },
    async (uri, extra) => {
      if (ctx.getPolicyStatus) {
        const prepared = await ctx.registry.preflight('policy_status', {}, extra)
        if (isInputRequiredResult(prepared)) return prepared
        if (prepared.isError) throw new Error(JSON.stringify(prepared.content))
        const status = await ctx.getPolicyStatus()
        return textResource(uri.href, 'policy', JSON.stringify(status))
      }
      const r = await ctx.registry.executeRegistered('policy_status', {}, extra)
      if (isInputRequiredResult(r)) return r
      if (r.isError) throw new Error(JSON.stringify(r.content))
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
      annotations: ASSISTANT_RESOURCE,
    },
    async (uri, extra) => {
      const authorization = await ctx.registry.preflight('get_tool_metadata', { tool_name: 'get_tool_metadata' }, extra)
      if (isInputRequiredResult(authorization)) return authorization
      if (authorization.isError) throw new Error('Resource access denied')
      const activeProfile = ctx.getActiveProfile?.() ?? ctx.profile
      const tools = Object.entries(TOOL_CATALOG)
        .filter(([, meta]) => toolInProfile(meta, ctx.profile) && toolInProfile(meta, activeProfile))
        .map(([name, meta]) => ({ name, ...meta }))
      return textResource(uri.href, 'profile-tools', JSON.stringify({
        profile: activeProfile,
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
      annotations: { audience: ['assistant'], priority: 1 },
    },
    async (uri, extra) => {
      const authorization = await ctx.registry.preflight('screenshot', ctx.getLastScreenshot?.()?.targetArgs ?? {}, extra)
      if (isInputRequiredResult(authorization)) return authorization
      if (authorization.isError) throw new Error('Resource access denied')
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
          annotations: { audience: ['assistant'], priority: 1 },
        }],
      }
    },
  )

  server.registerResource(
    'filesystem-artifact',
    new ResourceTemplate(`${FILESYSTEM_RESOURCE_PREFIX}{path}`, {
      list: undefined,
      complete: {
        // The SDK's completion callback has no authenticated request context.
        // Do not expose filesystem names through this unauthorizable surface.
        path: async () => [],
      },
    }),
    {
      title: 'Filesystem artifact',
      description: 'Read a file or directory allowed by both MCP roots and COMPUTER_USE_FS_ROOTS',
      mimeType: 'application/octet-stream',
      annotations: ASSISTANT_RESOURCE,
    },
    async (uri, variables, extra) => {
      const selected = decodeURIComponent(String(variables.path))
      const authorization = await ctx.registry.preflight('filesystem', { mode: 'read', path: selected }, extra)
      if (isInputRequiredResult(authorization)) return authorization
      if (authorization.isError) throw new Error('Filesystem resource denied')
      const roots = JSON.parse(authorization.content.find(c => c.type === 'text')?.text ?? '{}').clientRoots ?? ctx.getClientRoots?.()
      const violation = fsRootsViolation(selected, roots)
      if (violation) throw new Error(violation.remediation[0])
      const stat = fs.statSync(selected)
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(selected, { withFileTypes: true }).slice(0, 1_000)
          .map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }))
        return textResource(uri.href, path.basename(selected) || selected, JSON.stringify({ path: selected, entries }))
      }
      if (stat.size > 1_048_576) throw new Error('Resource exceeds the 1 MiB MCP read limit')
      const data = fs.readFileSync(selected)
      if (data.includes(0)) {
        return { contents: [{
          uri: uri.href,
          name: path.basename(selected),
          mimeType: 'application/octet-stream',
          blob: data.toString('base64'),
          annotations: ASSISTANT_RESOURCE,
        }] }
      }
      return textResource(uri.href, path.basename(selected), data.toString('utf8'), 'text/plain')
    },
  )
  // Request-level completion has identity and MRTR state, unlike template callbacks.
  server.server.setRequestHandler('completion/complete', async (request, extra) => {
    const { ref, argument } = request.params
    if (ref.type === 'ref/prompt' && argument.name === 'app') {
      const result = await ctx.registry.executeRegistered('list_running_apps', {}, extra)
      if (isInputRequiredResult(result)) throw new Error('Completion requires negotiated authority; use tools/call')
      if (result.isError) throw new Error('Application completion denied')
      const parsed = JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '[]')
      const apps = Array.isArray(parsed) ? parsed : parsed.apps ?? []
      return { completion: { values: apps.map((app: any) => String(app.bundleId ?? app.bundle_id ?? app.name ?? ''))
        .filter((name: string) => name.toLowerCase().startsWith(argument.value.toLowerCase())).slice(0, 100) } }
    }
    if (ref.type === 'ref/resource' && ref.uri.startsWith(FILESYSTEM_RESOURCE_PREFIX)) {
      const value = decodeURIComponent(argument.value)
      const authorization = await ctx.registry.preflight('filesystem', { mode: 'list', path: value || '.' }, extra)
      if (isInputRequiredResult(authorization)) throw new Error('Completion requires negotiated roots; use filesystem tool')
      if (authorization.isError) throw new Error('Filesystem completion denied')
      const roots = JSON.parse(authorization.content.find(c => c.type === 'text')?.text ?? '{}').clientRoots ?? ctx.getClientRoots?.()
      return { completion: { values: completeFilesystemPath(value, roots) } }
    }
    return { completion: { values: [] } }
  })

}

function completeFilesystemPath(value: string, clientRoots?: readonly string[]): string[] {
  const roots = clientRoots ?? fsRoots()
  const candidates = value ? [value] : roots
  const suggestions = new Set<string>()
  for (const candidate of candidates) {
    if (fsRootsViolation(candidate, clientRoots)) continue
    const directory = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
      ? candidate
      : path.dirname(candidate)
    const prefix = directory === candidate ? '' : path.basename(candidate)
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.name.startsWith(prefix)) continue
        const suggestion = path.join(directory, entry.name) + (entry.isDirectory() ? path.sep : '')
        if (!fsRootsViolation(suggestion, clientRoots)) suggestions.add(encodeURIComponent(suggestion))
        if (suggestions.size >= 100) return [...suggestions]
      }
    } catch { /* unreadable candidate */ }
  }
  return [...suggestions]
}

export async function authorizeResourceAccess(registry: ToolRegistry, uri: string, context: ServerContext): Promise<void> {
  const tools: Record<string, string> = {
    'computer://windows': 'list_windows', 'computer://frontmost': 'get_frontmost_app',
    'computer://display/main': 'get_display_size', 'computer://screenshot/latest': 'screenshot',
    'computer://policy': 'policy_status', 'computer://profile/tools': 'get_tool_metadata',
  }
  const tool = tools[uri] ?? (uri.startsWith(FILESYSTEM_RESOURCE_PREFIX) ? 'filesystem' : undefined)
  if (!tool) throw new Error('Unknown resource')
  const args = tool === 'filesystem' ? { mode: 'read', path: decodeURIComponent(uri.slice(FILESYSTEM_RESOURCE_PREFIX.length)) }
    : tool === 'get_tool_metadata' ? { tool_name: tool } : {}
  const result = await registry.preflight(tool, args, context)
  if (isInputRequiredResult(result) || result.isError) throw new Error('Resource subscription requires current authorization')
}
