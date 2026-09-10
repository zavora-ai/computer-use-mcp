# Agent Examples

End-to-end AI agent examples using `computer-use-mcp` for desktop automation. Each example connects an LLM to the MCP server and runs an observe → act → verify loop.

```
agents/
├── claude-agent/        JavaScript agent using Anthropic Claude
├── openai-agent/        JavaScript agent using OpenAI Responses
└── langchain-agent/     JavaScript agent using LangChain + Claude
```

## Quick Start

These JavaScript agents use the in-process MCP server — no separate process needed.

### Claude Agent
```bash
export ANTHROPIC_API_KEY=your-key
npm install @anthropic-ai/sdk
node agents/claude-agent/agent.mjs "Open Calculator and compute 42 * 58"
```

### OpenAI Agent

Build the TypeScript library first with `npm run build:ts`.

```bash
export OPENAI_API_KEY=your-key
npm install openai
node agents/openai-agent/agent.mjs "Open Safari and search for Rust programming"
```

### LangChain Agent
```bash
export ANTHROPIC_API_KEY=your-key
npm install @langchain/anthropic @langchain/core langchain
node agents/langchain-agent/agent.mjs "Open Finder and list files on Desktop"
```

## How They Work

These agents follow the same pattern:

1. **Connect** — Start or connect to the computer-use-mcp MCP server
2. **Observe** — Take a screenshot to see the current desktop state
3. **Reason** — Send the screenshot + task to the LLM for planning
4. **Act** — Execute the LLM's tool calls (click, type, open app, etc.)
5. **Verify** — Take another screenshot to confirm the action worked
6. **Repeat** — Loop until the task is complete

## Comparison

| Agent | LLM | Language | Vision | Best For |
|---|---|---|---|---|
| Claude | Claude Sonnet | JavaScript | ✓ screenshots | Vision-heavy tasks, UI navigation |
| OpenAI | Configurable Responses model | JavaScript | ✓ image tool outputs | Lazy tool discovery, compact observations, local waits |
| LangChain | Claude (swappable) | JavaScript | ✓ via Claude | Framework integration, chains |

The OpenAI example uses Responses function outputs with real image inputs and preserves MCP input schemas. Set `OPENAI_MODEL` to choose a compatible model (default `gpt-6-astra`). It starts with three bootstrap tools, loads up to six schemas on demand, and reports actual API token usage. Image reuse is opt-in through `COMPUTER_USE_REUSE_IMAGES=true`. See [efficiency helpers and limits](../docs/EFFICIENCY.md).

## Custom Tasks

Pass any task as a command-line argument:

```bash
# Productivity
node agents/claude-agent/agent.mjs "Open Numbers, create a budget with rent, groceries, and utilities"
node agents/claude-agent/agent.mjs "Open Mail and send a test email to me@example.com"

# System admin
node agents/openai-agent/agent.mjs "Check disk space and list the top 5 largest files"
node agents/openai-agent/agent.mjs "Open Activity Monitor and find which app uses the most memory"

# Web browsing
node agents/claude-agent/agent.mjs "Open Safari, go to news.ycombinator.com, and summarize the top 3 stories"

# Cross-app workflow
node agents/langchain-agent/agent.mjs "Scrape the weather from weather.com, then create a Calendar event for tomorrow if it will rain"
```

## GPT-6 Astra showcases

See [the Responses showcase guide](openai-agent/README.md) for a native paint agent,
a reproducible paint studio, a coordinated Office report agent, and a read-only
desktop inspector. Each run records API usage, image feedback and artifact evidence.
