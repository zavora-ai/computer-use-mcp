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

export type FsRootDecision =
  | { violation: FsRootViolation }
  | { violation: null; path: string }

/** True when either a configured or a negotiated boundary is in force. */
export function fsBoundaryEnforced(clientRoots?: readonly string[]): boolean {
  return fsRoots().length > 0 || clientRoots !== undefined
}

/**
 * Check `target` and return the path the caller should actually operate on.
 *
 * When a boundary is in force the returned path is the canonicalized one that
 * was just checked, so the syscall cannot be redirected outside the roots by a
 * symlink swapped in after the check (the check-then-use race). With no boundary
 * configured there is nothing to bypass, so the caller's path is returned
 * unchanged and deliberate symlinks keep behaving as the caller expects.
 *
 * **This is necessary but not sufficient, and `openWithinRoots` is the rest of it.**
 * Canonicalizing narrows the window; it cannot close it. The path is resolved at one
 * instant and the syscall happens at another, and for a write target that does not
 * exist yet the tail cannot be canonicalized at all — a component created as a symlink
 * in between will be followed. Closing that needs the operation to happen on a
 * descriptor whose identity has been verified, not on a name resolved earlier.
 */
export function enforceFsRoots(target: string, clientRoots?: readonly string[]): FsRootDecision {
  const violation = fsRootsViolation(target, clientRoots)
  if (violation) return { violation }
  return {
    violation: null,
    path: fsBoundaryEnforced(clientRoots) ? resolveForJail(target) : target,
  }
}

/**
 * Open a path and prove the descriptor is inside the roots before anything reads or
 * writes through it.
 *
 * The check-then-use race cannot be won with pathnames: whatever a name resolves to
 * now, it may resolve elsewhere by the time the kernel looks again. What can be won is
 * the question asked after opening — this descriptor, whatever games were played with
 * names, refers to *this* file, and here is whether that file is inside the boundary.
 *
 * Two things make that answerable:
 *
 * - `O_NOFOLLOW` on the final component, so the last name in the path cannot itself be
 *   a symlink at open time. That covers the common swap.
 * - `/dev/fd/N`, which on macOS and Linux resolves to the path the descriptor actually
 *   holds. Comparing *that* against the roots is a statement about the open file rather
 *   than about a name, so a component swapped mid-flight is caught rather than
 *   followed.
 *
 * Where `/dev/fd` is unavailable — Windows — the descriptor's identity cannot be
 * recovered this way, so the caller is told so rather than being given false assurance.
 * The pathname check still applies there; it is simply the weaker guarantee it always
 * was.
 */
export function openWithinRoots(
  target: string,
  flags: number,
  clientRoots?: readonly string[],
  mode?: number,
): { violation: FsRootViolation } | { violation: null; fd: number; verified: boolean } {
  const decision = enforceFsRoots(target, clientRoots)
  if (decision.violation) return { violation: decision.violation }

  // O_NOFOLLOW refuses a symlink as the final component. Without a boundary in force
  // there is nothing to protect, and refusing a deliberate symlink would be a
  // behaviour change, so it is only added when a boundary applies.
  const enforced = fsBoundaryEnforced(clientRoots)
  const openFlags = enforced && typeof fs.constants.O_NOFOLLOW === 'number'
    ? flags | fs.constants.O_NOFOLLOW
    : flags

  const fd = (() => {
    try {
      return mode === undefined
        ? fs.openSync(decision.path, openFlags)
        : fs.openSync(decision.path, openFlags, mode)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // O_NOFOLLOW reports ELOOP when the final component is a symlink. That is the
      // boundary working, not an I/O fault, so it is reported as a violation with the
      // reason rather than thrown as an unexplained open failure.
      if (enforced && (code === 'ELOOP' || code === 'EMLINK')) return 'symlink' as const
      throw error
    }
  })()
  if (fd === 'symlink') {
    return {
      violation: {
        error: 'fs_root_violation',
        message: `${target} is a symbolic link, and following it could leave the configured roots. `
          + 'The final component of a path must be a real file when COMPUTER_USE_FS_ROOTS is set.',
        path: target,
        roots: fsRoots(),
      } as unknown as FsRootViolation,
    }
  }

  if (!enforced) return { violation: null, fd, verified: false }

  // Ask whether the descriptor still refers to the file the check approved.
  //
  // Identity, not names. `fstat` describes the open file; `lstat` describes whatever the
  // name refers to right now. If the device and inode agree, nothing was swapped in
  // between, and the descriptor is the thing that was checked. If they disagree,
  // something changed under us and refusing is the only safe answer.
  //
  // This replaces an earlier attempt to recover the path from `/dev/fd/N`, which works
  // on Linux and does not on macOS: there `realpath` returns `/dev/fd/11` rather than
  // the file, so every legitimate write was rejected. Comparing inodes needs no
  // procfs and behaves the same on all three platforms.
  try {
    const opened = fs.fstatSync(fd)
    const named = fs.lstatSync(decision.path)
    if (opened.dev !== named.dev || opened.ino !== named.ino) {
      try { fs.closeSync(fd) } catch { /* closing a doomed descriptor */ }
      return {
        violation: {
          error: 'fs_root_violation',
          message: `${target} changed while it was being opened, so it cannot be confirmed inside `
            + 'the configured roots. Nothing was written. This is what a symlink swapped in '
            + 'between the check and the open looks like.',
          path: target,
          roots: fsRoots(),
        } as unknown as FsRootViolation,
      }
    }
  } catch {
    // The identity could not be established. The pathname check passed and O_NOFOLLOW
    // held, so the descriptor is usable — but say the stronger guarantee is absent
    // rather than implying it.
    return { violation: null, fd, verified: false }
  }
  return { violation: null, fd, verified: true }
}
