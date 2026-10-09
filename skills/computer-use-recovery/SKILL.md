---
name: computer-use-recovery
description: Recover from FocusFailure, user_active and wrong-window input when using computer-use-mcp.
---

# Focus / window recovery

When a mutating tool returns `focus_failed` or similar:

| suggestedRecovery | Action |
|---|---|
| `activate_window` | `activate_window(requestedWindowId)` then retry |
| `unhide_app` | `unhide_app` → wait → `activate_window` → retry |
| `open_application` | `open_application` → wait (`wait_for_window` for the app) → retry |

If a third-party app steals focus after activation, retry once with `focus_strategy: "prepare_display"`, then `unhide_app` for any `hiddenBundleIds` when done.

Always re-resolve `window_id` via `list_windows` if the target window may have moved or closed. `get_target` shows the session target set by `set_target` and whether its window is still on screen; call `set_target` again after a window is replaced.

## user_active

`user_active` is not a focus failure: the person was typing or moving the mouse within `COMPUTER_USE_USER_IDLE_MS` (default 4 s), and the call would have taken focus or posted input. Do not retry in a loop, and do not add `force: true` unless the user asked for the action.
1. Retry with `delivery: "pid"` (no activation, no cursor movement; keys usually reach background apps, clicks often do not), or
2. `wait` a few seconds and retry, or
3. Ask the user.

## Capture helper errors (macOS)
`helper_busy` (another capture held the helper lock too long), `helper_timeout` (the helper was killed after the call timeout) and `sck_timeout` (ScreenCaptureKit stalled for 10 s) mean the capture failed, not that the screen is empty. Wait a moment and retry once; `doctor` reports `agent_helper`. Do not run two captures at once yourself: the server serialises them.
