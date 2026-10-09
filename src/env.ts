/**
 * Environment parsing that never throws at import time.
 *
 * `Number(process.env.X ?? 16)` returns NaN for an empty string and 0 for "0", and the task manager's
 * constructor throws on both, which used to end the server before its transport opened. Fall back to the
 * default instead and say so on stderr (stdout is the MCP channel on stdio).
 */
export function envPositiveInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = line => console.error(line)): number {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (Number.isSafeInteger(value) && value >= 1) return value
  warn(`[computer-use-mcp] ${name}=${JSON.stringify(raw)} is not a positive integer; using ${fallback}`)
  return fallback
}
