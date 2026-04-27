/**
 * Desktop Agent — Anthropic Claude + computer-use-mcp
 *
 * A practical agent that uses Claude as the LLM and computer-use-mcp
 * for desktop automation. Runs an observe → act → verify loop.
 *
 * Setup:
 *   export ANTHROPIC_API_KEY=your-key
 *   npm install @anthropic-ai/sdk
 *   node agents/claude-agent/agent.mjs "Open Calculator and compute 42 * 58"
 */
import Anthropic from '@anthropic-ai/sdk'
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'

const MAX_TURNS = 20

async function main() {
  const task = process.argv[2] || 'Take a screenshot and describe what you see on screen'

  console.log('=== Desktop Agent (Claude + computer-use-mcp) ===\n')
  console.log(`Task: ${task}\n`)

  // 1. Start MCP server in-process
  const server = createComputerUseServer()
  const client = await connectInProcess(server)
  const allTools = await client.listTools()
  console.log(`✓ ${allTools.length} tools available\n`)

  // 2. Map MCP tools to Claude's tool format
  const tools = allTools.map(t => ({
    name: t.name,
    description: t.description || '',
    input_schema: { type: 'object', properties: {}, additionalProperties: true },
  }))

  // 3. Initialize Claude
  const anthropic = new Anthropic()
  const messages = [{ role: 'user', content: task }]

  const systemPrompt = `You are a desktop automation agent with access to computer-use-mcp tools.

Your approach:
1. Take a screenshot first to see the current state
2. Plan your actions based on what you see
3. Execute one action at a time
4. Take a screenshot after important actions to verify
5. Prefer accessibility tools (click_element, set_value) over coordinate clicks
6. Use run_script with AppleScript for scriptable apps (Mail, Safari, Finder, Numbers)

You are running on macOS. Use bundle IDs for apps (e.g., com.apple.Safari).
Be concise in your responses. Focus on completing the task efficiently.`

  // 4. Agent loop
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.log(`── Turn ${turn + 1} ──`)

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    })

    // Collect text and tool use blocks
    const textBlocks = response.content.filter(b => b.type === 'text')
    const toolBlocks = response.content.filter(b => b.type === 'tool_use')

    for (const t of textBlocks) {
      console.log(`  Claude: ${t.text}`)
    }

    // If no tool calls, we're done
    if (response.stop_reason === 'end_turn' || toolBlocks.length === 0) {
      console.log('\n✓ Task complete')
      break
    }

    // Execute tool calls
    const toolResults = []
    for (const block of toolBlocks) {
      console.log(`  → ${block.name}(${JSON.stringify(block.input).slice(0, 80)}...)`)
      try {
        const result = await client.callTool(block.name, block.input)
        const hasImage = result.content.some(c => c.type === 'image')
        const textContent = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
        console.log(`    ${hasImage ? '[screenshot] ' : ''}${textContent.slice(0, 100)}`)

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content.map(c =>
            c.type === 'image'
              ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } }
              : { type: 'text', text: c.text }
          ),
        })
      } catch (err) {
        console.log(`    ERROR: ${err.message}`)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          is_error: true,
        })
      }
    }

    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })
  }

  await client.close()
  console.log('\n✓ Done')
}

main().catch(e => { console.error(e); process.exit(1) })
