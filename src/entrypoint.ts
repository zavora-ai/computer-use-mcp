/**
 * Standalone stdio entrypoint detection.
 *
 * Determines whether the current Node process was invoked as the
 * computer-use-mcp stdio server (e.g. `node dist/server.js` or
 * `npx @zavora-ai/computer-use-mcp`) vs imported as a library.
 *
 * Path-separator-agnostic: Node normalizes `process.argv[1]` to the platform
 * separator, so a hard-coded `/` check rejects valid Windows invocations like
 * `C:\path\to\server.js`. Without this, the server silently exits without
 * starting StdioServerTransport on every Windows host.
 *
 * Kept in its own module (no native imports) so the helper is unit-testable
 * without building the Rust NAPI binary.
 */
export function isStdioEntrypoint(argv1: string | undefined): boolean {
  if (!argv1) return false
  // Normalize backslashes to forward slashes once, then match against the
  // POSIX-style suffixes. Cheaper and clearer than checking both separators
  // for every suffix.
  const normalized = argv1.replace(/\\/g, '/')
  return (
    normalized.endsWith('/server.ts') ||
    normalized.endsWith('/server.js') ||
    normalized.endsWith('/computer-use-mcp')
  )
}
