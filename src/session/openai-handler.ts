import type { ToolResult } from '../result.js'
import type { SessionRequestContext } from '../session.js'
import { mapLegacyOpenAiAction } from './openai-compat.js'

export type CompatibilityDispatch = (
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onProgress?: (update: { progress: number; total?: number; message?: string }) => void,
  requestContext?: SessionRequestContext,
) => Promise<ToolResult>

/** Executes the legacy OpenAI computer-action envelope through canonical tools. */
export class OpenAiCompatibilityHandler {
  readonly #dispatch: CompatibilityDispatch

  constructor(dispatch: CompatibilityDispatch) { this.#dispatch = dispatch }

  async handle(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (update: { progress: number; total?: number; message?: string }) => void,
    requestContext?: SessionRequestContext,
  ): Promise<ToolResult | undefined> {
    if (tool !== 'openai_computer') return undefined
    const actions = Array.isArray(args.actions)
      ? args.actions
      : args.action && typeof args.action === 'object'
        ? [args.action]
        : [{ ...args }]
    const common = {
      ...(typeof args.target_app === 'string' ? { target_app: args.target_app } : {}),
      ...(typeof args.target_window_id === 'number' ? { target_window_id: args.target_window_id } : {}),
      ...(typeof args.focus_strategy === 'string' ? { focus_strategy: args.focus_strategy } : {}),
      ...(typeof args.approval_token === 'string' ? { approval_token: args.approval_token } : {}),
    }
    const summaries: Array<Record<string, unknown>> = []
    const content: ToolResult['content'] = []
    for (let index = 0; index < actions.length; index++) {
      if (signal?.aborted) throw new Error('openai_computer batch aborted before the next action')
      const action = actions[index]
      if (!action || typeof action !== 'object' || Array.isArray(action)) {
        summaries.push({ index, ok: false, error: 'invalid_action' })
        continue
      }
      const value = action as Record<string, unknown>
      let actionType = String(value.type ?? value.action ?? '').toLowerCase()
      try {
        const mapped = mapLegacyOpenAiAction(value, {
          common,
          ...(typeof args.width === 'number' ? { width: args.width } : {}),
          ...(typeof args.quality === 'number' ? { quality: args.quality } : {}),
          ...(typeof args.provider === 'string' ? { provider: args.provider } : {}),
          useVirtualPointer: args.use_virtual_pointer === true,
          ...(typeof args.native_overlay === 'boolean' ? { nativeOverlay: args.native_overlay } : {}),
        })
        actionType = mapped.actionType
        const result = await this.#dispatch(mapped.tool, mapped.args, signal, onProgress, requestContext)
        summaries.push({ index, action: actionType, tool: mapped.tool, ok: !result.isError })
        content.push(...result.content)
        if (result.isError) {
          return {
            content: [
              { type: 'text', text: JSON.stringify({ ok: false, failed_index: index, summaries }) },
              ...result.content,
            ],
            isError: true,
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        summaries.push({ index, action: actionType, ok: false, error: message })
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, failed_index: index, summaries }) }],
          isError: true,
        }
      }
    }
    if (args.return_screenshot === true) {
      const result = await this.#dispatch('screenshot', {
        ...(typeof args.width === 'number' ? { width: args.width } : {}),
        ...(typeof args.quality === 'number' ? { quality: args.quality } : {}),
        ...(typeof args.provider === 'string' ? { provider: args.provider } : {}),
        show_agent_pointer: args.use_virtual_pointer === true,
      }, signal, onProgress, requestContext)
      content.push(...result.content)
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, count: summaries.length, summaries }) },
        ...content,
      ],
    }
  }
}
