/**
 * Desktop Agent — LangChain + Anthropic + computer-use-mcp
 *
 * A practical agent using LangChain's tool-calling agent with
 * computer-use-mcp for desktop automation.
 *
 * Setup:
 *   export ANTHROPIC_API_KEY=your-key
 *   npm install @langchain/anthropic @langchain/core langchain
 *   node agents/langchain-agent/agent.mjs "Open Finder and list files on Desktop"
 */
import { ChatAnthropic } from '@langchain/anthropic'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'

const MAX_ITERATIONS = 15

async function main() {
  const task = process.argv[2] || 'Take a screenshot and tell me what apps are open'

  console.log('=== Desktop Agent (LangChain + Claude + computer-use-mcp) ===\n')
  console.log(`Task: ${task}\n`)

  // 1. Start MCP server in-process
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  const allTools = await client.listTools()
  console.log(`✓ ${allTools.length} MCP tools available\n`)

  // 2. Wrap MCP tools as LangChain DynamicStructuredTools
  const tools = allTools.map(t =>
    new DynamicStructuredTool({
      name: t.name,
      description: (t.description || '').slice(0, 1024),
      schema: z.object({}).passthrough(),
      func: async (args) => {
        const result = await client.callTool(t.name, args)
        return result.content
          .map(c => c.type === 'text' ? c.text : `[${c.type}: ${c.mimeType || ''}]`)
          .join('\n')
      },
    })
  )

  // 3. Create the model with tools bound
  const model = new ChatAnthropic({
    model: 'claude-sonnet-4-20250514',
    maxTokens: 4096,
  }).bindTools(tools)

  // 4. Manual agent loop (simpler than AgentExecutor for this use case)
  const messages = [
    new SystemMessage(
      `You are a desktop automation agent with access to computer-use-mcp tools.

Your approach:
1. Take a screenshot first to see the current state
2. Use get_tool_guide to find the best approach
3. Prefer scripting (run_script) for scriptable apps
4. Use accessibility (click_element) over coordinates
5. Verify results with screenshots

You are on macOS. Use bundle IDs (e.g., com.apple.Safari).
Be concise and efficient.`
    ),
    new HumanMessage(task),
  ]

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`── Iteration ${i + 1} ──`)

    const response = await model.invoke(messages)
    messages.push(response)

    // Print any text content
    if (typeof response.content === 'string' && response.content) {
      console.log(`  Agent: ${response.content}`)
    } else if (Array.isArray(response.content)) {
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          console.log(`  Agent: ${block.text}`)
        }
      }
    }

    // Check for tool calls
    const toolCalls = response.tool_calls || []
    if (toolCalls.length === 0) {
      console.log('\n✓ Task complete')
      break
    }

    // Execute tool calls
    for (const call of toolCalls) {
      console.log(`  → ${call.name}(${JSON.stringify(call.args).slice(0, 80)}...)`)
      const tool = tools.find(t => t.name === call.name)
      if (!tool) {
        console.log(`    Tool not found: ${call.name}`)
        continue
      }

      try {
        const result = await tool.invoke(call.args)
        console.log(`    ${result.slice(0, 100)}`)
        // Add tool result as a ToolMessage
        const { ToolMessage } = await import('@langchain/core/messages')
        messages.push(new ToolMessage({
          content: result,
          tool_call_id: call.id,
        }))
      } catch (err) {
        console.log(`    ERROR: ${err.message}`)
        const { ToolMessage } = await import('@langchain/core/messages')
        messages.push(new ToolMessage({
          content: `Error: ${err.message}`,
          tool_call_id: call.id,
        }))
      }
    }
  }

  await client.close()
  console.log('\n✓ Done')
}

main().catch(e => { console.error(e); process.exit(1) })
