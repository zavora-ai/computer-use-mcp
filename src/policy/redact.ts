const sensitiveKey = /pass(word|code)?|secret|token|credential|otp|one.?time|api.?key|pin|authorization|cookie/i

export type Redactor = (value: Record<string, unknown>) => Record<string, unknown>

/** Recursively removes values carried by secret-bearing field names. */
export function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactValue(value) as Record<string, unknown>
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redactValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([entryKey, entry]) => [entryKey, redactValue(entry, entryKey)]),
    )
  }
  return value
}
