---
name: computer-use-scripting
description: Prefer AppleScript/JXA (macOS) or PowerShell (Windows) via run_script before GUI automation.
---

# Script-first automation

1. `get_tool_guide` then `get_app_capabilities`
2. macOS: `run_script` with `language: "applescript"` or `"javascript"` (JXA)
3. Windows: `run_script` with `language: "powershell"`
4. Use `get_app_dictionary` (macOS) for suite/command names
5. Fall back to AX only if scripting fails or app is not scriptable

Examples:
- Safari URL: `tell application "Safari" to open location "https://…"`
- Windows: `Start-Process "https://example.com"`
