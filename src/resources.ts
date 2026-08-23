/**
 * MCP resources — live desktop context without tool calls (P1 §3 / PR-9).
 * Screenshot resource is cache-only (K15) — never captures on read.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/server'
import type { Session } from './session.js'
import { fsRoots, fsRootsViolation } from './session/fs-jail.js'
import type { ProfileName } from './tool-catalog.js'
import { TOOL_CATALOG, toolInProfile } from './tool-catalog.js'
import { FILESYSTEM_RESOURCE_PREFIX } from './resource-links.js'

export interface ResourceContext {
  session: Session
  profile: ProfileName
  getActiveProfile?: () => ProfileName
  /** Last screenshot structured metadata (optional; never auto-captures). */
  getLastScreenshot?: () => { mimeType: string; data: string; capturedAt: number } | undefined
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
      annotations: ASSISTANT_RESOURCE,
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
      annotations: ASSISTANT_RESOURCE,
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
      annotations: ASSISTANT_RESOURCE,
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
      annotations: ASSISTANT_RESOURCE,
    },
    async (uri) => {
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
        path: async value => completeFilesystemPath(value, ctx.getClientRoots?.()),
      },
    }),
    {
      title: 'Filesystem artifact',
      description: 'Read a file or directory allowed by both MCP roots and COMPUTER_USE_FS_ROOTS',
      mimeType: 'application/octet-stream',
      annotations: ASSISTANT_RESOURCE,
    },
    async (uri, variables) => {
      const selected = decodeURIComponent(String(variables.path))
      const violation = fsRootsViolation(selected, ctx.getClientRoots?.())
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
}

function completeFilesystemPath(value: string, clientRoots?: readonly string[]): string[] {
  const roots = clientRoots ?? fsRoots()
  const candidates = value ? [value] : roots
  const suggestions = new Set<string>()
  for (const candidate of candidates) {
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
