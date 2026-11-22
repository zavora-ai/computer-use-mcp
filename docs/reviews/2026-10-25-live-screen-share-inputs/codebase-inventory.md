# computer-use-mcp codebase inventory for a live "share your screen" mode

Scope: what in the repository could carry a live mode (screen state streamed from the MCP server to the host and the
model, actions and the person's input streamed back), and what is missing. Read-only review of branch
`fix/linux-card-review` at `a79b428` (based on main `e16fdc5`, version 7.7.0). Every claim cites a file and line range
in this repository; links are relative to this notes file. Tags: **[tested]** = code exists and a test pins it;
**[code]** = code exists, no test found that pins the specific behaviour; **[doc only]** = written down, not built.

## 1. Capture: what produces images today, at what cost, and could any of it stream?

### Takeaway
Every capture path is one still per request. macOS uses `SCScreenshotManager.captureImage` in a warm Swift helper (not
an `SCStream`), strictly one request at a time and serialised across servers by a lock file; Windows keeps a DXGI
Desktop Duplication open per monitor (the nearest thing to a stream in the tree) but builds a new Windows.Graphics.Capture
session per window capture; Linux starts a capture program per call. Nothing in the tree opens an `SCStream`, a
persistent WGC session, or a PipeWire ScreenCast stream, and the native addon has no way to push frames to JavaScript.

### Cited Findings
**macOS Swift helper (`libexec/macos-agent-helper.swift`)**
- Subcommands: `capture --window <id>` / `--display <id|main>` with `--width`, `--format png|jpeg`, `--quality`,
  `--region x,y,w,h`; `ocr (--window|--image) [--region] [--fast]`; `serve [--idle-ms]`; `version`. Each prints one JSON
  object; nothing activates an app or moves the pointer. [code] — [libexec/macos-agent-helper.swift:8-24](../../../libexec/macos-agent-helper.swift#L8-L24)
- Window capture builds a fresh `SCContentFilter(desktopIndependentWindow:)` and a fresh `SCStreamConfiguration` per call
  (`scalesToFit`, `showsCursor = false`, `ignoreShadowsSingleWindow`, `captureResolution = .best`) and calls
  `SCScreenshotManager.captureImage`; it also re-enumerates `SCShareableContent` every call. [tested via fakes] —
  [libexec/macos-agent-helper.swift:101-141](../../../libexec/macos-agent-helper.swift#L101-L141)
- Display capture (7.7.0, K8) excludes the status card by app-name prefix and the server's own shielding-level overlay
  windows (`--overlay-pids`), again via `SCScreenshotManager.captureImage`. [tested] —
  [libexec/macos-agent-helper.swift:143-187](../../../libexec/macos-agent-helper.swift#L143-L187); test
  [test/v7.7-capture.test.mjs:205](../../../test/v7.7-capture.test.mjs#L205)
- Every ScreenCaptureKit call is wrapped in a 10 s `withSckTimeout` because "two helpers side by side both hung"
  (measured 2026-10-09). — [libexec/macos-agent-helper.swift:77-99](../../../libexec/macos-agent-helper.swift#L77-L99)
- Each capture is encoded (PNG or JPEG via ImageIO) and **written to a file**; the reply carries the path, size,
  a 16-hex SHA-256 of the encoded bytes (`hash`), `scale`, `frame`, `bytes`. —
  [libexec/macos-agent-helper.swift:214-231](../../../libexec/macos-agent-helper.swift#L214-L231),
  [:326-334](../../../libexec/macos-agent-helper.swift#L326-L334)
- `serve` mode: one JSON request per stdin line, one reply per stdout line; the loop `await`s each command before
  reading the next line, so a warm helper handles exactly one request at a time. It exits when stdin closes, after
  `--idle-ms`, or after an `sck_timeout` (a stalled SCK call would block the next one). The comment records ~200 ms of
  process/framework/WindowServer start per one-shot capture against ~60 ms warm. [tested] —
  [libexec/macos-agent-helper.swift:371-421](../../../libexec/macos-agent-helper.swift#L371-L421); tests
  [test/v7.7-capture.test.mjs:73-147](../../../test/v7.7-capture.test.mjs#L73-L147)
- OCR is Vision `VNRecognizeTextRequest`, `.fast` or `.accurate`, boxes in image pixels; window OCR captures at
  `minPixelScale: 2`. — [libexec/macos-agent-helper.swift:235-270](../../../libexec/macos-agent-helper.swift#L235-L270),
  [:335-360](../../../libexec/macos-agent-helper.swift#L335-L360)

**macOS helper wrapper (`src/session/macos-helper.ts`)**
- One warm `serve` process per server (default on; `COMPUTER_USE_HELPER_SERVE=false` for a process per call), stopped
  after 30 s idle (`serveIdleMs`), on a timeout (30 s `callTimeoutMs`), on a cancel, or when it exits; a call whose
  helper died is retried once. [tested] — [src/session/macos-helper.ts:279-380](../../../src/session/macos-helper.ts#L279-L380)
- All helper calls are serialised through an in-process promise chain **and** an advisory lock file
  `~/Library/Caches/computer-use-mcp/helper.lock` across servers, polled every 50 ms; a held lock times out as
  `helper_busy`. Rationale: "Two ScreenCaptureKit captures running at once hang each other". [tested] —
  [src/session/macos-helper.ts:233-277](../../../src/session/macos-helper.ts#L233-L277),
  [:394-409](../../../src/session/macos-helper.ts#L394-L409); [test/v7.6-helper-serial.test.mjs](../../../test/v7.6-helper-serial.test.mjs)
- `capture()` passes a temp file path, then `readFileSync`s the image back and deletes it (image bytes never cross the
  pipe). — [src/session/macos-helper.ts:415-436](../../../src/session/macos-helper.ts#L415-L436)

**Measured costs (macOS)**
- 62 ms per warm helper capture; 112-128 ms per `screenshot` end to end; 157-223 ms before 7.7 (macOS 26.2). —
  [CHANGELOG.md:45-46](../../../CHANGELOG.md#L45-L46); [docs/specs/v7.7/tasks.md:74](../../../docs/specs/v7.7/tasks.md#L74)
- Helper memory flat at 27.4-27.8 MB over 200 warm captures. — [docs/specs/v7.7/tasks.md:74](../../../docs/specs/v7.7/tasks.md#L74)
- Process start: the wrapper says "about 150 ms" per capture before warm mode
  ([src/session/macos-helper.ts:11-12](../../../src/session/macos-helper.ts#L11-L12)), the Swift source says "about 200 ms"
  ([libexec/macos-agent-helper.swift:374-375](../../../libexec/macos-agent-helper.swift#L374-L375)), and the competitor study
  measured "about 21 ms of process start" ([docs/reviews/2026-10-23-competitor-study.md:110](../../../docs/reviews/2026-10-23-competitor-study.md#L110)).
  These conflict; the 21 ms figure is plausibly bare spawn while 150-200 ms includes framework load and the WindowServer
  connection, but the repository does not say so.
- Accurate Vision OCR 456-538 ms p50 on 1-1.5 MP. — [docs/reviews/2026-10-23-competitor-study.md:110](../../../docs/reviews/2026-10-23-competitor-study.md#L110)
- The gaming review summarises the server as "One still per call, about 8 per second at best on macOS". —
  [docs/reviews/2026-10-25-gaming-computer-use.md:18](../../../docs/reviews/2026-10-25-gaming-computer-use.md#L18)

**Native fallback paths (`native/src/screenshot.rs`, `native/src/capture_win.rs`)**
- macOS native `take_screenshot` (used when the helper is unavailable, or `show_agent_pointer: true`) shells out to
  `screencapture` and up to two `sips` runs per call. [code] — [native/src/screenshot.rs:478-555](../../../native/src/screenshot.rs#L478-L555)
- Linux shells out per call: `grim` (wlroots, `-g` for a window), `gnome-screenshot`, or the XDG portal Screenshot via
  an embedded python3-gi script with a 30 s timeout on Wayland; `scrot`/`gnome-screenshot` on X11. [code] —
  [native/src/screenshot.rs:11-94](../../../native/src/screenshot.rs#L11-L94)
- Windows monitor capture keeps one `IDXGIOutputDuplication` per monitor in a process-wide `static DUPLICATIONS` map
  and reuses it across calls; each call tries `AcquireNextFrame(100 ms)` up to three times, treats
  `DXGI_ERROR_WAIT_TIMEOUT` as "no new frame (a still screen)", and rebuilds the duplication on access loss. The
  `DXGI_OUTDUPL_FRAME_INFO` is filled but never read (no dirty or move rectangles used). [code; Rust tests on CI] —
  [native/src/capture_win.rs:55-71](../../../native/src/capture_win.rs#L55-L71),
  [:138-160](../../../native/src/capture_win.rs#L138-L160), [:162-210](../../../native/src/capture_win.rs#L162-L210)
- Windows window capture is a ladder: `PrintWindow(PW_RENDERFULLCONTENT)` → Windows.Graphics.Capture → crop of a screen
  capture (with an `occluded` flag) → `BitBlt`. The WGC rung creates a `Direct3D11CaptureFramePool` (1 buffer) and a
  `GraphicsCaptureSession` per call, spins `TryGetNextFrame` for up to 1.5 s, then closes both. [code] —
  [native/src/capture_win.rs:1-10](../../../native/src/capture_win.rs#L1-L10),
  [:361-430](../../../native/src/capture_win.rs#L361-L430), [:492-552](../../../native/src/capture_win.rs#L492-L552)
- All three platforms hash the encoded image (`DefaultHasher`) and, when the caller passes the previous hash, return
  `unchanged: true` without base64. — [native/src/screenshot.rs:556-568](../../../native/src/screenshot.rs#L556-L568) (macOS),
  [:931-956](../../../native/src/screenshot.rs#L931-L956) (Windows), [:159-182](../../../native/src/screenshot.rs#L159-L182) (Linux)
- `take_screenshot_async` runs a capture on a libuv worker (7.7.0, K4); `offThread` prefers `*Async` variants for
  `takeScreenshot`, `getUiTree`, `findElement`, `getMenuBar`, `activateWindow`, `activateApp`. [tested] —
  [native/src/screenshot.rs:1137-1163](../../../native/src/screenshot.rs#L1137-L1163);
  [src/session/native-async.ts:13-23](../../../src/session/native-async.ts#L13-L23); [native/src/async_task.rs:51-52](../../../native/src/async_task.rs#L51-L52)
- The only native→JS mechanism is `AsyncTask` (one result per call); a search of `native/src`, `libexec` and `src`
  finds no `ThreadsafeFunction`, so native code cannot push repeated frames or events to JavaScript today.
  (Search: `grep -rn ThreadsafeFunction native/src libexec src`, no matches.)

**Outside the server**
- Demo recording uses ffmpeg `avfoundation` at 15 fps with the cursor, a continuous screen video, but only as a
  separate recording script, not part of the server. — [agents/deepseek-agent/record.mjs:47-60](../../../agents/deepseek-agent/record.mjs#L47-L60)

### Inferences
- The macOS helper's `serve` protocol (line-delimited JSON, ids, a warm process with idle exit, lock and stall handling)
  is the natural host for an `SCStream`: a `stream start|stop|latest` subcommand family could live beside `capture`.
  But its loop handles one request at a time and blocks on each, and the lock assumes one capture at a time
  machine-wide, so a stream that runs while other captures are requested needs either a concurrent request loop in the
  helper or all captures served from the stream's frames.
- The cross-server lock exists because two concurrent ScreenCaptureKit operations hung each other. A persistent stream
  held by one server for minutes would starve every other server's capture (`helper_busy` after `lockWaitMs`), so a
  live mode needs a design decision: serve all of that server's captures from the stream, or share frames across servers.
- On Windows the cached DXGI duplication is already a long-lived per-monitor source; `AcquireNextFrame` with
  `DXGI_OUTDUPL_FRAME_INFO.LastPresentTime`, `AccumulatedFrames` and the dirty-rect API would give change events nearly
  for free. A per-window stream would need the WGC session kept open instead of closed after one frame.
- On Linux a stream needs the ScreenCast portal and PipeWire; the existing RemoteDesktop portal session for libei
  input selects devices only (no `SelectSources`/ScreenCast), see [native/src/linux_ei.rs:385-420](../../../native/src/linux_ei.rs#L385-L420).

### Gaps
- No measurement in the repository of an `SCStream` on this codebase's machines; the 81 ms open / ~17 ms per frame
  figures are from a third-party Go library cited in the reviews, not measured here.
- No measured Windows capture timings in the repo (K6 is "needs hardware": [docs/specs/v7.7/tasks.md:72](../../../docs/specs/v7.7/tasks.md#L72)).
- No Linux capture timings recorded.

## 2. Change detection already present

### Takeaway
There are four change detectors, all built on exact hashes of encoded captures or on polled lists: the unchanged-capture
text reply, `wait_for_stable`, `verify: true`, and the pid-delivery check; plus OCR polling (`wait_for_text`) and window
list polling (`wait_for_window`). All are pull-driven loops inside one tool call; none runs between calls or emits
events. Hashes are exact (any pixel change, including a clock or caret, counts as a change).

### Cited Findings
- **Unchanged-capture reply (K3):** `UNCHANGED_TEXT_REPEATS = 3`. When a capture's scope (window id, width, quality,
  bounds) and hash match the last image sent, the tool returns JSON `{unchanged: true, image_omitted: true, hash, since,
  repeats, mapping, hint}` instead of the image, up to 3 times in a row; `resend: true` or
  `COMPUTER_USE_RESEND_UNCHANGED=true` forces the image. The comment prices an unchanged frame at 122-187 KB base64 and
  ~1,000 image tokens. [tested] — [src/session/screenshot-handlers.ts:27-32](../../../src/session/screenshot-handlers.ts#L27-L32),
  [:101-133](../../../src/session/screenshot-handlers.ts#L101-L133), [:220-224](../../../src/session/screenshot-handlers.ts#L220-L224),
  [:267-271](../../../src/session/screenshot-handlers.ts#L267-L271), [:470-479](../../../src/session/screenshot-handlers.ts#L470-L479);
  tests [test/session.test.mjs:199-213](../../../test/session.test.mjs#L199-L213), [test/session-screenshot-handlers.test.mjs:40](../../../test/session-screenshot-handlers.test.mjs#L40)
- The handler keeps `lastHash()`, `lastMapping()` (image→screen origin and scale) and `lastScreenshot()` (base64,
  mime, `capturedAt`, target args). — [src/session/screenshot-handlers.ts:366-371](../../../src/session/screenshot-handlers.ts#L366-L371)
- **`wait_for_stable` (macOS only):** polls helper captures at 800 px wide, JPEG q50, optionally cropped to `region`;
  default poll 250 ms (min 50 ms), `quiet_ms` 800 ms, timeout 10 s (max 120 s); stable when consecutive hashes match
  for `quiet_ms`; reports `changes`, `polls`, `regionApplied`. [tested] —
  [src/session/agent-desktop-handlers.ts:27-32](../../../src/session/agent-desktop-handlers.ts#L27-L32),
  [:311-361](../../../src/session/agent-desktop-handlers.ts#L311-L361); test [test/v7.7-capture.test.mjs:339](../../../test/v7.7-capture.test.mjs#L339)
- **`wait_for_text` (macOS only):** OCR polls every 500 ms (min 200 ms); "mixed" mode reads fast, confirms an ending read
  with accurate, and reads accurately every third and the last poll; reports `reads: {fast, accurate}`. [tested] —
  [src/session/agent-desktop-handlers.ts:23-25](../../../src/session/agent-desktop-handlers.ts#L23-L25),
  [:242-307](../../../src/session/agent-desktop-handlers.ts#L242-L307); tests [test/v7.7-capture.test.mjs:298-328](../../../test/v7.7-capture.test.mjs#L298-L328)
- **`wait_for_window` (all platforms):** re-lists classified windows every 250 ms, with an AX round trip only for
  dialog/panel/document kinds; `gone: true` waits for disappearance; timeout max 120 s. [tested in v7.6-waits] —
  [src/session/agent-desktop-handlers.ts:21](../../../src/session/agent-desktop-handlers.ts#L21),
  [:427-458](../../../src/session/agent-desktop-handlers.ts#L427-L458); [test/v7.6-waits.test.mjs](../../../test/v7.6-waits.test.mjs)
- **`read_window_text`** OCRs a window (covered windows too, without activation) into lines with boxes in window
  points plus one `screen_origin`. — [src/session/agent-desktop-handlers.ts:372-384](../../../src/session/agent-desktop-handlers.ts#L372-L384);
  [AGENTS.md "Apps that draw their own UI"](../../../AGENTS.md)
- **`verify: true` (K1):** on `click`, its aliases, `scroll`, `type`, `key`, `mouse_drag`, `left_click_drag`,
  `hold_key`, `multi_select`, `multi_edit`: hash the target (480 px JPEG q60) before and after with a 250 ms settle and
  report `changed` / `no_visible_change` / `unverified`. [tested] —
  [src/session/input-handlers.ts:36-40](../../../src/session/input-handlers.ts#L36-L40),
  [:330-353](../../../src/session/input-handlers.ts#L330-L353), [:361-364](../../../src/session/input-handlers.ts#L361-L364)
- **Pid-delivery verification:** the first pid delivery to an app captures before/after and records whether it
  `changed`. — [src/session/input-handlers.ts:229-257](../../../src/session/input-handlers.ts#L229-L257)
- **Result contract:** `Effect = 'verified' | 'changed' | 'no_visible_change' | 'unverified'`; per-route defaults
  (input → `unverified` with a `next_call` to observe; accessibility → `unverified`; window/clipboard read-backs →
  `verified`); one refusal table with `hint` (≤240 chars) and a read-only `next_call`. [tested] —
  [src/session/contract.ts:1-34](../../../src/session/contract.ts#L1-L34), [:94-122](../../../src/session/contract.ts#L94-L122),
  [:129-254](../../../src/session/contract.ts#L129-L254); [test/v7.7-contract.test.mjs](../../../test/v7.7-contract.test.mjs)
- The gaming review notes exact-hash dedup "almost never fires on an animated scene" and `wait_for_stable` "times out on
  a game unless the agent picks a static HUD region", and proposes a perceptual-hash `tolerance` for the waits only
  (dedup stays exact). [doc only] — [docs/reviews/2026-10-25-gaming-computer-use.md:63](../../../docs/reviews/2026-10-25-gaming-computer-use.md#L63),
  [:133](../../../docs/reviews/2026-10-25-gaming-computer-use.md#L133)

### Inferences
- The hash, scope and mapping bookkeeping in `ScreenshotHandler` is reusable as the "frame identity" of a live stream:
  a stream that emits an event only when the hash of a downscaled frame changes would match what dedup and
  `wait_for_stable` already treat as "changed", and `lastMapping()` already gives the image→click mapping a live frame
  would need.
- Because hashes are of encoded JPEG bytes, change detection costs a full encode per sample; a stream-based detector
  would be cheaper on raw pixel buffers (or DXGI dirty rects / SCK frame status), but that is a new mechanism.

### Gaps
- No region- or tile-level diff ("what changed where") exists; every detector answers only changed/unchanged.
- No perceptual or tolerant comparison exists anywhere in the code.

## 3. Push and long-running mechanisms (MCP transport, subscriptions, tasks, progress, HTTP)

### Takeaway
The server can push only small notifications, and only as a side effect of a tool call: `notifications/resources/updated`
(legacy subscribe, or modern `subscriptions/listen` SSE), `tools/list_changed`, logging, and `notifications/progress`
(used by filesystem search only). The Tasks extension runs selected read-only tools in the background but has no
intermediate output and is polled. No server-originated observer produces events between tool calls, and no frame is
pushed anywhere.

### Cited Findings
- **Capabilities:** `logging`, `resources: { subscribe: true }`, `extensions: { io.modelcontextprotocol/tasks,
  io.modelcontextprotocol/ui (only when a desktop broker or the run console is enabled) }`, cache hints, MRTR
  (`inputRequired` max 4 rounds). [tested] — [src/server.ts:169-196](../../../src/server.ts#L169-L196);
  [src/strategy.ts:8](../../../src/strategy.ts#L8)
- `docs/ARCHITECTURE.md` still says "MCP Apps | Not advertised" ([docs/ARCHITECTURE.md:156](../../../docs/ARCHITECTURE.md#L156)),
  which is stale against [src/server.ts:178](../../../src/server.ts#L178).
- **Resource updates are emitted only from `afterToolCall`:** a successful `screenshot` → `computer://screenshot/latest`;
  a successful desktop mutation → `computer://frontmost`, `computer://windows`; filesystem ops → their resource URI;
  profile change → `computer://profile/tools` + `tools/list_changed`. [tested] —
  [src/server.ts:272-310](../../../src/server.ts#L272-L310); [docs/ARCHITECTURE.md:113-124](../../../docs/ARCHITECTURE.md#L113-L124);
  tests [test/mcp-2026.test.mjs:133-165](../../../test/mcp-2026.test.mjs#L133-L165), [test/v7.1-mcp-capabilities.test.mjs:110](../../../test/v7.1-mcp-capabilities.test.mjs#L110)
- `computer://screenshot/latest` is cache-only: it returns the last captured image as a blob and never captures on
  read. [tested] — [src/resources.ts:141-172](../../../src/resources.ts#L141-L172); [test/v6.2-regression.test.mjs:138](../../../test/v6.2-regression.test.mjs#L138)
- **Legacy subscriptions** are connection-local (`resources/subscribe`/`unsubscribe`, `sendResourceUpdated`), authorized
  at creation and delivery; **modern** `subscriptions/listen` is owned by the SDK serving entry, which answers with a
  `text/event-stream` and an acknowledgement first. [tested] —
  [src/mcp-v7.1.ts:25-36](../../../src/mcp-v7.1.ts#L25-L36), [:93-107](../../../src/mcp-v7.1.ts#L93-L107);
  [test/mcp-2026.test.mjs:133-165](../../../test/mcp-2026.test.mjs#L133-L165)
- Restricted HTTP hosts (custom `authorizeToolCall` or a desktop broker) reject `subscriptions/listen` and must poll,
  because the SDK's shared event bus cannot reauthorize each recipient; documented as intentional "until a transport
  with per-recipient delivery authorization is supplied". — [src/server.ts:383-394](../../../src/server.ts#L383-L394);
  [docs/STRATEGY.md:176-181](../../../docs/STRATEGY.md#L176-L181)
- **Transports:** stdio entry (`legacy: 'serve'`, `maxSubscriptions: 256`, wrapped in a Tasks transport bridge);
  per-request fetch handler `createComputerUseHttpHandler` (`legacy: 'stateless'`, one server instance per request,
  `maxSubscriptions: 256`); the bundled `computer-use-mcp-http` runner refuses non-loopback hosts. —
  [src/server.ts:476-494](../../../src/server.ts#L476-L494), [:349-399](../../../src/server.ts#L349-L399);
  [src/http.ts:12-20](../../../src/http.ts#L12-L20); [package.json:24-28](../../../package.json#L24-L28)
- **Progress:** the registry wires `notifications/progress` only when the request carries a `progressToken`, waits for
  queued notifications before the result, and (K10) on legacy stdio sends a `ping` barrier (1 s cap) so the client
  handles progress before the result. Only `filesystem` search reports progress (every 25 entries). [tested] —
  [src/registry/registry.ts:554-576](../../../src/registry/registry.ts#L554-L576), [:611-616](../../../src/registry/registry.ts#L611-L616),
  [:157-176](../../../src/registry/registry.ts#L157-L176); [src/session/admin-handlers.ts:202-218](../../../src/session/admin-handlers.ts#L202-L218);
  tests [test/progress.test.mjs:28](../../../test/progress.test.mjs#L28), [:49](../../../test/progress.test.mjs#L49)
- `wait_for_stable`, `wait_for_text` and `wait_for_window` emit no progress (no `onProgress` use in
  [src/session/agent-desktop-handlers.ts](../../../src/session/agent-desktop-handlers.ts)).
- **Tasks extension:** server-directed, only when the request opts in; eligible tools are `wait` ≥ 2 s, `scrape`,
  `get_ui_tree`, `get_app_dictionary`, vision `snapshot` (not the `wait_for_*` tools). Process-wide store, 192-bit ids,
  TTL 1 h, poll hint 1 s, 16 concurrent per owner; `tasks/get|update|cancel` only, no `tasks/list`. The task's context
  stubs `notify` and `log` to no-ops, and `statusMessage` is set only at start and end, so a task produces no
  intermediate output. "Task notifications through `subscriptions/listen` are optional and are not advertised." [tested] —
  [src/mcp-tasks.ts:95-100](../../../src/mcp-tasks.ts#L95-L100), [:120-123](../../../src/mcp-tasks.ts#L120-L123),
  [:203-252](../../../src/mcp-tasks.ts#L203-L252), [:265-266](../../../src/mcp-tasks.ts#L265-L266);
  [docs/ARCHITECTURE.md:90-111](../../../docs/ARCHITECTURE.md#L90-L111)
- **Logging** is retained for legacy clients and carries only event name, tool, outcome and duration, never screenshots
  or arguments. — [src/server.ts:278-289](../../../src/server.ts#L278-L289); [docs/ARCHITECTURE.md:159-161](../../../docs/ARCHITECTURE.md#L159-L161)
- **Server structure:** `createComputerUseServer` builds the session, a `ToolRegistry` (profile/platform filtered,
  validation, policy, approval, `afterToolCall`), registers v7 tools, optional strategy/browser/run-console extensions,
  the task manager, prompts and resources. — [src/server.ts:161-347](../../../src/server.ts#L161-L347);
  [docs/ARCHITECTURE.md:46-58](../../../docs/ARCHITECTURE.md#L46-L58)
- **Elicitation** exists for approvals only (`elicitInput`, a boolean `approve` form, 60 s timeout; modern clients via
  MRTR). — [src/server.ts:209-243](../../../src/server.ts#L209-L243); [src/registry/registry.ts:505-535](../../../src/registry/registry.ts#L505-L535)
- **Sampling** is not advertised. — [docs/ARCHITECTURE.md:155](../../../docs/ARCHITECTURE.md#L155)

### Inferences
- `subscriptions/listen` (SSE) plus a new subscribable resource (for example `computer://screen/live` or a
  per-target URI) is the only existing standard channel through which the server could tell a host "the screen
  changed" without a tool call. It carries a URI, not the frame; the host would then `resources/read` the latest frame
  (the cache-only `screenshot/latest` pattern). That needs a server-side observer to call `resourceUpdated` outside
  `afterToolCall`, which does not exist.
- The restricted-host rule means the embedded/brokered deployments (the ones with a run console) are exactly the ones
  that cannot use `subscriptions/listen` today.
- A long-running Tasks call (for example a "watch" tool) could carry a live session's lifetime and cancellation, but the
  no-op `notify` means it cannot stream anything until the task context forwards notifications.

### Gaps
- No resource template or URI exists for a live frame; no event schema for "screen changed" beyond `resources/updated`.
- Whether target hosts (Claude Desktop, Cursor, Claude Code) surface `resources/updated` or `subscriptions/listen`
  events to the model is outside this repository and not recorded here.

## 4. The run console (MCP App, frames, transcript, typed messages)

### Takeaway
The run console is the closest existing thing to a shared live view: an MCP App (`ui://computer-use/run-console/v1`)
showing the transcript, plan, activity feed and the latest frame, with a composer through which a person's typed text
and images become `user` turns. But frames arrive only when the agent calls `run_progress` with `capture: true`; the
person's messages reach the agent only on its next run-tool call; and the reference host polls `run_console` every
900 ms and pushes `ui/notifications/tool-result` to the iframe when the run changed. It is enabled only by
`computer-use-mcp-console` or an embedding host, not by the stdio server.

### Cited Findings
- **Tools:** `run_start`, `run_plan`, `run_progress`, `run_say`, `run_spend`, `run_cancel`, `run_attachment`,
  `run_console` (the last carries `_meta.ui.resourceUri`). [tested] — [src/agent-run.ts:720-851](../../../src/agent-run.ts#L720-L851);
  [AGENTS.md "Let a person watch: the run console"](../../../AGENTS.md)
- **App resource:** `text/html;profile=mcp-app` with CSP `connectDomains: [], resourceDomains: [], frameDomains: []`, so
  the page cannot open any network connection of its own. — [src/agent-run.ts:853-860](../../../src/agent-run.ts#L853-L860)
- **Frames:** `run_progress {capture: true, window_id?}` captures server-side through `session.dispatch('screenshot',
  {quality: 70})` and attaches it as `run.screenshot`; a fresh capture also rides back to the agent as an image. The
  model cannot supply image data. [tested] — [src/agent-run.ts:740-772](../../../src/agent-run.ts#L740-L772);
  [src/server.ts:315-330](../../../src/server.ts#L315-L330); tests [test/agent-run-console.test.mjs:241](../../../test/agent-run-console.test.mjs#L241),
  [:289](../../../test/agent-run-console.test.mjs#L289)
- **Persistence:** `COMPUTER_USE_RUN_STORE` writes runs atomically to JSON but never writes frame bytes ("worthless once
  stale"). [tested] — [src/agent-run.ts:196-290](../../../src/agent-run.ts#L196-L290); [test/agent-run-console.test.mjs:669](../../../test/agent-run-console.test.mjs#L669)
- **The person's text:** a `user` turn "is how the person watching steers a run in flight: every tool reply carries the
  whole transcript, so the agent sees it on its next call without polling for it"; `pending` lists unacknowledged user
  turns and `acknowledge` moves the cursor; the transcript is bounded but keeps the opening prompt. Since 7.6.1 the
  model cannot post `role: "user"` (`run_say` has no role). [tested] — [src/agent-run.ts:292-335](../../../src/agent-run.ts#L292-L335),
  [:411-442](../../../src/agent-run.ts#L411-L442), [:774-786](../../../src/agent-run.ts#L774-L786);
  [test/agent-run-console.test.mjs:143-165](../../../test/agent-run-console.test.mjs#L143-L165)
- **Cancel** is cooperative: a flag shown in every run-tool reply; nothing is terminated. [tested] —
  [src/agent-run.ts:811-815](../../../src/agent-run.ts#L811-L815); [test/agent-run-console.test.mjs:551-577](../../../test/agent-run-console.test.mjs#L551-L577)
- **Attachments:** a person's image is written to disk by the host and exposed by path via `run_attachment` (so an app
  such as Blender can open it). — [src/agent-run.ts:42-57](../../../src/agent-run.ts#L42-L57), [:816-846](../../../src/agent-run.ts#L816-L846);
  [src/run-console-host.ts:247](../../../src/run-console-host.ts#L247)
- **Activity feed:** driver-observed thinking and tool calls posted to `/driver/activity` in batches and kept away from
  the agent. [tested] — [src/run-console-host.ts:430-452](../../../src/run-console-host.ts#L430-L452);
  [test/run-console-host.test.mjs:207](../../../test/run-console-host.test.mjs#L207), [test/agent-run-console.test.mjs:326](../../../test/agent-run-console.test.mjs#L326)
- **Page refresh model:** the page speaks the MCP Apps postMessage protocol (`ui/initialize`, protocol version
  `2026-01-26`), re-renders on `ui/notifications/tool-result`, calls `tools/call run_console` once after initialize,
  and otherwise only on its own actions; its 1 s `setInterval(tick)` updates the elapsed clock only, not data. The frame
  is rendered as a `data:` URL. [code; HTML asserted in tests] — [src/run-console.ts:316-317](../../../src/run-console.ts#L316-L317),
  [:321-328](../../../src/run-console.ts#L321-L328), [:399](../../../src/run-console.ts#L399), [:513-514](../../../src/run-console.ts#L513-L514),
  [:577-594](../../../src/run-console.ts#L577-L594)
- The composer sends `run_say {role: 'user', text, image?}` and Stop sends `run_cancel` through the host. —
  [src/run-console.ts:548-569](../../../src/run-console.ts#L548-L569)
- **Reference host (`computer-use-mcp-console`, `src/run-console-host.ts`):** one process owning one run store and one
  session, serving `/mcp` (Streamable HTTP), `/` and `/app` (the app in an iframe with a minimal MCP Apps host), `/rpc`
  (a page allowlist of `run_say`, `run_console`, `run_cancel` with the run id pinned), `/driver`, `/driver/activity`,
  `/driver/usage`; loopback only, Host and Origin validated on every route. The host page **polls** `run_console` every
  900 ms and posts `ui/notifications/tool-result` only when state, `updatedAt`, frame time, message count or activity
  count changed. [tested] — [src/run-console-host.ts:1-50](../../../src/run-console-host.ts#L1-L50),
  [:100-147](../../../src/run-console-host.ts#L100-L147), [:318-376](../../../src/run-console-host.ts#L318-L376),
  [:383-480](../../../src/run-console-host.ts#L383-L480), [:221](../../../src/run-console-host.ts#L221);
  [test/run-console-host.test.mjs:107](../../../test/run-console-host.test.mjs#L107)
- The run console is not enabled by the default stdio server (`serveStdio(() => createComputerUseServer())`), only by
  `runConsole: true`. — [src/server.ts:479](../../../src/server.ts#L479), [:315](../../../src/server.ts#L315)
- **Session console (strategy surface):** `ui://computer-use/session-console/v1`, linked to `desktop_console`, shows
  session state, observed controls and last operation, and is the one place an app pushes into the host conversation:
  clicking a control sends `ui/message {role: 'user', ...}`; teardown pauses the session. [code; protocol harness
  tests per STRATEGY] — [src/session-console.ts:9-16](../../../src/session-console.ts#L9-L16);
  [src/strategy.ts:52-75](../../../src/strategy.ts#L52-L75); [docs/STRATEGY.md:153-167](../../../docs/STRATEGY.md#L153-L167)
- **Desktop broker** (strategy): owner-bound sessions with a `revision`, expiring observations, `pause` that aborts the
  controller and clears observations, `observe` optionally with a screenshot. — [src/desktop-broker.ts:17](../../../src/desktop-broker.ts#L17),
  [:107-118](../../../src/desktop-broker.ts#L107-L118), [:134-146](../../../src/desktop-broker.ts#L134-L146)

### Inferences
- Effective latency today: a person's typed message waits for the agent's next run-tool call (seconds to tens of
  seconds, a model turn); a frame appears only when the agent chooses to capture; the reference host adds up to 900 ms
  of polling. Nothing here is a live stream; it is a narrated slideshow with a chat box.
- The run console's `capture` goes through `session.dispatch('screenshot', …)` directly, so it bypasses the registry's
  `afterToolCall` (no `screenshot/latest` update) and is subject to the unchanged-capture dedup: when the frame is
  unchanged the reply has no image block and `capture` returns `null`, so no frame is attached. This follows from
  [src/server.ts:318-325](../../../src/server.ts#L318-L325) and [src/session/screenshot-handlers.ts:220-224](../../../src/session/screenshot-handlers.ts#L220-L224);
  no test covers it.
- The page's CSP forbids any connection, so a live view inside an MCP App must receive frames through the host's
  postMessage channel (tool results or a future host notification), not a direct WebSocket/SSE from the server.
- The host-side poll-and-diff loop in `run-console-host.ts` is the shape a live host would use, but it should be driven
  by a server event instead of a 900 ms poll.

### Gaps
- No measured end-to-end latency for the console (frame captured → painted, message typed → agent reads it).
- No evidence in the repo that product hosts (Claude Desktop, Cursor, VS Code) push repeated `tool-result`
  notifications for a long-lived app; the 2026-10-09 review says Claude Code does not render MCP Apps at all
  ([docs/reviews/2026-10-09-desktop-control-review.md:220](../../../docs/reviews/2026-10-09-desktop-control-review.md#L220)).

## 5. A person's control (status card, takeover, emergency chord, user-active guard)

### Takeaway
A complete person-in-the-loop layer exists and is on by default on macOS: an always-on-top card showing the resolved
current action with Pause/Resume/Stop, an emergency chord, takeover-pauses-agent, a user-active guard, locked-screen
refusals and a native latch. It runs on physical-input counters and an idle clock read by polling, and the takeover
watch is armed only while a mutating call is in flight. These are directly reusable for a live mode, where person and
agent share the desktop continuously.

### Cited Findings
- **State machine:** `running | paused | stopped`, reasons `person | host | emergency_stop | session_closed | takeover`,
  waiting `user_active | approval`; Pause refuses new mutations (`paused_by_user`) and aborts the one in flight, reads
  continue; Stop latches for the session and trips the native emergency-stop latch. [tested] —
  [src/session/operator-control.ts:1-21](../../../src/session/operator-control.ts#L1-L21), [:30-74](../../../src/session/operator-control.ts#L30-L74);
  [test/v7.6.1-status-card.test.mjs:18](../../../test/v7.6.1-status-card.test.mjs#L18)
- **Card protocol:** the server writes `state.json` atomically (`CardFrame`: state, reason, current `action` label/app/
  window, last 4 `recent` actions, `waiting`, `chord`); the card writes `control.txt`. The server polls `control.txt`
  every 150 ms and also `fs.watch`es it (Stop under 50 ms, tested); the macOS card re-reads `state.json` on a 0.2 s
  timer. Typed text is never written. [tested] — [src/session/operator-control.ts:47-58](../../../src/session/operator-control.ts#L47-L58),
  [:91-92](../../../src/session/operator-control.ts#L91-L92), [:400-408](../../../src/session/operator-control.ts#L400-L408);
  [libexec/macos-status-card.swift:8](../../../libexec/macos-status-card.swift#L8), [:50-51](../../../libexec/macos-status-card.swift#L50-L51),
  [:313](../../../libexec/macos-status-card.swift#L313); tests [test/v7.7-person-control.test.mjs:23](../../../test/v7.7-person-control.test.mjs#L23),
  [test/v7.6.1-status-card.test.mjs:51-67](../../../test/v7.6.1-status-card.test.mjs#L51-L67)
- The card is excluded from captures (macOS by sharing type and by name in the helper; Windows display affinity); on
  Linux X11 it is painted grey in every capture and clicks inside it are refused (`card-guard.ts`). —
  [libexec/macos-agent-helper.swift:143-170](../../../libexec/macos-agent-helper.swift#L143-L170);
  [src/session/operator-control.ts:9-16](../../../src/session/operator-control.ts#L9-L16); [CHANGELOG.md:28-37](../../../CHANGELOG.md#L28-L37)
- **Takeover (K5):** `TAKEOVER_MOVEMENT = 500` (points of physical movement), any physical key or button; checked every
  100 ms **only while a mutating call is active** (`#watchTakeover` armed in `begin` when `options.mutates`); pauses with
  `taken_over` and resumes after 5 s of idle. [tested] — [src/session/operator-control.ts:97-101](../../../src/session/operator-control.ts#L97-L101),
  [:271-279](../../../src/session/operator-control.ts#L271-L279), [:294-338](../../../src/session/operator-control.ts#L294-L338);
  [test/v7.7-person-control.test.mjs:43-71](../../../test/v7.7-person-control.test.mjs#L43-L71)
- **Native physical-input sources:** monotonic counters `PHYSICAL_MOVEMENT/KEYS/BUTTONS` and a last-physical-input clock,
  fed by a passive HID event tap on macOS (re-enabled when the system disables it), low-level hooks that discard
  `LLKHF_INJECTED`/`LLMHF_INJECTED` on Windows, XI2 raw events excluding XTEST on X11, and the Mutter IdleMonitor (minus
  the agent's own input) on GNOME Wayland. Exposed as `getPhysicalInputCounters()` and `getUserIdleTimeMs()` (pull only).
  [code; Rust tests] — [native/src/activity.rs:1-11](../../../native/src/activity.rs#L1-L11), [:27-60](../../../native/src/activity.rs#L27-L60),
  [:331-340](../../../native/src/activity.rs#L331-L340), [:569-584](../../../native/src/activity.rs#L569-L584),
  [:677-679](../../../native/src/activity.rs#L677-L679), [:990](../../../native/src/activity.rs#L990),
  [:1106-1190](../../../native/src/activity.rs#L1106-L1190); wiring [src/session.ts:256-258](../../../src/session.ts#L256-L258)
- **Emergency chord:** `configure_emergency_stop_chord`, a native latch, `wait_for_native_emergency_stop(timeout_ms)`;
  default `ctrl+alt+escape` on macOS and Windows. — [native/src/activity.rs:13-25](../../../native/src/activity.rs#L13-L25),
  [:178-226](../../../native/src/activity.rs#L178-L226); [test/v7.7-person-control.test.mjs:89](../../../test/v7.7-person-control.test.mjs#L89)
- **A worker-thread event pattern already exists:** `DesktopSupervisor` runs `supervisor-worker.ts` in a
  `worker_threads` Worker that loops on `waitForNativeEmergencyStop(25)` and the idle clock and `postMessage`s
  `{type: 'takeover'}` to the main thread. — [src/supervisor.ts:4-21](../../../src/supervisor.ts#L4-L21);
  [src/supervisor-worker.ts:1-25](../../../src/supervisor-worker.ts#L1-L25)
- **User-active guard:** refuses activation or HID input within `COMPUTER_USE_USER_IDLE_MS` (default 4,000 ms on macOS)
  of physical input with `user_active`, unless `force: true` or `delivery: "pid"`; reads never consult it; without
  Input Monitoring it allows everything. [tested] — [src/session/user-activity.ts:1-19](../../../src/session/user-activity.ts#L1-L19)
- **Locked screen** refusals (`screen_locked`, `session_disconnected`, `secure_desktop`) for input and capture. [tested] —
  [test/v7.7-person-control.test.mjs:104](../../../test/v7.7-person-control.test.mjs#L104); [src/session/contract.ts:166-176](../../../src/session/contract.ts#L166-L176)
- **Agent pointer overlay** (`agent_pointer`): a native click-through overlay showing where the agent points
  (`agent_pointer_overlay_show/move/hide/status`), excluded from capture. — [native/src/overlay.rs:255-317](../../../native/src/overlay.rs#L255-L317);
  [src/session/virtual-pointer.ts:19-20](../../../src/session/virtual-pointer.ts#L19-L20)
- 7.7 V3 live run (macOS 26.2): 37/37 checks, including takeover pausing a `hold_key` after 1.8 s and Stop ending a hold
  after 2.1 s. — [docs/specs/v7.7/tasks.md:84](../../../docs/specs/v7.7/tasks.md#L84)

### Inferences
- In a live mode the person is expected to use the mouse and keyboard while the agent watches. The existing pieces map
  well: the user-active guard keeps the agent's input out of the person's way, takeover yields control, the card shows
  what the agent is doing, and the chord stops it. Two changes would be needed: takeover would have to be armed for the
  whole session rather than per mutating call, and the counters could also serve as a "the person is acting" event for
  the model (the person's input as a signal, not only as a veto).
- The worker-thread polling pattern of `DesktopSupervisor` is a ready template for turning pull-only native signals
  (idle clock, counters, latch) into events without adding `ThreadsafeFunction` to the addon.

### Gaps
- No record of what physical input the person performed (only counts and a clock), so the model cannot be told "the
  person clicked X" today; any such capture of the person's actions would also raise privacy questions the codebase has
  not addressed (the card deliberately never shows typed text).

## 6. Accessibility event sources

### Takeaway
Accessibility is on-demand only: tree walks, finds and menu-bar reads per call (now off-thread with timeouts). There is
no AXObserver, no UI Automation event handler, no AT-SPI event listener, and no NSWorkspace activation observer anywhere
in the tree.

### Cited Findings
- A search of `native/src`, `libexec` and `src` for `AXObserver`, `kAXFocusedUIElementChanged`, `kAXValueChanged`,
  `AddAutomationEventHandler`, `AddFocusChangedEventHandler`, `AddStructureChangedEventHandler`,
  `AddPropertyChangedEventHandler`, `SetWinEventHook`, `NSWorkspaceDidActivate`, AT-SPI `EventListener` and
  `ThreadsafeFunction` finds none (matches were only DOM `addEventListener` calls in the console pages).
- macOS walks: 0.5 s messaging timeout per element, 5 s budget per walk, `timedOut` / `ax_timeout`. [tested off-thread] —
  [docs/specs/v7.7/tasks.md:52](../../../docs/specs/v7.7/tasks.md#L52)
- Windows: `CUIAutomation8` with 2 s connection and 5 s transaction timeouts, one client per thread; request/response
  only. — [docs/specs/v7.7/tasks.md:45](../../../docs/specs/v7.7/tasks.md#L45)
- Linux: a fixed AT-SPI script reads one JSON request from stdin and walks the tree; no main loop or listener. —
  [libexec/linux-atspi.py:1-25](../../../libexec/linux-atspi.py#L1-L25)
- `wait_for_window` detects new dialogs by polling window lists every 250 ms. —
  [src/session/agent-desktop-handlers.ts:427-458](../../../src/session/agent-desktop-handlers.ts#L427-L458)
- The Unreal editor's own Mac accessibility manager has a 0.25 s refresh timer (relevant to the v8 bridges). —
  [docs/reviews/2026-10-09-desktop-control-review.md:224](../../../docs/reviews/2026-10-09-desktop-control-review.md#L224)

### Inferences
- Semantic change events (focus moved, window opened, value changed) for a live mode would be new native work on all
  three platforms; until then, window-list polling and frame hashing are the only change signals.

### Gaps
- No measurement of AX/UIA event volume or cost exists in the repository.

## 7. What the docs already say about live, streaming, voice and real-time, and the stated direction

### Takeaway
Streaming has been considered and consistently deferred: "add transport-specific streaming later only if measured need
justifies it" (2026-09-08), a 1-2 fps supervision panel is the last, optional item of the v8 plan, and a persistent
`SCStream` plus a persistent WGC session are scheduled for 7.8 for waits and action-bound frames. The gaming review
argues against continuous streaming to the model ("sample and synchronise rather than stream"). Nothing in the docs or
code addresses voice or live audio.

### Cited Findings
- 2026-09-08 strategy review: the portable console "does not itself provide background OS input, remote desktop
  streaming, or authentication. Add transport-specific streaming later only if measured need justifies it." [doc only] —
  [docs/reviews/2026-09-08-computer-use-strategy.md:255-261](../../../docs/reviews/2026-09-08-computer-use-strategy.md#L255-L261)
- 2026-10-09 desktop-control review, option E: "An MCP App supervision panel | Live window view at 1 to 2 fps, approve
  and deny as app-only tools, point-to-widget | Later, optional. Claude Code doesn't render MCP Apps; Claude Desktop,
  Cursor and VS Code do". [doc only] — [docs/reviews/2026-10-09-desktop-control-review.md:220](../../../docs/reviews/2026-10-09-desktop-control-review.md#L220)
- v8 app-bridges R5 "Supervision panel (optional, last)": `ui://desktop-control/panel` showing the targeted window at
  1-2 fps (JPEG, downscaled), last action's `delivery/route/effect`, approve/deny, point-to-widget; app-only tools
  hidden from the model; hosts without `ui` get an image block and the agent console. [doc only] —
  [docs/specs/v8-app-bridges/requirements.md:83-87](../../../docs/specs/v8-app-bridges/requirements.md#L83-L87)
- Competitor study, rank 10, shipped in 7.8: "A long-lived helper and a persistent SCStream for the waits … a stream
  costs 81 ms to open, then about 17 ms per frame at 60 fps … the lock semantics must survive the move"; listed again
  under "Deferred to 7.8 or later". (The long-lived helper half shipped in 7.7 as `serve`; the stream did not.)
  [doc only] — [docs/reviews/2026-10-23-competitor-study.md:226](../../../docs/reviews/2026-10-23-competitor-study.md#L226),
  [:315-317](../../../docs/reviews/2026-10-23-competitor-study.md#L315-L317)
- Gaming review: "A three-second decision spans 180 frames, so sample and synchronise rather than stream"; "The server's
  job is not to reach 30 Hz"; plan item 9 (P2) "Action-bound frames: `run_steps.capture` gains `frames` (at most 8) and
  `interval_ms` (at least 50), returned as one contact sheet, on the persistent SCStream and a persistent per-target WGC
  session"; item 10 a perceptual-hash `tolerance` for `wait_for_stable`; P1 "belongs in 7.8 beside the persistent helper
  and stream". [doc only] — [docs/reviews/2026-10-25-gaming-computer-use.md:41-59](../../../docs/reviews/2026-10-25-gaming-computer-use.md#L41-L59),
  [:132-133](../../../docs/reviews/2026-10-25-gaming-computer-use.md#L132-L133), [:146](../../../docs/reviews/2026-10-25-gaming-computer-use.md#L146)
- Research notes behind those reviews: SCStream `minimumFrameInterval` 1/30-1/60, `queueDepth` 3-5, sample the latest
  frame on demand; Desktop Duplication exposes dirty and moved rectangles and per-frame timing ("a cheap did-anything-
  change signal"); "Use a threadsafe function … only for progress or streaming (for example SCStream frames for
  `wait_for_stable`)"; a "diff since last observation" idea. [doc only] —
  [performance_techniques.md:68-100](../../../docs/reviews/2026-10-23-inputs/research_notes/Competitor%20study%20and%20improvement%20plan/performance_techniques.md),
  [:153](../../../docs/reviews/2026-10-23-inputs/research_notes/Competitor%20study%20and%20improvement%20plan/performance_techniques.md),
  [:216](../../../docs/reviews/2026-10-23-inputs/research_notes/Competitor%20study%20and%20improvement%20plan/performance_techniques.md);
  [macos_linux_input_capture.md:77-100](../../../docs/reviews/2026-10-25-inputs/research_notes/Gaming%20computer%20use%20for%20agents/macos_linux_input_capture.md)
- Competitors noted as shipping live window previews (cua-driver 0.34.1 `display_only` on `get_window_state`) and
  takeover UX. — [docs/reviews/2026-10-11-end-to-end-review.md:55-58](../../../docs/reviews/2026-10-11-end-to-end-review.md#L55-L58),
  [:268](../../../docs/reviews/2026-10-11-end-to-end-review.md#L268)
- STRATEGY: the session console "needs no network, third-party assets, storage, camera or microphone". —
  [docs/STRATEGY.md:159](../../../docs/STRATEGY.md#L159)
- Voice: the only "voice" hits in docs are VoiceOver (the Unreal accessibility gate). —
  [docs/specs/v8-app-bridges/design.md:11](../../../docs/specs/v8-app-bridges/design.md#L11)
- `packages/computer-use-remote` and `packages/computer-use-supervisor` contain only empty `src/` and `test/`
  directories, although AGENTS.md describes `COMPUTER_USE_REMOTE_*` / `COMPUTER_USE_SUPERVISOR_*` control-plane
  variables. [unbuilt] — [AGENTS.md "Hosting and runtime"](../../../AGENTS.md)

### Inferences
- The stated direction favours synchronised sampling over a stream to the model, and treats a live view as a
  person-facing supervision panel at 1-2 fps. A "share your screen" mode is consistent with that if the stream feeds the
  person's view and a change detector, while the model receives sampled, event-triggered frames.

### Gaps
- No document describes a live mode, a frame-push protocol, a voice channel, or a latency budget for one.

## 8. Gaps: what would have to be built

### Takeaway
(a) Continuous capture with change events needs a persistent capture source per platform (SCStream in the helper,
persistent DXGI/WGC on Windows, PipeWire on Linux), a concurrency model that replaces "one capture at a time" for that
server, and an event (not a reply) when a frame changes. (b) Pushing to the host without a tool call needs a
server-side observer that emits `resources/updated` (or a new notification) outside `afterToolCall`, a frame resource,
and host/app plumbing; the run console's postMessage path and the SSE `subscriptions/listen` entry are the existing
carriers. (c) A person's live text exists only as run-console `user` turns read on the agent's next call; there is no
voice path at all.

### Cited Findings
- (a) Present: warm helper, lock, stall handling, hashes, waits ([§1](#1-capture-what-produces-images-today-at-what-cost-and-could-any-of-it-stream),
  [§2](#2-change-detection-already-present)). Missing: any `SCStream`; any persistent WGC session (closed per call,
  [native/src/capture_win.rs:404-427](../../../native/src/capture_win.rs#L404-L427)); DXGI frame info unused
  ([native/src/capture_win.rs:140](../../../native/src/capture_win.rs#L140)); any PipeWire/ScreenCast; any
  `ThreadsafeFunction` for native→JS events; the helper `serve` loop is sequential
  ([libexec/macos-agent-helper.swift:397-419](../../../libexec/macos-agent-helper.swift#L397-L419)).
- (b) Present: SSE `subscriptions/listen` with acknowledgement ([test/mcp-2026.test.mjs:133-165](../../../test/mcp-2026.test.mjs#L133-L165));
  `resourceUpdated` helper ([src/server.ts:202-207](../../../src/server.ts#L202-L207)); MCP Apps postMessage bridge and
  `ui/notifications/tool-result` re-render ([src/run-console.ts:577-590](../../../src/run-console.ts#L577-L590));
  `ui/message` from an app into the conversation ([src/session-console.ts:9](../../../src/session-console.ts#L9));
  progress notifications ([src/registry/registry.ts:554-576](../../../src/registry/registry.ts#L554-L576)). Missing: an
  emitter that runs between calls; a live-frame resource; task notifications (`notify` is a no-op,
  [src/mcp-tasks.ts:249-250](../../../src/mcp-tasks.ts#L249-L250)); `subscriptions/listen` for restricted hosts
  ([src/server.ts:383-394](../../../src/server.ts#L383-L394)); the app CSP forbids direct connections
  ([src/agent-run.ts:858](../../../src/agent-run.ts#L858)).
- (c) Present: typed messages and images from the console become `user` turns with `pending`/`acknowledge`
  ([src/agent-run.ts:319-335](../../../src/agent-run.ts#L319-L335), [:411-442](../../../src/agent-run.ts#L411-L442)),
  Stop and cancel ([src/run-console.ts:548-552](../../../src/run-console.ts#L548-L552)), physical-input counters and an
  idle clock ([native/src/activity.rs:27-60](../../../native/src/activity.rs#L27-L60)). Missing: any microphone, audio
  or speech code (none found by search); any channel that interrupts the model mid-turn (messages wait for the next
  run-tool call, [src/agent-run.ts:319-323](../../../src/agent-run.ts#L319-L323)); any record of what the person did on
  screen beyond counts.

### Inferences
- Smallest reuse-first path suggested by the inventory: (1) a `stream` subcommand in the Swift helper that keeps one
  `SCStream` per target with a low `minimumFrameInterval`, hashes downscaled frames and writes a line to stdout only on
  change, with `capture` served from the latest stream frame while a stream runs (so the lock is not contended); (2) the
  Windows equivalent on the cached DXGI duplication plus a kept-open WGC session; (3) a session-level observer in
  TypeScript (the `DesktopSupervisor` worker pattern) that turns those lines into `resourceUpdated('computer://…')` and
  card/console updates; (4) the run-console host driven by that event instead of its 900 ms poll; (5) the existing
  person-control layer armed for the whole live session. Voice would be entirely host-side; the server-side contract
  would only be "a person's utterance becomes a `user` turn", which the run store already models.
- Decisions the inventory surfaces but does not settle: whether the model sees a stream or event-triggered samples
  (the gaming review argues for samples); how a live stream coexists with the cross-server capture lock; and whether
  the restricted-host subscription rule must be lifted for brokered deployments.

### Gaps
- No measured cost of keeping a capture stream open on macOS, Windows or Linux in this codebase.
- No host-side evidence (Claude Desktop, Cursor, Claude Code) of support for app-pushed frames or for interrupting a
  model turn with a person's input; outside this repository's scope.
