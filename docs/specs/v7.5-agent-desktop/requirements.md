# v7.5 "agent desktop": requirements

Status: **pre-approved by James 2026-10-01**. Overview and motivation: `games/specs/agent-tooling/README.md` in the
unreal_engine workspace. Last updated 2026-10-01.

## Context

Found while building Nairobi Racer (2026-10-01): the agent avoided this server because (1) macOS input is posted at the
HID tap, so it goes to the frontmost app and moves James's real cursor while he works; (2) Unreal and Blender draw their
own UI, so the accessibility tree is near-empty and only pixel clicks remain; (3) `screenshot {target_app}` returned an
Unreal notification toast instead of the editor window; (4) the backtick key is missing and `type` sends Unicode text, not
key events (games' consoles). Bugs 3–4 are recorded in `games/ROADMAP.md` → "computer-use bugs".

## User stories and acceptance criteria

### R1 Capture the window the agent means
- **When** `screenshot` / `zoom` / `snapshot` is given `target_app`, **then** the main window is chosen: the largest
  titled, layer-0, on-screen window of that app; ties go to the frontmost. `target_title` (substring, case-insensitive)
  picks a specific window.
- `list_windows` labels each window with `kind`: `main`, `document`, `dialog` (AX subrole `AXDialog`/`AXSystemDialog`, or
  a small titled window that is modal-sized), `panel`, `toast` (untitled, small, layer 0 near a screen corner), `other`,
  plus `area` and `isOnScreen`.

### R2 Read a window's text without the accessibility tree
- `read_window_text(target_app | target_window_id, region?, languages?)` returns the recognised text lines with bounding
  boxes (window points and screen points) and confidences, using Apple's on-device Vision framework. No network.
- `click_text(text, target_app | target_window_id, match: exact|contains|regex, nth)` finds the text and clicks the
  centre of its box (subject to R4/R5), returning what it matched.
- Typical cost: a few dozen tokens per call instead of an image.

### R3 Capture without focus or subprocesses
- Window capture uses ScreenCaptureKit (`SCScreenshotManager`, macOS 14+) in a helper: it captures a window that is
  covered or on another part of the screen, never activates it, and returns a file path (and, when asked, the image).
  `screencapture -l` stays as the fallback on older systems.
- Each capture returns a content hash; `previous_hash` short-circuits unchanged frames (existing behaviour kept).

### R4 Don't take over while James works
- **When** a tool needs to activate an app or move the real pointer, and physical keyboard or mouse input happened within
  `COMPUTER_USE_USER_IDLE_MS` (default 4000 ms), **then** the call is refused with `user_active` (how long ago, what it
  would have done) unless `force: true` or the input can be delivered without focus (R5).
- Reads (captures, OCR, lists, AX reads) are never blocked.

### R5 Deliver input to a background app
- `key`, `type`, `left_click` (and `double_click`, `right_click`, `scroll`) accept `delivery: "pid"`: events are posted to
  the target process (`CGEventPostToPid`) without activating it or moving the real cursor; coordinates are window-relative
  when `target_window_id` is given.
- `doctor`/`get_app_capabilities` report whether pid delivery worked for an app the last time it was tried, and the
  result for Unreal Editor and Blender is recorded in the design (spike).
- `delivery: "auto"` (default) uses pid delivery when R4 would refuse focus and the app is known to accept it.

### R6 Real key events
- The key map includes `grave`/`` ` ``/`backtick`, `tilde`, and the remaining punctuation keys; unknown key names list the
  valid ones in the error.
- `type` accepts `mode: "keys"`: each character is sent as key-down/key-up of its virtual key (with shift when needed), so
  apps that bind keys (Unreal's console on the tilde key) receive them. Default stays Unicode text.

### R7 Wait for a window
- `wait_for_window(target_app, kind?, title?, timeout_ms, gone?)` returns as soon as a matching window appears (or
  disappears with `gone: true`), with its id, kind, title and bounds; polls every 250 ms; honours cancellation.

## Compatibility
- Windows and Linux keep their behaviour; new tools report `unsupported` there except R1's selection fix and R6/R7 where
  easy. Existing tool names, arguments and results stay backward compatible; additions are optional fields.
