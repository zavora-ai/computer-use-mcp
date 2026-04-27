//! Desktop Automation Agent — ADK-Rust + Gemini + computer-use-mcp
//!
//! A practical AI agent that uses Gemini as the LLM and computer-use-mcp
//! as the MCP tool server for desktop automation. The agent can take
//! screenshots, click, type, manage windows, and automate any desktop app.
//!
//! ## Setup
//! 1. Set GOOGLE_API_KEY or GEMINI_API_KEY environment variable
//! 2. Install computer-use-mcp: `npm install -g @zavora-ai/computer-use-mcp`
//! 3. Run: `cargo run`
//!
//! ## What it does
//! The agent takes a screenshot, describes what it sees, then performs a
//! practical task: opens a text editor, writes a summary, and saves it.

use adk_rust::prelude::*;
use adk_tool::mcp::manager::{McpServerConfig, McpServerManager};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing for debug output
    tracing_subscriber::fmt()
        .with_env_filter("info,adk=debug")
        .init();

    println!("=== Desktop Automation Agent (ADK-Rust + Gemini) ===\n");

    // ── 1. Configure the MCP server for desktop control ──────────────────
    let manager = McpServerManager::from_json(r#"{
        "mcpServers": {
            "desktop": {
                "command": "npx",
                "args": ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"],
                "autoApprove": [
                    "screenshot", "zoom", "left_click", "type", "key",
                    "get_frontmost_app", "list_windows", "list_running_apps",
                    "get_display_size", "cursor_position", "read_clipboard",
                    "write_clipboard", "open_application", "get_ui_tree",
                    "find_element", "click_element", "snapshot", "wait"
                ]
            }
        }
    }"#)?
    .with_health_check_interval(Duration::from_secs(60))
    .with_grace_period(Duration::from_secs(3));

    println!("Starting computer-use-mcp server...");
    let results = manager.start_all().await;
    for (name, result) in &results {
        match result {
            Ok(_) => println!("  ✓ {name} started"),
            Err(e) => println!("  ✗ {name} failed: {e}"),
        }
    }

    // ── 2. Configure the Gemini model ────────────────────────────────────
    let model = GeminiModel::new("gemini-2.5-flash")?;

    // ── 3. Build the agent ───────────────────────────────────────────────
    let agent = LlmAgentBuilder::new("desktop-agent")
        .model(Arc::new(model))
        .instruction(
            "You are a desktop automation agent. You can control the computer \
             using the tools provided by the computer-use-mcp server. \
             \n\nYour approach:\n\
             1. Always take a screenshot first to understand the current state\n\
             2. Use get_tool_guide to find the best approach for a task\n\
             3. Prefer scripting (run_script) for scriptable apps\n\
             4. Use accessibility (click_element, set_value) over coordinates\n\
             5. Fall back to coordinates (left_click, type) only when needed\n\
             6. Take a screenshot after each action to verify the result\n\
             \nYou are running on macOS. Use bundle IDs for app targeting \
             (e.g., com.apple.Safari, com.apple.TextEdit)."
        )
        .toolset(Arc::new(manager))
        .build()?;

    // ── 4. Create a runner and execute the task ──────────────────────────
    let runner = Runner::new(agent);

    let task = "\
        Take a screenshot to see what's on screen. Then:\n\
        1. Open TextEdit (com.apple.TextEdit)\n\
        2. Create a new document (Cmd+N)\n\
        3. Type a short system report with today's date, the display resolution, \
           and a list of running apps\n\
        4. Take a final screenshot to show the result";

    println!("\nTask: {task}\n");
    println!("─".repeat(60));

    // Run the agent in console mode — streams output to stdout
    let session = InMemorySession::new();
    let result = runner
        .run(&session, task)
        .await?;

    println!("\n─".repeat(60));
    println!("\nAgent completed. Final response:");
    for content in &result.content {
        match content {
            Content::Text(t) => println!("{}", t.text),
            Content::Image(_) => println!("[screenshot]"),
            _ => {}
        }
    }

    // ── 5. Graceful shutdown ─────────────────────────────────────────────
    // manager.shutdown().await?;
    println!("\n✓ Done");
    Ok(())
}
