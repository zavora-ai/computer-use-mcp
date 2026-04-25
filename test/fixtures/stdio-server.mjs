import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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
