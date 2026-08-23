import { ok, okJson, type ToolResult } from '../result.js'
import type { VirtualPointerController } from './virtual-pointer.js'

/** Session-local diagnostics, policy introspection, and virtual-pointer commands. */
export async function handleCoreTool(
  tool: string,
  args: Record<string, unknown>,
  context: {
    runDoctor(includeRemediation: boolean): Promise<Record<string, unknown>>
    policyStatus(): Record<string, unknown>
    pointer: VirtualPointerController
  },
): Promise<ToolResult | undefined> {
  if (tool === 'doctor') {
    return okJson(await context.runDoctor(args.include_remediation !== false))
  }
  if (tool === 'policy_status') return okJson(context.policyStatus())
  if (tool !== 'agent_pointer') return undefined
  if (typeof args.action !== 'string') throw new Error('Invalid action: expected string')
  const action = args.action
  const nativeOverlayRequested = typeof args.native_overlay === 'boolean'
    ? args.native_overlay
    : action !== 'get'
  if (action === 'move') {
    const coordinate = args.coordinate
    if (!Array.isArray(coordinate) || coordinate.length < 2
      || typeof coordinate[0] !== 'number' || typeof coordinate[1] !== 'number') {
      throw new Error('Invalid coordinate: expected [number, number]')
    }
    context.pointer.move(
      coordinate[0], coordinate[1], typeof args.visible === 'boolean' ? args.visible : true,
    )
  } else if (action === 'show') context.pointer.show()
  else if (action === 'hide') context.pointer.hide()
  else if (action === 'reset') context.pointer.reset(typeof args.visible === 'boolean' ? args.visible : false)
  else if (action !== 'get') {
    return { content: [{ type: 'text', text: `Unknown agent_pointer action: ${action}` }], isError: true }
  }
  return ok(JSON.stringify({
    ...context.pointer.current(),
    nativeOverlay: context.pointer.syncOverlay(nativeOverlayRequested),
    note: 'Virtual pointer only; the OS cursor and app focus were not changed.',
  }))
}
