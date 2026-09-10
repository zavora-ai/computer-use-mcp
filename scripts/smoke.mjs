/** Explicit live desktop check. No input injection or document mutation. */
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'

const client = await connectInProcess(createComputerUseServer())
try {
  const tools = await client.listTools()
  if (!tools.some(tool => tool.name === 'discover_applications')) throw Error('Discovery tool missing')
  console.log(`${tools.length} tools available`)
  for (const name of ['get_display_size', 'list_windows', 'discover_applications']) {
    const result = await client.callTool(name, name === 'discover_applications' ? {limit: 5} : {})
    if (result.isError) throw Error(`${name}: ${result.content.find(c => c.type === 'text')?.text}`)
    console.log(`${name}: passed`)
  }
} finally {
  await client.close()
}
