# desktop-control (computer-use-mcp): review and direction, 2026-10-09

Reviewed by Claude Code (the lead session in James's games workspace) with four read-only worker reports in
[`2026-10-09-inputs/`](2026-10-09-inputs/): the TypeScript server, the native layer with build and CI, the computer-use
ecosystem, and Unreal's own automation surfaces. Repository at `feat/v7.5-agent-desktop` @ `b97de7e` (7.5.0). Live checks
were limited to reading: the server was started once on stdio, the running Unreal editor was queried through Epic's MCP
(`describe_toolset`, one shallow `Snapshot`) and through macOS accessibility (System Events). Nothing was clicked, typed
or committed.

James: "review all its PRs and issues on GitHub, review the code itself for improvement, look at how game developers
actually work through point and click in Unreal vs limitations of MCP and build the mcp (or an mcp app extension) to
address this gap ... don't assume anything because the mcp is being used by many people ... does it help embedding it as
an unreal plugin."

## 1. Bottom line

- **The server is real and used.** 73 tools, about 4,000 npm downloads a month, 487 unit tests, six native targets. Its
  v7.5 features (right-window capture, on-device OCR, pid delivery, the user-active guard, `wait_for_window`) are things
  users of Anthropic's and others' computer-use tools are still filing requests for.
- **It was down for us for five days for a trivial reason.** `node_modules/` was deleted from the repo on 2026-10-04 (a
  disk clean-up), so `node dist/server.js` died on `import 'zod'`. Claude Code showed `CONNECTION_CLOSED`. `npm ci` fixed
  it today. The server should notice a broken install and say so; the workspace doctor should check it.
- **Four defects need fixing before any new feature:** the user-active guard refuses the first input call of every
  server process (that is why PR #35's CI is red); `process_kill` accepts `pid: -1`; `hold_key` has no cap and freezes
  the whole server; the startup path throws on an empty environment variable and has no unhandled-rejection handler.
- **Release and branch state is messy for a package other people install:** npm `latest` is 7.4.0 while the repo is
  7.5.0 on an unmerged branch (PR #35, open since 10-01); PR #34 (a fork's permission fixes, correct and complementary)
  has waited since 09-19 with CI never approved; the per-platform packages issue #36 asks for packages that exist only as
  manifests; the release job fails on every push that doesn't bump the version; 7.3.0 has no git tag.
- **On the point-and-click gap:** "developers work by clicking in Unreal and MCP can't" is four different gaps, and only
  one of them is desktop-control's to close.
  1. Editor UI with no data API (designer-only state, menus, some modal dialogs, brush tools). For this, in-process Slate
     access beats OS-level OCR and clicks on every axis, and Epic already ships it: `SlateInspectorToolset` (14 tools:
     snapshot with refs, click, type, drag, select option, fill form, wait, window list, widget screenshots). Its faults
     are that it warps the user's real mouse cursor, sends characters not key events, has unstable refs and one-jump drags,
     and stops when the game thread stops.
  2. Working while James works (no focus steal, no cursor movement). No shipping tool does this for canvas and engine
     windows; cua's design proposal is an in-app input bridge, which for Unreal is exactly a Slate inspector without the
     cursor warp.
  3. Honest verification. Every ecosystem tracker is full of "green check, nothing happened". We return `ok` for
     `open_application ... activated: false`.
  4. OS-only surfaces: `NSOpenPanel` and `NSAlert` dialogs, TCC prompts, the crash reporter, a hung editor, the splash
     screen, standalone game windows, Blender and every other app. This is desktop-control's permanent territory and it
     is the weakest-served part of the stack today.
- **A thin Unreal plugin helps; a Slate re-implementation does not.** Unreal has a complete macOS accessibility layer
  compiled into the editor that is off behind two gates (a cvar and "VoiceOver was on at launch"). A roughly 30-line
  editor module can open it, after which `get_ui_tree`, `find_element` and `click_element` would see buttons, text boxes,
  combo boxes and rows with labels and values, cross-process and without focus or cursor movement. The same plugin can
  carry a hardened copy of Epic's inspector (fake cursor, key events, stable path refs, stepped drags, a blocking wait, a
  dialog hook) exposed through the toolset registry so both Epic's MCP and `ue_python` reach it. That is days, not weeks.
- **An MCP App panel is optional.** Claude Desktop, Cursor and VS Code render them; Claude Code (the CLI we work in) does
  not, and the repo already has a watchable agent console. Build it after the bridges, with an image-block fallback.

The programme is in §8, the design second pass is in [`2026-10-09-design-second-pass.md`](2026-10-09-design-second-pass.md), and the specs in [`../specs/v7.6-honest-actions/`](../specs/v7.6-honest-actions/requirements.md)
and [`../specs/v8-app-bridges/`](../specs/v8-app-bridges/requirements.md).

## 2. Repository state: PRs, issues, releases

| Item | State | Finding | Action |
|---|---|---|---|
| PR #35 v7.5.0 (ours) | Open since 10-01, CI red | `Test - macOS arm64` fails in `smoke-new-tools.mjs`: `multi_select` refused with `user_active`, `msSinceInput: 643`. Real bug (§3.1), not a flake. One commit, +3862/-91, clean rebase on `origin/main` (35de1a2 touched only an example) | Fix the guard, rebase, merge, tag, publish |
| PR #34 permissions (fork, swiftkimani) | Open since 09-19, CI never approved | Correct and complementary: refuses input when the process isn't trusted for Accessibility, names the TCC permission in `doctor` and capture failures, runs `screencapture` with `.output()` so a child can't write to the MCP stdout, fixes the overlay's screen anchor. Conflicts with #35 only in `CHANGELOG.md` and `keyboard.rs`; it does not cover the new `*_to_pid` paths | Land after #35; extend `ensure_input_trusted()` to pid delivery and `typeKeys` |
| Issue #36 per-platform packages | Open 10-08, no reply | True: the resolver's step 2 and six manifests exist, nothing builds or publishes them, all six names 404, and the "binary missing" error still tells users to install them. The reporter offers a PR and asks whether `COMPUTER_USE_NATIVE_PATH` is stable | Reply this week: accept the PR offer, confirm the env var is a stable contract for 7.x |
| Issue #32 overlay deadlock, Windows 11 | Open | Fixed in reasoning (v7.4.0 moved window calls onto the owning thread) and never confirmed on hardware; `hwnd()` still polls up to 750 ms on the event loop; no DPI awareness anywhere in `native/src` | Ask the reporter to confirm on 7.4.0; make `hwnd()` non-blocking |
| Issue #21 empty AX tree on Linux | Open (filed on 7.1.0) | Since 7.2 a Python AT-SPI bridge returns real nodes; the reporter's empty `list_windows` matches `wmctrl` being absent, which the code hides by substituting `true` | Typed `dependency_missing` errors; add the tools to the Linux Docker worker; ask the reporter to retest |
| Issues #19, #20 (Linux run_script, zoom) | Closed in 7.4.0 | Both were real and fixed with a platform guard that returns `platform_unsupported` | None |
| PR #24 (automated security scanner) | Closed | Path validation claim on `filesystem`; the real control is the opt-in fs jail | None |
| Releases | npm `latest` 7.4.0 (09-12); repo 7.5.0; 7.3.0 untagged; 7.5.0 unpublished | The publish job fails on any `main` push that doesn't bump the version ("does not match the attested tarball"), so docs-only pushes go red | Skip cleanly when the version is already published; tag 7.3.0; write the release checklist CONTRIBUTING lacks |
| Branches | Local `main` stale at cfbb6af; `origin/main` 35de1a2 | | `git fetch`, rebase #35 |

## 3. Code review: what to fix, ranked

File and line references are to the branch. The full lists with evidence are in the two code-review inputs.

### 3.1 High

| # | Defect | Where | Fix |
|---|---|---|---|
| 1 | **User-active guard refuses the first input call.** The passive HID tap stamps "last physical input = now" when it installs (`activity.rs:368`). The TypeScript warm-up at session creation (`session.ts:211`) only moves that stamp to session start, so any guarded call in the next 4 s is refused. This is PR #35's CI failure and our own first click in every session | `native/src/activity.rs:333-368`, `src/session.ts:211` | Seed the clock from the system's own HID idle counter (`CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGAnyInputEventType)`) at install, so the first reading is real. Consider using that counter as the primary source and keeping the tap for the emergency chord |
| 2 | **`process_kill` can signal every process the user owns.** `pid: int` has no minimum and reaches `process.kill(pid)`; POSIX `kill(-1)` broadcasts. `pkill` runs without `-x`, so `name` is an unanchored regex | `src/registry/definitions.ts:413`, `src/session/admin-handlers.ts:239-240` | `pid > 1`, resolve names to pids and refuse ambiguous matches, `pkill -x` |
| 3 | **`hold_key` blocks the server.** `duration` has no maximum and the native call sleeps on the Node thread; every other tool waits | `definitions.ts:177-179`, `src/session/input-handlers.ts:458`, `native/src/keyboard.rs:760` | Cap at 10 s; chunk the hold in the native layer or run it off-thread with the abort signal |
| 4 | **Startup fragility.** `Number(process.env.X ?? default)` throws at import for an empty string; `isStdioEntrypoint` is a filename-suffix test, so any other `argv[1]` exits 0 silently; no `unhandledRejection` handler; `build:ts` deletes `dist/` before compiling, so a session that starts mid-build dies | `src/server.ts:86-90, 470`, `src/mcp-tasks.ts:127`, `src/entrypoint.ts:19`, `scripts/clean-dist.mjs` | Parse env defensively, use `isModuleEntrypoint`, add the handler, build to a temp dir and rename, check `node_modules` and the addon at start and print the fix |
| 5 | **Shared mutable `hiddenBundleIds`.** `prepare_display` runs on every dispatch, including unserialised reads, and writes one shared list; parallel calls corrupt it and the user's apps stay hidden | `src/session/focus.ts:42,83`, `src/session.ts:402,512` | Per-dispatch state; call `beginDispatch` only for mutating tools |
| 6 | **Guard gaps.** `hide_app`, `unhide_app`, the `click_element` coordinate fallback and `prepare_display` when the target is already frontmost skip the user-active guard | `window-handlers.ts:159-160`, `accessibility-handlers.ts:150`, `focus.ts:93` | Route them through the guard |
| 7 | **Swift helper compile cached with the first caller's abort signal.** A cancelled first call caches "swiftc failed" for 10 minutes, taking OCR and window capture with it | `src/session/macos-helper.ts:157-160` | Compile without the per-call signal |
| 8 | **Silent input drop when the process isn't trusted for Accessibility** (PR #34's finding). `CGEventPost` from an untrusted process is discarded with no error and `doctor` passes | `native/src/mouse.rs`, `keyboard.rs`, `permissions.rs:46`, `doctor.ts` | Land #34; extend to pid delivery |

### 3.2 Medium

- No token saving on an unchanged frame: `screenshot` re-sends the full cached image (`screenshot-handlers.ts:117, 275`);
  the spec's `previous_hash` short-circuit is missing. No `display_id` or `full_screen` argument; the macOS fallback and
  `describeCapture` assume the main display; `snapshot.display` is advertised and ignored.
- The sensitive-value redaction regex is unanchored (`pin|otp|pass`): "Shipping address", "Compass", "Opinion",
  "Footprint" and "Pinned tabs" all redact to `value: null` (`accessibility-handlers.ts:37`, `legacy-policy.ts:231`).
- `resize_window` ignores `window_id` on macOS (`window-handlers.ts:207`). Coordinate validation is skipped by `scroll`,
  `left_mouse_down/up` and `multi_*`.
- The cross-process lock fails immediately with `locked_by_pid` and no retry hint (`session.ts:387`).
- Failures returned as successes: `open_application` says "activated: false" with `isError: false`; `hide_app` returns
  "App not found" as success. The OpenAI adapter passes model coordinates unscaled (default 1024 px wide screenshots,
  so clicks land 2.5x off on a wide display).
- Windows: input and capture address the primary monitor only (`mouse.rs:827` without `MOUSEEVENTF_VIRTUALDESK`,
  `screenshot.rs:759` `EnumOutputs(0)`); window capture is GDI `BitBlt`, not occlusion-safe; no DPI awareness.
- Linux: a layer of shell-outs (`wmctrl`, `xdotool`, `scrot`, `import`, `ydotool`, `gdbus`, `xclip`); the Docker worker
  installs none of them; `doctor` fails Linux unconditionally (`doctor.ts:52`).

### 3.3 Design for agent use

- `tools/list` is 104,806 bytes, about 27k tokens, for 73 tools: repeated targeting-parameter descriptions dominate,
  macOS receives dead tools (`registry`, `notification`) and six Spaces tools. Peers put a server's whole surface in
  under 12k.
- Result shapes mix `structuredContent` and prose; `force` means "override the guard" on input tools and SIGKILL on
  `process_kill`; coordinate units differ between tools.
- No synchronisation beyond `wait_for_window`: no wait-for-text, no wait-for-stable-frame, no click-and-verify.
- `SERVER_INSTRUCTIONS` predate v7.5: no OCR, `user_active`, `delivery` or `wait_for_window`; "macOS and Windows" only.
- Screenshots are always inline base64; there is no file-path mode for a host that can read files.

### 3.4 Tests and CI

487 tests, strong on pure logic with fake natives (keys, window selection, OCR mapping, pid routing, the guard with a fake
clock, policy, the fs jail). Not covered: real capture, OCR or pid delivery (CI runners have no permissions), the Swift
helper, startup under bad env, wrong argv or a missing addon, parallel dispatch, `process_kill` and `hold_key` limits,
redaction false positives. CI tests on Node 20 only; the install matrix imports entry points on Linux without loading the
addon, so Node 25 (what we run) is never exercised. The `package` job's required-file list stops at v7.2, so the v7.5 files
are not asserted into the tarball.

### 3.5 Security posture

By default an injected agent can run arbitrary scripts, read, write and delete any file the user can, kill processes, and
read the clipboard and the whole screen without approval. `scrape` has no SSRF or host rules. The guards that exist
(approval token, elicitation, env sanitising, the opt-in fs jail with `O_NOFOLLOW`, loopback-only HTTP, a 0600 audit
log) are good; the sensitive-app gate matches four names case-sensitively and only when `target_app` is explicit. The
user-active guard is not a security control (`force` is agent-supplied). Peers ship unattended allowlists with
refuse-when-no-approver, hard-blocked key combos and a consumed global Escape.

## 4. How Unreal developers work, and what an agent can reach

The question is not "click or API". For each thing a developer does with the mouse there are up to three routes, and the
best one is the deepest that exists.

| What the developer clicks | Data API (Python, Epic toolsets, VibeUE) | In-process UI (Epic `SlateInspectorToolset`) | OS-level (desktop-control) |
|---|---|---|---|
| Place or move an actor; set a Details property | **Yes** (`set_editor_property`, `ActorTools`, `ObjectTools`) | Possible, worse | Worse |
| Content Browser navigation, open an asset editor | **Yes** (`EditorAppToolset.SetContentBrowserPath`, `OpenEditorForAsset`) | Possible | Worse |
| Viewport pick ("what is under this pixel") | **Yes** (`ScreenCoordsToWorld`, `WorldPosToScreenCoords`) | n/a | OCR can't |
| Materials, Blueprints, Niagara, Sequencer, UMG | **Yes** (matgraph, `write_graph_dsl`, Niagara toolset, 140 Sequencer tools, VibeUE) | Possible | Worse |
| Widget Blueprint designer-only state (`bIsVariable`, wrap/replace, bindings) | Partly (`FWidgetBlueprintOperationUtils` in 5.8) | **Yes** | Worse |
| Menus (File, Edit, Tools) and toolbar buttons | No (`ToolMenus` can add entries, not invoke) | **Yes** (snapshot, click by ref) | Main menu is a native `NSMenu` in principle, but it read as only Apple, UnrealEditor, Window while the editor was in the background (unverified frontmost) |
| Slate modal dialogs (Save Content, Import Options, Message dialogs) | `-unattended` avoids some | **Yes** (`Windows(list)`, `Snapshot`, `Click`) when the game thread ticks | OCR and `click_text` work; the only route when the game thread is blocked |
| Native dialogs (`NSOpenPanel`, `NSSavePanel`, `NSAlert`) | No | No | **Only route.** Native Cocoa: full AX tree, `click_element` works |
| Brush tools (Landscape sculpt, Foliage paint, Modeling), MetaHuman vertex refine | Partly (Landscape and Foliage services; vertex refine is UI-only) | Drag exists but is one jump; brushes need stepped moves | Real drags, but the user loses the mouse |
| Watching what the user sees | `CaptureEditorImage`, `CaptureViewport`, widget `Screenshot` (in-process, occlusion-proof) | same | ScreenCaptureKit (covered windows fine) |
| Crash reporter, hung editor, splash, TCC prompts, Gatekeeper | No | No | **Only route** |
| Standalone game window (`-game`), PIE 3D input | No MCP in `-game` | PIE: same Slate; 3D input needs real key events | Keys reach the window through pid delivery (verified); clicks don't |
| Blender, Finder, browsers, other apps | Their own MCPs | No | **Only route** |

Live evidence from today (read-only, editor in the background):
- The editor window exposes **four** accessibility nodes: `AXWindow` plus the close, zoom and minimise buttons. Nothing
  from Slate. The menu bar read as three items. This is why `get_ui_tree` and `find_element` are useless on Unreal today.
- Epic's inspector with the default depth-0 observer reports the editor window as three `image` nodes. Deep coverage
  needs `Observe(ref, maxDepth)`, which re-walks the subtree every ~100 ms until `Unobserve`; refs are session counters
  (`b12`, `tb3`), not paths.
- `Click`, `Hover`, `Drag` and `SelectOption` call `SetCursorPos`, which reaches `CGWarpMouseCursorPosition`: the user's
  pointer moves. `Type` sends `FCharacterEvent`s only (no key down or up). `WaitFor` checks once; the caller polls.
- Everything in the inspector runs on the game thread. When the editor hangs, stalls on exit, or sits behind a native
  dialog, it answers nothing. That is when desktop-control is the only tool.
- Unreal's macOS accessibility layer (`ApplicationCore/Private/Mac/Accessibility/`, 937 lines) is compiled into the
  installed editor (`WITH_ACCESSIBILITY 1`, symbols present in `libUnrealEditor-ApplicationCore.dylib`). It publishes
  Slate widgets to AppKit only when `Accessibility.Enable` is set **and** VoiceOver was on at launch
  (`FMacApplication::SetAccessibleMessageHandler` checks `isVoiceOverEnabled` once; the runtime observer is commented
  out). `OnVoiceoverEnabled()` is a public exported member, so a tiny editor module can open the gate without VoiceOver.
  Exposed roles: window, button, checkbox, static text, editable text with value, combo box, list and tree rows, slider,
  image, link. Actions: press on buttons and checkboxes, increment and decrement on sliders. Not exposed: dock tabs, spin
  boxes as numbers, the viewport, scroll bars; no writable value, no identifier, no hit-test.
- The `'/'` typing stop in the Cmd box has no confirmed cause; the best hypothesis is the console suggestion popup closing
  mid-string and moving focus. The route that avoids it exists already: `unreal.SystemLibrary.execute_console_command`
  through ue-bridge.

What this means: **for in-editor UI, Slate-level control is the right layer and Epic ships most of it.** The three things
it lacks are no-takeover input, honest results, and surviving a blocked game thread. The first two belong in a thin
Unreal plugin that hardens Epic's inspector; the third is desktop-control's job, and it should also cover the OS-only
column above far better than it does.

## 5. What users of computer-use tools ask for

From the ecosystem input (Anthropic's built-in computer use, OpenAI's, trycua/cua, Peekaboo, macos-use, Windows-MCP,
Unity MCP, UI-TARS, Agent S and others; issue links in the input). Ranked by how often the gap appears across trackers:

| # | Recurring gap | We have | We lack |
|---|---|---|---|
| 1 | Focus, cursor and keyboard takeover; no background mode | pid delivery for keys; the user-active guard | pointer in the background (nobody has it for canvas apps; cua uses private SkyLight APIs) |
| 2 | Full-screen capture; wrong or occluded window | window-targeted ScreenCaptureKit, window kinds | a display argument; occlusion-safe Windows capture |
| 3 | TCC identity: which process holds the grant; restart after granting | `doctor` (partly) | PR #34's named refusals; an Input Monitoring probe |
| 4 | HiDPI, mixed DPI, multi-monitor coordinate errors, silently wrong monitor | exact SCK mapping for windows | multi-display on macOS; all of Windows |
| 5 | **Silent false success** | capture-before-and-after for pid delivery | `effect` / `route` / `delivery` on every action; typed refusals; never `ok` for "did nothing" |
| 6 | Stale element refs across snapshots or sessions | | one-use `capture_id` on pixel clicks; opaque element tokens that fail loudly |
| 7 | Empty accessibility trees (Electron, Qt, custom-drawn, engines) | OCR `read_window_text`, `click_text` (no peer has these) | the Unreal AX gate (§6) |
| 8 | Canvas, OpenGL and game input in the background | keys via pid | an in-app input bridge (§6) |
| 9 | Latency and missing sync primitives | `wait_for_window` | `wait_for_text` (OCR), `wait_for_stable` (frame diff), click-and-verify; no blanket post-action lock |
| 10 | Token and image cost (1,000 to 1,800 tokens a screenshot; 27k for our tool list) | zoom, regions | unchanged-frame short-circuit, thumbnails, a smaller default profile, file-path results |
| 11 | Single-session locks | the cross-process lock | a wait-with-timeout and a clear retry hint |
| 12 | Unattended approval and safety | approval token, elicitation, sensitive-app gate | allowlists with refuse-when-no-approver, hard-blocked combos, a consumed global Escape |
| 13 | Install and start-up friction | prebuilt binaries in the tarball | a start-up self-check; the per-platform packages (#36); a prebuilt Swift helper |
| 14 | Daemon hygiene (stuck overlays, orphans) | | the Windows overlay confirmation (#32) |
| 15 | OS-owned UI invisible or inert (UAC, Dock, sheets) | AX on native sheets | `wait_for_window kind: dialog` is there; dialog reading and answering as a first-class flow |

Features one or two peers have and users praise: cua's honest delivery contract (`delivery`, `route`, `effect`, typed
refusal codes, per-OS test ledgers); its one-use `capture_id`; Peekaboo's fail-closed selectors and retry-unsafe
receipts; Anthropic's consumed global Escape and per-app tiers; Codex's per-agent visible cursor; Hermes's screenshot
eviction. Nothing in the ecosystem combines an engine API for state with pid-targeted capture and OCR for the UI the API
doesn't expose. ue-bridge plus desktop-control already does that by hand; v8 makes it a product.

## 6. The plugin question, answered

| Option | What it is | Verdict |
|---|---|---|
| A. Extend desktop-control with Unreal-specific screen hacks | OCR the Details panel, click by pixel, learn Slate layouts | **No.** It is the weakest route on every axis, and Epic's inspector already does it in-process |
| B. A new Unreal plugin that re-implements point-and-click | Our own Slate tree, click, type, drag | **No.** It duplicates `SlateInspectorToolset` (about 3,000 lines including tests) |
| C. A thin **agent-desktop plugin** that (1) opens the macOS accessibility gate and (2) hardens Epic's inspector | Call `FMacApplication::OnVoiceoverEnabled()` after Slate init with `Accessibility.Enable` set; register toolset functions: click, hover and drag with a fake cursor (the Automation Driver's approach, no `SetCursorPos`), `Type` with real key down and up and a `SetText` commit, stable path refs (window, tab, ancestor labels, property name), stepped drags, a blocking `WaitFor` with timeout, a window-shown hook for dialogs, `ClickByText(role, label, within)` | **Yes.** Days of work. It makes OS-level tools (desktop-control, VoiceOver, Accessibility Inspector) see Slate cross-process with no focus or cursor change, and gives ue-bridge and Epic's MCP a no-takeover UI route. Spike first (half a day): set the cvar, launch once with VoiceOver on, dump `get_ui_tree` |
| D. desktop-control learns to **route** through app bridges | When a target window belongs to an app with a registered bridge (Unreal through Epic's MCP on 8000 or ue-bridge; Blender through 9876), `click_text`, `click_element`, `type` and `key` can take `route: "app-bridge"` instead of CGEvents, with the OS path as fallback and the route reported in the result | **Yes**, after C. This is the hybrid nobody ships |
| E. An MCP App supervision panel | Live window view at 1 to 2 fps, approve and deny as app-only tools, point-to-widget | **Later, optional.** Claude Code doesn't render MCP Apps; Claude Desktop, Cursor and VS Code do; the repo's agent console already gives James a watchable panel. Build with an image-block fallback once C and D exist |

Risks: Epic's toolsets are experimental and NoRedist, so the plugin should depend on `FSlateApplication` (stable) and
register through the toolset registry rather than fork the inspector; the Mac accessibility manager has two probable bugs
(cache key, parent-before-window) and a 0.25 s refresh timer whose cost on a big editor layout is unmeasured; the
inspector and the AX actions both need the game thread to tick (ue-bridge's `nr.Agent.KeepAwake` covers that).

## 7. MCP Apps, specifically

Facts (ecosystem input): extension `io.modelcontextprotocol/ui`, spec 2026-01-26, `ui://` HTML resources rendered in a
sandboxed iframe with JSON-RPC over `postMessage`; app-only tools hidden from the model; declared CSP and permissions.
Clients: Claude web and Desktop, VS Code Copilot, M365 Copilot, ChatGPT, Cursor, Goose, Postman and others. Claude Code
renders an image block and nothing interactive (feature request anthropics/claude-code#95149, open). Whether the Claude
Desktop "Code" tab renders apps is unconfirmed. A 2026-07-28 revision reportedly changes the protocol; check the
`@modelcontextprotocol/ext-apps` SDK before building.

Verdict: the panel is worth having for James's supervision (watch the targeted window, approve a risky action, point at a
widget to name it), but it is the last item in the programme, not the first. The gap James feels in daily work is
closed by §6 C and D and by §3's fixes.

## 8. Programme

Three releases, each a spec in `docs/specs/`, in the order the risk sits.

| Release | Content | Size |
|---|---|---|
| **7.5.1** (this week) | §3.1 defects 1 to 4 with tests; a start-up self-check that names a missing install; land #35 and #34; reply to #36 and accept the PR offer; tag 7.3.0 and 7.5.x; publish; CI on Node 22 and 25; `package` job asserts the v7.5 files; release job skips cleanly | days |
| **7.6 honest actions** ([spec](../specs/v7.6-honest-actions/requirements.md)) | `effect`, `route`, `delivery` and typed refusals on every action; one-use `capture_id` for pixel clicks; element tokens that fail loudly; `wait_for_text`, `wait_for_stable`, click-and-verify; unchanged-frame short-circuit, `display_id`, file-path results; **the tool-surface design pass (R7, [second pass](2026-10-09-design-second-pass.md))**: default profile `desktop`, platform filtering, shared-parameter diet, `approval_token` out of the schemas, one `click` with aliases, trimmed metadata, instructions generated per platform, byte budgets under test; the §3.2 fixes; unattended allowlist with refuse-when-no-approver and a consumed global Escape | 1 to 2 weeks |
| **8.0 app bridges** ([spec](../specs/v8-app-bridges/requirements.md)) | The Unreal agent-desktop plugin (AX gate, hardened inspector) and desktop-control's `route: "app-bridge"`; the Blender input-bridge spike (pid delivery, `bpy` as the bridge); dialog reading and answering as a first-class flow; the optional MCP App panel | 2 to 3 weeks, with the spike first |

Platform work that other users need and we can't test here (Windows multi-monitor and DPI, occlusion-safe Windows
capture, native Linux enumeration, the per-platform packages) is listed in the native input's top 10 and should be
offered to the contributors who asked (#32's reporter has a mixed-DPI Windows 11 machine; #36's reporter offered a
release-workflow PR).

## 9. Decisions for James

1. **Order:** 7.5.1 fixes now, then 7.6, then 8.0 with the accessibility spike first. Or start the spike in parallel.
2. **Land PR #34** (a fork's work) after #35, and reply to #36 accepting the per-platform packages PR offer with
   `COMPUTER_USE_NATIVE_PATH` declared stable for 7.x.
3. **The Unreal plugin (§6 C):** go ahead with the half-day spike in Nairobi Racer (`Accessibility.Enable=1` in the project
   ini, one launch with VoiceOver on, a `get_ui_tree` dump), then the plugin.
4. **Default profile:** make `core` plus the OCR tools the default (31 tools) instead of `full` (73). Existing users
   keep `COMPUTER_USE_PROFILE=full`.
5. **The MCP App panel:** build after 8.0, or not at all while we work in Claude Code.
6. **Committing today's branch:** the review, the two specs and the 7.5.1 fixes are on `review/2026-10-09-desktop-control`,
   uncommitted until you say so (repo rule: commits as James, after confirmation).

## 10. Not verified here

- Whether Unreal's native menu bar is populated when the editor is frontmost (it read as three items in the background).
- Whether `unreal.ToolsetRegistry.execute_tool("SlateInspectorToolset", ...)` works from `ue_python`, and whether
  `SelectOption`'s internal `Tick()` is safe inside a ue-bridge job.
- The cause of the `'/'` typing stop; and whether a single-jump `Drag` starts a Slate drag-drop operation.
- The Mac accessibility manager's behaviour on a 3,000-actor editor layout (refresh cost, the two probable bugs).
- All Windows and Linux runtime behaviour (CI compiles and unit-tests there; no desktop runs).
- Whether `CGEventSourceSecondsSinceLastEventType(HIDSystemState, ...)` excludes this server's private-source events; the
  7.5.1 fix uses it only to seed the clock at install, where no such events exist yet.
- MCP Apps support in the Claude Desktop Code tab.
