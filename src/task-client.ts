import { setTimeout as delay } from 'node:timers/promises'
export type TaskRequest = (method: 'tasks/get' | 'tasks/update' | 'tasks/cancel', params: Record<string, unknown>) => Promise<Record<string, any>>
/** Poll without model turns. A pending decision returns to the host; it is never auto-approved. */
export async function waitForTask(request: TaskRequest, taskId: string, options: {
  signal?: AbortSignal; timeoutMs?: number; onChange?: (task: Record<string, any>) => void;
} = {}): Promise<Record<string, any>> {
  const timeout = options.timeoutMs ?? 120000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600000) throw new Error('Invalid task wait deadline')
  const end = Date.now() + timeout
  let previous = ''
  try {
    while (true) {
      options.signal?.throwIfAborted()
      const task = await request('tasks/get', { taskId })
      const state = JSON.stringify([task.status, task.lastUpdatedAt])
      if (state !== previous) { options.onChange?.(task); previous = state }
      if (['completed', 'failed', 'cancelled', 'input_required'].includes(task.status)) return task
      if (task.status !== 'working') throw new Error('Unknown task state')
      if (Date.now() >= end) throw new Error('Task wait deadline exceeded')
      const interval = typeof task.pollIntervalMs === 'number' && Number.isFinite(task.pollIntervalMs) ? task.pollIntervalMs : 1000
      await delay(Math.min(end-Date.now(), Math.max(25, Math.min(interval, 30000))), undefined, { signal: options.signal })
    }
  } catch (error) {
    await request('tasks/cancel', { taskId }).catch(() => {})
    throw error
  }
}
