import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type { ToolResult } from './result.js'

export const FILESYSTEM_RESOURCE_PREFIX = 'computer://filesystem/'

export function filesystemResourcePath(selected: string): string {
  return isAbsolute(selected) ? selected : join(homedir(), 'Desktop', selected)
}

export function filesystemResourceUri(selected: string): string {
  return `${FILESYSTEM_RESOURCE_PREFIX}${encodeURIComponent(filesystemResourcePath(selected))}`
}

/** Add a readable resource reference for successful filesystem operations. */
export function withFilesystemResourceLink(
  result: ToolResult,
  args: Readonly<Record<string, unknown>>,
): ToolResult {
  if (result.isError) return result
  const mode = String(args.mode ?? '')
  if (mode === 'delete' || mode === 'search') return result
  const selected = mode === 'copy' || mode === 'move' ? args.destination : args.path
  if (typeof selected !== 'string' || selected.length === 0) return result
  const resolved = filesystemResourcePath(selected)
  return {
    ...result,
    content: [...result.content, {
      type: 'resource_link',
      uri: filesystemResourceUri(selected),
      name: basename(resolved) || 'filesystem-resource',
      title: `Filesystem result: ${resolved}`,
      description: 'Read this filesystem artifact through the computer-use MCP resource interface.',
    }],
  }
}
