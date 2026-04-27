# Desktop Agent — ADK-Rust + Gemini

A desktop automation agent built with [ADK-Rust](https://adk-rust.com) and Google Gemini that uses `computer-use-mcp` for desktop control.

## What it does

The agent takes a screenshot, observes the desktop, then opens TextEdit and writes a system report including the date, display resolution, and running apps.

## Setup

```bash
# 1. Set your Gemini API key
export GOOGLE_API_KEY=your-key-here

# 2. Install computer-use-mcp globally
npm install -g @zavora-ai/computer-use-mcp

# 3. Run the agent
cd agents/adk-rust-gemini
cargo run
```

## How it works

1. **MCP Server** — `computer-use-mcp` starts as a child process via `McpServerManager`
2. **Gemini LLM** — Gemini 2.5 Flash reasons about the task and decides which tools to call
3. **Tool execution** — ADK-Rust dispatches tool calls to the MCP server (screenshot, click, type, etc.)
4. **Agent loop** — The agent observes → acts → verifies in a loop until the task is complete

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐
│  ADK-Rust   │────▶│  Gemini API  │     │  computer-use-mcp   │
│  Agent Loop │◀────│  (reasoning) │     │  (desktop control)  │
│             │────▶│              │     │                     │
│             │     └──────────────┘     │  Rust NAPI module   │
│  McpToolset │─────────────────────────▶│  ├── screenshot     │
│             │◀─────────────────────────│  ├── mouse/keyboard │
└─────────────┘     MCP (stdio)          │  ├── UI automation  │
                                         │  └── window mgmt    │
                                         └─────────────────────┘
```

## Customization

Change the task in `src/main.rs` to automate anything:

```rust
let task = "Open Safari, go to github.com, and take a screenshot";
let task = "Open Numbers, create a budget spreadsheet with sample data";
let task = "Check disk space and send the results via Mail to me@example.com";
```
