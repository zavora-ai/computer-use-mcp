/**
 * Tool result helpers — dual-write text JSON + structuredContent (K5 / K21).
 */

export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | {
        type: 'resource_link'
        uri: string
        name: string
        title?: string
        description?: string
        mimeType?: string
      }
  >
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

/**
 * A tool that exists in the catalog but has no implementation on this platform.
 * Structured rather than prose so an agent can branch on `error` and follow
 * `remediation` to the platform-appropriate tool instead of retrying.
 */
export function platformUnsupported(
  tool: string,
  supportedOn: string,
  alternative: string,
): ToolResult {
  return errJson({
    error: 'platform_unsupported',
    tool,
    platform: process.platform,
    supported_on: supportedOn,
    remediation: [alternative],
  })
}

/**
 * Map an internal ToolResult to the MCP wire shape.
 *
 * When `includeStructuredContent` is false (the `COMPUTER_USE_STRUCTURED_CONTENT=false`
 * opt-out), the `structuredContent` field is stripped so results are legacy text-only.
 * The caller is responsible for also suppressing `outputSchema` advertisement, since a
 * registered outputSchema without structuredContent would fail SDK output validation.
 */
export function toMcpToolResult(
  result: ToolResult,
  includeStructuredContent = true,
): {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
    | {
        type: 'resource_link'
        uri: string
        name: string
        title?: string
        description?: string
        mimeType?: string
      }
  >
  structuredContent?: Record<string, unknown>
  isError?: boolean
} {
  const content = result.content.map(c => {
    if (c.type === 'image') return { type: 'image' as const, data: c.data, mimeType: c.mimeType }
    if (c.type === 'resource_link') return { ...c, type: 'resource_link' as const }
    return { type: 'text' as const, text: c.text }
  })
  const out: {
    content: typeof content
    structuredContent?: Record<string, unknown>
    isError?: boolean
  } = { content }
  if (includeStructuredContent && result.structuredContent !== undefined) {
    out.structuredContent = result.structuredContent
  }
  if (result.isError) out.isError = true
  return out
}
