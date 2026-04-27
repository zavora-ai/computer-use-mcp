/**
 * Desktop Agent — OpenAI GPT-4o + computer-use-mcp
 *
 * A practical agent that uses GPT-4o as the LLM and computer-use-mcp
 * for desktop automation. Runs an observe → act → verify loop.
 *
 * Setup:
 *   export OPENAI_API_KEY=your-key
 *   npm install openai
 *   node agents/openai-agent/agent.mjs "Open Safari and search for Rust programming"
 */
import OpenAI from 'openai'
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'

const MAX_TURNS = 20

async function main() {
  const task = process.argv[2] || 'Take a screenshot and describe what apps are running'

  console.log('=== Desktop Agent (GPT-4o + computer-use-mcp) ===\n')
  console.log(`Task: ${task}\n`)

  // 1. Start MCP server in-process
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  const allTools = await client.listTools()
  console.log(`✓ ${allTools.length} tools available\n`)

  // 2. Map MCP tools to OpenAI function calling format
  const tools = allTools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: (t.description || '').slice(0, 1024),
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
  }))

  // 3. Initialize OpenAI
  const openai = new OpenAI()
  const messages = [
    {
      role: 'system',
      content: `You are a desktop automation agent with access to computer-use-mcp tools.

Your approach:
1. Take a screenshot first to see the current state
2. Plan your actions based on what you see
3. Execute one action at a time
4. Take a screenshot after important actions to verify
5. Prefer accessibility tools (click_element, set_value) over coordinate clicks
6. Use run_script with AppleScript for scriptable apps

You are running on macOS. Use bundle IDs for apps (e.g., com.apple.Safari).
Be concise. Focus on completing the task efficiently.

IMPORTANT: When calling tools, pass arguments as a flat JSON object matching
the tool's parameter names. For example:
- screenshot: {}
- left_click: {"coordinate": [x, y]}
- type: {"text": "hello"}
- key: {"text": "command+s"}
- open_application: {"bundle_id": "com.apple.Safari"}`
    },
    { role: 'user', content: task },
  ]

  // 4. Agent loop
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.log(`── Turn ${turn + 1} ──`)

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools,
      tool_choice: 'auto',
    })

    const msg = response.choices[0].message
    messages.push(msg)

    if (msg.content) {
      console.log(`  GPT-4o: ${msg.content}`)
    }

    // If no tool calls, we're done
    if (!msg.tool_calls?.length) {
      console.log('\n✓ Task complete')
      break
    }

    // Execute tool calls
    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments)
      console.log(`  → ${call.function.name}(${JSON.stringify(args).slice(0, 80)}...)`)

      try {
        const result = await client.callTool(call.function.name, args)
        const hasImage = result.content.some(c => c.type === 'image')
        const textContent = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
        console.log(`    ${hasImage ? '[screenshot] ' : ''}${textContent.slice(0, 100)}`)

        // OpenAI doesn't support images in tool results — send text description
        const responseText = hasImage
          ? `[Screenshot captured: ${textContent}]`
          : textContent

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: responseText,
        })
      } catch (err) {
        console.log(`    ERROR: ${err.message}`)
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Error: ${err.message}`,
        })
      }
    }
  }

  await client.close()
  console.log('\n✓ Done')
}

main().catch(e => { console.error(e); process.exit(1) })
