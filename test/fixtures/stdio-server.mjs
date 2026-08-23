import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createComputerUseServer } from '../../dist/server.js'

const server = createComputerUseServer({
  session: {
    async dispatch() {
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  },
})

const transport = new StdioServerTransport()
await server.connect(transport)
