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
    let mappedActions
    try {
      if (actions.length > 100) throw new Error('Batch exceeds 100 actions')
      mappedActions = actions.map(action => {
        if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('invalid_action')
        return mapLegacyOpenAiAction(action as Record<string, unknown>, {
          common,
          ...(typeof args.width === 'number' ? { width: args.width } : {}),
          ...(typeof args.quality === 'number' ? { quality: args.quality } : {}),
          ...(typeof args.provider === 'string' ? { provider: args.provider } : {}),
          useVirtualPointer: args.use_virtual_pointer === true,
        })
      })
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, status: 'blocked', completed: 0, error: String(error) }) }] }
    }
    for (let index = 0; index < mappedActions.length; index++) {
      const mapped = mappedActions[index]
      let actionType = mapped.actionType
      try {
        signal?.throwIfAborted()
        actionType = mapped.actionType
        const result = await this.#dispatch(mapped.tool, mapped.args, signal, onProgress, requestContext)
        summaries.push({ index, action: actionType, tool: mapped.tool, ok: !result.isError })
        content.push(...result.content)
        if (result.isError) {
          return {
            content: [
              { type: 'text', text: JSON.stringify({ ok: false, status: 'unknown_outcome', completed: index, failed_index: index, summaries }) },
              ...result.content,
            ],
            isError: true,
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        summaries.push({ index, action: actionType, ok: false, error: message })
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, status: 'unknown_outcome', completed: index, failed_index: index, summaries }) }],
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
      if (result.isError) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, status: 'executed', verificationError: true, summaries }) }, ...content] }
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, status: 'executed', count: summaries.length, summaries }) },
        ...content,
      ],
    }
  }
}
