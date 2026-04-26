# v5.2 Design — Reliable Foreground Automation

## Summary

Add four primitives to the existing v5.1 session layer, all composed of Rust + TS rather than new native modules.

| Primitive | Where | What it does |
|---|---|---|
| `prepareDisplay` | `native/src/apps.rs` + `session.ts` | Hide non-target apps before input. |
| `escHotkey` | `native/src/input_abort.rs` (new) + `session.ts` | CGEventTap that consumes Escape while a CU session is active. |
| `sessionLock` | `src/session.ts` (pure TS — `O_EXCL` via `fs.openSync`) | One CU session per Mac. |
| `runloopPump` | `src/session.ts` (pure TS — `setInterval` + NAPI call) | Persistent CFRunLoop drain during sessions. |

Plus non-code work: **tag every tool with `focusRequired`** in `server.ts`.

No new public MCP tools. All four primitives operate under the hood; one new `focus_strategy` value (`"prepare_display"`) is the only user-visible surface.

---

## Data flow: current vs v5.2

**Today (v5.1):**

```
MCP tool call → session.ts → ensureFocusV4 (activate + poll) → native input → return
                                     ↑
                           iscreenshoter steals focus here
```

**v5.2:**

```
MCP tool call
  → acquireSessionLock()            ← R3
  → startRunloopPump()              ← R5
  → startEscHotkey()                ← R2
  → prepareDisplay() if requested   ← R1
  → ensureFocusV4 (now ~immediate,
      because no other app is visible)
  → native input
  → finally: stopEscHotkey()
  → finally: stopRunloopPump()
  → finally: releaseSessionLock()
```

The lock + pump + hotkey are **refcounted** — if two mutating tools are called back-to-back within the same MCP server process, we don't tear them down and rebuild.

---

## Component: `prepareDisplay`

### Native signature
```rust
#[napi]
pub fn prepare_display(
    target_bundle_id: String,
    keep_visible: Vec<String>,
) -> napi::Result<PrepareDisplayResult>;

struct PrepareDisplayResult {
    hidden_bundle_ids: Vec<String>,
    target_bundle_id: String,
    terminal_bundle_id: Option<String>,
}
```

