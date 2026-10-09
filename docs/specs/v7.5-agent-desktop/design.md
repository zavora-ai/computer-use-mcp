# v7.5 "agent desktop": design

Status: **pre-approved by James 2026-10-01; implemented on `feat/v7.5-agent-desktop` (`b97de7e`, PR #35)**. Implements
[requirements.md](requirements.md). Last updated 2026-10-01. "Decided:" notes record choices made during implementation
where this design was open.

## 1. Window choice and kinds (R1)

- `native/src/screenshot.rs` `window_id_for_bundle` → `main_window_for_pid(pid, title_filter)`: walk
  `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly)`, keep layer 0 and owner pid, score by
  `(has_title, area)`, ties to the earlier (frontmost) entry. Same selection in `windows_macos.rs` for anything that
  resolves `target_app` to a window.
- Kinds in `list_windows`: AX subrole when the window is reachable through AX; else heuristics on title, size relative to
  the app's main window and the display, and position (toast: untitled, < 15% of the main window's area, within 120 pt of a
  screen corner or edge).
- Decided: the scoring and the kinds live in TypeScript (`src/session/window-select.ts`), one implementation for every
  platform and testable on canned lists; the Rust `main_window_for_pid` is the same scoring for callers of the native
  module directly. `screenshot`, `zoom`, `snapshot`, `read_window_text`, `click_text` and pid delivery all resolve
  `target_app` (+ `target_title`) in TS and hand native a window id. `target_title` is not a native argument.
- Decided: AX facts come from a new napi `getWindowAxInfo(pid)` (title, role, subrole, modal, bounds; 0.4 s messaging
  timeout), matched to CG windows by bounds (±2 pt). It is consulted only when `list_windows` is narrowed to one app (and
  by `wait_for_window` only for kinds AX can change), so an unfiltered list never waits on a hung app. An AX title fills a
  CG title hidden by a missing Screen Recording permission.
- Decided: heuristic kinds: `main` = the selected window; untitled → `toast` (small + near an edge) or `other`; titled and
  < 40% of the main window → `dialog` when its centre is over the main window, else `panel`; other titled → `document`.
  AX `AXDialog`/`AXSystemDialog`/modal → `dialog`, `AXFloatingWindow`/`AXSystemFloatingWindow` → `panel`,
  `AXStandardWindow` → `main`/`document`. Each window also carries `area` and `kindSource` (`ax` | `heuristic`).

## 2. The Swift helper (R2, R3)

- `libexec/macos-agent-helper.swift`, compiled on first use with `swiftc -O` into
  `~/Library/Caches/computer-use-mcp/macos-agent-helper-<sha8>` (sha of the source; rebuilt when it changes), codesigned
  ad hoc. `swiftc` comes with Xcode or the Command Line Tools; `doctor` reports when it's missing.
- Subcommands, JSON on stdout:
  - `capture --window <id> --out <png> [--scale s]` → `SCShareableContent` → `SCContentFilter(desktopIndependentWindow:)` →
    `SCScreenshotManager.captureImage` → PNG; `{path, width, height, hash}`.
  - `ocr --window <id> | --image <png> [--region x,y,w,h] [--languages en-US,…] [--fast]` → `VNRecognizeTextRequest`
    (accurate by default) → `[{text, confidence, box:{x,y,w,h}}]` in image pixels; TypeScript maps to window and screen
    points with the window bounds and scale.
- TypeScript wrapper `src/session/macos-helper.ts`: spawn with timeout and abort signal; cache the compiled path.
- Decided: the compile writes a unique temp file and renames it into place (two processes never run a half-written
  binary); a failed build is retried after ten minutes rather than on every capture. `capture` uses
  `ignoreShadowsSingleWindow` (no shadow, so `screenshot` now states an exact image→screen mapping) and `scalesToFit`
  (without it SCK draws the window at backing size into the corner of the buffer: a smaller buffer crops, a larger one
  pads). It also takes `--width`, `--format png|jpeg`, `--quality` and `--min-scale`, and returns `{path, width, height,
  hash, scale, frame, mimeType, bytes}`; the hash is the first 16 hex of SHA-256 of the encoded file.
- Decided: window OCR captures at max(backing scale, 2x): on a 1x display Vision reads small UI text better upscaled.
  `--region` is in window points with `--window` (the helper multiplies by its capture scale), image pixels with
  `--image`. TS maps boxes to window points (÷ scale) and screen points (+ window origin from the native bounds).
