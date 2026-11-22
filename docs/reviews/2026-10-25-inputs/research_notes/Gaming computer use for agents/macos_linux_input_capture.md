# Games on macOS and Linux: how they receive input and how their frames can be captured (for a computer-use MCP server)

Research date: 2026-10-25. Sources dated before 2023 are marked "(pre-2023, possibly outdated)". Statements about this repository cite local file paths rather than URLs.

## 1. macOS input: do games see CGEventPost events, and what does relative mouse look need?

### Takeaway
Keyboard events and clicks posted at the HID tap reach AppKit/NSEvent-based games (SDL, Wine/CrossOver/GPTK) like any other app. Mouse look does not work from absolute moves alone. Games in relative mode read *deltas*: SDL reads `NSEvent deltaX/deltaY`, and Wine's mac driver (the base of CrossOver and GPTK) does the same. A synthetic `kCGEventMouseMoved` therefore has to carry `kCGMouseEventDeltaX/Y`, and this server's macOS `mouse_move` does not set them. Anything that reads input through GameController (GCMouse/GCKeyboard) is fed from HID devices, not from the CGEvent stream. SDL 3 on macOS 14+ uses GCMouse for relative motion whenever one is connected and then ignores NSEvent deltas, so synthetic deltas are dropped there. A virtual HID device (CoreHID `HIDVirtualDevice` or a DriverKit extension like Karabiner's) is the only way to be seen at the HID/GameController level, and it is gated by entitlements.

### Cited Findings
**SDL (current `main`) on macOS: relative mode and where the deltas come from**
- `Cocoa_SetRelativeMouseMode(true)` warps the cursor to the centre of the focused window, then calls `CGAssociateMouseAndMouseCursorPosition(NO)` and `[NSCursor hide]`. Disabling it calls `CGAssociateMouseAndMouseCursorPosition(YES)`. — [SDL_cocoamouse.m (main)](https://raw.githubusercontent.com/libsdl-org/SDL/main/src/video/cocoa/SDL_cocoamouse.m)
- Relative deltas have two sources. (1) The NSEvent path reads `[event deltaX]` and `[event deltaY]` for move and drag events; `kCGMouseEventDeltaX` is never read directly. (2) The GCMouse path sends `deltaX, -deltaY` from `mouseMovedHandler` while relative mode is on. When GCMouse is active, the NSEvent path skips its deltas ("// GCMouse is providing raw input, skip NSEvent deltas") unless system-scaled (accelerated) relative motion is enabled. — [SDL_cocoamouse.m (main)](https://raw.githubusercontent.com/libsdl-org/SDL/main/src/video/cocoa/SDL_cocoamouse.m)
- GCMouse is enabled by `SDL_HINT_MAC_USE_GCMOUSE` (default true) and only on macOS 14+. The comment reads: "GCMouse until Sonoma due to broken motion and button events on MacBooks". — [SDL_cocoamouse.m (main)](https://raw.githubusercontent.com/libsdl-org/SDL/main/src/video/cocoa/SDL_cocoamouse.m)
- SDL compensates for its own warps: it records `lastWarpX/Y` and `seenWarp` and removes the warp displacement from the next move event, "since it gets included in the next movement event". — [SDL_cocoamouse.m (main)](https://raw.githubusercontent.com/libsdl-org/SDL/main/src/video/cocoa/SDL_cocoamouse.m)

**SDL issue #16241: synthetic CGEvents bypass GCMouse**
- Opened Sep 4 2026, milestone 3.6.0. While any GCMouse device is connected, synthetic button events from remote-control and accessibility tools (CGEvent or accessibility APIs, VNC, Screen Sharing) never reach SDL apps. `Cocoa_SendMouseButtonClicks` returns early whenever a GCMouse exists, and these injected events "bypass GCMouse callbacks". — [libsdl-org/SDL#16241](https://github.com/libsdl-org/SDL/issues/16241)
- icculus added the kill-switch hint `SDL_HINT_MAC_USE_GCMOUSE` (Sep 10 2026). slouken: "We probably should only use GCMouse for relative mode, for consistency with other platforms"; icculus will look at making it relative-only for 3.6.0. — [libsdl-org/SDL#16241](https://github.com/libsdl-org/SDL/issues/16241)

**GameController framework**
- Apple Frameworks Engineer: "GCMouse (and GCKeyboard) only delivers events to the current foreground application." The thread is from 2021 (pre-2023, possibly outdated). — [Apple Developer Forums 696020](https://developer.apple.com/forums/thread/696020)
- A 2026 SDL issue describes GCMouse as the "raw" source and CGEvent/accessibility injection as bypassing it. — [libsdl-org/SDL#16241](https://github.com/libsdl-org/SDL/issues/16241)

**Wine mac driver (CrossOver, Apple Game Porting Toolkit, Whisky)**
- GPTK is built on CrossOver's Wine source. — [CodeWeavers blog, Jun 2023](https://codeweavers.com/blog/mjohnson/2023/6/6/wine-comes-to-macos-apple-s-game-porting-toolkit-powered-by-crossover-source-code)
- Whisky development has stopped, and CrossOver is recommended instead. — [Apfeltalk](https://www.apfeltalk.de/magazin/news/whisky-stellt-entwicklung-ein-empfehlung-fuer-crossover-als-alternative/)
- `winemac.drv` `handleMouseMove:` accumulates `mouseMoveDeltaX += [anEvent deltaX]` (NSEvent deltas, not `kCGMouseEventDeltaX`). The deltas also decide whether the cursor is pinned at the edge of its clip; relative moves are sent when "the cursor is pinned to" that edge. — [wine-mirror cocoa_app.m](https://raw.githubusercontent.com/wine-mirror/wine/master/dlls/winemac.drv/cocoa_app.m)
- Wine's warp code: "Annoyingly, CGWarpMouseCursorPosition() effectively disassociates the mouse from the cursor position for 0.25 seconds". To compensate, Wine calls `CGSetLocalEventsSuppressionInterval(0)`, warps, restores `0.25` and forces `CGAssociateMouseAndMouseCursorPosition(true)`. — [wine-mirror cocoa_app.m](https://raw.githubusercontent.com/wine-mirror/wine/master/dlls/winemac.drv/cocoa_app.m)
- After a warp, Wine discards mouse-moved events whose `[anEvent timestamp] <= lastSetCursorPositionTime` and flushes queued relative and absolute move events. — [wine-mirror cocoa_app.m](https://raw.githubusercontent.com/wine-mirror/wine/master/dlls/winemac.drv/cocoa_app.m)
- Cursor clipping (`ClipCursor`, used by mouse-look games) uses either `WineConfinementClipCursorHandler` or `WineEventTapClipCursorHandler`, an event-tap based handler. — [wine-mirror cocoa_app.m](https://raw.githubusercontent.com/wine-mirror/wine/master/dlls/winemac.drv/cocoa_app.m)

**Delta fields on synthetic events (practitioner evidence; no Apple statement found)**
- Keyboard Maestro 10.2 added "low level" mouse movement. The pattern: create a mouse-moved event, `CGEventSetIntegerValueField(kCGMouseEventDeltaX/Y)`, then post to `kCGHIDEventTap`. — [Keyboard Maestro forum](https://forum.keyboardmaestro.com/t/generate-low-level-mouse-movement-events/27923)
- `kCGMouseEventDeltaX` is field index 4. — [Free Pascal CGEventTypes](https://docs.freepascal.org/daily/packages/univint/cgeventtypes/kcgmouseeventdeltax.html)
- robotjs's mac code computes deltas as "a workaround for games not detecting mouse moves". Its issue #159 reported that Portal, Minecraft and a browser game ignored robotjs moves on macOS. It was closed by PR #177, with no user confirmation (2016; pre-2023, possibly outdated). — [robotjs mouse.c](https://cdn.jsdelivr.net/npm/robotjs@0.7.0/src/mouse.c); [octalmage/robotjs#159](https://github.com/octalmage/robotjs/issues/159)
- Older SDL called `CGSetLocalEventsSuppressionInterval(0)` around warps; it has been deprecated since 10.6 in favour of `CGEventSourceSetLocalEventsSuppressionInterval`. A 2016 SDL commit removed it and re-associates instead (pre-2023, possibly outdated). — [SDL commit 08488e6 (mirror)](https://git.axiodl.com/encounter/SDL/commit/08488e6d34462635f01e15179814450ba9c56397); [SDL forum](https://forums.libsdl.org/viewtopic.php?p=34912)

**Virtual HID / virtual game controller on macOS**
- Karabiner-DriverKit-VirtualHIDDevice provides a virtual HID keyboard and pointing device through DriverKit, plus a client library. The repo describes no gamepad. The fork's README says the client "needs SIP disabled at the moment" for its own builds. — [Karabiner-DriverKit-VirtualHIDDevice (xd2 fork)](https://github.com/xd2/Karabiner-DriverKit-VirtualHIDDevice)
- Apple DTS, Sep 2026, on a virtual Xbox-style gamepad app:
  - CoreHID's virtual device API is gated by `com.apple.developer.hid.virtual.device`, which "is NOT a DEXT entitlement and should never be included in a DEXT".
  - CoreHID and a DEXT "both work in EXACTLY the same way. CoreHID is just using a kernel extension we wrote".
  - On GameController: it matches on undocumented hardware details. "I think CoreHID will work fine, but it's possible there's some detail I've overlooked."
  - The poster's capability request had been pending about 2.5 months.
  - [Apple Developer Forums 845599](https://developer.apple.com/forums/thread/845599)
- A forum thread reports that on the macOS 26.4 beta, built-in keyboard events no longer reach DriverKit virtual HID layers, and DTS pointed to CoreHID. (This comes from the search snippet; the thread was not read in full.) — [Apple Developer Forums 817009](https://developer.apple.com/forums/thread/817009)
- A forum thread says the DriverKit `driverkit.family.hid.virtual.device` entitlement is documented but cannot be requested, "superseded by CoreHID?" (from the search snippet). — [Apple Developer Forums 840311](https://developer.apple.com/forums/thread/840311)

**This repository (local observation)**
- `native/src/mouse.rs` `mouse_move` builds `CGEvent::new_mouse_event(source(), MouseMoved, point, Left)` and posts it at `CGEventTapLocation::HID` without setting `MOUSE_EVENT_DELTA_X/Y`. No file in `native/src` writes the delta fields; `native/src/activity.rs` only reads them, for takeover detection. — local: `/Users/jameskaranja/Developer/projects/mcp-servers/computer-use-mcp/native/src/mouse.rs`, `/Users/jameskaranja/Developer/projects/mcp-servers/computer-use-mcp/native/src/activity.rs`

### Inferences
- A `mouse_move` without delta fields probably produces zero or wrong camera motion in SDL and Wine games that are in relative mode or clipped. In those modes the cursor is disassociated, so the position in the event is not what the game reads. The usual fix is a `relative_move {dx, dy}` (or `mouse_drag` in relative mode). It should post `kCGEventMouseMoved` (or `*MouseDragged` while a button is held) with `kCGMouseEventDeltaX/Y` set to the step, at a position of current point + delta, clamped to the display. Large motions should be split into small steps (several per frame) so games that integrate per frame see smooth motion. Not verified against a running game in this research.
- With a physical mouse connected, SDL 3 games on macOS 14+ probably ignore synthetic deltas in relative mode, because the GCMouse path wins and GCMouse never sees CGEvents. The workaround is launching the game with `SDL_MAC_USE_GCMOUSE=0` (SDL hints are normally readable from environment variables of the same name; not confirmed for this hint). SDL 3.6.0 may make GCMouse relative-only, which fixes clicks but not relative motion.
- Unity, Unreal and native Metal games that use `GCMouse`/`GCKeyboard` (common for iPad-ported and Apple Arcade titles) probably ignore all CGEvent input for the channels they read through GameController. Only a virtual HID device (CoreHID/DriverKit) would reach them.
- Wine discards moves timestamped at or before its last warp. Synthetic events should carry fresh timestamps (the default from `CGEventCreate*`). An agent should not fire a burst of moves in the same tick as a game-initiated warp.
- A virtual gamepad on macOS is feasible only through CoreHID `HIDVirtualDevice` with an Apple-granted entitlement. GameController recognition is "probably" but unconfirmed by Apple, and approvals are slow. For an npm-distributed MCP server this is a separate signed helper app, not a native addon feature.

### Gaps
- No Apple documentation found that states whether `NSEvent.deltaX` for a posted CGEvent equals the event's `kCGMouseEventDeltaX`, or whether the window server computes deltas from position when the fields are zero. Practitioners and robotjs imply zero deltas are delivered as-is. A small local experiment (post an event, read `deltaX` in a test NSWindow) would settle it.
- Did not fetch Apple's `CGAssociateMouseAndMouseCursorPosition` or `CGGetLastMouseDelta` reference text (the page did not render). The 0.25 s disassociation after a warp is sourced only to Wine's code comment.
- Did not verify that GCVirtualController is iOS/iPadOS only; Apple docs were not checked.
- No source on whether Apple Arcade or Metal-native titles specifically use GCKeyboard rather than NSEvent for keys. This varies per title.
- Did not determine whether a MacBook's built-in trackpad registers as a GCMouse, which decides whether the SDL GCMouse path is active on laptops with no external mouse.

## 2. macOS Game Mode, full-screen Spaces and ScreenCaptureKit capture of games

### Takeaway
Game Mode (Apple silicon, macOS 14+) gives the game the highest CPU/GPU priority, lowers background-task usage and doubles the Bluetooth sampling rate. It turns on automatically when a game enters macOS full screen. Apple documents nothing about its effect on capture or on synthetic input. ScreenCaptureKit can stream at display rate: `minimumFrameInterval` defaults to 0 (the maximum rate), and 1/60 requests 60 fps. A persistent `SCStream` delivers frames every ~17 ms at 60 fps, while one-shot `SCScreenshotManager` captures cost ~90-130 ms each. To watch a game at 30-60 fps the agent needs a stream, not repeated screenshots.

### Cited Findings
- Game Mode "gives your game the highest priority access to your CPU and GPU, lowering usage for background tasks" and "doubles the Bluetooth sampling rate". — [Apple Support 105118](https://support.apple.com/en-us/105118)
- It turns on automatically when the game enters full screen and turns off when you quit. Requirements: Apple silicon, macOS Sonoma 14 or later, and a game that supports macOS full-screen mode. — [Apple Support 105118](https://support.apple.com/en-us/105118)
- Manual toggle on macOS 26 Tahoe: Game icon in the menu bar or Command-Esc → Game Overlay → Settings → Game Mode. On Sonoma/Sequoia: Game menu → Turn Game Mode On/Off. A manual off "remains off for that game until you turn it on again". The page says nothing about recording or streaming. — [Apple Support 105118](https://support.apple.com/en-us/105118)
- AppleInsider (2023): Apple hasn't offered much insight into how Game Mode works internally. — [AppleInsider](https://appleinsider.com/articles/23/10/17/this-is-what-game-mode-does-to-your-mac)
- `minimumFrameInterval`: "The default value is `0`, which indicates that the system uses the maximum supported frame rate". For 60 fps, set `1/60`. Available on macOS 12.3+. — [Apple: minimumFrameInterval](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/minimumframeinterval.md)
- `queueDepth`: "The maximum number of frames for the queue to store". — [Apple: SCStreamConfiguration](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration.md)
- A Qt source comment says ScreenCaptureKit's default queue depth is 3 (unofficial). — [Qt qmacscreencapturekit_p.h](https://contribute.qt-project.org/doc/d5/d45/qmacscreencapturekit__p_8h_source.html)
- The WWDC22 sample configures 1080p at `minimumFrameInterval = 1/60`. — [WWDC22 10156](https://developer.apple.com/fr/videos/play/wwdc2022/10156/)
- `SCScreenshotManager` captures "single frames from a stream" (`captureImage`, `captureSampleBuffer`). — [Apple: SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager.md)
- Third-party benchmark (sckit-go, M-series, macOS 26.3, 1920×1080), a single source:

  | Capture | Latency |
  |---|---|
  | One-shot window capture | ~89 ms p50, 108 ms p95 |
  | One-shot display capture (includes enumeration) | ~132 ms p50 |
  | Cold stream open | ~81 ms |
  | Steady-state stream frame at 60 fps | 17.4 ms p50 |
  | Steady-state stream frame at 30 fps | 34.0 ms p50 |

  [sckit-go v0.3.1](https://pkg.go.dev/github.com/LocalKinAI/sckit-go@v0.3.1)
- This repo's own measurement on macOS 26.2: 62 ms per warm window capture through the kept-alive helper, 112-128 ms per `screenshot`. — local: `/Users/jameskaranja/Developer/projects/mcp-servers/computer-use-mcp/AGENTS.md`
- Forum reports of shortfalls:
  - A 32×32 capture configured for 30 fps delivered ~7 fps on an Intel Mac mini. — [Apple Developer Forums 811300](https://developer.apple.com/forums/thread/811300)
  - iPadOS 27 beta capped capture at 60 fps even at 1/120 (single report, unconfirmed). — [Apple Developer Forums 848296](https://developer.apple.com/forums/thread/848296)
- OBS on macOS has no game-capture hook; it uses Display/Window capture through ScreenCaptureKit (unofficial site). — [obs-versions.com](https://obs-versions.com/blog/obs-game-capture-vs-display-capture)

### Inferences
- An agent that watches a game should open one `SCStream` on the game window or display for the task: `minimumFrameInterval` 1/30 to 1/60, `queueDepth` 3-5, and a scaled-down `width/height`. It can then sample the latest frame on demand (and hash it for `wait_for_stable`) rather than paying ~60-130 ms per one-shot. The current helper "serve" mode amortises process start, but each capture is still a screenshot.
- Because Game Mode is triggered by entering macOS full screen, a full-screen game sits in its own Space. Window-targeted capture by window ID should still work (SCK window capture does not need the window to be frontmost), but `onScreenWindowsOnly` enumeration may omit it when another Space is active. This is unverified; see Gaps.
- Game Mode lowers background-task priority. The MCP server, its capture helper and the model host are all "background" while a full-screen game has focus, so capture and input latency may rise. A tester can turn Game Mode off per game (the choice persists) to compare.

### Gaps
- No primary source on whether Game Mode throttles ScreenCaptureKit clients, delays CGEvent delivery, or changes the frame rate SCK delivers.
- No primary source on SCK behaviour with a full-screen game in a separate Space: whether `SCShareableContent` lists it when not active, and whether frames continue while that Space is not visible.
- No measured SCK frame rates for Metal games specifically, or for HDR/EDR output (`captureDynamicRange` exists but was not investigated).

## 3. Linux input: XTest vs uinput vs libei. What do games (SDL, Wine/Proton, Steam) actually read?

### Takeaway
On X11, XTest relative motion (`XTestFakeRelativeMotionEvent`) does produce XI2 `RawMotion` 1:1, so SDL and Wine games that read raw motion see it. XTest *absolute* moves also produce RawMotion, but carrying positions, which raw readers treat as large jumps. Under XWayland the raw-motion path is fragile (Proton/SDL valuator-mode bugs). XTest from a Wayland session reaches only Xwayland clients, and only through the portal/libei bridge. On native Wayland, a locked-pointer game receives only `wp_relative_pointer` motion, so the injector must emit *relative* motion: libei `ei_device_pointer_motion` (pointer capability), portal `NotifyPointerMotion`, or a uinput `REL_X/REL_Y` device. This server's libei path binds only the absolute-pointer capability. Gamepads are a uinput-only story: Steam's own virtual pad is a uinput device with ID 28de:11ff, and libei has no gamepad device.

### Cited Findings
**X11 / XTest**
- roomler-ai PR #2380 (Oct 17 2026), field-tested:
  - `XTestFakeRelativeMotionEvent` "an XI2 raw reader sees 1:1". On Xvfb, 10 × +100 summed to exactly 1000.0; on real Xorg (Ubuntu 24.04 GNOME on X11), `xinput test-xi2 --root` showed "10 events of exactly 100".
  - Absolute XTest moves "also raise RawMotion, carrying positions rather than deltas", so "a game that reads raw motion takes each absolute move as a large jump, which is why relative mode matters on X11".
  - On a Wayland desktop, "XTest reaches only Xwayland clients".
  - [gjovanov/roomler-ai#2380](https://github.com/gjovanov/roomler-ai/pull/2380)
- SDL 3 X11 implementation details:
  - It selects `XI_RawMotion` on the root window for `XIAllMasterDevices`, applies no XTEST-device filtering, and skips only pens.
  - It reads each device's valuator mode (`v->mode == XIModeRelative`). Absolute axes are converted to deltas against the previous sample, and "The first absolute value is meaningless by itself and must be ignored".
  - Relative motion is delivered only when `mouse->relative_mode && SDL_GetKeyboardFocus()`.
  - Raw values are used unless the system-scale hint is set.
  - [SDL_x11xinput2.c (main)](https://raw.githubusercontent.com/libsdl-org/SDL/main/src/video/x11/SDL_x11xinput2.c)
- SDL 2: `SDL_HINT_MOUSE_RELATIVE_MODE_WARP` selects warp-based relative mode, and "by default SDL uses raw input". — [SDL2 wiki](https://wiki.libsdl.org/SDL2/SDL_HINT_MOUSE_RELATIVE_MODE_WARP)
- Godot moved to XI2 RawMotion because it reports relative motion unaffected by pointer warping. — [godotengine/godot#19191](https://github.com/godotengine/godot/pull/19191)
- Proton issue #10189 (Sep 28 2026, closed "not planned", to be fixed in upstream Wine first):
  - winex11 mouselook reads XI2 raw motion and decides relative vs absolute from the *master pointer's* valuator classes.
  - Under XWayland the master has two slaves, `xwayland-pointer` (absolute, id 6) and `xwayland-relative-pointer` (relative, id 7). "Raw motion always comes from id 7", but "the master copies the classes of the slave that last switched". Raw deltas are then interpreted as absolute coordinates, producing a small directionless nudge.
  - The state persists until the session restarts. Running under gamescope avoids it.
  - [ValveSoftware/Proton#10189](https://github.com/ValveSoftware/Proton/issues/10189)
- SDL issue #16163: on X11/XWayland, a cached master-device valuator mode corrupts relative motion after a source transition (from the search snippet). — [libsdl-org/SDL#16163](https://github.com/libsdl-org/SDL/issues/16163)
- xdotool's README warns that it does not work correctly under Wayland. — [jordansissel/xdotool](https://github.com/jordansissel/xdotool)
- Xwayland's `-enable-ei-portal` flag routes XTest through the portal and libei. It has no effect if the compositor lacks the portal or Xwayland was built without EI/OEFFIS support. — [Xwayland(1)](https://man.archlinux.org/man/Xwayland.1.txt)
- KWin MR 5619 routes Xwayland XTest through the RemoteDesktop portal and libei, reusing a context per command line. — [KDE invent MR 5619](https://invent.kde.org/plasma/kwin/-/merge_requests/5619)
- The original Xwayland MR notes that the RemoteDesktop API requires a ScreenCast session for absolute pointer motion. — [xserver MR 465](https://gitlab.freedesktop.org/xorg/xserver/-/merge_requests/465)

**libei and the RemoteDesktop portal**
- `ei_device_pointer_motion()` is relative motion and needs the pointer capability. `ei_device_pointer_motion_absolute()` needs the absolute-pointer capability, and its coordinate "must be within the device's regions or the event is silently discarded". Units are logical pixels or mm depending on device type. — [libei sender API](https://libinput.pages.freedesktop.org/libei/api/group__libei-sender.html)
- `ei_device_keyboard_key()` takes evdev keycodes from `linux/input-event-codes.h`; these are keymap-independent. To produce a given symbol, the client consults `ei_device_keyboard_get_keymap()`. `ei_device_text_keysym()` takes XKB keysyms and needs the text capability. — [libei sender API](https://libinput.pages.freedesktop.org/libei/api/group__libei-sender.html)
- Frames: `ei_device_frame()` groups events into one hardware event and carries a CLOCK_MONOTONIC µs timestamp (`ei_now()`).
- Emulation boundaries: `ei_device_start_emulating()` takes an increasing sequence number. `ei_device_stop_emulating()` does not release held keys or buttons; the caller must release them first. — [libei sender API](https://libinput.pages.freedesktop.org/libei/api/group__libei-sender.html)
- Keymaps are XKB only (`EI_KEYMAP_TYPE_XKB`), and `ei_keymap_source` distinguishes CLIENT from SERVER-provided keymaps. — [libei API (D. Edmundson docs mirror)](https://davidedmundson.pages.freedesktop.org/libei/group__libei.html)
- Chromium remoting notes that the keymap is constant for the device's lifetime and can be cached. — [chromium ei_keymap.h](https://gitcode.com/openharmony-tpc/chromium_src/blob/master/remoting/host/linux/ei_keymap.h)
- The current libei is 1.6.0. — [libei docs](https://libinput.pages.freedesktop.org/libei/api/index.html)
- RemoteDesktop portal v2:
  - `NotifyPointerMotion` is "a new relative pointer motion event". `NotifyPointerMotionAbsolute` takes "the PipeWire stream node the coordinate is relative to".
  - `ConnectToEIS` was added in v2. After it, "Any events submitted via NotifyPointerMotion(), NotifyKeyboardKeycode() and other `Notify*` methods will return an error".
  - `persist_mode` 2 persists until revoked, and a restore token is single-use.
  - [xdg-desktop-portal RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)

**Native Wayland games: relative pointer and pointer constraints**
- While a pointer is locked, `wl_pointer.motion` events are suppressed and "relative motion continues via wp_relative_pointer objects of the same seat". On unlock, a compositor warp to the cursor hint "will not result in any relative motion events". — [pointer-constraints-unstable-v1](https://isaacfreund.com/docs/wayland/pointer-constraints-unstable-v1)
- `relative_motion` carries a 64-bit µs timestamp, `dx/dy` and `dx_unaccel/dy_unaccel`. The unaccelerated delta "does not represent 'raw' events". Motion is "unaffected by the clipping" at monitor edges. — [relative-pointer-unstable-v1](https://wayland.app/protocols/relative-pointer-unstable-v1)
- Wine's Wayland driver: MR 4593 adds mouselook through pointer constraints and relative motion when the cursor is hidden, and notes relative velocity with scaling "is somewhat inconsistent among Wayland compositors". MR 7457 ignores absolute and enter motion while locked. — [wine-gitlab MR4593 thread](https://list.winehq.org/hyperkitty/list/wine-gitlab@list.winehq.org/thread/IEMNW76B2C3H5ZKTPYPHIXIR5VLZZ5EI/); [wine-gitlab archive](https://mail.winehq.org/mailman3/hyperkitty/list/wine-gitlab@winehq.org/2025/3/?page=69)
- Wine 11.9 (May 2026) supports `wp_pointer_warp_v1` for `SetCursorPos`, falling back to lock/hint. — [Phoronix](https://www.phoronix.com/news/Wine-Wayland-Pointer-Warp)

**Gamepads (uinput) and Steam Input**
- Steam's virtual controller is vendor 0x28DE, product 0x11FF, with evdev name "Microsoft X-Box 360 pad 0", and SDL special-cases it. — [SDL testevdev commit](https://cdn05042023.gitlink.org.cn/zinface/SDL/commit/c244eb937b7fb31202580f2a28f2e81e706f861e); [SDL commit 39302c9 (mirror)](https://git.axiodl.com/encounter/SDL/commit/39302c921445e9f695a72469be17ba041f6f09db)
- The Steam client translates the controller over direct USB and "creates a uinput virtual gamepad" (kernel patch, 2018; pre-2023, possibly outdated). — [LKML Steam Controller driver v5](https://lore.kernel.org/lkml/20180321175610.GA8112@casa/T/)
- Permission failure symptom: "Couldn't initialize virtual gamepad: Couldn't open /dev/uinput for writing" (pre-2023, possibly outdated). — [Steam for Linux discussion](https://steamcommunity.com/app/221410/discussions/0/1693795812304458372)
- The `TAG+="uaccess"` udev rule grants access to the active session's user and was preferred over a fixed group; rule ordering relative to uaccess matters (2015-2016; pre-2023, possibly outdated). — [Debian bug 818905](https://lists.alioth.debian.org/pipermail/pkg-games-devel/2016-March/038940.html); [Arch FS#47330](https://bugs.archlinux.org/task/47330)
- inputtino emulates Xbox, PS5 and Nintendo pads through uinput, evdev and uhid. vgamepad's Linux (evdev/uinput) devices are "not yet indistinguishable from physical pads". — [inputtino](https://github.com/reenignearcher/inputtino); [vgamepad changelog](https://data.safetycli.com/changelogs/vgamepad/?page=1)
- libei issue #40 asks for gamepad emulation because Steam wants a virtual gamepad that games use. — [libei#40](https://gitlab.freedesktop.org/libinput/libei/-/issues/40)
- A gamescope log shows "Successfully initialized libei for input emulation!" — [ValveSoftware/gamescope#1707](https://github.com/ValveSoftware/gamescope/issues/1707)

**This repository (local observation)**
- `native/src/linux_ei.rs` connects through `ConnectToEIS` and binds a seat with `PointerAbsolute | Button | Scroll`. Moves go through `ei::PointerAbsolute::motion_absolute`; there is no relative `ei_pointer` path. ydotool (`/dev/uinput`) is the documented last resort. — local: `/Users/jameskaranja/Developer/projects/mcp-servers/computer-use-mcp/native/src/linux_ei.rs`, `/Users/jameskaranja/Developer/projects/mcp-servers/computer-use-mcp/src/session/doctor.ts`

### Inferences
- **Fix for Wayland mouselook:** also bind `DeviceCapability::Pointer` in the libei seat and expose a `relative_move {dx, dy, steps}` that calls `ei_device_pointer_motion` with `ei_device_frame` per step. Absolute motion is suppressed while a game holds a pointer lock, so the current absolute-only path cannot turn a camera on GNOME or KDE.
- **Fix for X11 mouselook:** use `XTestFakeRelativeMotionEvent` rather than absolute XTest moves while a game is in relative mode. Absolute XTest moves become large raw "jumps".
- **XWayland games under GNOME/KDE** have a separate, input-source-dependent failure mode (Proton #10189, SDL #16163). Mixing absolute and relative injected sources (for example a libei absolute device for clicks and a relative one for look) could trigger the master-pointer class switch these bugs describe. Running the game inside gamescope is the documented sidestep.
- **Gamepads:** uinput with the right capability bits (and ideally an Xbox 360-like vendor/product so SDL's database maps it) is the only route. It needs `/dev/uinput` write access (a uaccess udev rule or root daemon), which is the same security exposure the doctor already flags for ydotool.

### Gaps
- Not confirmed whether XTest *relative* motion is accelerated by the X server before it reaches RawMotion; the roomler tests show 1:1 under their settings.
- No source confirming GNOME (mutter) or KDE (KWin) EIS implementations advertise the relative `pointer` capability (as opposed to only `pointer_absolute`) to portal clients, or whether the compositor's acceleration is applied to EIS relative motion.
- No primary source on Proton's DirectInput/RawInput and XInput emulation over evdev/SDL beyond the winex11 raw-motion path; Steam Input internals (beyond 28de:11ff) are undocumented publicly.
- `GCVirtualController`-style on-screen controllers on Linux were not researched; not applicable.

## 4. Linux capture: XWayland vs native Wayland, gamescope, the PipeWire portal, and unredirected X11 fullscreen

### Takeaway
Nested gamescope (on a desktop) is just a window to the host compositor. The game inside it runs in gamescope's own Xwayland, so host-side window capture works, and host input reaches the game only through gamescope's window: `--force-grab-cursor` forces relative mode, and `-s` scales mouse sensitivity. Embedded gamescope (Steam Deck Game Mode) has no host desktop; capture comes from gamescope's PipeWire video node, the source Steam recording and Remote Play use. Input there goes to its libinput or libei side. On X11, a fullscreen game that the compositor has unredirected may not exist in any offscreen buffer, so window grabs can come back black or stale. Capture the root window or force the compositor to redirect.

### Cited Findings
- gamescope README:
  - Embedded mode "does the same thing as steamcompmgr, but with less extra copies and latency" and can flip frames directly through DRM/KMS. Nested mode "runs on top of a regular desktop", with the game in its own Xwayland.
  - Frames arrive "through Wayland by way of Xwayland".
  - Super+S takes a screenshot to `/tmp/gamescope_$DATE.png`; Super+G toggles keyboard grab.
  - [ValveSoftware/gamescope README](https://github.com/ValveSoftware/gamescope)
- gamescope help strings, from `main.cpp`:

  | Option | Help text or values |
  |---|---|
  | `--backend` | `auto`, `drm`, `sdl`, `openvr`, `headless` ("no window, no DRM output"), `wayland` |
  | `--expose-wayland` | "support wayland clients using xdg-shell" |
  | `--force-grab-cursor` | "always use relative mouse mode instead of flipping dependent on cursor visibility" |
  | `-s, --mouse-sensitivity` | "multiply mouse movement by given decimal number" |
  | `-g, --grab` | grab the keyboard |
  | `-e, --steam` | Steam integration |
  | `--xwayland-count` | create N Xwayland servers |
  | `-r, --nested-refresh` | game refresh rate (frames per second) |

  No help string mentions PipeWire. — [gamescope main.cpp](https://raw.githubusercontent.com/ValveSoftware/gamescope/master/src/main.cpp)
- gamescope exposes a PipeWire video node for recording (from the ArchWiki search snippet; the page blocked automated fetch). — [ArchWiki: Gamescope](https://wiki.archlinux.org/title/Gamescope)
- Known gamescope PipeWire failures:
  - A consumer's failed format negotiation kills the capture node until restart. — [OpenGamingCollective/gamescope#27](https://github.com/OpenGamingCollective/gamescope/issues/27)
  - NV12 frames come back all zero on the NVIDIA proprietary driver, giving a green screen in Steam Remote Play. — [ValveSoftware/gamescope#2489](https://github.com/ValveSoftware/gamescope/issues/2489)
  - Remote Play and recording break when PipeWire isn't running in the session. — [DroidDeck PR 1139](https://github.com/Droid-Deck/DroidDeck/pull/1139)
- steamdeck-pipewire-capture: standard screenshot tools "just don't work in the Steam Deck's Gaming Mode". The tool taps gamescope's PipeWire feed and saves one frame as PNG. — [Gaudeu/steamdeck-pipewire-capture](https://github.com/Gaudeu/steamdeck-pipewire-capture)
- Example project: a probe finds gamescope's PipeWire node and captures a frame from it. — [LowGuiGui/gbfr-auto-linux PR 8](https://github.com/LowGuiGui/gbfr-auto-linux/pull/8)
- Portal ScreenCast frame rate: mutter's screencast source offers a variable rate from 1 fps up to the monitor's rate, and the sink can clamp it (2018; pre-2023, possibly outdated). — [mutter commit (commits-list)](https://mail.gnome.org/archives/commits-list/2018-July/msg01754.html)
- xdg-desktop-portal-wlr limits screencast frame rate by the output rate and respects PipeWire's negotiated maximum (pre-2023, possibly outdated). — [xdpw v0.5.0 tag](https://salsa.debian.org/swaywm-team/xdg-desktop-portal-wlr/-/tags/v0.5.0)
- KWin adds PipeWire explicit sync (PipeWire ≥ 1.2.0). — [KWin MR 6204](https://invent.kde.org/plasma/kwin/-/merge_requests/6204/pipelines)
- X11 unredirection: GNOME Shell's fix for screenshots during fullscreen unredirect disables unredirection, paints a frame and then captures (2020; pre-2023, possibly outdated). — [gnome-shell MR 1536](https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/1536)
- `XGetImage` on an obscured window returns pixels that "do not exist". Workarounds: `XCompositeRedirectWindow`, or grab the root window with `IncludeInferiors` (2016; pre-2023, possibly outdated). — [xorg list 2016-07](https://lists.freedesktop.org/archives/xorg/2016-July/058163.html)

### Inferences
- **Testing a game on a Linux desktop:** launching it as `gamescope -W .. -H .. --force-grab-cursor -- %command%` gives one stable window to capture and target. It also sidesteps the XWayland raw-motion class bugs (Proton #10189). Host-side input (libei or XTest into the host session) reaches the game through gamescope's window.
- **Steam Deck Game Mode / embedded gamescope:** capture must subscribe to gamescope's PipeWire node. The ScreenCast portal is a desktop-session service, and there is no desktop compositor. Input must come from uinput (seen by gamescope's libinput) or, if exposed, gamescope's EIS socket. This research found no documentation of an external EIS socket.
- **Sampling frames:** the portal and PipeWire streams deliver frames only when content changes, up to the negotiated rate. An agent should keep the stream open and read the latest buffer, as on macOS.

### Gaps
- Could not read the gamescope PipeWire node naming or format details (ArchWiki blocked by Anubis; the steamdeck utility's source was not read).
- No source documents how external tools inject input into embedded gamescope through libei: socket name, environment variable, or whether it is Steam-only.
- No current data on actual ScreenCast portal delivery rates for fullscreen games on GNOME 47+/KDE 6.x, or on whether direct scanout of a fullscreen game disables or slows screencast.

## 5. Timing, frame sampling and pointer acceleration

### Takeaway
Games poll input once per frame, so a key down/up pair delivered inside one frame (<16.7 ms at 60 fps) can be invisible. Hold keys for at least 2 frames (~35-50 ms at 60 fps) and leave a similar gap before the next press. For relative motion, SDL 3 uses *unaccelerated* deltas by default, and Wayland supplies both accelerated and unaccelerated deltas. Injected deltas therefore map roughly 1:1 to game units, scaled by the game's own sensitivity (and gamescope's `-s`). Accelerated paths (uinput through libinput's default adaptive profile) make distance depend on step speed, so use small, evenly timed steps.

### Cited Findings
- Phaser: "Keys are not polled constantly while down". A press that starts and ends between polls is missed. — [Phaser issue 4484](https://urls.greenkeeper.io/photonstorm/phaser/issues/4484)
- Practitioner reports that games miss very short synthetic presses, fixed by key-down, delay, key-up (anecdotal; mostly pre-2023, possibly outdated):
  - AutoIt: presses "extremely quickly, which often enough isn't long enough for the game to register". — [AutoIt forum](https://www.autoitscript.com/forum/topic/148455-send-keypress-delay)
  - AutoHotkey: the game ignored input unless sleep was inserted between down and up. — [AutoHotkey forum](https://www.autohotkey.com/boards/viewtopic.php?p=290627)
- Games that read Raw Input directly, and anti-cheat-protected applications, may ignore or detect synthesized input. — [KeepPressing wiki](https://github.com/P4suta/keep-pressing/wiki/Known-Limitations)
- SDL 3 `SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE`: "0" (default) means "Relative mouse motion will be unscaled", and "1" scales with the system acceleration curve (since SDL 3.2.0). `SDL_HINT_MOUSE_RELATIVE_SPEED_SCALE` applies after it. — [SDL3 wiki](https://wiki.libsdl.org/SDL3/SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE)
- SDL on macOS skips GCMouse raw deltas "if user wants system-scaled (accelerated) deltas" and uses NSEvent deltas then. NSEvent deltas are therefore the system-scaled ones. — [SDL_cocoamouse.m (main)](https://raw.githubusercontent.com/libsdl-org/SDL/main/src/video/cocoa/SDL_cocoamouse.m)
- SDL 3 on X11 uses raw XI2 values unless the system-scale hint is set. — [SDL_x11xinput2.c (main)](https://raw.githubusercontent.com/libsdl-org/SDL/main/src/video/x11/SDL_x11xinput2.c)
- SDL 3 relative mode hides the cursor, confines it to the window, and reports "continuous relative mouse motion even if the mouse is at the edge"; enabling it discards queued motion. — [SDL3 wiki: SDL_SetWindowRelativeMouseMode](https://wiki.libsdl.org/SDL3/SDL_SetWindowRelativeMouseMode)
- libinput 1.32: adaptive is "the default profile for all devices". Flat is "a constant factor applied to all device deltas, regardless of the speed of motion". — [libinput pointer acceleration](https://wayland.freedesktop.org/libinput/doc/latest/pointer-acceleration.html)
- With flat, the speed setting still multiplies the delta; 1:1 needs flat and the speed slider at the middle (pre-2023, possibly outdated). — [freedesktop bug 89485](https://bugs.freedesktop.org/show_bug.cgi?id=89485); [KDE bug 397747](https://bugs.kde.org/show_bug.cgi?id=397747)
- Wayland `relative_motion` carries both `dx/dy` (accelerated) and `dx_unaccel/dy_unaccel`. — [relative-pointer-unstable-v1](https://wayland.app/protocols/relative-pointer-unstable-v1)
- libei frames carry CLOCK_MONOTONIC µs timestamps per `ei_device_frame()`, and libei "does not prevent a caller from passing in a future time". — [libei sender API](https://libinput.pages.freedesktop.org/libei/api/group__libei-sender.html)
- gamescope `-s/--mouse-sensitivity` multiplies mouse movement. — [gamescope main.cpp](https://raw.githubusercontent.com/ValveSoftware/gamescope/master/src/main.cpp)
- Wine Wayland notes inconsistent relative velocity across compositors when scaling is involved. — [wine-gitlab MR4593 thread](https://list.winehq.org/hyperkitty/list/wine-gitlab@list.winehq.org/thread/IEMNW76B2C3H5ZKTPYPHIXIR5VLZZ5EI/)
- For comparison on Windows, `mouse_event` relative motion "is subject to the settings for mouse speed and acceleration level". — [Microsoft mouse_event](https://learn.microsoft.com/en-us/windows/desktop/api/winuser/nf-winuser-mouse_event)

### Inferences
- A game-aware `key` or `hold_key` default should be ≥ 2 frames at the game's frame rate: about 35-50 ms at 60 fps, 70-100 ms at 30 fps. This is derived from per-frame polling, not from a measured study. A `run_steps` sequence should space presses by at least one frame. Tap-to-jump style inputs should allow per-call `hold_ms`.
- Camera turns should be emitted as N small relative steps across ~N frames (for example 8-16 px per step at ~8-16 ms spacing), not one large delta. This avoids accelerated paths magnifying a single fast step and matches how games integrate per-frame motion. A calibration step (turn by D units, capture, measure) gives the deg-per-unit for a given game and sensitivity.
- On Linux uinput (ydotool), deltas go through libinput's acceleration for the virtual mouse unless the profile is flat. On libei relative and XTest relative paths, 1:1 behaviour is observed on X11 (roomler) but unverified for compositor EIS.

### Gaps
- No primary measurement of the minimum key hold that specific engines (Unity, Unreal, SDL, Godot) register at 60 fps. The 2-frame figure is an inference.
- No source on whether macOS applies pointer acceleration to deltas in posted CGEvents (it likely does not, since the poster supplies both position and delta), or on how macOS "Pointer acceleration" settings (macOS 14+) affect NSEvent deltas of synthetic events.
- No source on whether libinput treats a uinput REL_X/REL_Y device with its normal mouse acceleration (inferred, not confirmed), or on how GNOME and KDE handle acceleration for EIS relative motion.
