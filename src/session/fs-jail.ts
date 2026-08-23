/**
 * Filesystem jail (PR-11b, opt-in) — `COMPUTER_USE_FS_ROOTS`.
 *
 * When `COMPUTER_USE_FS_ROOTS` is set to a comma-separated list of absolute roots,
 * the `filesystem` tool may only touch paths contained within one of those roots.
 * Defends against `..` traversal and symlink escapes by normalizing the path and
 * resolving the deepest existing ancestor via `realpath`, then re-appending the
 * non-existent tail before the containment check.
 *
 * Unset (default) → no restriction (legacy behavior; K16-A documents the residual
 * risk of unrestricted absolute paths). Read env on every call so it is testable
 * without re-importing the module.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface FsRootViolation extends Record<string, unknown> {
  error: 'fs_root_denied'
  path: string
  resolved: string
  roots: string[]
  remediation: string[]
}

/** Parsed configured roots (realpath'd where they exist). Empty when unset. */
export function fsRoots(): string[] {
  const raw = process.env.COMPUTER_USE_FS_ROOTS
  if (!raw) return []
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(r => {
      const abs = path.resolve(r)
      try { return fs.realpathSync(abs) } catch { return abs }
    })
}

/**
 * Resolve a path for containment checks: normalize `..`, realpath the deepest
 * existing ancestor (defeating symlink escapes), then re-append the remaining
 * non-existent tail so not-yet-created write targets are still checked.
 */
export function resolveForJail(target: string): string {
  let cur = path.resolve(target)
  const tail: string[] = []
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur)
    if (parent === cur) break // reached filesystem root
    tail.unshift(path.basename(cur))
    cur = parent
  }
  let real = cur
  try { real = fs.realpathSync(cur) } catch { /* keep normalized cur */ }
  return tail.length ? path.join(real, ...tail) : real
}

function isWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root + path.sep)
}

/**
 * Returns a structured violation when `target` escapes every configured root,
 * or `null` when the target is allowed. Returns `null` when no roots are
 * configured (jail disabled — legacy behavior).
 */
export function fsRootsViolation(target: string, clientRoots?: readonly string[]): FsRootViolation | null {
  const configuredRoots = fsRoots()
  const resolved = resolveForJail(target)
  const normalizedClientRoots = clientRoots?.map(root => {
    const absolute = path.resolve(root)
    try { return fs.realpathSync(absolute) } catch { return absolute }
  })
  const insideConfigured = configuredRoots.length === 0
    || configuredRoots.some(root => isWithin(resolved, root))
  const insideClient = normalizedClientRoots === undefined
    || normalizedClientRoots.some(root => isWithin(resolved, root))
  if (insideConfigured && insideClient) return null
  const roots = normalizedClientRoots === undefined
    ? configuredRoots
    : configuredRoots.length === 0
      ? normalizedClientRoots
      : [...new Set([...configuredRoots, ...normalizedClientRoots])]
  return {
    error: 'fs_root_denied',
    path: target,
    resolved,
    roots,
    remediation: [
      `Path is outside the negotiated filesystem boundaries. Configured roots: ${configuredRoots.join(', ') || '(unrestricted)'}. Client roots: ${normalizedClientRoots?.join(', ') || (normalizedClientRoots ? '(none)' : '(unsupported)')}.`,
      'Use a path allowed by both the MCP client roots and COMPUTER_USE_FS_ROOTS.',
    ],
  }
}
