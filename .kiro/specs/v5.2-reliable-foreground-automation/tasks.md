# v5.2 Implementation Plan

Target: ~1–2 days of focused work. Each phase ends with `npm run build && npm test` green.

## Phase 1 — Session lock + runloop pump (TS-only, no native changes)

Low-risk, pure plumbing. Lets us validate the refcounting machinery before adding native code.

- [ ] **1.1** `src/session.ts`: add `LockError`, `acquireSessionLock`, stale-PID recovery.
- [ ] **1.2** Expose `drain_runloop` as a NAPI export (rename internal fn, add `#[napi]` wrapper). Rebuild native.
- [ ] **1.3** `src/session.ts`: add `startPump` / `stopPump` with refcount, `.unref()` the interval.
- [ ] **1.4** Wire into mutating-tool dispatch: wrap each case in `withSessionLock(async () => …)`.
- [ ] **1.5** Cleanup handlers: `process.on('exit' | 'SIGTERM' | 'SIGINT', …)` release lock + stop pump.
- [ ] **1.6** Unit tests: lock happy path, EEXIST-dead, EEXIST-alive, nested refcount, pump start/stop refcount.
- [ ] **1.7** Integration test: two child Node processes race on `left_click`; exactly one succeeds.
- [ ] **1.8** Smoke test additions (`test-v5-smoke.mjs`): lock acquire + release round-trip, pump start + stop.

**Exit criteria:** 61 → ~65 tests pass, smoke passes, no regressions.

## Phase 2 — `prepareDisplay` (native + session)

- [ ] **2.1** `native/src/apps.rs`: add `prepare_display(target_bundle_id, keep_visible) -> PrepareDisplayResult`.
- [ ] **2.2** Unit-testable split: a `plan_hide(running_apps, target, keep_set)` helper returning the list to hide, so we can test the filtering logic without requiring real apps.
- [ ] **2.3** Apply hides sequentially: `[app hide]` in NSRunningApplication order; skip apps already hidden.
- [ ] **2.4** `src/session.ts`: add `"prepare_display"` to `FocusStrategy` union. Add `resolveTerminalBundleId()` that reads `process.env.TERM_PROGRAM_BUNDLE_ID`, falls back to `__CFBundleIdentifier`, then `com.apple.Terminal`.
- [ ] **2.5** In `ensureFocusV4`, when `strategy === 'prepare_display'`, call `prepareDisplay()` first, then run the normal activate+poll.
- [ ] **2.6** Mutating-tool response payloads: when `prepare_display` ran, include `hiddenBundleIds: string[]`. This is additive; existing consumers ignore it.
- [ ] **2.7** `server.ts`: `focusStrategyParam` enum gains `"prepare_display"`; update description.
- [ ] **2.8** Integration test (runs against live macOS): open TextEdit + Safari + Notes, call `set_value(..., focus_strategy: "prepare_display")` against TextEdit, assert Safari + Notes hidden, TextEdit frontmost.
- [ ] **2.9** README + AGENTS.md: document `prepare_display`, when to use it, the "we don't un-hide" policy.

**Exit criteria:** Freeform smiley task completes end-to-end with `prepare_display`.

## Phase 3 — Escape hotkey abort

Highest-risk phase — CGEventTap lifecycle is fussy.

