---
name: computer-use
description: Desktop automation with computer-use-mcp. Use when controlling native macOS/Windows apps via screenshot, accessibility, or scripting — not for pure git/file/http tasks.
---

# Computer Use (desktop automation)

## When to use
- Native desktop apps, installers, modal dialogs, simulators
- UI-only workflows with no API/CLI

## When NOT to use
- Prefer connectors, shell, filesystem, or browser automation (Playwright) first

## Mandatory first steps
If the app ID is unknown, first use `discover_applications({query, include_capabilities: true})`. Use its `targetApp` when present; do not assume a desktop registration ID is a process target.
1. `get_tool_guide({ task_description })` — pick scripting vs AX vs coordinates
2. `get_app_capabilities({ bundle_id })` — is the app scriptable/accessible/running?
3. Prefer `run_script` → accessibility (`fill_form`, `click_element`) → `left_click`/`type` last

## Hard rules
- Always set `target_app` (bundle ID macOS / process name Windows) or `target_window_id`
- Do not screenshot every step; use `get_ui_tree` / `find_element` for structure
- Long text: `write_clipboard` + paste shortcut, not `type`
- On focus failure, follow `suggestedRecovery` (`activate_window`, `unhide_app`, `open_application`)
- Use `focus_strategy: "prepare_display"` only after a focus race

## Safety
- Destructive: `process_kill`, filesystem delete/write, registry set/delete, `run_script`
- Sensitive apps may need `approval_token` or host elicitation
