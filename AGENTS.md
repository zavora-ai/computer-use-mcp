# Using computer-use-mcp with AI Agents

This guide covers how to integrate `computer-use-mcp` into AI agent frameworks and agentic workflows.

## Quick setup for any agent

The server speaks standard MCP over stdio. Start it with:

```bash
npx @zavora-ai/computer-use-mcp
```

Any agent framework with MCP support can connect to it immediately.

## Claude (Anthropic)

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"]
    }
  }
}
```

Restart Claude Desktop. Claude will automatically use the tools when asked to interact with your Mac.

**Example prompts:**
- *"Take a screenshot and tell me what's on my screen"*
- *"Open Safari, go to github.com, and find the trending repositories"*
- *"Open TextEdit, write a short poem, and save it to the desktop"*

### Claude API (programmatic)

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { createComputerUseServer } from '@zavora-ai/computer-use-mcp'
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client'

// Start the MCP server in-process
const server = createComputerUseServer()
const mcpClient = await connectInProcess(server)

// List available tools to pass to Claude
const tools = await mcpClient.listTools()

const anthropic = new Anthropic()

// Agent loop
async function runAgent(task: string) {
  const messages: any[] = [{ role: 'user', content: task }]

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: { type: 'object', properties: {} }
      })),
      messages,
    })

    if (response.stop_reason === 'end_turn') break

    // Execute tool calls
    const toolResults = []
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const result = await mcpClient.callTool(block.name, block.input as any)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content,
        })
      }
    }

    messages.push({ role: 'assistant', content: response.content })
    if (toolResults.length) {
      messages.push({ role: 'user', content: toolResults })
    }
  }

  await mcpClient.close()
}

await runAgent('Open Calculator and compute 123 * 456')
```

## OpenAI Agents SDK

```typescript
import OpenAI from 'openai'
import { createComputerUseServer } from '@zavora-ai/computer-use-mcp'
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client'

const server = createComputerUseServer()
const mcpClient = await connectInProcess(server)
const openai = new OpenAI()

// Wrap MCP tools as OpenAI function tools
const tools = (await mcpClient.listTools()).map(t => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description ?? '',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
  },
}))

async function runAgent(task: string) {
  const messages: any[] = [{ role: 'user', content: task }]

  while (true) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools,
      tool_choice: 'auto',
    })

    const msg = response.choices[0].message
    messages.push(msg)

    if (!msg.tool_calls?.length) break

    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments)
      const result = await mcpClient.callTool(call.function.name, args)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result.content),
      })
    }
  }

  await mcpClient.close()
}

await runAgent('Take a screenshot and describe what you see')
```

## LangChain / LangGraph

```typescript
import { ChatAnthropic } from '@langchain/anthropic'
import { createComputerUseServer } from '@zavora-ai/computer-use-mcp'
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client'

const server = createComputerUseServer()
const mcpClient = await connectInProcess(server)

// Wrap as LangChain tools
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'

const tools = (await mcpClient.listTools()).map(t =>
  new DynamicStructuredTool({
    name: t.name,
    description: t.description ?? '',
    schema: z.object({}).passthrough(),
    func: async (args) => {
      const result = await mcpClient.callTool(t.name, args)
      return result.content.map(c => c.type === 'text' ? c.text : '[image]').join('\n')
    },
  })
)

const model = new ChatAnthropic({ model: 'claude-opus-4-5' }).bindTools(tools)
// Use with LangGraph agent executor as normal
```

## Best practices for agents

### Always specify `target_app`
Agents should explicitly target the app they want to control to avoid sending keystrokes to the wrong window:

```typescript
await client.type('Hello', 'com.apple.TextEdit')
await client.key('command+s', 'com.apple.TextEdit')
```

### Screenshot before acting
Take a screenshot first to understand the current state before clicking or typing:

```typescript
const shot = await client.screenshot()
// Pass shot to the model to understand what's on screen
// Then decide where to click
```

### Use clipboard for long text
For typing long content, use clipboard paste instead of `type` — it's faster and more reliable:

```typescript
await client.writeClipboard(longText)
await client.key('command+v', targetApp)
```

### Handle `activated: false`
When opening an app, check if it actually launched:

```typescript
const result = await client.openApp('com.apple.Safari')
const text = result.content.find(c => c.type === 'text')?.text ?? ''
if (text.includes('activated: false')) {
  await client.wait(2)  // give it more time
}
```

### Coordinate system
Coordinates are in logical pixels (not physical pixels on Retina displays). Use `get_display_size` to get the screen dimensions before calculating click positions:

```typescript
const size = await client.getDisplaySize()
// size contains width, height, pixelWidth, pixelHeight, scaleFactor
```
