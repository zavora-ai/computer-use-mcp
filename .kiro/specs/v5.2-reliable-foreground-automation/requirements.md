# v5.2 — Reliable Foreground Automation

## Problem

Today, a third-party focus-stealing app (e.g. `com.screenshot.iscreenshoter`) can snatch frontmost state between our `activate_app` and the synthetic input that follows. When that happens:

- `focus_strategy: "strict"` tools fail hard with `focus_failed`.
- `focus_strategy: "best_effort"` tools silently send the input to the wrong app.
- Our own `screenshot` tool, on some user setups, triggers a screenshot-watcher that grabs focus — a self-inflicted race.

We also lack:

- A way for the user or calling agent to **abort** an in-flight automation sequence.
- Protection against **two agents** driving the cursor at the same time.
- Honest per-tool metadata so agents can reason about what a tool needs to succeed.

## Evidence from prior art

Claude Code's CLI computer-use implementation (`claude-code-source-code/src/utils/computerUse/*`) has already solved these problems in production:

- `prepareForAction()` → `prepareDisplay()` hides every non-target app before input dispatch (including the screenshot watcher kind of problem).
- An `escHotkey` CGEventTap intercepts Escape system-wide during an in-flight session so the user can always bail out.
- `computerUseLock.ts` uses an `O_EXCL` file lock to prevent two concurrent CU sessions.
- `drainRunLoop.ts` pumps CFRunLoop on a refcounted 1ms interval so NSWorkspace KVO updates and `@MainActor` async methods make progress under libuv.

Their deliberate choice: **foreground-only**. They do not attempt background-AX automation. We will follow that contract.

## Non-goals (explicit)

- **Background AX automation** — rejected. The general case (Freeform, SwiftUI popovers, Electron apps) breaks too often. Agents that need true background automation should use `run_script` (AppleScript / JXA), which is already background-safe by design.
- **Visual activation polish** — we do not animate focus transitions, fade non-target apps, etc.
- **Multi-agent cooperation** — one CU session at a time is a feature, not a bug.

## Goals

1. **Deterministic foreground** — when a mutating tool runs, no other app can steal focus between activation and input dispatch, because we have hidden every other app.
2. **User abort** — the user can press Escape during an in-flight sequence and get a clean teardown + structured abort response.
3. **Session lock** — two processes using `@zavora-ai/computer-use-mcp` on the same Mac cannot interfere.
4. **Honest metadata** — each MCP tool advertises `focusRequired: "ax" | "cgevent" | "scripting" | "none"` so agents (and our own internal dispatch) can choose the cheapest adequate path.
5. **Backwards compatibility** — no existing tool changes shape. New behaviours are additive and opt-in via env / params when they affect user experience.

## User-visible requirements

### R1 — `prepareDisplay` activation mode
- New `focus_strategy: "prepare_display"` value, available on every mutating tool.
- When set, before the action: hide all apps except (a) the target app, (b) `Terminal.app` / the host terminal, (c) an opt-out allowlist (env var `COMPUTER_USE_PREPARE_KEEP_VISIBLE` = comma-separated bundle IDs).
- After the action: **do not un-hide**. The user decides when to restore their layout. (Matches Claude Code's behaviour; prevents flicker between chained actions.)
- The tool's return payload includes a `hiddenBundleIds: string[]` field listing what was hidden, so callers can restore later.

### R2 — Escape hotkey abort
- While any MCP mutating tool is executing, a CGEventTap intercepts Escape.
- On Escape: the in-flight tool returns `{ isError: true, error: "aborted_by_user" }` within 100 ms and releases the computer-use lock.
- Tap is released when no mutating tool is active (refcounted).
- Opt-out: env var `COMPUTER_USE_DISABLE_ESC_ABORT=1`.

### R3 — Computer-use session lock
- `O_EXCL` lock file at `/tmp/.computer-use-mcp.lock` held for the duration of any mutating tool call.
- Stale-PID recovery: if the lock file exists but the holding PID is dead, reclaim.
- Two concurrent MCP servers on the same Mac will see the second one's mutating calls fail with `{ isError: true, error: "locked_by_pid", lockingPid: N }` until the first releases.
- Observation tools do not take the lock.

### R4 — `focusRequired` metadata on every tool
- Each `tool()` registration carries a `focusRequired` tag.
- Mapping (proposed):
  - `"scripting"`: `run_script`, `get_app_dictionary`.
  - `"ax"`: `get_ui_tree`, `get_focused_element`, `find_element`, `list_menu_bar`, `list_windows`, `list_running_apps`, `get_frontmost_app`, `list_spaces`, `get_active_space`, `list_displays`, `get_display_size`, `get_window`, `get_cursor_window`, `get_tool_guide`, `get_app_capabilities`.
  - `"cgevent"`: all click / key / type / scroll / drag variants, plus `click_element` / `set_value` / `press_button` / `select_menu_item` / `fill_form` (because they fall back to CGEvent).
  - `"none"`: `wait`, `read_clipboard`, `write_clipboard`.
- Exposed as an extension field on each tool's MCP description so agents can filter.

### R5 — Runloop drain as a persistent pump during sessions
- Our v5.1 fix drains the run loop on each NSWorkspace read. That works but is lossy — a tight sequence of reads can still miss an event that fires between drains.
- Upgrade: while the computer-use lock is held, run a 1 ms `setInterval` pump (matching Claude Code's `drainRunLoop.ts`).
- When the lock releases, stop the pump.

### R6 — Structured activation failure on frontmost race
- When `ensureFocusV4` finds the frontmost app is **not** the target even after activation attempts, the returned error includes:
  - `thief`: the bundle ID currently frontmost (so the agent can see "iscreenshoter took focus").
  - `suggestedRecovery: "prepare_display"` — telling the agent to retry with the harder strategy.
- This supersedes the current `suggestedRecovery: "activate_window"` for this specific case.

## Acceptance tests

1. Run today's Freeform smiley attempt with `focus_strategy: "prepare_display"` on `select_menu_item` — three ovals land on the canvas without `iscreenshoter` disruption.
2. Start a 30-second `fill_form` call, press Escape at 2 seconds, verify (a) the next field is not filled, (b) the call returns within 200 ms with `error: "aborted_by_user"`.
3. Start two MCP servers, call `left_click` on both simultaneously — exactly one succeeds, the other returns `locked_by_pid`.
4. Boot the MCP server, then quit + relaunch an app 30 seconds later. Call `activate_app` with no prior warm-up — it activates (validates R5 covers the KVO staleness window).
5. Call `listTools()` and confirm every tool description carries `focusRequired`.

## Out-of-scope (deferred)

- Per-tool "restore window layout" recovery helper (`unhide_all`). Agents can compose it from `hiddenBundleIds` + `unhide_app` today; a one-call helper can come in v5.3.
- Opt-in **background-AX fast-path** for apps we know handle `AXUIElementPerformAction` correctly while backgrounded. Needs a curated per-bundle allowlist + runtime verification. v5.3 candidate.
- A proper **Freeform shape-drawing helper** that composes `list_menu_bar` + `select_menu_item` into one call. v5.3.
