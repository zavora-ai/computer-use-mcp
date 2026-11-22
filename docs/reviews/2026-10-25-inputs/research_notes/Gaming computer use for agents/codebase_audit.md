# What computer-use-mcp 7.7.0 can and cannot do for driving video games (codebase audit)

Scope: source and docs of `computer-use-mcp` at `main` commit `0c79450` (package version 7.7.0, `package.json:3`). Citations are repo-relative paths with line numbers; link targets are the same paths. No web sources were used. Where a repo doc summarises an outside source, the note says so. Nothing was modified.

## 1. Mouse input: absolute or relative, deltas, drags, buttons, pid delivery

### Takeaway
Every pointer move on every platform is an **absolute warp to a screen point that must lie on a display**. No relative-motion (delta) primitive exists anywhere. macOS mouse events never set `kCGMouseEventDeltaX/Y`. Mouse-look camera control (pointer lock, raw input, unbounded turning) is therefore unsupported. The nearest thing is `mouse_drag`, which interpolates absolute points with a held button (8 events per segment, 8 ms apart). That suits editor viewports (Blender orbit) but is in the `ax` profile, not the default one.

### Cited Findings
**macOS (CoreGraphics)**
- Events are created with a private source (`CGEventSourceStateID::Private`) and posted at the HID tap (`CGEventTapLocation::HID`) — [native/src/mouse.rs:519-527](native/src/mouse.rs#L519).
- `mouse_move` creates `CGEventType::MouseMoved` at an absolute `CGPoint::new(x, y)`. It sets no other fields — [native/src/mouse.rs:529-545](native/src/mouse.rs#L529).
- No code in `native/src/mouse.rs` reads or writes `MOUSE_EVENT_DELTA_X/Y`. The only use of those fields in the whole native crate is the *physical-input monitor*, which reads the person's deltas — [native/src/activity.rs:412-419](native/src/activity.rs#L412). (Repo-wide grep for `DELTA`, `delta_x`, `relative`.)
- Click: move, then `sleep(15 ms)`, then down and up posted back to back with `MOUSE_EVENT_CLICK_STATE = i`. There are 30 ms between repeated clicks and no hold time between down and up — [native/src/mouse.rs:679-732](native/src/mouse.rs#L679). The TypeScript click path adds `mouseMove` then `sleep(50)` before the native click — [src/session/input-handlers.ts:313-320](src/session/input-handlers.ts#L313).
- Button-aware press, drag and release (`mouse_press`, `mouse_drag_to`, `mouse_release`) cover left, right and middle (`OtherMouse*`). Modifiers ride on the event flags (shift, ctrl, alt, cmd). The release carries no flags — [native/src/mouse.rs:547-668](native/src/mouse.rs#L547).
- `mouse_button` (behind `left_mouse_down` / `left_mouse_up`) is left-button only — [native/src/mouse.rs:735-762](native/src/mouse.rs#L735). The legacy native `mouse_drag` posts only `LeftMouseDragged` — [native/src/mouse.rs:799-812](native/src/mouse.rs#L799).
- Scroll uses `ScrollEventUnit::LINE` with integer line counts — [native/src/mouse.rs:788-797](native/src/mouse.rs#L788).

**Windows (SendInput)**
- Every move and button event uses `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`: `const ABSOLUTE: MOUSE_EVENT_FLAGS = MOUSE_EVENT_FLAGS(MOUSEEVENTF_ABSOLUTE.0 | MOUSEEVENTF_VIRTUALDESK.0);` — [native/src/mouse.rs:946-954](native/src/mouse.rs#L946).
- Coordinates are normalised 0..65535 over the virtual desktop and clamped to it: `(value - origin).clamp(0.0, (size - 1))` — [native/src/mouse.rs:1223-1228](native/src/mouse.rs#L1223).
- `mouse_move` is `send_mouse(ax, ay, MOUSEEVENTF_MOVE | ABSOLUTE, 0)` — [native/src/mouse.rs:1092-1096](native/src/mouse.rs#L1092). No call anywhere sends `MOUSEEVENTF_MOVE` without `ABSOLUTE`. Wheel events send `(0, 0)` with the wheel flag only — [native/src/mouse.rs:1176-1187](native/src/mouse.rs#L1176).
- Click: absolute move, `sleep(10 ms)`, then down and up **in one atomic `SendInput`**, so the button is held for 0 ms — [native/src/mouse.rs:1108-1138](native/src/mouse.rs#L1108).
- Windows mouse events carry no modifier state, so a `ModifierGuard` sends real VK key-downs and key-ups around the press and release — [native/src/mouse.rs:1001-1072](native/src/mouse.rs#L1001).
- `SendInput` returning fewer events than asked is an `input_blocked` error. The message names UIPI against an elevated foreground window, the lock screen or UAC — [native/src/keyboard.rs:1043-1060](native/src/keyboard.rs#L1043).

**Linux**
- X11 `mouse_move` is `XWarpPointer(dpy, 0, root, 0,0,0,0, x, y)`, not an XTest motion event. Clicks and drags also warp and then use `XTestFakeButtonEvent`. Each call opens and closes the X display — [native/src/mouse.rs:28-60](native/src/mouse.rs#L28), [native/src/mouse.rs:107-136](native/src/mouse.rs#L107).
- ydotool moves with `ydotool mousemove --absolute -x .. -y ..` — [native/src/mouse.rs:169-172](native/src/mouse.rs#L169). Button-held drags are refused on ydotool ("Button-aware drags are unavailable through ydotool") — [native/src/mouse.rs:381-387](native/src/mouse.rs#L381).
- libei: `Action::Move` is documented as "Absolute pointer motion, in logical desktop pixels" — [native/src/linux_ei.rs:172-176](native/src/linux_ei.rs#L172). It is sent with `PointerAbsolute::motion_absolute` — [native/src/linux_ei.rs:598-607](native/src/linux_ei.rs#L598). The seat binds `Pointer` (relative) as a capability but never emits relative motion. Device choice prefers `PointerAbsolute` — [native/src/linux_ei.rs:505-513](native/src/linux_ei.rs#L505), [native/src/linux_ei.rs:543-560](native/src/linux_ei.rs#L543).
- libei sleeps 2 ms after every event ("as real hardware would send them") — [native/src/linux_ei.rs:628-634](native/src/linux_ei.rs#L628). A libei move took 2 ms on Ubuntu 24.04 — [docs/specs/v7.7/wayland.md:92-94](docs/specs/v7.7/wayland.md#L92).

**Server layer (tools)**
- `#validateCoordinates` refuses any point outside every display ("Coordinates (x, y) are outside display bounds"). `mouse_move`, `left_click_drag`, `mouse_drag` and click all call it — [src/session/input-handlers.ts:792-799](src/session/input-handlers.ts#L792), [src/session/input-handlers.ts:425-432](src/session/input-handlers.ts#L425).
- `mouse_drag` schema: `path` has 2–64 waypoints; `button` is left, middle or right; `modifiers` are shift, ctrl, alt or cmd; `steps` is 1–64, default 8 — [src/registry/definitions.ts:160-170](src/registry/definitions.ts#L160). The handler moves to the start, sleeps 15 ms, presses, emits `steps` linear points per segment with `sleep(8)` between them, and always releases in `finally`. Its comment: "applications that integrate incremental motion — 3D viewport orbit, canvas painting — ignore a single jump to the endpoint" — [src/session/input-handlers.ts:617-664](src/session/input-handlers.ts#L617).
- `left_click_drag` uses the left button only, with 16 ms between waypoints and no interpolation — [src/session/input-handlers.ts:435-455](src/session/input-handlers.ts#L435).
- Profiles: `mouse_move`, `click`, `scroll`, `key`, `type` and `hold_key` are `core`. `mouse_drag`, `left_click_drag` and `left_mouse_down/up` are `ax`, so they are absent from the default `desktop` profile — [src/tool-catalog.ts:156-173](src/tool-catalog.ts#L156). The Blender skill says the same: "`mouse_drag` (in the `ax` and `full` profiles, not the default `desktop` one)" — [skills/blender-agent/SKILL.md:102](skills/blender-agent/SKILL.md#L102).

**Pid delivery (no focus, no cursor)**
- macOS only: "Pid delivery (CGEventPostToPid) is macOS only" — [src/session/input-handlers.ts:184-192](src/session/input-handlers.ts#L184).
- Covered tools: click variants, `scroll`, `type`, `key` and `click_text`. Not `mouse_move`, `mouse_drag` or `hold_key` — [src/session/input-handlers.ts:55-59](src/session/input-handlers.ts#L55), [src/session/input-handlers.ts:154-165](src/session/input-handlers.ts#L154).
- Pid clicks tag window fields 91/92 so Cocoa routes them to the intended window — [native/src/mouse.rs:814-871](native/src/mouse.rs#L814).
- The first pid delivery to an app is verified by captures before and after, with two 250 ms sleeps — [src/session/input-handlers.ts:227-257](src/session/input-handlers.ts#L227). Outcomes persist per app and per input class (keyboard or pointer). The module's own caveat: "apps that read the hardware state directly may not [act on them]" — [src/session/pid-delivery.ts:1-14](src/session/pid-delivery.ts#L1).
- An internal research note (summarising cua's docs) says Blender GHOST and Unity "accept input only from `cghidEventTap` after a `mouseMoved`", so background input to canvas and game apps is dropped — [docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md:48](docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md#L48), [docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md:136-141](docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md#L136).

### Inferences
- First-person mouse-look will not work reliably. Games lock or recentre the pointer and read relative deltas (Raw Input `WM_INPUT` on Windows, HID or `GCMouse` deltas on macOS, XI2 raw motion or relative pointer on Linux). The server sends only absolute positions inside display bounds, and macOS events carry zero deltas.
  - On Windows, absolute SendInput arrives in raw input flagged absolute. Many games ignore that. This is general platform knowledge, not verified in this repo.
  - On X11, `XWarpPointer` generates no XI2 raw motion at all.
- Instant clicks and key taps (0 ms between down and up on Windows; back to back on macOS) can be missed by games that poll button state once per frame. There is no click-hold duration parameter. `left_mouse_down` / `left_mouse_up` give a held left button only, and only in the `ax` profile.
- `mouse_drag` is the only interpolated motion tool. Its fastest cadence is about 8 ms per event, with a 64 × 63 events-per-call ceiling. It always holds a button, so plain unbuttoned "look" motion has no interpolated tool; `mouse_move` is a single jump.

### Gaps
- No measurement in the repo of how any game engine reacts to these synthetic absolute events: SDL relative mode, Unreal viewport fly-through, Unity Input System.
- Whether macOS's window server fills delta fields for a posted absolute `MouseMoved` cannot be settled from this code. The code only shows it never sets them.

## 2. Keyboard input: virtual keys vs scan codes, timing, hold_key, type modes

### Takeaway
Windows keys are sent as **virtual-key codes with `wScan: 0`**; `KEYEVENTF_SCANCODE` and `KEYEVENTF_EXTENDEDKEY` do not appear anywhere. macOS uses CGEvent virtual keycodes. Linux uses evdev or X keycodes on a fixed US layout. Taps have no hold time. `hold_key` gives a real held state (one key-down, an awaited timer, a key-up) for up to 10 s, and can hold several keys at once. It cannot run alongside mouse motion, because `run_steps` is sequential and no `key_down` / `key_up` tool is exposed. On macOS, Windows and X11 a combo keeps only one non-modifier key.

### Cited Findings
**Windows**
- `key_input` builds `KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: 0 | KEYEVENTF_KEYUP }` — [native/src/keyboard.rs:1062-1075](native/src/keyboard.rs#L1062).
- A repo-wide grep finds no `KEYEVENTF_SCANCODE`, `MapVirtualKey` or `KEYEVENTF_EXTENDEDKEY`.
- The key map covers letters, digits, F1–F20, home, end, page keys, arrows, return, tab, space, backspace, delete, escape, capslock and punctuation. Modifiers are generic (`VK_SHIFT`, `VK_CONTROL`, `VK_MENU`, `VK_LWIN`), and `fn` maps to `VK_F24`. There are **no numpad, insert, pause, print-screen or right-hand modifier keys** — [native/src/keyboard.rs:969-1034](native/src/keyboard.rs#L969). The union accepted by the server is the same — [src/session/keys.ts:16-22](src/session/keys.ts#L16).
- `key_press` sends the whole chord (modifier downs, key down, key up, modifier ups) in one atomic `SendInput`, so the key is held 0 ms. Repeats are 5 ms apart — [native/src/keyboard.rs:1078-1114](native/src/keyboard.rs#L1078).
- `type_text` sends every UTF-16 unit as `KEYEVENTF_UNICODE` (`wVk 0`, `wScan = char`) in one `SendInput`. `\n` becomes a real `VK_RETURN` — [native/src/keyboard.rs:1117-1162](native/src/keyboard.rs#L1117).

**macOS**
- `key_press_impl` posts `CGEvent::new_keyboard_event(code, true)` then `(code, false)` back to back, with modifiers as flags and the last key-up flagless. Repeats are 5 ms apart. It goes to the HID tap or, with pid delivery, to one process — [native/src/keyboard.rs:384-394](native/src/keyboard.rs#L384), [native/src/keyboard.rs:512-549](native/src/keyboard.rs#L512).
- `type_text` posts keycode 0 with `set_string_from_utf16_unchecked` in 20-unit chunks, 3 ms apart — [native/src/keyboard.rs:562-582](native/src/keyboard.rs#L562).
- `type_keys` (`type mode: "keys"`) maps each character through the current layout (UCKeyTranslate) to a real virtual key with shift or option, 4 ms per character. Characters the layout cannot produce fall back to Unicode text — [native/src/keyboard.rs:597-841](native/src/keyboard.rs#L597).
- Its doc comment names games: "apps that bind keys rather than read text — a game console on the grave/tilde key" — [native/src/keyboard.rs:843-848](native/src/keyboard.rs#L843). The key map comment: "kVK_ANSI_Grave: the key Unreal (and most games) bind the console to" — [native/src/keyboard.rs:493-496](native/src/keyboard.rs#L493).

**Combos keep one main key**
- On macOS, every non-modifier part overwrites `main_key = Some(code)`, so `"w+a"` presses only `a` — [native/src/keyboard.rs:521-531](native/src/keyboard.rs#L521).
- Windows does the same — [native/src/keyboard.rs:1084-1098](native/src/keyboard.rs#L1084), and so does X11 — [native/src/keyboard.rs:199-216](native/src/keyboard.rs#L199).
- libei presses every key in the combo — [native/src/keyboard.rs:168-186](native/src/keyboard.rs#L168).
- The TypeScript normaliser passes several keys through in order — [src/session/keys.ts:109-120](src/session/keys.ts#L109).

**hold_key**
- Schema: `keys: string[]`, `duration` positive, at most 10 seconds — [src/registry/definitions.ts:212-219](src/registry/definitions.ts#L212). `MAX_HOLD_SECONDS = 10` "so a forgotten hold cannot keep keys down for long" — [src/session/input-handlers.ts:28-33](src/session/input-handlers.ts#L28).
- Since 7.7 the handler calls `keyDown(keys)`, then `sleepAbortable(duration*1000, signal)`, then `keyUp(keys)` in `finally`. An interrupted hold is an error stating the keys were released — [src/session/input-handlers.ts:568-596](src/session/input-handlers.ts#L568).
- Native `key_down` posts one key-down per key, with accumulated modifier flags on macOS, and records it in `HELD_KEYS`. No auto-repeat events are generated — [native/src/keyboard.rs:860-944](native/src/keyboard.rs#L860) (macOS), [native/src/keyboard.rs:1163-1222](native/src/keyboard.rs#L1163) (Windows).
- `key_down` and `key_up` are native only. The MCP surface lists `hold_key` but no `key_down` / `key_up` tool — [src/session/input-handlers.ts:18-24](src/session/input-handlers.ts#L18).
- The 2026-10-23 competitor study's claim that "`hold_key` blocks" (one synchronous native sleep) describes 7.6.1, before this fix — [docs/reviews/2026-10-23-competitor-study.md:128](docs/reviews/2026-10-23-competitor-study.md#L128).

**`type` modes**
- `mode: "text"` (default): Unicode text, pasted through the clipboard when longer than 100 characters or multi-line. `mode: "keys"`: real key events, never pasted — [src/registry/definitions.ts:187-199](src/registry/definitions.ts#L187), [src/session/input-handlers.ts:498-531](src/session/input-handlers.ts#L498).
- Off macOS, `mode: "keys"` falls back to `charToUsCombo` and `keyPress` per character, with a 4 ms sleep (US layout) — [src/session/input-handlers.ts:772-790](src/session/input-handlers.ts#L772).

**Linux**
- libei types through evdev codes on a US layout. Characters outside it are an error telling the caller to paste — [native/src/linux_ei.rs:86-170](native/src/linux_ei.rs#L86).
- Reading the compositor's XKB keymap is listed as "the next step" — [docs/specs/v7.7/wayland.md:89-91](docs/specs/v7.7/wayland.md#L89).
- X11 uses `XTestFakeKeyEvent` with fixed X keycodes; ydotool uses evdev codes (X keycode − 8) — [native/src/keyboard.rs:10-150](native/src/keyboard.rs#L10).

### Inferences
- **Scan codes:** many DirectInput and Raw Input games read hardware scan codes. With `wScan: 0` and no `KEYEVENTF_SCANCODE`, Windows key events may not register in such games. This is platform knowledge, not tested here; it is a likely top gap for Windows games.
- **WASD-plus-look is not expressible.**
  - `hold_key(['w','a'], 1.5)` gives diagonal movement for 1.5 s, and blocks the call while it runs.
  - A held key cannot overlap a mouse move or drag. `run_steps` awaits each step in turn, and the only overlapping tool is `mouse_drag` with modifier keys (shift, ctrl, alt, cmd).
- **Taps:** a short `hold_key` (for example 0.05 s) is the workaround for games that miss 0 ms taps; `key` has no duration. An internal note cites cua #3757: state-polled games (Doom) ignore taps — [docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md:59](docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md#L59).

### Gaps
- No test or measurement in the repo of `KEYEVENTF_SCANCODE` versus VK delivery to games.
- No numpad or extended-key support, so games binding numpad keys cannot be driven.
- No per-key delay parameter for `key`, and no tool-level key-down / key-up primitives.

## 3. Screen capture: ladders, rate, dedup, size, video

### Takeaway
Capture is **one still image per call**. There is no video, no burst and no persistent stream.
- **macOS:** one-shot `SCScreenshotManager.captureImage` per request through a warm helper process. Measured at about 62 ms warm and 112–128 ms end to end per `screenshot`. Captures are serialised across all servers.
- **Windows:** windows climb PrintWindow, then Windows.Graphics.Capture (a new session per call), then a DXGI screen crop, then BitBlt. The screen comes from cached DXGI desktop duplication.
- **Linux:** shells out to grim, gnome-screenshot, the XDG portal, ImageMagick `import` or scrot.

At the defaults the observation ceiling is roughly 8 frames per second on macOS before any model round trip. The unchanged-frame dedup is exact-hash and so will rarely fire on an animated game.

### Cited Findings
**macOS**
- The helper captures a window or display with `SCScreenshotManager.captureImage`, `scalesToFit = true`, `showsCursor = false`. Every SCK call has a 10 s `sck_timeout` — [libexec/macos-agent-helper.swift:78-140](libexec/macos-agent-helper.swift#L78), [libexec/macos-agent-helper.swift:152-186](libexec/macos-agent-helper.swift#L152).
- It encodes PNG or JPEG to a file and returns a 16-hex SHA-256 `hash` — [libexec/macos-agent-helper.swift:214-231](libexec/macos-agent-helper.swift#L214), [libexec/macos-agent-helper.swift:294-331](libexec/macos-agent-helper.swift#L294).
- `serve` mode: one JSON request per stdin line — [libexec/macos-agent-helper.swift:371-431](libexec/macos-agent-helper.swift#L371). One warm helper per server, stopped after 30 s idle; call timeout 30 s — [src/session/macos-helper.ts:205-207](src/session/macos-helper.ts#L205), [src/session/macos-helper.ts:279-285](src/session/macos-helper.ts#L279).
- Serialisation: "Two ScreenCaptureKit captures running at once hang each other". Helper runs go through a promise chain plus a lock file shared across servers (`helper_busy`) — [src/session/macos-helper.ts:232-275](src/session/macos-helper.ts#L232).
- Measured on macOS 26.2: "62 ms per warm capture, 112-128 ms per `screenshot` end to end, against 157-223 ms before" — [CHANGELOG.md:33-36](CHANGELOG.md#L33); also [AGENTS.md:61](AGENTS.md#L61).
- The competitor study measured about 89 ms in-process for a one-shot capture. It quotes sckit-go (an outside source): a persistent SCStream costs 81 ms to open, then about 17 ms per frame at 60 fps. "A long-lived helper and a persistent SCStream for the waits" is planned for 7.8 — [docs/reviews/2026-10-23-competitor-study.md:226](docs/reviews/2026-10-23-competitor-study.md#L226), [docs/reviews/2026-10-23-competitor-study.md:317](docs/reviews/2026-10-23-competitor-study.md#L317).

**Windows**
- The ladder: (1) `PrintWindow(PW_RENDERFULLCONTENT)`, (2) Windows.Graphics.Capture, (3) a crop of the screen capture, flagged `occluded`, (4) `BitBlt` — [native/src/capture_win.rs:1-14](native/src/capture_win.rs#L1), [native/src/capture_win.rs:492-552](native/src/capture_win.rs#L492).
- An all-black frame (sampled) counts as a failure and moves to the next rung — [native/src/capture_win.rs:286-295](native/src/capture_win.rs#L286), [native/src/capture_win.rs:354-356](native/src/capture_win.rs#L354), [native/src/capture_win.rs:463-465](native/src/capture_win.rs#L463).
- WGC builds a new frame pool and session per call (pool size 1), turns cursor capture off, and waits up to 1500 ms for a frame — [native/src/capture_win.rs:361-470](native/src/capture_win.rs#L361).
- DXGI desktop duplication is cached per monitor. `AcquireNextFrame(100 ms)` is tried up to 3 times, waiting up to 1 s for a first frame. On error the duplication is dropped and rebuilt: "Access lost (a mode change, the secure desktop)". GDI is the fallback — [native/src/capture_win.rs:55-211](native/src/capture_win.rs#L55), [native/src/capture_win.rs:272-284](native/src/capture_win.rs#L272).
- A minimised window is refused with `window_minimized` — [native/src/capture_win.rs:496-505](native/src/capture_win.rs#L496).

**Linux**
- Wayland: `grim -g` (window), `grim`, `gnome-screenshot`, then a Python XDG-portal script. X11: `import -window`, `scrot -u`, `scrot`, `gnome-screenshot`, `import -window root` — [native/src/screenshot.rs:50-98](native/src/screenshot.rs#L50).

**Size, quality and dedup**
- Default width is 1024 px for Anthropic and OpenAI (768 Gemini, 512 `openai-low`, and so on); JPEG quality 80 — [src/session/constants.ts:5-29](src/session/constants.ts#L5), [src/session/screenshot-handlers.ts:135-143](src/session/screenshot-handlers.ts#L135).
- A default frame is 91–141 KB, which is "122–187 KB of base64 per frame" — [docs/reviews/2026-10-23-competitor-study.md:110](docs/reviews/2026-10-23-competitor-study.md#L110).
- Unchanged-frame dedup: when scope and hash equal the last capture, a short text reply goes out instead of the image, up to `UNCHANGED_TEXT_REPEATS = 3` times in a row. `resend: true` or `COMPUTER_USE_RESEND_UNCHANGED=true` overrides it — [src/session/screenshot-handlers.ts:28-32](src/session/screenshot-handlers.ts#L28), [src/session/screenshot-handlers.ts:102-131](src/session/screenshot-handlers.ts#L102), [src/session/screenshot-handlers.ts:220-224](src/session/screenshot-handlers.ts#L220).

**No video or burst**
- No tool returns more than one frame. `run_steps` takes one optional capture after the last step — [src/session.ts:731-740](src/session.ts#L731).
- The only screen recording in the repo is a demo script that runs ffmpeg/avfoundation outside the server — [agents/blender-agent/record.mjs:1-10](agents/blender-agent/record.mjs#L1), [agents/blender-agent/record.mjs:104-116](agents/blender-agent/record.mjs#L104).
- An internal note (citing openai/codex issues) records that GPU-app window capture can time out on Windows, for example Minecraft Bedrock "FrameArrived timed out" — [docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md:41](docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md#L41).

### Inferences
- **Effective frame rate.** At 112–128 ms per macOS `screenshot` and strict serialisation, the server can return at most about 8 frames per second to a caller, and in practice far fewer once model latency (seconds) is added. Real-time reaction (aiming, platforming, racing) is out of reach. Turn-based, menu-driven or paused-game play is feasible.
- **Windows full-screen games.** A DirectX or Vulkan game in a window will usually fail PrintWindow (black) and fall to WGC. Exclusive full-screen games may break DXGI duplication on mode changes; the code handles this by dropping the duplication and retrying next call. Not tested against any game in the repo.
- **Dedup on games.** Animated scenes almost never hash identically, so the dedup saves tokens only on paused or static screens.

### Gaps
- No captured-frame timing on Windows or Linux in the repo.
- No test of capturing exclusive full-screen or HDR games on any platform.
- No region-of-interest streaming, frame differencing or motion detection beyond `wait_for_stable`'s exact-hash equality.

## 4. Waits, batching and timing

### Takeaway
The waits poll captures or OCR at hundreds of milliseconds and are built for UI states: dialogs, text, a still window. `wait_for_stable` needs byte-identical captures, so a continuously animating game window will time out unless a static `region` is chosen. `run_steps` batches up to 30 steps sequentially, with no per-step delay control and no parallel steps. Focus and activation add 160 ms or more to a cold action.

### Cited Findings
**Waits**
- `wait`: at most 300 s — [src/registry/definitions.ts:264](src/registry/definitions.ts#L264).
- `wait_for_window`: polls every 250 ms — [src/registry/definitions.ts:379-385](src/registry/definitions.ts#L379), [src/session/agent-desktop-handlers.ts:22](src/session/agent-desktop-handlers.ts#L22).
- `wait_for_text` (macOS): default poll 500 ms, minimum 200 ms. Fast OCR is used, with every third poll and any match confirmed by accurate OCR — [src/registry/definitions.ts:388-396](src/registry/definitions.ts#L388), [src/session/agent-desktop-handlers.ts:23-26](src/session/agent-desktop-handlers.ts#L23), [src/session/agent-desktop-handlers.ts:243-279](src/session/agent-desktop-handlers.ts#L243).
- `wait_for_stable` (macOS): quiet time 800 ms by default, poll 250 ms by default, 50 ms minimum. Captures are 800 px JPEG at quality 50. "Stable" means `hash === lastHash` over `quiet_ms` — [src/session/agent-desktop-handlers.ts:27-31](src/session/agent-desktop-handlers.ts#L27), [src/session/agent-desktop-handlers.ts:326-352](src/session/agent-desktop-handlers.ts#L326).
- All wait timeouts are at most 120 s — [src/session/agent-desktop-handlers.ts:32](src/session/agent-desktop-handlers.ts#L32).

**run_steps**
- Allowed steps: input, the click aliases, `click_text`, accessibility actions, activation, `write_clipboard`, `wait` and the three `wait_for_*` tools — [src/tool-catalog.ts:284-294](src/tool-catalog.ts#L284).
- 1–30 steps, one optional end capture (`none`, `window` or `screen`) — [src/registry/definitions.ts:140-150](src/registry/definitions.ts#L140).
- All steps are validated first, then dispatched one by one (`await dispatch(...)`). The batch stops at the first failure. The person's pause or stop is checked before each mutating step — [src/session.ts:650-760](src/session.ts#L650).
- Profile `desktop` — [src/tool-catalog.ts:163](src/tool-catalog.ts#L163).

**Latency built into actions**
- Focus: if the target is already frontmost, there is no activation. Otherwise `activateApp` is given a 2000 ms timeout, then 80 ms of sleep, plus 80 ms more with a window id — [src/session/focus.ts:116-137](src/session/focus.ts#L116).
- A HID click adds 50 ms in TypeScript plus 15 ms native — [src/session/input-handlers.ts:316-318](src/session/input-handlers.ts#L316), [native/src/mouse.rs:714](native/src/mouse.rs#L714).
- The competitor study's tally: "Focus costs 80 + 80 ms of sleeps plus up to 2 s of blocking activation … a HID click adds 50 + 15 ms" — [docs/reviews/2026-10-23-competitor-study.md:217](docs/reviews/2026-10-23-competitor-study.md#L217).
- Measured costs:
  - OCR: accurate Vision takes 456–538 ms p50 on a 1–1.5 MP image; fast takes 77–83 ms and finds 18–30% fewer lines — [docs/reviews/2026-10-23-competitor-study.md:110](docs/reviews/2026-10-23-competitor-study.md#L110).
  - Read-only calls: 0.12 ms p50 in-process — [docs/reviews/2026-10-23-competitor-study.md:108](docs/reviews/2026-10-23-competitor-study.md#L108).
- Stop and pause reach in-flight work through a 150 ms control poll — [src/session/operator-control.ts:80](src/session/operator-control.ts#L80). The study puts worst-case Stop latency for a drag at "about one 150 ms poll plus one step" — [docs/reviews/2026-10-23-competitor-study.md:126](docs/reviews/2026-10-23-competitor-study.md#L126).
- A rival's profile (cua, quoted in the study): a click took 1.35 s; model time was 49 s against 41 s of tool time over 63 runs — [docs/reviews/2026-10-23-competitor-study.md:39](docs/reviews/2026-10-23-competitor-study.md#L39).
- `docs/EFFICIENCY.md` gives no per-action latency numbers; its only timing is a 250 ms default poll for `waitForElement` — [docs/EFFICIENCY.md:86](docs/EFFICIENCY.md#L86).

### Inferences
- `run_steps` can script an open-loop sequence such as "hold W 2 s, press space, hold D 1 s, capture". That is the most game-useful primitive today. It cannot react within a batch: the waits are OCR- or hash-based and too slow for gameplay events.
- `wait_for_stable` with a `region` on a static HUD element is the only way to wait on a game window that animates.

### Gaps
- No benchmark of end-to-end action-to-observation loop time, in the repo's own benchmarks or docs.
- No timing parameters (inter-step delay, press duration) on `run_steps` steps.

## 5. OCR and self-drawn UI

### Takeaway
OCR is the strongest game-relevant feature, but it is macOS only. The documented route for "Unreal, Blender, games" is `list_windows`, then `read_window_text` with a `region`, then `click_text`, with `screenshot` / `zoom` / coordinates as fallback. It works on covered windows without activating them. `get_app_capabilities` reports `hasControls: false` for self-drawn apps. The Blender skill tells agents to use the app's own MCP for everything inside the app and this server only for what has no API.

### Cited Findings
- `read_window_text`, `click_text`, `wait_for_text` and `wait_for_stable` are `darwin` only — [src/tool-catalog.ts:255-258](src/tool-catalog.ts#L255).
- `read_window_text` description: "Works on apps that draw their own UI (Unreal, Blender) where get_ui_tree is empty, on covered windows, without activating anything … No network" — [src/registry/definitions.ts:364](src/registry/definitions.ts#L364).
- `click_text` follows the user-active guard and accepts `delivery: "pid"` — [src/registry/definitions.ts:368](src/registry/definitions.ts#L368).
- Vision `VNRecognizeTextRequest` runs at `.accurate`, or `.fast` with `--fast`. Language correction is off in fast mode. OCR asks for a capture at 2x minimum scale on 1x displays — [libexec/macos-agent-helper.swift:116-117](libexec/macos-agent-helper.swift#L116), [libexec/macos-agent-helper.swift:235-249](libexec/macos-agent-helper.swift#L235), [libexec/macos-agent-helper.swift:336-356](libexec/macos-agent-helper.swift#L336).
- `hasControls` is true only when a button, field, checkbox, menu, table or list other than the window's own close, minimise, zoom and full-screen buttons appears within depth 3 and 200 nodes — [src/session/accessibility-handlers.ts:36-62](src/session/accessibility-handlers.ts#L36).
- `get_tool_guide` matches `/\b(unreal|blender|game|viewport|godot|unity|slate|custom[- ]drawn|self[- ]drawn|ocr)\b/i` to approach `coordinate`, sequence `list_windows`, `read_window_text`, `click_text`, fallback `screenshot`, `zoom`, `click`. The entry is `platform: 'darwin'` — [src/session/tool-guide.ts:144-152](src/session/tool-guide.ts#L144).
- The generated instructions say: "OCR for apps that draw their own UI (Unreal, Blender, games, Electron canvases) … Their accessibility tree is empty" — [src/instructions.ts:44](src/instructions.ts#L44).
- The computer-use skill: "Unreal, Blender, games and Electron canvases expose an empty accessibility tree. Do **not** call `get_ui_tree`, `find_element` or `list_menu_bar` on them". `mouse_drag` is the tool for orbit and pan — [skills/computer-use/SKILL.md:22-28](skills/computer-use/SKILL.md#L22).
- AGENTS.md, "Applications with no accessible controls":
  - Blender's `get_ui_tree` returns six nodes.
  - Use OCR first, then `screenshot` / `zoom`, `mouse_drag` for middle-button orbit, `mouse_move` before `key` because Blender routes hotkeys to the editor under the pointer, and `scroll` for zoom.
  - "Expect to verify visually after each step."
  — [AGENTS.md:520-562](AGENTS.md#L520).
- AGENTS.md, the 7.5 section: `delivery: "pid"`; "a background TextEdit takes keys but not clicks"; "Never pass `force: true` unless the person asked" — [AGENTS.md:988-1012](AGENTS.md#L988).
- Blender skill: use the Blender MCP for the app's internals; computer-use for launch, hung app, modal dialogs, waits, sculpt and paint strokes, and whole-window screenshots — [skills/blender-agent/SKILL.md:3](skills/blender-agent/SKILL.md#L3), [skills/blender-agent/SKILL.md:86-103](skills/blender-agent/SKILL.md#L86).
- Origin: v7.5's features "came from building a game with Unreal and Blender, where the agent stopped using this server". Fixed then: the Unreal 352×81 toast captured instead of the main window, and a game's console that could not be opened (no grave key, Unicode-only `type`) — [CHANGELOG.md:304-349](CHANGELOG.md#L304); [docs/releases/v7.5.0.md:5-10](docs/releases/v7.5.0.md#L5) (a "racing game"); [docs/specs/v7.5-agent-desktop/requirements.md:3-12](docs/specs/v7.5-agent-desktop/requirements.md#L3).
- The internal Unreal research says a standalone game window or PIE "game viewport itself (3D input) needs real key events (`type mode:"keys"`, pid delivery works for keys, per skill)" — [docs/reviews/2026-10-09-inputs/research-unreal-automation-surfaces.md:203](docs/reviews/2026-10-09-inputs/research-unreal-automation-surfaces.md#L203).

### Inferences
- For game menus, settings, inventories, dialogue boxes and HUD text on macOS, `read_window_text` with a region plus `click_text` is a working, token-cheap loop.
  - It cannot read non-text game state (positions, health bars as graphics, enemies). That needs the screenshot path and a vision model.
  - Accurate OCR at about 0.5 s per read is too slow for real-time feedback.
- On Windows and Linux, where most PC games run, the OCR route does not exist. Agents fall back to `screenshot` and `zoom` with model vision.

### Gaps
- No OCR on Windows or Linux (no Windows.Media.Ocr or Tesseract backend).
- No OCR accuracy figures for stylised game fonts.

## 6. Person control and safety: user-active guard, takeover, emergency stop, policy, anti-cheat

### Takeaway
The safety model assumes **the agent and the person do not use the input devices at the same time**.
- On macOS by default, any physical keyboard or mouse input in the last 4 s blocks agent input with `user_active`.
- Physical key or button presses, or 500 points of pointer travel, during an action pause the agent (`taken_over`) until 5 s of idle.

A person playing a game alongside the agent would continually trip both. Gamepad input is not monitored at all. The emergency chord is `ctrl+alt+escape`. Policy knows only credential-manager apps. There is no game- or anti-cheat-specific logic anywhere.

### Cited Findings
**User-active guard**
- `DEFAULT_USER_IDLE_MS = 4_000`. It is on by default only on macOS; Windows and Linux enable it only when `COMPUTER_USE_USER_IDLE_MS` is set — [src/session/user-activity.ts:19](src/session/user-activity.ts#L19), [src/session/user-activity.ts:62-80](src/session/user-activity.ts#L62).
- It refuses with `user_active` unless the call passes `force` or uses `delivery: "pid"` — [src/session/user-activity.ts:84-100](src/session/user-activity.ts#L84), [src/session/input-handlers.ts:147-182](src/session/input-handlers.ts#L147).
- Activation is guarded too — [src/session/focus.ts:101-107](src/session/focus.ts#L101).

**Physical-input monitor (what counts as the person)**
- macOS: a listen-only HID tap on mouse buttons, moves, drags, key down/up, flags, scroll and tablet events. It counts only events whose source state is the HID system state. Movement is summed from `MOUSE_EVENT_DELTA_X/Y`; zero-length moves are ignored — [native/src/activity.rs:365-445](native/src/activity.rs#L365). It needs Input Monitoring — [native/src/activity.rs:446-450](native/src/activity.rs#L446). Agent events use the private source, so they are excluded — [native/src/mouse.rs:519-523](native/src/mouse.rs#L519).
- Windows: `WH_MOUSE_LL` and `WH_KEYBOARD_LL` hooks drop events flagged `LLMHF_INJECTED` / `LLKHF_INJECTED`. Movement is measured from **cursor-position differences** (`MSLLHOOKSTRUCT.pt`), not raw deltas — [native/src/activity.rs:576-612](native/src/activity.rs#L576), [native/src/activity.rs:671-680](native/src/activity.rs#L671).
- Linux X11: XI2 raw events from physical, non-XTest devices — [native/src/activity.rs:829-1011](native/src/activity.rs#L829).
- GNOME Wayland: Mutter's IdleMonitor. Agent libei activity within 150 ms is set aside, and "a takeover needs about 300 ms of sustained input, and a single key or click alone does not pause the agent" — [docs/specs/v7.7/wayland.md:95-100](docs/specs/v7.7/wayland.md#L95).

**Takeover**
- `TAKEOVER_MOVEMENT = 500` (points, summed |dx|+|dy|), `TAKEOVER_RESUME_IDLE_MS = 5000`, poll every 100 ms — [src/session/operator-control.ts:83-90](src/session/operator-control.ts#L83).
- Trigger: `now.keys > baseline.keys || now.buttons > baseline.buttons || movement >= 500` during an action — [src/session/operator-control.ts:272-282](src/session/operator-control.ts#L272).
- On by default; `COMPUTER_USE_TAKEOVER=false` disables it — [src/session/operator-control.ts:529-531](src/session/operator-control.ts#L529); also [AGENTS.md:93-96](AGENTS.md#L93).

**Emergency stop**
- Default chord `ctrl+alt+escape` — [src/session/operator-control.ts:519-527](src/session/operator-control.ts#L519). A chord needs at least two modifiers and exactly one trigger, escape or F12 — [native/src/activity.rs:80-108](native/src/activity.rs#L80).
- The latch releases every button and key the agent holds, on its own thread — [native/src/activity.rs:117-131](native/src/activity.rs#L117), [native/src/mouse.rs:764-786](native/src/mouse.rs#L764), [native/src/keyboard.rs:1254-1268](native/src/keyboard.rs#L1254).
- The chord is unsupported on Linux — [native/src/activity.rs:179-186](native/src/activity.rs#L179).
- The competitor study's "Stop during a middle-button orbit in Blender … leaves the middle button held" — [docs/reviews/2026-10-23-competitor-study.md:143](docs/reviews/2026-10-23-competitor-study.md#L143) — is addressed in 7.7, which tracks all three buttons — [native/src/mouse.rs:515-517](native/src/mouse.rs#L515).

**Status card**
- Pause and Stop buttons; the card is excluded from captures. On by default on macOS, opt-in on Windows, none on Linux — [AGENTS.md:67-104](AGENTS.md#L67).

**Policy**
- The only default gate is the credential-manager list: on macOS `com.apple.keychainaccess`, `com.apple.Passwords`, `com.1password.1password`, `com.agilebits.onepassword7`; on Windows `1Password.exe`, `CredentialUIBroker.exe`, `KeePassXC.exe` — [src/session/legacy-policy.ts:126-128](src/session/legacy-policy.ts#L126).
- `COMPUTER_USE_ALLOWED_APPS` / `BLOCKED_APPS` are operator-configured — [src/session/legacy-policy.ts:129-136](src/session/legacy-policy.ts#L129).

**Anti-cheat**
- A repo-wide grep (excluding `node_modules`, `dist`, `reference-projects` and this inputs folder) for `cheat`, `EasyAntiCheat`, `BattlEye`, `vanguard` finds **no mention** in source, skills, AGENTS.md, CHANGELOG or specs.
- The only related behaviour is Windows `input_blocked` when the foreground process is elevated (UIPI) — [native/src/keyboard.rs:1043-1060](native/src/keyboard.rs#L1043).

### Inferences
- **Co-play.** A person cannot play while the agent acts.
  - Keyboard and mouse play trips `user_active` on macOS (4 s window). During any agent action it trips `taken_over`, from a single key press or 500 points of mouse travel.
  - Disabling both (`COMPUTER_USE_USER_IDLE_MS=0`, `COMPUTER_USE_TAKEOVER=false`) removes the person-protection the design relies on.
- **Gamepad play is invisible to the guard.** None of the monitored event types (macOS tap list, Windows LL hooks, XI2 raw events) carries gamepad input. A person using a controller would not be detected as active, and the agent could inject keyboard or mouse input into their game.
- **Cursor recentring.** On Windows the takeover meter sums cursor-position differences. A game that hides the cursor and recentres it every frame may produce misleading movement counts. Untested.
- **Anti-cheat.** All injected input is plainly marked synthetic: Windows sets the `LLMHF_INJECTED` / `LLKHF_INJECTED` flags; macOS uses a private event source. Kernel anti-cheat products may flag or block this. Games running elevated will make `SendInput` fail with `input_blocked`. Neither case is documented or handled by name.

### Gaps
- No policy, warning or documentation on anti-cheat, terms of service, or online multiplayer use.
- No test of the takeover and guard behaviour with a game running.

## 7. Gamepads and controllers

### Takeaway
There is **no gamepad or controller support of any kind**: no virtual controller, no XInput / DirectInput / GameController / evdev joystick output, and no controller monitoring.

### Cited Findings
- A grep of `src/`, `native/src/`, `libexec/`, `skills/`, `AGENTS.md` and `CHANGELOG.md` for `gamepad`, `joystick`, `ViGEm`, `GameController`, `GCController`, `DirectInput`, `XInput` (other than XInput2), `WM_INPUT` and `raw input` returns nothing. The only "XInput" hits are the X11 XInput2 extension used to *monitor* physical keyboard and mouse — [native/src/activity.rs:829-1011](native/src/activity.rs#L829), [native/Cargo.toml:32](native/Cargo.toml#L32).
- Input devices offered by libei and bound by the server: `PointerAbsolute | Pointer | Button | Scroll | Keyboard`. There is no gamepad capability — [native/src/linux_ei.rs:505-513](native/src/linux_ei.rs#L505).
- All MCP input tools are mouse, keyboard, scroll or clipboard — [src/session/input-handlers.ts:18-24](src/session/input-handlers.ts#L18).

### Inferences
- Console-style games, and PC games that need analog sticks or triggers, cannot be driven. Keyboard-and-mouse bindings are the only route, and that route is limited by the absolute-only mouse (section 1).

### Gaps
- No spec or roadmap item in `docs/specs/` mentions controllers. Searched `v7.5-agent-desktop`, `v7.6-*`, `v7.7`, `v8-app-bridges`.

## 8. What the internal reviews and specs say about games, Unreal, Blender and real-time apps

### Takeaway
The repo's game work so far targets **game development tools** (the Unreal Editor and Blender used to build a racing game), not playing games. The recurring conclusions:
- Canvas and engine windows drop background input.
- OCR is this server's differentiator.
- The long-term answer is in-app bridges.

Nothing in the 2026-10-23 competitor study or the Wayland spec addresses real-time play, relative mouse, scan codes or controllers.

### Cited Findings
- Competitor study: on-device OCR for self-drawn apps is where 7.6.1 "still leads"; the self-drawn-UI row is rated "**Ahead**" — [docs/reviews/2026-10-23-competitor-study.md:19](docs/reviews/2026-10-23-competitor-study.md#L19), [docs/reviews/2026-10-23-competitor-study.md:97](docs/reviews/2026-10-23-competitor-study.md#L97).
- It notes the OCR and wait tools are macOS only — [docs/reviews/2026-10-23-competitor-study.md:150](docs/reviews/2026-10-23-competitor-study.md#L150).
- It plans a persistent SCStream for 7.8 — [docs/reviews/2026-10-23-competitor-study.md:226](docs/reviews/2026-10-23-competitor-study.md#L226).
- Gaps research (2026-10-09), section 4 on game engines and self-drawn UIs:
  - Accessibility trees are empty.
  - "Synthetic background input is dropped".
  - GPU-app window capture can time out.
  - What works: pixel vision plus OCR, and above all engine-side APIs (Blender MCP, Unity MCP, Epic's Unreal MCP).
  - The section rests on outside sources, and evidence is "thin".
  — [docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md:136-143](docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md#L136).
  - Headline: "Nobody solves canvas / OpenGL / game input in the background" — [docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md:8](docs/reviews/2026-10-09-inputs/research-computer-use-gaps.md#L8).
- v8 app-bridges requirements: "Canvas and engine windows (Unreal, Blender, Unity) drop background clicks everywhere in the ecosystem; cua's design answer is an in-app input bridge". R1 is an agent-desktop plugin for Unreal. `route: "os"` is kept for when "the game thread is blocked" — [docs/specs/v8-app-bridges/requirements.md:10-27](docs/specs/v8-app-bridges/requirements.md#L10), [docs/specs/v8-app-bridges/requirements.md:31-35](docs/specs/v8-app-bridges/requirements.md#L31), [docs/specs/v8-app-bridges/requirements.md:64](docs/specs/v8-app-bridges/requirements.md#L64).
- Wayland spec (v7.7): only input routing (libei, ydotool, XTEST), US-keymap typing, consent and takeover. No mention of games, Unreal, Blender or real-time — [docs/specs/v7.7/wayland.md:80-100](docs/specs/v7.7/wayland.md#L80).

### Inferences
- A gaming report should treat this server as strongest for:
  - out-of-engine chores (launchers, dialogs, menus by OCR, console commands via `type mode:"keys"` and the grave key);
  - turn-based or menu-driven play, with screenshot-based perception;
  - editor viewports through `mouse_drag`.
- It should treat it as weakest for:
  - real-time action;
  - mouse-look;
  - scan-code-dependent games;
  - controllers;
  - anything on Windows or Linux that needs OCR.
- The internal direction (app bridges) points to engine-side input injection, not better OS-level emulation, as the planned route for engines.

### Gaps
- No internal document assesses playing commercial games, as opposed to building them with Unreal and Blender.