### Algorithm
1. `drain_runloop()` (already in v5.1).
2. Enumerate `NSWorkspace.runningApplications`, filter `activationPolicy == 0` (Regular).
3. For each regular app, if its `bundleIdentifier` is not in the keep set (target + terminal + caller's allowlist) and not already hidden, call `[app hide]`.
4. Accumulate the list of bundles we actually hid (not the ones that were already hidden — we don't want to unhide those later).
5. Activate the target via the existing `activate_app` path.
6. Poll `frontmostApplication` until it matches the target (timeout 1500 ms) — this is much faster now because the only windows left on screen belong to the target or the terminal.

### Session layer integration
`session.ts` resolves the terminal bundle via `process.env.TERM_PROGRAM_BUNDLE_ID` → `process.env.__CFBundleIdentifier` → `"com.apple.Terminal"` fallback. The user's allowlist comes from `COMPUTER_USE_PREPARE_KEEP_VISIBLE`. We always include the target and the resolved terminal.

### Opt-in only
`prepareDisplay` only runs when a tool is called with `focus_strategy: "prepare_display"`. It is **not the default** — existing callers keep their current behaviour.

---

## Component: `escHotkey`

### Why a CGEventTap (not AppKit key monitor)
Claude Code's implementation uses `CGEventTapCreate` at the `kCGSessionEventTap` level. This is the only way to consume Escape *before* the focused app sees it — an `NSEvent.addGlobalMonitorForEvents` can only observe, not swallow. The tap also survives modal dialogs, Stage Manager, full-screen apps.

### Native signature
```rust
#[napi]
pub fn start_esc_abort_hotkey(callback: ThreadsafeFunction<()>) -> napi::Result<()>;

#[napi]
pub fn stop_esc_abort_hotkey() -> napi::Result<()>;
```

### Internal state
- Single global `Option<CGEventTapRef>` guarded by a `Mutex`.
- Tap callback posts to a single-threaded tokio runtime which invokes the JS callback.
- Decay timer: if the tap sees an Escape keydown, it suppresses the matching keyup 100 ms later even if the original event didn't reach the callback (prevents the next user-typed Escape from being eaten — exact pattern Claude Code uses).

### Session layer integration
```typescript
// src/session.ts, new helpers
async function withAbortHotkey<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (process.env.COMPUTER_USE_DISABLE_ESC_ABORT === '1') {
    return fn(new AbortController().signal);
  }
  const ctrl = new AbortController();
  incrementEscRefcount(() => ctrl.abort(new UserAbortError()));
  try { return await fn(ctrl.signal); }
  finally { decrementEscRefcount(); }
}
```

Mutating tool dispatch wraps its body in `withAbortHotkey`. Native input calls **do not** accept an AbortSignal, but the session layer checks the signal between dispatched sub-steps (e.g. per-field in `fill_form`, per-keypress in `hold_key`, before every `mouseClick`). This is enough granularity for user-visible abort without changing the NAPI surface.

### Failure mode
If `CGEventTapCreate` returns null (no Accessibility permission, as is common on first run), the hotkey feature silently degrades to a no-op. Mutation calls still work; abort just won't fire. We log a one-time warning to stderr so the operator knows.

---

## Component: `sessionLock`

Pure TS — no native code needed.

```typescript
// src/session.ts
const LOCK_PATH = '/tmp/.computer-use-mcp.lock';

async function acquireSessionLock(): Promise<LockHandle> {
  while (true) {
    try {
      const fd = fs.openSync(LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
      fs.writeSync(fd, String(process.pid));
      return { fd, release: () => { fs.closeSync(fd); fs.unlinkSync(LOCK_PATH); } };
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      const holder = tryReadHolderPid();
      if (holder != null && !pidIsAlive(holder)) {
        fs.unlinkSync(LOCK_PATH);
        continue;
      }
      // Live lock — fail fast, let the caller decide to retry.
      throw new LockError({ error: 'locked_by_pid', lockingPid: holder });
    }
  }
}
```

Session refcounts the lock within a single process — nested mutating calls (`fill_form` calling per-field `set_value`) don't re-acquire.

Released on `process.on('exit')` and `SIGTERM` / `SIGINT` via a cleanup handler.

---

## Component: `runloopPump`

Also pure TS — the native side already has `drain_runloop()` from v5.1.

```typescript
// src/session.ts
let pumpInterval: NodeJS.Timeout | null = null;
let pumpRefcount = 0;

function startPump() {
  if (pumpRefcount++ > 0) return;
  pumpInterval = setInterval(() => n.drainRunloop(), 1);
  pumpInterval.unref();  // don't keep Node alive on its own
}

function stopPump() {
  if (--pumpRefcount > 0) return;
  if (pumpInterval) { clearInterval(pumpInterval); pumpInterval = null; }
}
```

Needs a new NAPI export: `drainRunloop()` — currently the drain is called internally only.

---

## `focusRequired` metadata

`server.ts` currently calls `tool(name, description, shape)`. Extend:

```typescript
function tool(name: string, description: string, shape: Record<string, z.ZodTypeAny>, meta?: { focusRequired: 'ax' | 'cgevent' | 'scripting' | 'none' }) {
  server.tool(name, description, shape, { ...meta && { _meta: meta } }, async (args, extra) => { ... });
}
```

The MCP SDK currently doesn't have a first-class `_meta` field in the tool definition — we'll piggyback on the description string with a structured suffix `[focusRequired: cgevent]` for agents that read it, and emit a sibling tool `get_tool_metadata(name)` that returns the full structured metadata. Cheaper than fighting the SDK.

---

## Refcounting diagram

```
 mutating tool call A
   ├─ lock.acquire()     refcount: 0 → 1
   ├─ pump.start()       refcount: 0 → 1
   ├─ hotkey.start()     refcount: 0 → 1
   │
   │    nested sub-call (fill_form → set_value)
   │    ├─ lock.acquire()     refcount: 1 → 2 (no-op, same PID)
   │    ├─ pump.start()       refcount: 1 → 2 (no-op)
   │    ├─ hotkey.start()     refcount: 1 → 2 (no-op)
   │    ├─ (input)
   │    ├─ hotkey.stop()      refcount: 2 → 1
   │    ├─ pump.stop()        refcount: 2 → 1
   │    └─ lock.release()     refcount: 2 → 1
   │
   ├─ hotkey.stop()      refcount: 1 → 0 (tear down tap)
   ├─ pump.stop()        refcount: 1 → 0 (clearInterval)
   └─ lock.release()     refcount: 1 → 0 (close + unlink fd)
```

---

## Testing plan

### Unit (Node `--test`)
- `acquireSessionLock` happy path, EEXIST + dead-PID recovery, EEXIST + live PID raises `LockError`.
- Refcounting: nested acquire/release calls don't stop the pump / hotkey / lock.
- `prepareDisplay` keeps target + terminal visible, hides the rest, returns correct `hiddenBundleIds`.
- `focusRequired` metadata present on all registered tools (assertion iterates `listTools()` and checks each).

### Integration (runs against real macOS)
- Open TextEdit + Safari + Notes. Call `set_value(target=TextEdit, ..., focus_strategy="prepare_display")`. Assert Safari and Notes are `isHidden: true`, TextEdit is `frontmost`, value set.
- `abort_test.mjs`: start a 10-second bounded `hold_key(['a'], 10)`. After 2 seconds, send Escape via a separate `osascript` that synthesizes `key code 53`. Assert the call returns `aborted_by_user` within 200 ms.
- `lock_test.mjs`: spawn two child Node processes that both create an MCP server and call `left_click` simultaneously. Assert exactly one succeeds.

### Manual
- Repeat the Freeform smiley attempt with `focus_strategy: "prepare_display"` on each `select_menu_item`. Expected result: three ovals + one line composed into a smiley without mid-sequence focus loss.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `CGEventTapCreate` without Accessibility returns null, Esc-abort silently disabled | high (first run) | one-time stderr warning; document in README |
| `prepareDisplay` hides an app the user needs (Slack notification during automation) | medium | explicit `keep_visible` param + `COMPUTER_USE_PREPARE_KEEP_VISIBLE` env var |
| Users complain about being left with a "desktop cleared of apps" after a CU sequence | medium | return `hiddenBundleIds` so agents can restore; v5.3 adds `restore_hidden` one-shot helper |
| Lockfile at `/tmp/.computer-use-mcp.lock` is readable by other users on multi-user Macs | low | mode 0o600; document; multi-user shared automation is out of scope |
| 1 ms runloop pump under libuv adds CPU overhead | low | `.unref()` the interval, stop it as soon as refcount hits 0, only active during mutating tools |
| Escape decay window (100 ms) misses a user Escape press immediately after an abort | low | matches Claude Code's choice; same tradeoff they made, no incidents reported |

---

## Rollout

- v5.2.0: land R1–R5, mark `prepare_display` as opt-in. README + AGENTS.md updated.
- **No deprecations.** Existing `focus_strategy` values (`strict`, `best_effort`, `none`) keep their meaning.
- Smoke test (`test-v5-smoke.mjs`) gains ~4 probes for the new primitives.
