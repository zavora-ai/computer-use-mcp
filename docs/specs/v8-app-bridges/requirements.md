# v8 app bridges: requirements

Status: **approved in principle by James 2026-10-09 with the v7.6 programme; the spikes in design.md run first.** From the review
[`docs/reviews/2026-10-09-desktop-control-review.md`](../../reviews/2026-10-09-desktop-control-review.md) §4, §6 and §7.
A design draft with the decisions and the spikes to run is in [`design.md`](design.md). Tasks follow approval. Depends
on v7.6 R1 (the `delivery`/`route`/`effect` contract).

## Context

- Game developers drive Unreal by clicking: menus, Details rows, dialogs, Content Browser drags, brush tools, graph
  editors. For most of these a data API exists (Python, Epic's toolsets, VibeUE) and is the right route. For the rest,
  Epic's `SlateInspectorToolset` already offers in-process Slate control with refs, click, type, drag, select, fill form,
  wait, window list and occlusion-proof widget screenshots. Its faults: it warps the user's real mouse cursor on every
  click, hover and drag; `Type` sends characters not key events; refs are session counters; `Drag` is one jump; `WaitFor`
  checks once; nothing works when the game thread is blocked.
- Unreal's macOS accessibility layer is compiled into the editor and off by default behind `Accessibility.Enable` and a
  "VoiceOver on at launch" check. Open, it would publish buttons, checkboxes, text and editable text with values, combo
  boxes, list and tree rows and sliders to AppKit, with press actions on buttons and checkboxes, cross-process, with no
  focus or cursor change. Today the editor window shows four accessibility nodes.
- Canvas and engine windows (Unreal, Blender, Unity) drop background clicks everywhere in the ecosystem; cua's design
  answer is an in-app input bridge. For Unreal that bridge exists in principle (the inspector); for Blender the candidate
  is `bpy` through the Blender MCP, with the pid-delivery spike for keys still pending from v7.5.
- OS-only surfaces (native file pickers and alerts, TCC prompts, the crash reporter, a hung editor, the splash, standalone
  game windows, other apps) are desktop-control's permanent job and are under-served: reading and answering a dialog is a
  hand-stitched sequence today.
- Users: the games workspace (ue-bridge, Epic's MCP on 8000, the Blender MCP on 9876), and npm users who automate other
  applications; the bridge mechanism must be generic even though Unreal is the first bridge.

## User stories and acceptance criteria

### R1 An agent-desktop plugin for Unreal (macOS first)
As the agent, I want the editor's UI readable and pressable without taking James's mouse or keyboard.
- An editor plugin (`AgentDesktop`, installed in Nairobi Racer and CrateLab like VibeUE) sets `Accessibility.Enable` and
  calls the platform's accessibility activation after Slate init, so the OS accessibility tree of the editor window shows
  Slate widgets with roles, labels, values and frames. Acceptance: `get_ui_tree` on the editor returns the Details panel's
  rows and the toolbar's buttons; `find_element` finds "Save Current Level"; `click_element` presses a button and a
  checkbox with the editor in the background and the pointer unmoved.
- The plugin registers toolset functions (through the toolset registry, so Epic's MCP `call_tool` and `ue_python` both
  reach them) that harden the inspector's operations:
  - `Click`, `Hover`, `Drag` without `SetCursorPos` (synthetic pointer events only); `effect` is read back from the widget
    (pressed state, text changed, window appeared) and returned.
  - `Type` with real key down and up per character plus a `SetText` + commit path for text boxes; `PressKey` unchanged.
  - Stable refs: a path (`window title / tab / ancestor labels / property name`, FTagMetaData where present) that survives
    re-snapshots; counters remain as a fallback.
  - `Drag` with stepped moves past the drag threshold and a hold, including from the Content Browser to the viewport.
  - `WaitFor` that blocks on tick with a timeout, and `WaitForWindow` for a Slate window by title.
  - `ClickByText(role, label, within)` to avoid the snapshot round trip.
  - A dialog hook: the list of Slate modal and notification windows with their text and buttons, and `Answer(title,
    button)`.
- Nothing in the plugin depends on Epic's experimental inspector source; it uses `FSlateApplication` and the toolset
  registry. It is off in cooked builds.
- The plugin is spec'd in the games workspace (`specs/agent-tooling/`), lives in `tools/vendor/` or its own repo, and is
  MIT like the rest.

### R2 desktop-control routes through app bridges
As the agent, I want one set of tools whatever the target app, with the best route chosen for me and reported.
- A bridge registry (`COMPUTER_USE_APP_BRIDGES` or a config file): for a bundle id, how to reach its bridge (Unreal: Epic's
  MCP `http://127.0.0.1:8000/mcp`, or ue-bridge; Blender: the MCP socket on 9876) and what it can do (read tree, click by
  ref or text, type, key, screenshot, dialogs).
- **When** a target window belongs to an app with a live bridge, **then** `get_ui_tree`, `find_element`, `click_element`,
  `click_text`, `type`, `key`, `wait_for_text` and `screenshot {target_app}` may take `route: "app-bridge"` (default
  `auto`: bridge when it can do the operation, OS otherwise). The result's `delivery` says `app-bridge` and names the
  bridge; `effect` comes from the bridge's read-back.
- `route: "os"` forces the OS path (needed when the bridge is down, the game thread is blocked, or the target is a native
  dialog the bridge cannot see). The tool says so when it falls back.
- The user-active guard treats bridge routes as non-takeover (like pid delivery) and allows them while James works.

### R3 Dialogs as a first-class flow (OS side)
- `read_dialog {target_app}` returns the frontmost dialog or sheet of the app with its kind (`native` | `slate` | `toast`),
  title, body text and buttons (AX for native, OCR or bridge for Slate), and `answer_dialog {target_app, button}` presses
  one. Both work in the background through pid delivery or AX, and report `effect`.
- `wait_for_window kind: "dialog"` gains `answer: {button, when_text}` so a known dialog ("Restore Packages", "Save
  Content") can be waited for and answered in one call, logged in the audit.
- The crash reporter, a hung app (no window updates for N s while a job runs) and the splash screen are detectable
  through `wait_for_window` kinds and `get_app_capabilities` (`responding: false`).

### R4 Blender bridge spike
- Run the pending v7.5 pid-delivery spike on Blender (keys and clicks into the 3D viewport with Blender in the
  background) and record the outcome in `doctor`'s `pid_delivery`.
- Evaluate `bpy` through the Blender MCP as Blender's bridge for R2 (operators with a context override for most UI
  actions; `brush_stroke` for sculpting). Decide in the design whether Blender gets a bridge entry in 8.0 or waits.

### R5 Supervision panel (optional, last)
- An MCP App (`ui://desktop-control/panel`) showing the targeted window at 1 to 2 fps (JPEG, downscaled), the last action's
  `delivery`/`route`/`effect`, approve and deny for tools gated by `COMPUTER_USE_REQUIRE_APPROVAL_FOR`, and point-to-widget
  (click on the panel to get the element under it). App-only tools are hidden from the model.
- Hosts without the `ui` capability get an image block and the existing agent console. Claude Code is such a host today.

## Compatibility
- Everything is additive. Without a bridge registry the server behaves exactly as 7.6.
- The plugin ships separately from the npm package; the server never requires it.

## Out of scope
- Re-implementing Slate inspection; Windows and Linux bridges (the AX gate exists on Windows through UIA already and is on
  by default there; verify, don't build).
- Driving two editors from one bridge; multi-user editors.