- [ ] **3.1** New file `native/src/input_abort.rs`. FFI bindings for `CGEventTapCreate`, `CGEventTapEnable`, `CFMachPortInvalidate`, `CFRunLoopAddSource`, `CFRunLoopRemoveSource`, `CGEventGetIntegerValueField` (for keycode), `kCGKeyboardEventKeycode`.
- [ ] **3.2** Tap factory: create at `kCGSessionEventTap`, event mask = keyDown | keyUp, callback filters keycode 53 (Escape).
- [ ] **3.3** Thread model: tap runs on the main thread's CFRunLoop; callback signals a `tokio` oneshot that invokes the N-API `ThreadsafeFunction` to JS.
- [ ] **3.4** 100 ms decay: on tap-abort-keydown, start a timer; if the matching keyup arrives inside 100 ms, suppress it too (prevents user's next natural Escape from being eaten).
- [ ] **3.5** `#[napi]` exports `start_esc_abort_hotkey(cb)` and `stop_esc_abort_hotkey()`. Refcounted per process.
- [ ] **3.6** Permission probe: if `CGEventTapCreate` returns null, emit single stderr warning and silently no-op subsequent starts (don't error).
- [ ] **3.7** `src/session.ts`: `withAbortHotkey(fn)` wrapper using `AbortController`. Refcounted, matches pump + lock lifecycle.
- [ ] **3.8** Instrument mutating tools for cooperative cancellation:
  - `fill_form` checks `signal.aborted` between fields.
  - `hold_key` checks in its duration loop.
  - Sequential `left_click_drag` checks between samples.
- [ ] **3.9** Error shape: `UserAbortError` → `{ isError: true, error: 'aborted_by_user' }`.
- [ ] **3.10** Integration test: synthesize an Escape via `osascript` mid-`hold_key(10s)`, assert abort within 200 ms.
- [ ] **3.11** Env opt-out: `COMPUTER_USE_DISABLE_ESC_ABORT=1` skips tap installation.

**Exit criteria:** Escape reliably aborts a long-running `hold_key` in integration test; no regression in short tool calls (tap teardown must not block).

## Phase 4 — `focusRequired` metadata

- [ ] **4.1** Define `FocusRequired = 'ax' | 'cgevent' | 'scripting' | 'none'` type in `src/types.ts`.
- [ ] **4.2** Build the tag table — one entry per existing tool. Put the table in `src/server.ts` near the tool registrations.
- [ ] **4.3** `server.ts` `tool()` helper extended to accept the tag and append `[focusRequired: <tag>]` to the description (MCP SDK passthrough).
- [ ] **4.4** New tool `get_tool_metadata(name)` returning `{ focusRequired, mutates: boolean, focusStrategyDefault: 'strict'|'best_effort'|'none'|'prepare_display' }`.
- [ ] **4.5** Test: `listTools()` iterates every tool, asserts every one has a parseable tag.

**Exit criteria:** `get_tool_metadata('run_script')` returns `focusRequired: 'scripting'`; agents can filter.

## Phase 5 — Docs, changelog, smoke, ship

- [ ] **5.1** CHANGELOG.md — v5.2.0 entry covering R1–R5.
- [ ] **5.2** README.md — add "Reliable foreground automation" section after the v5 intro. Mention `prepare_display`, Escape abort, session lock, the design decision to follow Claude Code's foreground-only contract.
- [ ] **5.3** AGENTS.md — guidance on when to use `prepare_display` (answer: any time you've hit `focus_failed` with a `thief` in the error payload).
- [ ] **5.4** `test-v5-smoke.mjs` — bump expected tool count if `get_tool_metadata` added; add 3 probes for lock / pump / metadata.
- [ ] **5.5** Version bump to `5.2.0`, build, tests green, smoke green.
- [ ] **5.6** Commit, push, publish, upgrade global install, repin Claude Code MCP config to `@5.2.0`.

**Exit criteria:** `npm view @zavora-ai/computer-use-mcp version` returns `5.2.0`; restart Claude Code and rerun Freeform smiley with `prepare_display` — three ovals + line compose into a smiley.

---

## Sequencing rationale

- **Phase 1 first** because lock + pump are pure TS and validate the refcounting model with no risk.
- **Phase 2 next** because it solves the user's concrete blocker from today's Freeform session — highest value per hour.
- **Phase 3 is the riskiest**: event taps have real teardown footguns. Gate behind env var so users without Accessibility permission still get phases 1 + 2 + 4.
- **Phase 4 is cheap and independent** — can be done in parallel with 3 if convenient.

## What we explicitly aren't doing in v5.2

- Background-AX fast-path (requires per-bundle allowlist + verification infra). Deferred to v5.3.
- `restore_hidden` one-shot helper. Agents compose from `hiddenBundleIds` + `unhide_app` for now.
- Freeform-specific shape-drawing helper. Deferred.
- Fixing the MCP SDK to support a real `_meta` field on tool descriptors. Description-suffix hack is good enough.
