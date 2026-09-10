/** Runs inside a host-selected OS sandbox. node:vm is only a persistent language context. */
import { createInterface } from 'node:readline'
import { createContext, Script } from 'node:vm'
let next = 0
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
const context = createContext({ state: {},
  computer: Object.freeze({ call: (name: string, args: unknown = {}) => new Promise((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject }); send({ type: 'call', id, name, args })
  }) }),
  emit: (value: unknown) => send({ type: 'output', value }),
})
let running = false
createInterface({ input: process.stdin }).on('line', async line => {
  try {
    const message = JSON.parse(line)
    if (message.type === 'result') {
      const operation = pending.get(message.id)
      if (operation) { pending.delete(message.id); message.error ? operation.reject(new Error(message.error)) : operation.resolve(message.value) }
    } else if (message.type === 'run') {
      if (running) throw new Error('Runtime is busy')
      running = true
      try {
        const script = new Script(`(async () => { ${message.code}\n })()`, { filename: 'agent-runtime.js' })
        await script.runInContext(context, { timeout: 1000 })
        if (pending.size) throw new Error('Unawaited broker calls; runtime must await all operations')
        send({ type: 'done' })
      } catch (error) { send({ type: 'failed', error: String(error) }) }
      finally { running = false }
    }
  } catch (error) { send({ type: 'failed', error: String(error) }) }
})