- Decided: `screenshot` uses the helper only for a window capture (explicit id, `target_app`, or the session's window)
  on macOS 14+ with vision on and no agent-pointer overlay; anything else, and any helper failure, takes the old
  `screencapture` path (`ScreenshotHandler.handleAsync`; the synchronous `handle` is unchanged). `zoom` gained
  `target_app`/`target_window_id`/`target_title`: the region is then in window points, cropped from a full-resolution
  window capture (or from a screen capture offset by the window origin without the helper). `snapshot` with a target
  uses that window for the UI tree and the capture.
- Decided: `read_window_text` args `region` ([x, y, w, h], window points), `languages`, `fast`, `min_confidence`;
  result `{window, count, lines: [{text, confidence, box, screen}], ocrMs}` with integer points. `click_text` args
  `match` (default `contains`), `nth` (1-based, reading order), `button`, `click_count`, plus targeting, `delivery`,
  `force`; a match inside a longer line is clicked at the substring's estimated centre (character offsets are
  proportional across the line box). Off macOS both report `platform_unsupported`.

## 3. Not taking over (R4)

- The native physical-input clock (`native/src/activity.rs`) already records the last hardware event. Expose
  `msSinceLastPhysicalInput()` through napi if it isn't, and a guard in `src/session/focus.ts` used by every handler that
  activates an app or posts HID events. Refusal result: `{status: "user_active", msSinceInput, wouldDo, hint}`.
- Decided: the existing napi `getUserIdleTimeMs()` is the clock (passive HID tap; this server's own events use a private
  source and are not counted). The guard is `src/session/user-activity.ts`; it is consulted by (a) every HID-posting
  input tool (`InputHandler.route`, before any focus change), (b) `focus.ensure` when it would change the frontmost app
  (AX tools such as `click_element`), (c) `activate_app`, `activate_window`, `open_application`. Keyboard input to the
  already-frontmost app counts as taking over (it lands in whatever the user is typing in), so it is guarded too.
  `force: true` (new optional argument on those tools) skips it. `COMPUTER_USE_USER_IDLE_MS=0` disables it.
- Decided: on Windows and Linux the guard is off unless `COMPUTER_USE_USER_IDLE_MS` is set explicitly, so those
  platforms keep their v7.4 behaviour (requirements, Compatibility); their native monitors already support it.
- Decided: when the clock is unavailable (no Input Monitoring permission, or no monitor on the platform) the guard
  allows the call and `doctor` warns (`user_active_guard`); refusing everything would make the server unusable.
- Decided: the result is a structured error (`isError`, `structuredContent`) with `status` and `error` both
  `user_active`, plus `tool`, `msSinceInput`, `thresholdMs`, `wouldDo`, `hint`. A new `StructuredToolError` in
  `errors.ts` carries such payloads through the dispatcher as `errJson`.
- Decided: the session starts the input monitor when it is created, because the monitor counts its own start as input
  and would otherwise refuse the first tool call.

## 4. Pid delivery (R5)

- `native/src/mouse.rs` / `keyboard.rs`: an alternate post path `post_to_pid(pid)` using `CGEvent::post_to_pid`
  (core-graphics) for key, text (unicode string on the event), mouse down/up/move with window-relative → screen location.
- Spike results for Unreal Editor (Slate) and Blender (GHOST) are written in §6, with what reached the app.
- Decided: new napi functions (macOS): `keyPressToPid`, `typeTextToPid`, `typeKeysToPid`, `mouseClickToPid(pid, x, y,
  button, count, windowId?)`, `mouseScrollToPid(pid, x, y, dy, dx, windowId?)`. Mouse events carry the target window
  number in fields 91/92 (window under pointer / that can handle the event). core-graphics' `elcapitan` feature
  provides `post_to_pid`; `foreign-types` gives `CGEventSetLocation` its event pointer.
