# v8 app bridges: design (draft, with the spikes to run first)

Status: draft alongside the requirements, 2026-10-09. Decisions marked **Decided** follow from evidence in the review;
those marked **Spike** need the experiment named before they are final.

## 1. Decisions

| # | Decision | Status | Why |
|---|---|---|---|
| D1 | Slate-level control for in-editor UI; desktop-control for OS-only surfaces; data APIs first wherever they exist | **Decided** | Review §4: the inspector is better than OCR on every axis; the OS-only column has no other route |
| D2 | Open Unreal's existing macOS accessibility layer rather than build a tree of our own | **Spike S1** | 937 lines of engine code already map roles, labels, values, frames and press actions; two gates close it; `OnVoiceoverEnabled()` is exported |
| D3 | Harden Epic's inspector through new toolset functions in our plugin, not a fork | **Decided** | Epic's source is experimental and NoRedist; `FSlateApplication` and the toolset registry are the stable surfaces |
| D4 | Pointer events without `SetCursorPos` | **Spike S2** | The Automation Driver drives Slate with a fake cursor; the inspector's `Process*Event` calls take screen positions, so the cursor warp may be unnecessary |
| D5 | Bridges are a routing layer in desktop-control, not new tools | **Decided** | One tool surface for the agent; the result's `delivery`/`route` (v7.6 R1) carries the difference |
| D6 | The Unreal bridge talks to Epic's MCP over HTTP on 8000 by default, ue-bridge as an alternative | **Decided** | Both already exist; `call_tool` reaches the registry; the bridge never needs the editor's Python |
| D7 | Blender's bridge is `bpy` over the Blender MCP socket, if the spike shows pid delivery can't do clicks | **Spike S3** | Pending from v7.5 |
| D8 | The MCP App panel is last and optional | **Decided** | Claude Code renders no apps; the agent console exists |

## 2. Spikes (run before design sign-off)

| Spike | Steps | Pass | Cost |
|---|---|---|---|
| **S1 accessibility gate** | In Nairobi Racer `Config/DefaultEngine.ini`, `[SystemSettings] Accessibility.Enable=1`; turn VoiceOver on (Cmd+F5), launch the editor, turn VoiceOver off; `get_ui_tree` and Apple's Accessibility Inspector on the editor window; count nodes, note roles with labels and values, time the first walk, watch the editor's frame time for the 0.25 s refresh. Then a 30-line editor module that calls `FMacApplication::OnVoiceoverEnabled()` after Slate init so VoiceOver is not needed | Buttons, text boxes, combo boxes and Details rows appear with labels; `click_element` presses a toolbar button with the pointer unmoved; no measurable frame cost at idle | half a day plus the module |
| **S2 pointer without warp** | A toolset function that calls `FSlateApplication::ProcessMouseMoveEvent` / `ProcessMouseButtonDownEvent` / `Up` at a widget's screen centre without `SetCursorPos`; click a toolbar button and a Details checkbox; check the widget state and that the OS cursor position is unchanged | Both widgets react; `CGEventGetLocation` unchanged | hours |
| **S3 Blender** | The v7.5 pending steps (design §6): `key n` over the viewport, `click_text "File"`, with Blender in the background through pid delivery; record in `doctor` | Keys reach; clicks probably don't (as Unreal and TextEdit) | an hour |
| **S4 inspector from Python** | `unreal.ToolsetRegistry.execute_tool("SlateInspectorToolset.SlateInspectorToolset", "Snapshot", json)` inside a ue-bridge job; `SelectOption` once (its internal `Tick()`) | Works from a bridge job, or we know the bridge must use Epic's MCP | an hour |
| **S5 drag-drop** | `Drag` from a Content Browser tile to the viewport with one jump vs stepped moves | A placed actor appears; records which variant is needed | an hour |
| **S6 the `'/'` stop** | `Type` "/Game/x" into the Cmd box with the suggestion popup closed vs open; `HasKeyboardFocus` after the `/` | Confirms or rejects the popup hypothesis; fixes `Type` if needed | an hour |

## 3. Components

- **`AgentDesktop` Unreal plugin** (games workspace, `tools/vendor/AgentDesktop` or its own repo): one editor module.
  - `FAgentDesktopModule::StartupModule`: on Mac, set the cvar and, after the first Slate tick, call the accessibility
    activation (`MacApplication->OnVoiceoverEnabled()`), with a setting to turn it off.
  - `UAgentDesktopToolset` (toolset registry): `Click`, `Hover`, `Drag` (stepped), `Type` (key events, `SetText` commit),
    `WaitFor` (blocking, timeout), `WaitForWindow`, `ClickByText`, `Dialogs` (list), `Answer`, `Refs` (path refs for a
    subtree). Each returns `{ok, effect, readback}`.
  - Tests: an automation test per function on a test window, like Epic's `AI.Toolsets.SlateInspectorToolset`.
- **desktop-control bridge layer** (`src/session/bridges/`): a registry, an Unreal bridge client (JSON-RPC over HTTP to
  Epic's MCP with `Mcp-Session-Id`, plus `call_tool`), a Blender bridge client (the MCP socket), route selection, result
  mapping to `delivery`/`route`/`effect`. `doctor` lists bridges and their liveness.
- **Dialog flow** (`src/session/dialog-handlers.ts`): `read_dialog`, `answer_dialog`, `wait_for_window.answer`, using AX
  for native dialogs and the bridge or OCR for Slate ones.
- **Supervision panel** (optional, `src/app/`): `ui://` resource, app-only tools `panel_frame`, `panel_approve`,
  `panel_point`.

## 4. Open questions for James
1. Does the plugin live in `games/tools/vendor/` beside VibeUE, or in its own public repo (it is generic to any Unreal
   project on macOS)?
2. Should the bridge layer ship in the npm package (generic, config-driven) or stay workspace-only until a second bridge
   exists?
3. Is the panel worth building while we work in Claude Code, which can't render it?
