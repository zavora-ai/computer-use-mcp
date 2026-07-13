import { adaptProviderActions } from '@zavora-ai/computer-use-mcp/runtime'

function value(result, field) {
  if (result?.isError) throw new Error(`computer-use call failed: ${JSON.stringify(result.structuredContent ?? result.content)}`)
  const found = result?.structuredContent?.[field]
  if (!found || typeof found !== 'object') throw new TypeError(`computer-use response is missing ${field}`)
  return found
}

function asClientRequest(request) {
  const { args: arguments_, principalId: _principalId, leaseId: _leaseId, approvalGrantId: _approvalGrantId, ...rest } = request
  return { ...rest, arguments: arguments_ }
}

const READ_ONLY_PROVIDER_TOOLS = new Set(['screenshot', 'wait', 'cursor_position'])

/** A separate bootstrap node ensures the v8 session id is checkpointed before an interrupt. */
export function createComputerUseSessionNode({ client, objective }) {
  return async state => {
    if (state.computerUse?.sessionId) return {}
    const session = value(await client.startSession({
      objective: objective ?? state.objective,
      executionGroupId: state.executionGroupId,
    }), 'session')
    return { computerUse: { ...state.computerUse, sessionId: session.sessionId, receipts: [] } }
  }
}

/**
 * Framework-neutral node compatible with LangGraph's node contract.
 *
 * Pass LangGraph's `interrupt` function. The checkpointed call id becomes the
 * v8 action id, so a crash after mutation but before graph checkpointing
 * replays the receipt instead of repeating the side effect.
 */
export function createComputerUseExecutorNode({ client, provider, hostContext, interrupt }) {
  return async state => {
    const sessionId = state.computerUse?.sessionId
    const call = state.computerUse?.pendingCall
    if (!sessionId) throw new Error('run the computer-use session bootstrap node first')
    if (!call?.id || !call?.action) throw new Error('state.computerUse.pendingCall requires stable id and action')

    const requests = adaptProviderActions(provider, call.action, {
      ...hostContext,
      sessionId,
      actionId: call.id,
      executionGroupId: state.executionGroupId,
    }).map(asClientRequest)
    const executable = []
    for (const request of requests) {
      const preview = (await client.previewAction(request)).structuredContent
      if (!preview || typeof preview !== 'object') throw new TypeError('preview_action returned no structured result')
      let approvalGrantId
      if (preview.blocker === 'approval_required') {
        const approved = await interrupt({
          kind: 'computer_use_approval',
          sessionId,
          actionId: request.actionId,
          envelope: preview.envelope,
          policy: preview.policy,
        })
        if (approved !== true && approved?.approved !== true) throw new Error(`approval declined for ${request.actionId}`)
        approvalGrantId = value(await client.approveAction(sessionId, request.actionId), 'grant').grantId
      } else if (!preview.executable) {
        throw new Error(`v8 blocked ${request.actionId}: ${preview.blocker ?? 'unknown blocker'}`)
      }
      executable.push({ ...request, ...(approvalGrantId ? { approvalGrantId } : {}) })
    }

    const mutatingCount = executable.filter(request => !READ_ONLY_PROVIDER_TOOLS.has(request.tool)).length
    const lease = mutatingCount > 0 ? value(await client.acquireControlLease({
      sessionId,
      agentId: hostContext.agentId,
      kind: 'cooperative',
      mode: hostContext.mode === 'background' ? 'background' : 'foreground',
      ttlMs: 30_000,
      actionBudget: mutatingCount,
      ...(hostContext.target?.appId ? { appIds: [hostContext.target.appId] } : {}),
      ...(hostContext.target?.windowId !== undefined ? { windowIds: [hostContext.target.windowId] } : {}),
    }), 'lease') : undefined
    try {
      const receipts = []
      for (const request of executable) {
        receipts.push(value(await client.executeAction({
          ...request,
          ...(!READ_ONLY_PROVIDER_TOOLS.has(request.tool) ? { leaseId: lease.leaseId } : {}),
        }), 'receipt'))
      }
      return {
        computerUse: {
          ...state.computerUse,
          pendingCall: null,
          receipts: [...(state.computerUse.receipts ?? []), ...receipts],
        },
      }
    } finally {
      if (lease?.leaseId) await client.releaseControlLease(lease.leaseId).catch(() => {})
    }
  }
}
