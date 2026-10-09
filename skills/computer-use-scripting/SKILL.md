---
name: computer-use-scripting
description: Prefer AppleScript/JXA (macOS) or PowerShell (Windows) via run_script before GUI automation.
---

# Script-first automation

1. `get_tool_guide` then `get_app_capabilities`
2. macOS: `run_script` with `language: "applescript"` or `"javascript"` (JXA)
3. Windows: `run_script` with `language: "powershell"`
4. Use `get_app_dictionary` (macOS) for suite/command names
5. Fall back to accessibility only if scripting fails or the app is not scriptable; for apps that draw their own UI, use OCR (`read_window_text`, `click_text`) and `click`

`run_script` is not in the default `desktop` profile: set `COMPUTER_USE_PROFILE=scripting` (or `windows-admin`, `full`). A script body naming a sensitive app is matched against the approval gate; `COMPUTER_USE_REQUIRE_APPROVAL_FOR=run_script` makes every script ask.

Examples:
- Safari URL: `tell application "Safari" to open location "https://…"`
- Windows: `Start-Process "https://example.com"`
