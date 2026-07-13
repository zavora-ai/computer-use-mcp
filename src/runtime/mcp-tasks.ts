import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestTaskStore } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { CallToolResult, Task } from '@modelcontextprotocol/sdk/types.js'
import type { RuntimeCoordinator } from './coordinator.js'

interface TaskBinding {
  taskId: string
  sessionId: string
  store: RequestTaskStore
  timer: NodeJS.Timeout
  syncing?: Promise<void>
}

/**
 * Experimental MCP Tasks projection over the authoritative v8 lifecycle.
 * The MCP task is a wire adapter only: v8 remains the source of session truth,
 * lease ownership, cancellation, receipts, and recovery behavior.
 */
export class McpSessionTaskAdapter {
  readonly #runtime: RuntimeCoordinator
  readonly #principalId: string
  readonly #bindings = new Map<string, TaskBinding>()
  readonly #pollMilliseconds: number
  readonly #unsubscribe: () => void

  constructor(options: {
    runtime: RuntimeCoordinator
    principalId: string
    pollMilliseconds?: number
  }) {
    this.#runtime = options.runtime
    this.#principalId = options.principalId
    this.#pollMilliseconds = options.pollMilliseconds ?? 25
    if (!Number.isInteger(this.#pollMilliseconds) || this.#pollMilliseconds < 10 || this.#pollMilliseconds > 1000) {
      throw new RangeError('task poll interval must be between 10 and 1000 milliseconds')
    }
    this.#unsubscribe = this.#runtime.events.subscribe(event => {
      const binding = [...this.#bindings.values()].find(value => value.sessionId === event.sessionId)
      if (binding) void this.#synchronize(binding)
    })
  }

  register(server: McpServer): void {
    server.experimental.tasks.registerToolTask(
      'run_session_task',
      {
        title: 'Run computer-use session task (experimental)',
        description: 'Create an experimental MCP Task projected over a principal-bound v8 session. Mutations still require preview, policy, evidence, and a lease through the normal v8 tools.',
        inputSchema: {
          objective: z.string().optional(),
          execution_group_id: z.string().optional(),
        },
        execution: { taskSupport: 'required' },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        _meta: {
          'computer-use/apiVersion': 8,
          'computer-use/experimental': true,
          'computer-use/lifecycleAuthority': 'v8-session',
        },
      },
      {
        createTask: async (args, extra) => {
          const task = await extra.taskStore.createTask({
            ttl: this.#boundedTtl(extra.taskRequestedTtl),
            pollInterval: 250,
            context: { adapter: 'computer-use-v8-session' },
          })
          try {
            const session = await this.#runtime.startSession({
              principalId: this.#principalId,
              executionGroupId: typeof args.execution_group_id === 'string'
                ? args.execution_group_id
                : `mcp-task:${task.taskId}`,
              ...(typeof args.objective === 'string' ? { objective: args.objective } : {}),
            })
            const timer = setInterval(() => {
              const binding = this.#bindings.get(task.taskId)
              if (binding) void this.#synchronize(binding)
            }, this.#pollMilliseconds)
            timer.unref()
            const binding: TaskBinding = {
              taskId: task.taskId,
              sessionId: session.sessionId,
              store: extra.taskStore,
              timer,
            }
            this.#bindings.set(task.taskId, binding)
            await this.#synchronize(binding)
          } catch (error) {
            await extra.taskStore.storeTaskResult(task.taskId, 'failed', this.#errorResult(error))
          }
          return { task: await extra.taskStore.getTask(task.taskId) }
        },
        getTask: async (_args, extra) => {
          const binding = this.#bindings.get(extra.taskId)
          if (binding) await this.#synchronize(binding)
          return extra.taskStore.getTask(extra.taskId)
        },
        getTaskResult: async (_args, extra) => {
          const binding = this.#bindings.get(extra.taskId)
          if (binding) await this.#synchronize(binding)
          const result = await extra.taskStore.getTaskResult(extra.taskId)
          if (!Array.isArray((result as { content?: unknown }).content)) {
            throw new Error('session task result is not an MCP tool result')
          }
          return result as CallToolResult
        },
      },
    )
  }

  dispose(): void {
    this.#unsubscribe()
    for (const binding of this.#bindings.values()) clearInterval(binding.timer)
    this.#bindings.clear()
  }

  #boundedTtl(requested: number | undefined): number {
    if (requested === undefined) return 60 * 60 * 1000
    return Math.min(Math.max(Math.trunc(requested), 60_000), 24 * 60 * 60 * 1000)
  }

  #synchronize(binding: TaskBinding): Promise<void> {
    if (binding.syncing) return binding.syncing
    const operation = this.#synchronizeOnce(binding)
    const tracked = operation.finally(() => {
      if (binding.syncing === tracked) binding.syncing = undefined
    })
    binding.syncing = tracked
    return tracked
  }

  async #synchronizeOnce(binding: TaskBinding): Promise<void> {
    try {
      let task: Task
      try { task = await binding.store.getTask(binding.taskId) }
      catch { this.#release(binding); return }

      if (task.status === 'cancelled') {
        try {
          const session = await this.#runtime.getSession(binding.sessionId, this.#principalId)
          if (!['completed', 'failed', 'stopped'].includes(session.state)) {
            await this.#runtime.stopSession(binding.sessionId, this.#principalId, 'mcp_task_cancelled')
          }
        } finally { this.#release(binding) }
        return
      }

      const session = await this.#runtime.getSession(binding.sessionId, this.#principalId)
      if (session.state === 'completed') {
        await binding.store.storeTaskResult(binding.taskId, 'completed', {
          content: [{ type: 'text', text: JSON.stringify({ session }) }],
          structuredContent: { session },
        })
        this.#release(binding)
      } else if (session.state === 'failed' || session.state === 'stopped') {
        await binding.store.storeTaskResult(binding.taskId, 'failed', {
          content: [{ type: 'text', text: JSON.stringify({
            error: 'session_terminal_without_completion',
            session_id: session.sessionId,
            state: session.state,
          }) }],
          isError: true,
        })
        this.#release(binding)
      } else if (['waiting_for_user', 'paused_by_user', 'paused_by_policy'].includes(session.state)) {
        if (task.status !== 'input_required') {
          await binding.store.updateTaskStatus(binding.taskId, 'input_required', 'Computer-use session is paused and requires host action')
        }
      } else if (task.status !== 'working') {
        await binding.store.updateTaskStatus(binding.taskId, 'working', 'Computer-use session is running')
      }
    } catch (error) {
      try { await binding.store.storeTaskResult(binding.taskId, 'failed', this.#errorResult(error)) }
      finally { this.#release(binding) }
    }
  }

  #release(binding: TaskBinding): void {
    clearInterval(binding.timer)
    this.#bindings.delete(binding.taskId)
  }

  #errorResult(error: unknown) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        error: 'session_task_failed',
        message: error instanceof Error ? error.message : String(error),
      }) }],
      isError: true,
    }
  }
}
