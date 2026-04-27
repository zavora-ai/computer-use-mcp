# Agent Examples

End-to-end AI agent examples using `computer-use-mcp` for desktop automation. Each example connects an LLM to the MCP server and runs an observe → act → verify loop.

```
agents/
├── adk-rust-gemini/     Rust agent using ADK-Rust + Gemini
├── claude-agent/        TypeScript agent using Anthropic Claude
├── openai-agent/        TypeScript agent using OpenAI GPT-4o
└── langchain-agent/     TypeScript agent using LangChain + Claude
```

## Quick Start

All TypeScript agents use the in-process MCP server — no separate process needed.

### Claude Agent (recommended for vision tasks)
```bash
export ANTHROPIC_API_KEY=your-key
npm install @anthropic-ai/sdk
node agents/claude-agent/agent.mjs "Open Calculator and compute 42 * 58"
```

### OpenAI Agent
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

### ADK-Rust + Gemini Agent
```bash
export GOOGLE_API_KEY=your-key
npm install -g @zavora-ai/computer-use-mcp
cd agents/adk-rust-gemini
cargo run
```

## How They Work

All four agents follow the same pattern:

1. **Connect** — Start or connect to the computer-use-mcp MCP server
2. **Observe** — Take a screenshot to see the current desktop state
3. **Reason** — Send the screenshot + task to the LLM for planning
4. **Act** — Execute the LLM's tool calls (click, type, open app, etc.)
5. **Verify** — Take another screenshot to confirm the action worked
6. **Repeat** — Loop until the task is complete

## Comparison

| Agent | LLM | Language | Vision | Best For |
|---|---|---|---|---|
| Claude | Claude Sonnet | TypeScript | ✓ screenshots | Vision-heavy tasks, UI navigation |
| OpenAI | GPT-4o | TypeScript | text only* | Text-based tasks, scripting |
| LangChain | Claude (swappable) | TypeScript | ✓ via Claude | Framework integration, chains |
| ADK-Rust | Gemini 2.5 Flash | Rust | ✓ screenshots | Performance, production agents |

*OpenAI function calling doesn't support image returns in tool results — screenshots are described as text.

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
