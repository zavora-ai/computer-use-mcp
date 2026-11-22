# Windows games: how they receive input and how their frames can be captured (for a desktop computer-use agent)

Scope: Windows-specific mechanics that make games behave differently from ordinary desktop apps when an MCP server
posts synthetic input (SendInput) and takes screenshots, the API-level fixes, and their limits. Research date
2026-10-25. Sources marked **(pre-2023)** are older than 2023 and may be outdated. Microsoft Learn reference pages
often carry an `ms.date` of 2018 but were updated in 2024-2025 and remain the current reference. Those are not flagged.

## 1. Input APIs games use, and which of them see SendInput-injected events

### Takeaway
SendInput puts keyboard and mouse events into the system input stream, not into a particular window. The focused
game's Win32 messages (WM_KEYDOWN, WM_MOUSEMOVE) and Raw Input (WM_INPUT) normally receive them. DirectInput keyboard
and mouse are built on WM_INPUT, so in principle they receive them too. SendInput cannot produce gamepad input at all,
so XInput, Windows.Gaming.Input and GameInput gamepads need a virtual device. Injected events carry a flag that games
and anti-cheat can read. No source settles whether GameInput's keyboard and mouse path sees SendInput events.

### Cited Findings
- SendInput synthesizes keystrokes, mouse motions and button clicks, inserting each INPUT structure serially into the keyboard or mouse input stream. These events are not interleaved with input from the user or from other keybd_event/mouse_event/SendInput calls. The signature is `SendInput(cInputs, pInputs, cbSize)`, with no target-window parameter. — [SendInput (Microsoft Learn)](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- SendInput does not reset the keyboard's current state, so keys already held can interfere with the injected events. Microsoft suggests checking GetAsyncKeyState and correcting. — [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- With KEYEVENTF_UNICODE, SendInput sends WM_KEYDOWN/WM_KEYUP with wParam = VK_PACKET to the foreground thread's message queue. TranslateMessage then turns it into WM_CHAR. — [KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)
- Microsoft names three ways a game reads the mouse: WM_MOUSEMOVE, WM_INPUT (Raw Input) and DirectInput.
  - WM_MOUSEMOVE is limited to screen resolution, so movement smaller than one pixel produces no message. Pointer ballistics are applied, which makes it right for a pointer and wrong for a first-person camera.
  - WM_INPUT is read directly from the HID stack.
  - DirectInput internally creates a second thread that reads WM_INPUT. It offers no advantage for mouse or keyboard, Microsoft discourages it there, and recommends XInput for controllers.
  - This article's content dates from 2018 (`ms.date` 2018-05-31; page updated 2025-03). — [Taking Advantage of High-Definition Mouse Movement](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/taking-advantage-of-high-dpi-mouse-movement)
- By default, Raw Input from a registered device class reaches the application only while it has window focus. With hwndTarget = NULL, raw input follows keyboard focus. The flags change this:
  - **RIDEV_NOLEGACY** stops the system generating legacy messages for that device: WM_KEYDOWN for keyboards, WM_LBUTTONDOWN and related messages for mice.
  - **RIDEV_INPUTSINK** delivers input even when the caller is not in the foreground; hwndTarget is required.
  - **RIDEV_EXINPUTSINK** delivers input in the background only when the foreground app is not registered for raw input.
  - **RIDEV_CAPTUREMOUSE** stops a click from activating another window. It is valid only together with NOLEGACY.
  - **RIDEV_NOHOTKEYS** disables application hotkeys, but system hotkeys such as ALT+TAB and CTRL+ALT+DEL are still handled.
  - — [RAWINPUTDEVICE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice)
- RAWMOUSE.usFlags distinguishes MOUSE_MOVE_RELATIVE (0x00) from MOUSE_MOVE_ABSOLUTE (0x01), plus MOUSE_VIRTUAL_DESKTOP (0x02). Absolute data arrives as normalized 0-65,535 coordinates. Microsoft's sample handles the two in separate branches: absolute data is mapped to screen coordinates, relative data is taken as deltas. Unlike WM_MOUSEMOVE, Raw Input mouse events are not affected by the Control Panel mouse-speed setting. — [RAWMOUSE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawmouse)
- A developer reported that a WH_MOUSE_LL hook did not see their SendInput-injected events, while the window procedure still received the matching WM_INPUT and SendInput returned 1. This is an old Stack Overflow question (id 2174512) on a mirror site **(pre-2023)**. — [mirror of SO 2174512](https://windows-hexerror.linestarve.com/q/so2174512-whmousell-hook-doesnt-get-called-for-injected-events-mouseevent-sendinput)
- Injected input is detectable. In a low-level mouse hook, LLMHF_INJECTED (bit 0) marks an injected event, from any process. LLMHF_LOWER_IL_INJECTED (bit 1) marks one injected by a process at a lower integrity level. — [MSLLHOOKSTRUCT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-msllhookstruct)
- GameInput is Microsoft's current input API:
  - It is a functional superset of XInput, DirectInput, Raw Input, HID and the WinRT input APIs, built directly on top of the Windows hardware interfaces.
  - On PC it ships via the Microsoft.GameInput NuGet package and supports Windows 10 19H1 and later.
  - Microsoft says to use it for all new code. It is the only input API for GDK games on Xbox One.
  - Page updated 2026-05. — [GameInput introduction (Microsoft GDK docs)](https://learn.microsoft.com/en-us/gaming/gdk/docs/features/common/input/overviews/input-overview)
- PyAutoGUI uses virtual-key codes and older Win32 calls, and fails in some applications, particularly video games. pydirectinput exists to use scan codes and SendInput instead. — [pydirectinput README](https://github.com/learncodebygaming/pydirectinput)
- AutoHotkey's own FAQ says not all games allow it to send keys and clicks, or to read pixel colours. — [AutoHotkey v2 FAQ](https://www.autohotkey.com/docs/v2/FAQ.htm)

### Inferences
- SendInput has no window parameter and works on the system input stream. The game must therefore be the focused, foreground window when the events are injected, and every injected event goes wherever focus is at that moment.
- Raw Input games, which covers most first-person and 3D games, can receive SendInput events because those events surface as WM_INPUT (one old report, plus Microsoft's statement that DirectInput reads WM_INPUT). The flag that matters is the one the game reads: MOUSE_MOVE_ABSOLUTE versus RELATIVE (see Q2).
- A KEYEVENTF_UNICODE "type text" path produces VK_PACKET/WM_CHAR, not a physical key. Games that poll key state or read raw keyboard input will not see it as a key press. Use it only for text fields such as chat boxes and name entry.
- Anti-cheat and some games can read LLMHF_INJECTED (and the keyboard equivalent) and drop injected input. A computer-use agent should treat "the game ignores my input" as a real outcome for competitive multiplayer titles, and should not try to evade it.
- GameInput is now the recommended API and says it sits on the hardware interfaces. Games that move their keyboard and mouse handling to GameInput may stop seeing SendInput, which works above that layer. This is unverified and should be tested per title.

### Gaps
- No source found on whether SendInput-injected keyboard and mouse events reach GameInput's keyboard and mouse readings on PC. Searches returned nothing GameInput-specific.
- No Microsoft documentation found on what RAWINPUTHEADER.hDevice holds for SendInput-injected events (commonly said to be NULL/0, which would let games filter them). Unconfirmed.
- Engine-level specifics (Unity Input System on Windows, Unreal Enhanced Input, SDL3's raw-input backend) were not verified beyond SDL's relative-mode description (Q2).

## 2. Relative mouse and camera control

### Takeaway
First-person cameras integrate relative mouse deltas, usually from Raw Input, while the game hides, clips or recenters
the cursor. Absolute SendInput (MOUSEEVENTF_ABSOLUTE, optionally with VIRTUALDESK) sends a normalized screen
position. A raw-input game receives it as MOUSE_MOVE_ABSOLUTE, which a relative-delta camera does not treat as a turn.
Relative MOUSEEVENTF_MOVE is the right primitive. Two cautions:
- On the legacy pointer path, relative motion is scaled by the mouse-speed and acceleration thresholds (up to 4x). Raw Input is documented as unaffected by mouse speed.
- Counts-per-degree differs per game and per sensitivity setting, so it has to be calibrated.

### Cited Findings
- MOUSEINPUT.dx/dy carry either an absolute position or relative motion in pixels since the last event, depending on dwFlags. — [MOUSEINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)
- MOUSEEVENTF_ABSOLUTE (0x8000) means dx/dy are normalized 0-65,535 coordinates. They map to the primary monitor, or to the whole virtual desktop with MOUSEEVENTF_VIRTUALDESK (0x4000). Without ABSOLUTE, dx/dy are relative to the last reported position. MOUSEEVENTF_MOVE_NOCOALESCE (0x2000) stops WM_MOUSEMOVE coalescing. — [MOUSEINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)
- Relative SendInput motion is subject to the mouse speed and the two mouse-threshold values (the Pointer Speed slider, readable through SystemParametersInfo):
  - The distance doubles if it exceeds the first threshold and mouse speed is non-zero.
  - It doubles again if it exceeds the second threshold and mouse speed equals 2.
  - A relative move can therefore be multiplied by up to 4x. — [MOUSEINPUT Remarks](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)
- Raw Input mouse events are not affected by the Control Panel mouse-speed setting. RAWMOUSE flags absolute data as MOUSE_MOVE_ABSOLUTE. — [RAWMOUSE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawmouse)
- WM_MOUSEMOVE has ballistics applied and is limited to pixel resolution, so it is poor for a first-person camera. WM_INPUT gives raw, unaccelerated data. **(content 2018)** — [High-Definition Mouse Movement](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/taking-advantage-of-high-dpi-mouse-movement)
- ClipCursor confines the cursor to a rectangle. If SetCursorPos or the mouse puts it outside, the system moves it back inside. The cursor is a shared resource, and an application that clips it must release it before giving up control. — [ClipCursor](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-clipcursor)
- SDL's relative mouse mode is the pattern many engines use. The cursor is hidden and constrained to the window, and SDL reports continuous relative motion even at the window edge. This applies only while the window has focus and relative mode is on. — [SDL3 SDL_SetWindowRelativeMouseMode](https://wiki.libsdl.org/SDL3/SDL_SetWindowRelativeMouseMode)
- pydirectinput: `moveTo` is absolute; `move`/`moveRel` are relative to the current position. — [pydirectinput](https://github.com/learncodebygaming/pydirectinput)
- pydirectinput_rgx, the maintained fork:
  - Absolute movement is the default, even for `moveRel`. `relative=True` sends true relative motion, which the README calls less reliable.
  - `disable_mouse_acceleration=True` turns acceleration off for the move and restores the user's settings afterwards.
  - `attempt_pixel_perfect` tries to land on the exact pixel, because Windows sometimes does not. — [pydirectinput_rgx README](https://github.com/ReggX/pydirectinput_rgx)
- Cradle (BAAI) uses AutoHotkey plus a ctypes layer for low-level mouse commands. Its mouse-move action takes a position, a duration in seconds, and a relative or absolute coordinate system. It does not describe calibrating mouse counts to degrees. — [Cradle paper, Appendix A](https://arxiv.org/html/2403.03186)
- Lumine (ByteDance Seed, Nov 2025) represents mouse actions as relative displacements (ΔX, ΔY) in (-1000, 1000) per 200 ms step, executed smoothly over that interval. Scroll ΔZ is in [-5, 5]. — [Lumine, arXiv 2511.08892, §4](https://arxiv.org/html/2511.08892)
- Interception is a Windows driver plus library for intercepting and controlling input devices. Its README says:
  - Installing it requires an administrator prompt.
  - It was tested from Windows XP to Windows 10 **(old; copyright 2008)**.
  - It is LGPL for non-commercial use, with commercial licences from the author.
  - It says nothing about anti-cheat. — [Interception](https://github.com/oblitum/Interception)
- Per-game camera nonlinearity is real. In RDR2 the camera applies smoothing to horizontal movement with weapons holstered, even with Raw Input and zero smoothing set; a community mod removes it. — [PCGamingWiki mod page](https://community.pcgamingwiki.com/files/file/3936-red-dead-redemption-2-mouse-smoothing-fix/)
- In RDR2's Raw Input mode only 21 sensitivity values can be selected; a community mod lifts that limit. — [Nexus Mods](https://www.nexusmods.com/reddeadredemption2/mods/5463)
- Source-engine games (CS2) use `m_yaw`, the horizontal sensitivity factor, default 0.022. A secondary blog says Apex uses the same 0.022. — [csdb.gg m_yaw](https://csdb.gg/command/m-yaw/); [Recharge blog (secondary)](https://www.recharge.com/blog/en-au//mouse-sensitivity-converter-calculator-for-23-fps-games)
- On Day of Defeat: Source, one 2009 measurement found effective sensitivity depended on aspect ratio **(pre-2023)**. — [gehrcke.de](https://gehrcke.de/2009/08/mouse-sensitivity-issue-in-source-based-games-with-wide-screen-setting/)

### Inferences
- **Why absolute SendInput breaks first-person cameras.**
  - It reaches a raw-input game as MOUSE_MOVE_ABSOLUTE with a normalized screen position. A camera that only integrates relative lLastX/lLastY sees no turn, or sees a jump if it converts absolute data.
  - The game is also clipping or recentering the cursor (ClipCursor, SDL relative mode), so a screen position has no stable meaning while the camera has the mouse.
  - Use MOUSEEVENTF_MOVE without ABSOLUTE for anything that turns a camera. Keep absolute moves for menus, where the game shows a cursor and reads WM_MOUSEMOVE.
- **Acceleration.**
  - Relative injection drives the cursor through the threshold and acceleration path ("Enhance pointer precision", up to 4x). Games that read WM_MOUSEMOVE deltas, for example menu cursors, see the accelerated distance.
  - Raw-input games should see the injected dx/dy unscaled, but no source states that for injected events, so this needs measuring.
  - Options:
    - Temporarily set mouse speed and thresholds via SPI_SETMOUSE/SPI_SETMOUSESPEED, then restore them, as pydirectinput_rgx does. This changes a user-visible setting, so it needs consent and guaranteed restoration.
    - Send many small steps below the first threshold.
- **Big turns.** Split a large turn into many small relative steps spread over time, as Lumine does over 200 ms, rather than one large delta. Games integrate per frame, may smooth (RDR2), and may clamp per-frame deltas.
- **Counts per degree is game-specific.**
  - Calibrate empirically: inject a known count, capture, measure the yaw change. A "turn 360°" probe against a landmark works.
  - Under the common Source-engine convention, yaw per count = sensitivity × m_yaw, which at sensitivity 1 and m_yaw 0.022 gives about 16,364 counts per 360°. This convention is not confirmed by an official Valve source here.
- A kernel driver like Interception makes injected input look like hardware, which is exactly what anti-cheat is designed to detect. It needs admin rights, a reboot or driver install, and an old codebase. It is out of scope for a general-purpose MCP server.

### Gaps
- No primary source confirms that SendInput-injected relative motion is delivered to WM_INPUT before pointer ballistics (unscaled).
- No source found for how AutoHotkey's own MouseMove handles acceleration (only its SetKeyDelay/FAQ pages were read).
- No official Valve page was found for the degrees-per-count formula.
- Cradle's mouse-to-degree handling for RDR2 is not described in the parts of the paper read (first 100k characters).

## 3. Keyboard: virtual-key codes vs scan codes, and how long to hold a key

### Takeaway
Send keys as scan codes (KEYEVENTF_SCANCODE, plus KEYEVENTF_EXTENDEDKEY for E0-prefixed keys). Scan codes identify the
physical key regardless of layout, which is what raw-input and DirectInput games bind to. That is why pydirectinput
exists. Separate down and up events with a deliberate hold. Many games poll key state once per frame, and tools that
work with games use holds of tens of milliseconds or more: VideoGameBench 100 ms by default, AutoHotkey's FAQ example
50 ms, Lumine 33 ms action slots with keys held across slots.

### Cited Findings
- With KEYEVENTF_SCANCODE (0x0008), wScan identifies the key and wVk is ignored. KEYEVENTF_EXTENDEDKEY (0x0001) means the scan code is a two-byte sequence starting 0xE0. A key's virtual-key value can change with the keyboard layout or other keys pressed, but its scan code stays the same, so scan codes simulate a physical keystroke regardless of keyboard. — [KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)
- KEYEVENTF_UNICODE requires wVk = 0 and produces VK_PACKET → WM_CHAR. It can only be combined with KEYUP. — [KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)
- pydirectinput uses DirectInput scan codes and SendInput because PyAutoGUI's virtual-key approach fails in DirectX games. — [pydirectinput](https://github.com/learncodebygaming/pydirectinput)
- pydirectinput_rgx:
  - Internals use SendInput and scan codes instead of virtual-key codes, plus `scancode_*` functions for raw scan codes.
  - `press(duration=…)` sets key-down time.
  - The default PAUSE between actions is 0.01 s and can be disabled.
  - `auto_shift` holds Shift for characters that need it. — [pydirectinput_rgx](https://github.com/ReggX/pydirectinput_rgx)
- AutoHotkey SetKeyDelay:
  - Its PressDuration is the delay between press and release. The docs say certain games and specialised applications need a delay inside each keystroke.
  - The default is -1, and PressDuration also delays after modifier changes.
  - SetKeyDelay is not obeyed in SendInput mode, which has no delay between keystrokes. — [AutoHotkey SetKeyDelay](https://www.autohotkey.com/docs/v2/lib/SetKeyDelay.htm)
- AutoHotkey's game advice:
  - Increase SetKeyDelay, e.g. `SetKeyDelay 0, 50`, which is a 50 ms press duration.
  - Send separate down and up events with a Sleep between them.
  - Try ControlSend.
  - SendPlay is deprecated and may do nothing on Windows 11 and later. — [AutoHotkey v2 FAQ](https://www.autohotkey.com/docs/v2/FAQ.htm)
- Microsoft's DirectInput sample shows both immediate mode (`GetDeviceState` read each frame) and buffered mode (`DIPROP_BUFFERSIZE`). **(content 2018)** — [High-Definition Mouse Movement](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/taking-advantage-of-high-dpi-mouse-movement)
- VideoGameBench's agent interface:
  - `press_key` holds a key for 0.1 s by default.
  - `hold_key` defaults to 0.5 s.
  - Sequences of timed actions are supported, e.g. hold Up for 2 s. — [VideoGameBench, arXiv 2505.18134, §2.2, §3, App. B.1](https://arxiv.org/html/2505.18134)
- Lumine:
  - Its 33 ms chunks each list zero to four keys or mouse buttons.
  - A key listed in consecutive chunks stays held, and any key not listed is released.
  - This gives 30 Hz control. — [Lumine §4](https://arxiv.org/html/2511.08892)
- Cradle exposes key-press duration (seconds, float), separate hold and release actions, and uses PyDirectInput for keyboard. — [Cradle, Appendix A, Table 7](https://arxiv.org/html/2403.03186)

### Inferences
- **Why a short press is missed.** A game that samples key state once per frame (GetAsyncKeyState, DirectInput immediate mode, polled GameInput or XInput state) misses a down-up pair that lands entirely between two samples. At 60 fps the sampling interval is about 16.7 ms; at 30 fps it is about 33.3 ms. Under load or vsync the interval can stretch further.
- **Recommended holds.**
  - At least two frame intervals at the game's real frame rate: at least 35 ms at 60 fps, at least 70 ms at 30 fps.
  - 50-100 ms as a practical default, matching AutoHotkey's example and VideoGameBench.
  - Explicit `hold_ms` for movement keys.
  - These are derived figures, not measured ones.
- **Two failure modes.** Rapid successive SendInput calls with no hold fail in polled games. Events delivered as messages (WM_KEYDOWN, WM_INPUT, buffered DirectInput) are seen, but a 0 ms tap may still register as nothing if the game acts on state at frame time.
- Movement in 3D games is time-integrated, so "walk forward 2 s" should be a held key with a duration, not repeated taps. Key auto-repeat is not generated by SendInput: a held key is a single down event until the up event.

### Gaps
- No primary source gives measured minimum hold times per engine (Unreal/Unity/Source).
- No source covers how GameInput's keyboard state reading treats sub-frame taps.
- No source found for whether games ignore VK-only (no-scan-code) SendInput events specifically under Raw Input. The common explanation is that raw keyboard input reports the scan code (MakeCode), which is missing or wrong when only wVk is sent, but this was not verified from a primary source in this pass.

## 4. Gamepads: injecting controller input on Windows in 2025-2026

### Takeaway
SendInput cannot emulate a controller. ViGEmBus, the de facto virtual Xbox 360/DS4 bus driver, was retired and
archived in late 2023 after a trademark conflict. Existing installs still work, but it gets no updates. Microsoft's
first-party path, InputInjector.InjectGamepadInput, exists from Windows 10 1709 but requires the restricted
`inputInjectionBrokered` capability, which means a packaged app, and one open-source user calls it buggy. vJoy survives
as a signed but minimally maintained fork. For an MCP server, keyboard and mouse is the dependable path; gamepad
injection carries driver and maintenance risk.

### Cited Findings
- SendInput synthesizes only keystrokes, mouse motions and button clicks. — [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- ViGEmBus: the repository says the project has been retired and was archived (read-only) on 2 Nov 2023. Version 1.17 and above target Windows 10/11 on x86, amd64 and ARM64. — [nefarius/ViGEmBus](https://github.com/nefarius/ViGEmBus)
- ViGEm end-of-life statement:
  - A conflict with a registered trademark of ViGEM GmbH was found in May 2023. The transition ran July-December 2023, and the vigem.org domain transfer completed on 26 Dec 2023.
  - ViGEmBus will receive no further updates. Existing installations are unaffected except the updater components, which should be adjusted so they do not contact the old domain.
  - Archived projects remain available.
  - HidHide is not declared end-of-life, but its updater must be adjusted for v1.2.128 or older until software updates become available, "if ever".
  - The author also cites lack of time. — [ViGEm End-of-Life (docs.nefarius.at)](https://docs.nefarius.at/projects/ViGEm/End-of-Life/)
- A May 2025 forum post calls ViGEmBus unsupported on Windows 10/11 with no alternatives. This is one user's view. — [mGBA forum](https://forums.mgba.io/printthread.php?tid=5788)
- InputInjector:
  - It has InitializeGamepadInjection, InjectGamepadInput and UninitializeGamepadInjection, added in Windows 10 1709 (SDK 16299).
  - The namespace requires the `inputInjectionBrokered` restricted capability, declared in Package.appxmanifest under the rescap namespace.
  - It also offers keyboard, mouse, touch, pen and shortcut injection.
  - The docs list monikers up to winrt-28000. — [InputInjector (Microsoft Learn)](https://learn.microsoft.com/en-us/uwp/api/windows.ui.input.preview.injection.inputinjector)
- VirtualGamePad-PC uses SendInput for keyboard and mouse and Windows.UI.Input.Preview.Injection for an experimental gamepad executor. Its author calls that API "in preview and is buggy" and says an earlier version was unusable. — [kitswas/VirtualGamePad-PC](https://github.com/kitswas/VirtualGamePad-PC)
- vJoy:
  - BrunnerInnovation forked njz3/vJoy and paid for driver signing so it works on Windows 11, including force feedback.
  - The fork's author does not intend to spend much on maintenance and may re-sign builds only for important fixes. — [BrunnerInnovation/vJoy](https://github.com/BrunnerInnovation/vJoy)
  - MobiFlight reports the fork works on Windows 10 and 11. — [MobiFlight docs](https://docs.mobiflight.com/features/input-action-types/mobiflight-vjoy/)
  - The original SourceForge vJoy is no longer updated. — [vjoy npm README](https://www.npmjs.com/package/vjoy)
- A third-party guide (low authority) says Windows natively supports only XInput controllers, and DirectInput-only devices need a wrapper. — [bugnet.io](https://bugnet.io/blog/fix-xinput-controller-not-detected-on-windows-11)
- Microsoft recommends XInput over DirectInput for Windows controllers **(content 2018)**. GameInput is the recommended API for all new code, and it subsumes XInput, DirectInput, HID and WinRT. — [High-Def Mouse article](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/taking-advantage-of-high-dpi-mouse-movement); [GameInput intro](https://learn.microsoft.com/en-us/gaming/gdk/docs/features/common/input/overviews/input-overview)

### Inferences
- **ViGEmBus.** It still installs and works as a signed virtual Xbox 360 or DualShock 4 bus that XInput and GameInput games see as a real pad. It is an archived kernel driver with no security or compatibility updates. Making a computer-use server depend on it puts an unmaintained kernel component on users' machines.
- **vJoy.** It presents a generic HID/DirectInput joystick, not an XInput pad. Many modern games, which read XInput, Windows.Gaming.Input or GameInput gamepads, will not treat it as a controller without a remapper. This is unverified per title.
- **InputInjector gamepad injection.** It needs a packaged (MSIX) host holding a restricted capability. Store policy restricts that capability, but sideloaded apps can declare it. It does not suit an npx-launched Node server unless a packaged helper is shipped. Which game input APIs observe the injected pad (Windows.Gaming.Input, XInput, GameInput) is not documented in what was read.
- **Practical 2026 recommendation.**
  - Prefer keyboard and mouse bindings, which almost every PC game supports.
  - Treat gamepad injection as an opt-in extension that requires a user-installed driver.
  - Report clearly when no virtual-pad backend is present.

### Gaps
- Not researched in this pass:
  - Steam Input's virtual controller (how Steam presents remapped devices to games).
  - Whether a third party can drive it.
  - HidHide's current release state beyond the EOL page.
- No source states which APIs see InputInjector-injected gamepads (XInput vs Windows.Gaming.Input vs GameInput).
- No authoritative 2025-2026 successor to ViGEmBus was confirmed. One search summary mentioned a third-party claim of a successor called "VirtualPad", but the originating page was not identified and the end-of-life statement names no successor.

## 5. Focus and window modes, UIPI and DPI

### Takeaway
Most game input paths are focus-bound: Raw Input by default, DirectInput at foreground cooperative level, Unity's
default pause-in-background, SDL relative mode. SendInput also goes to whatever has focus. So the game must be the
foreground window and stay there; many games pause or drop input when they lose it. Exclusive fullscreen gives the
game the display and breaks overlays and capture. Borderless/flip-model windowed mode is the agent-friendly mode, and
Windows 10/11 push games toward it (fullscreen optimizations; "Optimizations for windowed games"). Elevated games or
launchers silently block injection from a non-elevated server (UIPI). DPI-unaware games are bitmap-stretched, with
virtualized coordinates.

### Cited Findings
- Raw input defaults to the focused application only. RIDEV_INPUTSINK and RIDEV_EXINPUTSINK exist for background receipt, but only the game itself can opt in. — [RAWINPUTDEVICE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice)
- Microsoft's DirectInput mouse sample uses `DISCL_NONEXCLUSIVE | DISCL_FOREGROUND`. When GetDeviceState fails it re-acquires in a loop while the result is `DIERR_INPUTLOST`. **(content 2018)** — [High-Definition Mouse Movement](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/taking-advantage-of-high-dpi-mouse-movement)
- Unity's `Application.runInBackground` defaults to false, so the application pauses when it is in the background. — [Unity Scripting API](https://docs.unity3d.com/ScriptReference/Application-runInBackground.html)
- SDL relative mouse mode applies only while the window has focus. — [SDL3 wiki](https://wiki.libsdl.org/SDL3/SDL_SetWindowRelativeMouseMode)
- ClipCursor holds a shared resource the game must release when it gives up control. — [ClipCursor](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-clipcursor)
- UIPI: SendInput may inject only into applications at an equal or lower integrity level. When UIPI blocks it, neither the return value nor GetLastError says so. — [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
- AutoHotkey recommends two routes to elevated targets. Running with UI Access needs AutoHotkey installed under Program Files. Running as administrator makes programs it launches run as administrator too. — [AutoHotkey FAQ](https://www.autohotkey.com/docs/v2/FAQ.htm)
- Fullscreen Optimizations (DirectX blog, Dec 2019 **(pre-2023)**):
  - A game that believes it runs in fullscreen exclusive (FSE) is actually run in an optimised borderless window covering the screen.
  - FSE gives the game complete ownership of the display.
  - Fullscreen Optimizations enable fast alt-tab.
  - Overlays in FSE must intercept rendering, which can cause performance regressions, instability and anti-cheat problems.
  - The DWM hands control back to the game when it is the only thing on screen and takes it back when an overlay appears. — [Demystifying Full Screen Optimizations](https://devblogs.microsoft.com/directx/demystifying-full-screen-optimizations/)
- Windows 11 "Optimizations for windowed games":
  - DirectX 10 and 11 games in windowed and borderless mode move from the older blt-model to the flip model, for lower latency and support for Auto HDR and VRR.
  - Turning on Auto HDR turns this on.
  - Per-app opt-outs are under Settings > System > Display > Graphics.
  - A forum notes that DX12 games already present this way. — [Microsoft Support](https://support.microsoft.com/en-us/topic/3f006843-2c7e-4ed0-9a5e-f9389e535952); [ElevenForum](https://www.elevenforum.com/t/updates-in-graphics-and-gaming-for-windows-11.4725/latest)
- DPI:
  - DPI-unaware apps render at 96 DPI and are bitmap-stretched (blurry) on scaled displays.
  - For DPI-unaware or system-aware threads, Windows virtualizes DPI-sensitive API results into the caller's coordinate space; for example, the screen size is reported in 96-DPI units. Microsoft admits which APIs virtualize is not sufficiently documented.
  - Per-Monitor v2 processes see each display's raw pixels and are never bitmap-scaled.
  - Page updated 2026-09. — [High DPI Desktop Application Development on Windows](https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows)
- RIDEV_NOHOTKEYS lets a game disable application hotkeys, but ALT+TAB and CTRL+ALT+DEL are still handled by the system. — [RAWINPUTDEVICE](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-rawinputdevice)

### Inferences
- **Focus.**
  - The agent must activate the game window and confirm it is foreground before every input burst.
  - It should avoid stealing focus back to its own UI between steps: a status card, a terminal, a browser.
  - It should expect that alt-tabbing away pauses the game (Unity default) or drops raw input. That is also useful: focus loss can serve as a pause (see Q7).
  - An agent that clicks its own overlay will cause the game to release ClipCursor and may open the pause menu.
- **Background input.**
  - "Background input" is not available to an outside agent for most games. Raw Input needs the game's own INPUTSINK registration.
  - The server's macOS-style `delivery: "pid"` has no general Windows equivalent for games. PostMessage of WM_KEYDOWN to a window does not reach Raw Input, DirectInput or GameInput readers. That last point is inferred from the documented architecture, not tested.
- **Window mode.** Ask the user, or instruct the agent, to run games in borderless windowed mode. It keeps alt-tab cheap, lets the status card and pointer overlay coexist, and makes capture work (Q6). FSE is the worst case for every part of the loop.
- **UIPI.** A non-elevated MCP server cannot drive an elevated game or launcher, and gets no error. Detect target elevation (the process token integrity level) up front and report it, rather than reporting "input sent". This matches the existing pattern of naming refusals (`screen_locked`, `secure_desktop`) in this project's AGENTS.md.
- **DPI.** A per-monitor-v2-aware server (computer-use-mcp 7.7 on Windows, per this repo's AGENTS.md, `COMPUTER_USE_WINDOWS_DPI_AWARENESS`) works in physical pixels, while a DPI-unaware game's window content is a stretched 96-DPI surface. Absolute clicks on menus are fine in physical screen coordinates. Any mapping of game-internal coordinates must account for the stretch factor. Relative camera deltas are unaffected by DPI scaling.

### Gaps
- The current behaviour of true FSE on Windows 11 24H2/25H2 was not established: how often Fullscreen Optimizations silently convert FSE to borderless, and when they do not (e.g. DX9 titles, or with FSO disabled per-exe).
- No source on how anti-cheat-protected launchers' elevation affects SendInput in practice.

## 6. Capture: Desktop Duplication, Windows.Graphics.Capture, PrintWindow and hooks

### Takeaway
- For borderless and windowed games, both DXGI Desktop Duplication (per monitor) and Windows.Graphics.Capture
  (per window or monitor) capture D3D11/12 and Vulkan output that goes through DWM, at 60 fps and above.
- Exclusive fullscreen is the problem case. Desktop Duplication loses its interface on full-screen or mode
  transitions (DXGI_ERROR_ACCESS_LOST, recreate), and third-party tools report WGC does not work for FSE games.
- HDR output needs an FP16 pipeline and tone mapping, or captures look washed out.
- Minimized games render nothing, so there is nothing to capture. Covered windows can still be captured with WGC.
- PrintWindow(PW_RENDERFULLCONTENT) is an undocumented flag aimed at DirectComposition apps, not a reliable path for swap-chain games.
- OBS's game capture injects a DLL that hooks the game's present calls. It is fast but anti-cheat-sensitive, and an agent should not do it.

### Cited Findings
- Desktop Duplication:
  - It gives frame-by-frame desktop updates in a DXGI surface, with dirty and move rectangles.
  - Its image format is always DXGI_FORMAT_B8G8R8A8_UNORM, whatever the display mode.
  - The pointer may be separate from the image (hardware cursor), in which case the client must draw it from the frame info and the pointer shape.
  - Rotated modes return an unrotated surface.
  - It works per output (monitor). — [Desktop Duplication API](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api)
- AcquireNextFrame:
  - It returns DXGI_ERROR_ACCESS_LOST when a different type of image is displayed: a desktop switch, a mode change, or a switch from DWM on, DWM off, or another full-screen application. The app must release the duplication interface and create a new one.
  - It returns DXGI_ERROR_WAIT_TIMEOUT when no new frame arrives within the timeout. A new frame is acquired only when the OS updates the desktop image or the hardware pointer.
  - An INFINITE wait cannot be cancelled. — [IDXGIOutputDuplication::AcquireNextFrame](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutputduplication-acquirenextframe)
- Windows.Graphics.Capture (doc updated 2026-08):
  - The documented flow uses a system picker and draws a yellow border around each captured item.
  - Frames come from a Direct3D11CaptureFramePool through FrameArrived or TryGetNextFrame. Each frame carries ContentSize, Surface and a QPC SystemRelativeTime.
  - With HDR enabled the content may not be B8G8R8A8. To avoid washed-out, overclipped captures, use R16G16B16A16_FLOAT throughout and tone-map HDR to SDR as needed.
  - It is supported only on Windows desktop devices and Mixed Reality headsets. — [Screen capture (Microsoft Learn)](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- GraphicsCaptureSession was introduced in Windows 10 1803 (17134). IsCursorCaptureEnabled was added in 2004 (19041). Its properties are IsBorderRequired, IncludeSecondaryWindows, MinUpdateInterval, DirtyRegionMode and ConfigurationIteration. — [GraphicsCaptureSession](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession)
- Discord says Windows Graphics Capture does not work for full-screen exclusive games. It detects FSE with SHQueryUserNotificationState, which can give false positives, and falls back to other capture methods. — [Discord Support](https://support.discord.com/hc/en-us/articles/9410427556375--Windows-Capturing-Application-Window-for-Screen-Share-and-Go-Live)
- Medal says its Force Window Capture works only for windowed or borderless games, not exclusive fullscreen. SignalRGB says true fullscreen's exclusive display access prevents its screen capture. These are vendor support pages. — [Medal](https://support.medal.tv/support/solutions/articles/48000922110-black-clips-black-screen); [SignalRGB](https://docs.signalrgb.com/troubleshooting/screen-capture-troubleshooting)
- PW_RENDERFULLCONTENT is an undocumented PrintWindow flag that WebRTC adopted because plain PrintWindow fails on DirectComposition apps. Chromium notes it needs Windows 8.1 or later. Nothing found confirms it captures DirectX swap-chain games. — [WebRTC commit](https://webrtc.googlesource.com/src/+/f89110d67902e787f6745ad2b52f7f09fc808512%5E%21); [Chromium snapshot_win.cc](https://chromium.googlesource.com/chromium/src/+/d4afc97b7/ui/snapshot/snapshot_win.cc)
- Minimized windows (anecdotal):
  - OBS forum answers say the OS stops rendering minimized windows, so there is nothing to capture.
  - Windows covered by other windows can still be captured.
  - A 2007 article says PrintWindow cannot capture a minimized window **(pre-2023)**. — [OBS forum](https://obsproject.com/forum/threads/how-to-capture-minimized-window.167081/); [OBS forum 2](https://obsproject.com/forum/threads/how-to-capture-full-game-window-even-when-obscured-by-other-windows-by-using-obs-api.188915/latest)
- OBS game capture:
  - It works by injecting code into the game process and hooking graphics calls to reach each rendered frame. The OBS source functions are hook_direct, create_inject_process and inject_hook.
  - Old reports describe anti-cheat (XIGNCODE3, XTrap) detecting or killing the game over OBS's hook DLL **(pre-2023, ~2014)**.
  - Forum advice is to use window or display capture when injection must be avoided. — [OBS forum: anti-cheat compatibility hook](https://obsproject.com/forum/threads/from-a-developers-perspective-what-does-anti-cheat-compatibility-hook-do.68483/latest); [OBS forum: OBS-MP anti-cheat](https://obsproject.com/forum/threads/obs-mp-game-capture-anti-cheat-compatibility-parity-with-obs1.26986/latest)
- The Fullscreen Optimizations post says FSE overlays must intercept rendering, which can cause instability and anti-cheat issues **(2019)**. — [DirectX blog](https://devblogs.microsoft.com/directx/demystifying-full-screen-optimizations/)
- Throughput: DXcam (Desktop Duplication, with an optional WinRT/WGC backend) has a README dated 2026.
  - It reports 239.19 fps average at 1080p on a 240 Hz output (5900X + RTX 3090), against 118.36 for D3DShot and 75.87 for python-mss.
  - Targeting 60 fps it achieved 61.71, and at 30 fps 30.08.
  - `grab()` returns None when no new frame has arrived.
  - The author warns that many claims of "1000+ fps" measure re-reads of a stale frame. — [DXcam README](https://github.com/ra1nty/DXcam)

### Inferences
- **Recommended Windows capture route for games.**
  - Use WGC on the game's HWND. It is per-window, works when the window is covered, and the border is optional via IsBorderRequired where permitted.
  - Fall back to Desktop Duplication for the game's monitor, and handle ACCESS_LOST by recreating the duplication interface.
  - Never inject hooks.
  - Detect FSE (SHQueryUserNotificationState, as Discord does, or a window rect equal to the monitor plus exclusive-mode heuristics) and tell the user to switch to borderless, rather than returning black frames.
- **Black or stale frames are a signal.** An all-black frame, or WAIT_TIMEOUT with no new frame for a long time, should come back as a structured result (`fullscreen_exclusive_suspected`, `no_new_frame`), not as an image the model will misread.
- **HDR.** On HDR desktops, request an FP16 frame pool and tone-map before encoding to JPEG or PNG for the model. Otherwise captures are washed out.
- **Minimized games.** Do not minimize the game. If the agent must show its own UI, place it beside the game. Some games also pause when they lose focus (Q5).
- **Capture is not the bottleneck.** 60 fps (16.7 ms) is reachable with either API. A 2-5 fps sampling rate (Lumine 5 Hz, Cradle 2 fps) is more than enough for a model-in-the-loop agent, so prefer event-driven waits (frame changed, stable) over high-rate streaming.
- **Hook injection.** An agent must not use OBS-style DLL injection. It modifies the game process, trips anti-cheat (bans are possible on online titles), and is a different trust level from an input/capture tool.

### Gaps
- No Microsoft documentation found on WGC behaviour with true FSE, protected content (SetWindowDisplayAffinity WDA_EXCLUDEFROMCAPTURE yields black content), or minimized windows. These are third-party reports only.
- No measured WGC per-frame latency numbers were found. DXcam gives only throughput for Desktop Duplication.
- Vulkan-specific notes are missing. Vulkan games presenting through DXGI interop or the Windows flip model should behave like DX12 in borderless mode, but this is not verified.
- Details of OBS's current "anti-cheat compatibility hook" were not confirmed from primary OBS docs; the KB URL tried returned 404.

## 7. Timing: model loop latency vs game frame time, and ways to cope

### Takeaway
A game frame is 16.7 ms at 60 fps. A frontier-VLM screenshot-to-action loop takes far longer: papers describe models
taking so long that the game state has changed by the time an action returns. Real-time benchmark results are
correspondingly poor: Gemini 2.5 Pro completes 0.48% of VideoGameBench. What works:
- pausing the game while the model thinks (VideoGameBench Lite, Cradle on RDR2 and Stardew Valley);
- turn-based or menu-driven games;
- timed action chunks: hold-for-duration commands and sequences;
- a small, heavily optimised model emitting 33 ms action chunks (Lumine, about 114 ms to the first action on 4 GPUs).

### Cited Findings
- VideoGameBench (Princeton, arXiv 2505.18134):
  - 10 games from the 1990s (Game Boy, Game Boy Color, MS-DOS via PyBoy, DOSBox and JS-DOS), played in real time from raw frames.
  - Gemini 2.5 Pro completes 0.48% of VideoGameBench and 1.6% of VideoGameBench Lite.
  - The authors name inference latency as a major limitation. — [arXiv abstract](https://arxiv.org/abs/2505.18134v2)
- VideoGameBench mechanics:
  - VLMs take so long to respond that the state has changed by the time an action returns (§2.5).
  - In the Lite variant the emulator pauses while the agent processes its input, and the game resumes only momentarily when an action is made, like an OpenAI Gym step.
  - In real-time mode the agent gets a frame half a second after acting.
  - In Lite, DOS steps get five past frames 0.1 s apart. Actions default to 0.1 s presses and support timed holds and sequences (§2.2, §3). — [VideoGameBench HTML](https://arxiv.org/html/2505.18134)
- Cradle (BAAI, arXiv 2403.03186):
  - Because those games are dynamic and the model is slow, Cradle pauses RDR2 and Stardew Valley while waiting for the backbone model. Other environments run continuously.
  - Video is sampled at 2 fps.
  - Frequent model calls bring high costs and long delays (§4.1, §5, App. A). — [Cradle](https://arxiv.org/html/2403.03186)
- Lumine (arXiv 2511.08892, Nov 2025):
  - Observation is 5 Hz (one frame every 200 ms) at 1280×720. Each step predicts six 33 ms action chunks, giving 30 Hz control.
  - Latency breakdown (Table 4): network 6 ms, preprocessing 6.8 ms, vision encoder 39 ms, LLM prefill 52 ms, decode 3.1 ms per token.
  - First action chunk: 113.9 ms without reasoning, 234 ms with reasoning, which exceeds the 200 ms budget.
  - Chunks stream out and run as soon as each terminating semicolon is generated.
  - Optimisations: StreamingLLM KV cache, delimiter-based speculative decoding, TP=4 on H20 GPUs, W8A8 SmoothQuant, a CUDA graph. Together they give a 25.3× speedup over baseline.
  - The host captures a screenshot, sends it, then parses the action string into keyboard and mouse events. — [Lumine HTML, §4, §6.2](https://arxiv.org/html/2511.08892); [arXiv abstract](https://arxiv.org/abs/2511.08892)
- Batocera/RetroArch's run-ahead and near.sh's input-latency article note that emulated systems typically read controller input once per emulated frame. That is emulator context, not PC games. — [near.sh (archived)](https://archive.ares-emu.net/near.sh/articles/input/latency.html)

### Inferences
- **Order of magnitude.** A hosted frontier VLM call with an image is typically one to several seconds. VideoGameBench's real-time design assumes at least 0.5 s between action and next frame. At 60 fps that is roughly 60-300+ frames per decision. The seconds figure is not measured in these sources and should be read as an estimate. Real-time reflex play (aiming, platforming, dodging) is out of reach for a screenshot-to-model-to-action loop over MCP.
- **Ways to cope, best first.**
  - Pause the game between steps: the game's pause key, or focus loss where the engine pauses in the background, as Unity does by default.
  - Prefer turn-based, menu-driven, strategy, management and puzzle games.
  - Give the model timed macro actions in one call: hold W for 1.5 s, turn N counts over 300 ms, press E. This project's `run_steps` with per-step durations is the right shape.
  - Use event-driven waits instead of fixed sleeps (wait_for_stable or wait_for_text equivalents on Windows).
  - Accept 2-5 Hz observation as the ceiling for frontier models.
- **Pausing is a game-specific action.** Some games cannot pause (online multiplayer). Pause menus also cover the screen, so the agent must unpause, act for a duration, then re-pause and capture, which costs a few frames of unobserved play per step.
- **Native low-latency control (Lumine) needs a co-located, specialised small model.** That is not achievable through a general MCP tool loop.

### Gaps
- No primary source gives measured end-to-end latency (seconds) for a hosted frontier model in a screenshot-to-action loop on a Windows game. VideoGameBench gives no per-call seconds in the sections read, and Cradle gives none.
- Not researched: slow-motion or time-scale tools such as engine console commands, Cheat Engine speedhack (which modifies game memory and is anti-cheat-sensitive), or emulator frame-stepping as general techniques for PC games.
