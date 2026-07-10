/**
 * Tool result helpers — dual-write text JSON + structuredContent (K5 / K21).
 */

export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** Plain text result (no structuredContent). */
export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

/**
 * Dual-write: text JSON === structuredContent (K5).
 * Payload must already match wire-compat rules (K21).
 */
export function okJson(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  }
}

/** Class B wrap for tools that previously returned a top-level array. */
export function okJsonWrappedArray<T>(key: string, items: T[]): ToolResult {
  return okJson({ [key]: items } as Record<string, unknown>)
}

/** Class B wrap for tools that previously returned a bare scalar/null. */
export function okJsonWrappedScalar(key: string, value: unknown): ToolResult {
  return okJson({ [key]: value })
}

export function errJson(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: true,
  }
}

export function toMcpToolResult(result: ToolResult): {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >
  structuredContent?: Record<string, unknown>
  isError?: boolean
} {
  const content = result.content.map(c =>
    c.type === 'image'
      ? { type: 'image' as const, data: c.data, mimeType: c.mimeType }
      : { type: 'text' as const, text: c.text },
  )
  const out: {
    content: typeof content
    structuredContent?: Record<string, unknown>
    isError?: boolean
  } = { content }
  if (result.structuredContent !== undefined) {
    out.structuredContent = result.structuredContent
  }
  if (result.isError) out.isError = true
  return out
}