- Decided: pid delivery covers `key`, `type`, the five click tools, `scroll` and `click_text` (`delivery` argument);
  `hold_key`, drags and `mouse_move` stay HID-only and refuse `delivery: "pid"`. With `type` the clipboard paste is never
  used (cmd+v would land in the user's app); `clear`/`caret_position`/`press_enter` go to the pid too.
- Decided: coordinates are window-relative only for an explicit `delivery: "pid"` with `target_window_id`; when `auto`
  switches to pid on its own the caller's screen coordinates are kept, so the meaning of a coordinate never changes
  silently. `click_text` always passes screen points.
- Decided: "worked the last time" is observed, not assumed: the first pid delivery of each input class to an app (and
  each one until a change is seen) captures the target window twice before (250 ms apart; a difference means the window
  is changing on its own → `unverified`) and once 250 ms after, and records `changed` or `no_visible_change`. Records are
  per app **and per input class** (`keyboard` for key/type, `pointer` for clicks/scroll), because the TextEdit spike
  showed keys working while clicks did nothing. They persist in `~/Library/Caches/computer-use-mcp/pid-delivery.json`
  (memory only when a test injects the native module) and are reported by `doctor` (`pid_delivery`) and
  `get_app_capabilities` (`pidDelivery`). `auto` uses pid only for a class recorded `changed`.

## 5. Keys and waiting (R6, R7)

- Key map additions: `grave` (kVK_ANSI_Grave 0x32), `backtick`, `` ` ``, `tilde` (shift+grave), `minus`, `equal`,
  `leftbracket`, `rightbracket`, `backslash`, `semicolon`, `quote`, `comma`, `period`, `slash` where missing.
- `type mode:"keys"`: map each char through the current keyboard layout (`UCKeyTranslate` reverse table built once per
  process for US-ANSI at least), falling back to unicode text for unmapped characters.
- `wait_for_window`: polling loop in TypeScript over the native window list with the R1 kinds.
- Decided: key names are resolved in TypeScript (`src/session/keys.ts`) for every platform: aliases (`grave`, `backtick`,
  `backquote`, `tilde`/`~` → shift+grave, `minus`, `underscore`, `equal`, `plus`, brackets, braces, `backslash`, `pipe`,
  `semicolon`, `colon`, `quote`, `doublequote`, `comma`, `period`, `slash`, `question`, shifted digits, `page_up`, arrows…),
  `meta` → `cmd` (and `super`/`win` → `cmd` on macOS), `forwarddelete` → `delete` off macOS, modifiers deduplicated.
  Unknown names are refused before anything is focused, with the full list of valid names; a native "Unknown key" is
  rewrapped with the list too. `hold_key` expands aliases the same way. The macOS native map gained `grave`, `backtick`,
  `forwarddelete` and F13–F20. Combos the native maps never knew (`page_down`, `period`) now reach them resolved.
- Decided: `typeKeys(text)` (napi, macOS) uses the UCKeyTranslate table for the current layout (no modifier, shift,
  option, shift+option; keypad codes skipped; first mapping wins) when called on the main thread, else a US-ANSI table
  (Text Input Sources assert the main thread on macOS 14+). It returns `{keys, unicode, layout}`. Elsewhere (Windows,
  Linux, an older native module) TS sends each character through `keyPress` with its US-ANSI combo and falls back to
  `typeText` for characters no key produces.
- Decided: `wait_for_window(target_app, kind?, title?, timeout_ms = 10000 (max 120000), gone = false)` returns
  `{found, window: {windowId, kind, title, bounds, kindSource}, waitedMs, polls}` or `{gone, waitedMs, polls}`; a timeout
  is a structured error with the windows seen; cancellation returns `cancelled`. It works wherever `listWindows` works.

## 6. Spike results

Recorded 2026-10-01 on the M4 (macOS 26.2, one 2560×1080 display at 1x), while James was using the Mac. Every input
check went to TextEdit opened in the background (`open -g`), behind the full-width Claude window, with pid delivery;
nothing was typed into or clicked in any other app, and nothing was sent to Unreal or Blender.

**Verified**

- Window choice (R1): `list_windows {bundle_id: com.epicgames.UnrealEditor}` → one window, `main` (kindSource `ax`,
  `AXStandardWindow`); `screenshot {target_app}` captured the 1589×927 editor via ScreenCaptureKit in 139 ms; the native
  fallback `takeScreenshot(…, "com.epicgames.UnrealEditor")` also picked the editor (800×480 with shadow). No toast was
  up during the check, so the toast case itself is covered by the unit test built from the reported geometry
  (352×81 untitled window in front of the editor), not live.
- Covered capture (R3): the TextEdit window, fully covered by the Claude window, captured cleanly (no shadow, exact
  mapping); TextEdit and Claude stayed where they were. First call 3.3 s (helper compile), then ~0.1–0.6 s per capture.
- OCR (R2): TextEdit text read exactly ("Hello from the v7.5 OCR check"; one line split in two by Vision); the Unreal
  editor window read in 0.5 s (84 lines: menus, toolbar, Outliner rows). Token cost: a whole editor window is ~10 k
  characters of JSON (~2.5 k tokens) — use `region` for a few dozen tokens. An early build asked SCK for a 2x buffer
  without `scalesToFit` and got the window drawn into one corner, so boxes were off; with it, Calendar boxes matched the
  image to the point.
- Pid delivery into background TextEdit (R5): **keyboard reaches it** — `type` (Unicode), `key grave` and `type
  mode:"keys"` ("`~stat fps") all arrived exactly (checked with AppleScript `text of document 1`); TextEdit was never
  activated, the cursor never moved, frontmost stayed with James's app. **Menu shortcuts do not** (`cmd+p` opened no
  print sheet: key equivalents go through the menu of the active app). **Clicks do not reach the text view** (a pid
  double-click on "Hello" via `click_text` selected nothing; the window is not key and NSTextView does not accept the
  first mouse); scroll showed no change either. Recorded as TextEdit keyboard `changed`, pointer `no_visible_change`.
