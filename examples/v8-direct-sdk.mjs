import { adaptProviderActions } from '@zavora-ai/computer-use-mcp/runtime'

function payload(result, field) {
  if (result?.isError) throw new Error(`computer-use call failed: ${JSON.stringify(result.structuredContent ?? result.content)}`)
  const value = result?.structuredContent?.[field]
  if (!value || typeof value !== 'object') throw new TypeError(`computer-use response is missing ${field}`)
  return value
}

function clientRequest(request) {
  return {
    sessionId: request.sessionId,
    ...(request.actionId ? { actionId: request.actionId } : {}),
    ...(request.attempt !== undefined ? { attempt: request.attempt } : {}),
    ...(request.executionGroupId ? { executionGroupId: request.executionGroupId } : {}),
    ...(request.agentId ? { agentId: request.agentId } : {}),
    tool: request.tool,
    arguments: request.args,
    mode: request.mode,
    ...(request.target ? { target: request.target } : {}),
    ...(request.dataLabels ? { dataLabels: request.dataLabels } : {}),
    ...(request.provenance ? { provenance: request.provenance } : {}),
    ...(request.expiresInMs !== undefined ? { expiresInMs: request.expiresInMs } : {}),
  }
}

const READ_ONLY_PROVIDER_TOOLS = new Set(['screenshot', 'wait', 'cursor_position'])

/**
 * Execute one provider function call through the complete v8 lifecycle.
 *
 * The caller supplies trusted host context separately from provider output.
 * `review` is invoked only after v8 policy asks for exact-action approval.
 */
export async function executeProviderCall({
  client,
  provider,
  providerAction,
  hostContext,
  objective = `Execute one ${provider} computer action`,
  review = async () => false,
}) {
  const stableActionId = hostContext.actionId
    ?? (typeof providerAction?.id === 'string' && providerAction.id ? providerAction.id : undefined)
  if (!stableActionId) throw new TypeError('hostContext.actionId or a stable provider call id is required')
  const started = await client.startSession({ objective, executionGroupId: hostContext.executionGroupId })
  const session = payload(started, 'session')
  const requests = adaptProviderActions(provider, providerAction, {
    ...hostContext,
    sessionId: session.sessionId,
    actionId: stableActionId,
  }).map(clientRequest)
  let lease
  try {
    const approvedRequests = []
    for (const request of requests) {
      const previewResult = await client.previewAction(request)
      const preview = previewResult.structuredContent
      if (!preview || typeof preview !== 'object') throw new TypeError('preview_action returned no structured result')
      let approvalGrantId
      if (preview.blocker === 'approval_required') {
        const approved = await review({ request, preview })
        if (!approved) throw new Error(`approval declined for ${request.actionId}`)
        const approvedResult = await client.approveAction(request.sessionId, request.actionId)
        approvalGrantId = payload(approvedResult, 'grant').grantId
      } else if (!preview.executable) {
        throw new Error(`v8 blocked ${request.actionId}: ${preview.blocker ?? 'unknown blocker'}`)
      }
      approvedRequests.push({ ...request, ...(approvalGrantId ? { approvalGrantId } : {}) })
    }

    const mutatingCount = approvedRequests.filter(request => !READ_ONLY_PROVIDER_TOOLS.has(request.tool)).length
    if (mutatingCount > 0) {
      lease = payload(await client.acquireControlLease({
        sessionId: session.sessionId,
        agentId: hostContext.agentId,
        kind: 'cooperative',
        mode: hostContext.mode === 'background' ? 'background' : 'foreground',
        ttlMs: 30_000,
        actionBudget: mutatingCount,
        ...(hostContext.target?.appId ? { appIds: [hostContext.target.appId] } : {}),
        ...(hostContext.target?.windowId !== undefined ? { windowIds: [hostContext.target.windowId] } : {}),
      }), 'lease')
    }

    const receipts = []
    for (const request of approvedRequests) {
      const outcome = await client.executeAction({
        ...request,
        ...(!READ_ONLY_PROVIDER_TOOLS.has(request.tool) ? { leaseId: lease.leaseId } : {}),
      })
      receipts.push(payload(outcome, 'receipt'))
    }
    await client.completeSession(session.sessionId, {
      summary: `Committed ${receipts.length} governed action(s)`,
      postconditions: receipts.map(receipt => ({
        description: `receipt ${receipt.receiptId} is committed`,
        satisfied: receipt.status === 'committed',
      })),
      actionCounts: { committed: receipts.filter(receipt => receipt.status === 'committed').length },
    })
    return { sessionId: session.sessionId, receipts }
  } catch (error) {
    await client.stopSession(session.sessionId, error instanceof Error ? error.message : 'provider execution failed').catch(() => {})
    throw error
  } finally {
    if (lease?.leaseId) await client.releaseControlLease(lease.leaseId).catch(() => {})
  }
}
