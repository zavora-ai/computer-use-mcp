---
name: computer-use-recovery
description: Recover from FocusFailure and wrong-window input when using computer-use-mcp.
---

# Focus / window recovery

When a mutating tool returns `focus_failed` or similar:

| suggestedRecovery | Action |
|---|---|
| `activate_window` | `activate_window(requestedWindowId)` then retry |
| `unhide_app` | `unhide_app` → wait → `activate_window` → retry |
| `open_application` | `open_application` → wait → retry |

If a third-party app steals focus after activation, retry once with `focus_strategy: "prepare_display"`, then `unhide_app` for any `hiddenBundleIds` when done.

Always re-resolve `window_id` via `list_windows` if the target window may have moved or closed.