- Auto delivery + guard (R4): with the threshold raised so the guard was certainly active, `key period` to TextEdit
  switched to pid on its own (keyboard known good); `left_click` and `activate_app` were refused with `user_active`
  (nothing sent). The physical-input clock read 5–330 ms while James worked (Input Monitoring granted to the host).
- `wait_for_window` saw the TextEdit window at once and reported it gone 1 s after AppleScript closed TextEdit; `zoom
  {target_app, region}` cropped the right window region; `doctor` reports `agent_helper`, `user_active_guard` and
  `pid_delivery` as pass.

**Not verified**

- The click_text-on-a-dialog-button check from §7: TextEdit's background window offered no dialog reachable without
  activating it (menu shortcuts don't fire in the background), and clicks into an inactive Cocoa window don't land.
  click_text itself was verified end to end (OCR → match → pid click at the matched point) — the click had no effect.
- Toast OCR in Unreal and a Blender dialog: no toast was up and Blender was not running.
- Older macOS (13, no SCK) fallback, and Windows/Linux builds: only `cargo check --target x86_64-pc-windows-msvc`
  passed; the Linux check needs X11 headers this Mac lacks.

**Unreal Editor spike (run 2026-10-01 by the editor's owner, editor in the background behind the Claude window)**

- `wait_for_window {kind: main}` found the editor in 28 ms; `read_window_text` on the menu-bar region read "File Edit
  Window Tools Build …" and the open map name.
- **Keyboard reaches Unreal:** `key grave` (verification: changed) then `type "stat fps" mode:"keys" press_enter` with
  `delivery: "pid"` — the editor log shows `Cmd: stat fps`. Nothing was activated and the cursor never moved.
- **Pointer doesn't:** `click_text "Window"` with pid delivery hit the right point (189, 45) but no menu opened (as with
  TextEdit: an inactive window drops the first click). Escape via pid was sent afterwards.
- Blender wasn't running; its spike is still pending (steps below).

**Pending — Blender**

Run when no other agent drives the editor, with the editor in the background behind another window:

1. `wait_for_window {target_app: "com.epicgames.UnrealEditor", kind: "main"}` → note `windowId`.
2. `read_window_text {target_window_id, region: [0, 0, 600, 40]}` → expect the menu bar ("File Edit Window …").
3. Keyboard: click into the viewport once by hand so Slate has keyboard focus, put another app in front, then
   `key {text: "grave", target_app: "com.epicgames.UnrealEditor", delivery: "pid"}` and
   `type {text: "stat fps", mode: "keys", target_app: "com.epicgames.UnrealEditor", delivery: "pid", press_enter: true}`;
   check with `screenshot {target_app}` whether the console opened and the FPS overlay appears.
4. Pointer: `click_text {text: "Window", target_app: "com.epicgames.UnrealEditor", delivery: "pid"}` → does the Window
   menu open (capture again)? Then `key {text: "escape", …, delivery: "pid"}`.
5. Repeat 2–4 for Blender (`org.blenderfoundation.blender`; e.g. `click_text {text: "File"}`, `key {text: "n"}` over
   the 3D viewport to toggle the sidebar).
6. `doctor` → the `pid_delivery` check lists the recorded keyboard/pointer outcome per app; copy them here.

## 7. Testing

- Unit tests (node --test) for selection scoring and kind heuristics on canned window lists, the key map, OCR box mapping,
  the user-active guard (fake clock), and `wait_for_window` with a fake window source.
- Live checks (`scripts/` or a test gated by an env var): capture a covered TextEdit window via SCK; OCR it; `click_text`
  on a TextEdit dialog button with `delivery:"pid"`; backtick via `key`.
- Decided: unit tests are `test/v7.5-window-select.test.mjs`, `test/v7.5-keys.test.mjs` and
  `test/v7.5-agent-desktop.test.mjs` (helper wrapper with a fake runner, OCR mapping, text matching, the tools over a fake
  helper, the guard with a fake clock, auto/pid routing and verification, `wait_for_window` with a fake window source,
  the SCK screenshot path and its fallback). The live checks were run by hand (results in §6) rather than as a gated
  test, because they open TextEdit on the user's desktop.
