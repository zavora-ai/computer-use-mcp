/** Server-level MCP instructions injected at initialize (P1 §6 / PR-4). */

export const SERVER_INSTRUCTIONS = `You are connected to computer-use-mcp — desktop automation for macOS and Windows.

## Priority (high → low)
1. Prefer app connectors, shell/filesystem, or browser automation when available.
2. Call get_tool_guide(task) before screenshot-and-click workflows.
3. Prefer scripting (run_script: AppleScript/JXA on macOS, PowerShell on Windows) for scriptable apps.
4. Prefer accessibility tools (get_ui_tree, find_element, click_element, set_value, fill_form) over pixel clicks.
5. Coordinate tools (left_click, type, mouse_move) are a last resort.

## Targeting
- Always set target_app (bundle ID on macOS, process name on Windows) or target_window_id for input tools.
- On focus failures, follow suggestedRecovery: activate_window, unhide_app, or open_application.
- Use focus_strategy: prepare_display only after a focus race is observed.

## Observation
- Prefer get_ui_tree / find_element over screenshot for structured UI.
- Use zoom for small text; quality: 0 for lossless PNG.
- snapshot combines state; use when you need many observations at once.

## Safety
- Destructive tools: process_kill, filesystem delete/write, registry set/delete, run_script.
- Sensitive apps may require approval_token or host elicitation.
- Do not use this server when a more precise tool exists.

## Discovery
- get_app_capabilities(app) — scriptable? accessible? running?
- get_tool_metadata(name) — focusRequired and mutates flags.
- doctor — permissions and setup diagnostics.
`
