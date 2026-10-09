# Driving the UE 5.8 editor UI (Slate) from an agent: research (read-only, 2026-10-09)

Roots: E = /Users/jameskaranja/Developer/unreal_engine/UE_5.8/Engine ; AC = E/Source/Runtime/ApplicationCore ;
SI = E/Plugins/Experimental/Toolsets/SlateInspectorToolset/Source/SlateInspectorToolset.
Nothing was run. Everything below is from source on disk, the generated Python stub
(games/nairobi-racer/Unreal/Intermediate/PythonStub/unreal.py), the workspace skills, and a few web searches.
"UNCERTAIN" marks anything inferred and not read in code or docs.

## Bottom line

1. **A Mac accessibility implementation exists, is compiled into the editor, and is OFF by default.** The reason our
   AX tree shows ~6 nodes is that UE never publishes Slate widgets to AppKit unless two gates are open (cvar
   `Accessibility.Enable`, default false; and "VoiceOver was on at launch"). It is not that Slate cannot do it.
2. **Slate widgets that would appear** (when on): window, button, checkbox, text/editable text (with value), combo
   box, list/tree rows, slider, image, hyperlink. That covers menus (entries are SButton/SCheckBox), the Details
   panel's text, check and combo rows, toolbars, and the Content Browser lists. **Not exposed**: dock tabs, spin
   box as a number, tree expanders, anything that is a raw SWidget with mouse handlers (viewport, splitters, scroll bars).
3. The Mac layer supports **AXPress (buttons and checkboxes only) and increment/decrement (sliders)**. No AXValue
   set, no AXIdentifier, no hit-test. So an OS tool could read the tree and press buttons without focus or cursor
   movement, but typing into fields and dock-tab clicks would still need other paths.
4. **Epic's SlateInspectorToolset already gives a better, in-process version** of snapshot + click-by-ref + type +
   drag + select-option + WaitFor + FillForm + window list, plus widget screenshots. Its weaknesses (below) are: real
   cursor warp, refs not stable across sessions, char-only typing, needs the editor ticking, no modal/OS dialog reach.
5. **Recommendation (detail at end):** keep desktop-control for what is OS-level (D). For in-editor Slate work, use
   SlateInspector first. Treat "extend desktop-control to read the UE AX tree" as a cheap spike (enable the cvar +
   a flip) rather than building a plugin. Build a small plugin only for gaps SlateInspector leaves (stable ref paths,
   no cursor warp, set-value, modal detection).

---

## A. Slate accessibility on macOS

### A1. The Mac implementation (exists, real code, 937 lines)
- `AC/Private/Mac/Accessibility/MacAccessibilityManager.cpp` (FMacAccessibilityManager: element cache keyed by
  AccessibleWidgetId, 0.25 s refresh), `MacAccessibilityElement.cpp` (FMacAccessibilityElement : NSAccessibilityElement),
  `CocoaAccessibilityView.cpp` (FCocoaAccessibilityView). Headers in `AC/Public/Mac/Accessibility/`.
- Wiring: `FCocoaTextView : FCocoaAccessibilityView` (`AC/Public/Mac/CocoaTextView.h`), and the Slate/Metal content views
  derive from it: `FMetalView : FCocoaTextView` (`E/Source/Runtime/Apple/MetalRHI/Public/MetalViewport.h:25`),
  `FSlateCocoaView` (StandaloneRenderer). So every UE window content view can parent the accessible tree.
  `FCocoaAccessibilityView.accessibilityChildren` returns the accessible SWindow element's children.
- Element mapping (`MacAccessibilityElement.cpp` role switch): Button->AXButton, CheckBox->AXCheckBox,
  Image->AXImage, Slider->AXSlider, Text->AXStaticText, TextEdit->AXTextField (AXStaticText if read-only,
  secure subrole if password), Window->AXWindow, Hyperlink->AXLink, Layout->AXLayoutArea, ComboBox->AXComboBox,
  everything else AXUnknown. `ScrollBar`, `List`, `ListItem` enum values fall to AXUnknown here.
- Properties: AXLabel (= widget accessible text, else FTagMetaData tag, else C++ class name: `SlateCoreAccessibleWidgets.cpp`
  GetWidgetName), AXHelp (tooltip text), AXValue (bool / float / string only), AXFrame (Slate screen rect converted
  to Cocoa; `ConvertSlatePositionToCocoa`; DPI handling not checked, UNCERTAIN), AXEnabled, children, parent, window.
- Actions: `accessibilityPerformPress` -> `IAccessibleActivatable::Activate()` -> `SButton::ExecuteOnClick` /
  `SCheckBox::ToggleCheckedState` (`E/Source/Runtime/Slate/Private/Widgets/Accessibility/SlateAccessibleWidgets.cpp`),
  allowed only for Button and CheckBox roles (`isAccessibilitySelectorAllowed`). Increment/Decrement for sliders.
  `setAccessibilityFocused` -> `SetUserFocus` (Slate keyboard focus). Both run through `GameThreadCall`, so the editor
  game thread must tick.
- Gaps in the Mac layer (source comments, so factual): no `accessibilitySetValue` (AXValue is read-only; text
  `SetValue` exists on the Slate side but is only reachable via the VoiceOver text path); text-range methods are
  `@TODO` stubs; no hit-test (`CocoaAccessibilityView.cpp` has it commented out); no AXIdentifier. Likely bugs:
  `RemoveAccessibilitySubtree` reads `[Cache objectForKey:@(RootId)]` instead of CurrentId; `SetAccessibilityWindowAsAccessibilityChild`
  sets `accessibilityParent` before assigning the window. Impact UNCERTAIN.

### A2. How it is enabled (two gates, both closed by default)
- Gate 1, cvar: `Accessibility.Enable` = `GAllowAccessibility`, **default false**
  (`AC/Private/GenericPlatform/Accessibility/GenericAccessibleInterfaces.cpp:11-16`). `SetActive(true)` is masked by it
  (`bActive &= GAllowAccessibility`). Nothing in `E/Config` sets it (grep of E/Config, Platforms, Plugins: no hit).
  Epic docs: set `Accessibility.Enable=1` in a console-variable ini
  (https://dev.epicgames.com/documentation/en-us/unreal-engine/supporting-screen-readers-in-unreal-engine).
  Project route: `DefaultEngine.ini` `[SystemSettings]` `Accessibility.Enable=1` (read before Slate init: UNCERTAIN on
  ordering; `-ExecCmds` is probably too late).
- Gate 2, trigger: `FMacApplication::SetAccessibleMessageHandler` (`AC/Private/Mac/MacApplication.cpp:~363-383`) checks
  `[NSWorkspace sharedWorkspace].isVoiceOverEnabled` **once at startup** and only then calls `OnVoiceoverEnabled()`
  (`:2660`: `SetActive(true)`, attach accessible windows to each FCocoaWindow, start a 0.25 s NSTimer).
  The runtime KVO that would react to VoiceOver being switched on later is **commented out** with "can cause VoiceOver
  to hang" (`MacAccessibilityManager.cpp:62-75`). There is no `AXEnhancedUserInterface` / `AXManualAccessibility`
  handling (grep: none), unlike Chromium/Electron. So a plain AX client (our tool) does not wake it.
- Ways to open gate 2 without VoiceOver: `FMacApplication::OnVoiceoverEnabled()` is a **public** member of an
  `APPLICATIONCORE_API` class and `MacApplication` is an exported global (`AC/Public/Mac/MacApplication.h:140,159,450`).
  A tiny editor module (ObjC++ for Mac) could set the cvar and call it on the main thread after Slate init. Not read
  from Python (not UFUNCTION). Alternative with no code: turn VoiceOver on (Cmd+F5) before launching the editor
  (speaks, steals the user's keyboard handling; not acceptable while James works).
- `FSlateScreenReader` plugin (Engine/Plugins/Experimental/SlateScreenReader, Mac in its allow list) takes over the
  accessible-event delegate and unregisters users; do not enable it alongside this (it would replace
  `FMacApplication::OnAccessibleEventRaised`). It is a TTS reader, not an AX exposer.

### A3. Is it in editor builds?
- `bCompileWithAccessibilitySupport = true` by default (`E/Source/Programs/UnrealBuildTool/Configuration/Rules/TargetRules.cs:1565`),
  `Build.h:105` defaults `WITH_ACCESSIBILITY 1`; only console apps turn it off. No Editor-target override found.
- Binary check: `strings` on `E/Binaries/Mac/libUnrealEditor-ApplicationCore.dylib` shows `FMacAccessibilityElement`,
  `FMacAccessibilityManager` and the stats format string, so the installed editor has the Mac layer compiled in.
- The editor is not special-cased (no `GIsEditor` branch in the accessibility code). It is just Slate windows.

### A4. Which Slate widgets expose anything
- `SWidget` default `AccessibleBehavior = NotAccessible` (`E/Source/Runtime/SlateCore/Private/Widgets/SWidget.cpp:239`).
  Set in constructors: SButton(Summary), SCheckBox(Summary), SSlider(Summary), SEditableText(Auto),
  SEditableTextBox(Auto), STextBlock(Auto), SComboBox(Auto), SListView(Auto; STreeView derives), STableRow(Summary),
  SWindow(Auto). SHyperlink/SImage have accessible classes in headers. grep of `Editor/PropertyEditor`, ContentBrowser,
  LevelEditor, UnrealEd, SceneOutliner, `Slate/Private/Framework/MultiBox`, `Widgets/Docking`: **zero** editor-specific
  accessibility annotations. So what shows is whatever generic widgets the editor composes.
- Tree build: `FSlateAccessibleMessageHandler::Tick` (`SlateCore/Private/Widgets/Accessibility/SlateAccessibleMessageHandler.cpp:~240`)
  walks all top-level and child windows, **100 widgets per tick** (`Slate.AccessibleWidgetsProcessedPerTick`), skipping
  NotAccessible widgets but keeping their descendants. Mac side lazily creates elements as AppKit asks, so the tree
  fills level by level; strings refresh at most every 0.5 s. Expect a slow first walk on a large editor layout.
- Dock tabs (SDockTab handle OnMouseButtonDown themselves), spin boxes (SSpinBox has no accessible type of its own; its inner
  SEditableText would appear), viewport, splitters, 3D gizmos: not pressable via AX.
- Native macOS main menu bar: **already a real NSMenu.** `Slate/Private/SlateModule.cpp:16-19` loads module `MacMenu`;
  `E/Source/Runtime/Apple/MacMenu/Private/MacMenu.cpp` (`FSlateMacMenu::UpdateWithMultiBox`, `[NSApp setMainMenu:]`) mirrors
  the active window's menu MultiBox into NSMenu items whose action calls `FSlateMacMenu::ExecuteMenuItemAction`. So File/Edit/Window/
  Tools menus should already be readable and pressable through the OS AX menu APIs (`list_menu_bar`, AXPress), no UE change.
  (CLAUDE.md says never use list_menu_bar on Blender; for Unreal the main menu is native. Not verified at runtime: UNCERTAIN.)
  Context menus and combo dropdowns are Slate popup windows, so they need Slate AX.
- Windows has UIA (`AC/Private/Windows/Accessibility/*`), iOS has UIAccessibility; Mac is the least finished (VoiceOver-focused).
  Epic's docs list "Windows third-party readers, VoiceOver on iOS" and say nothing about macOS or the editor.

### A5. What it would take for our tool to see the Details panel by element
Cheapest spike (hours, no engine rebuild): put `Accessibility.Enable=1` in the project ini, then flip gate 2
(VoiceOver on at launch for a one-off experiment), then read the tree with `get_ui_tree` and Apple's Accessibility Inspector.
Expected: AXWindow -> (content view) -> AXButton/AXTextField/AXStaticText with labels, values, frames. Durable version
(days): editor module that calls `OnVoiceoverEnabled()` after startup, plus fixes. Higher-effort wish list (engine
source change; Epic's source is available but the install is binary): AXPress for combo/tab/menu rows, writable AXValue
via the existing `IAccessibleProperty::SetValue`, AXIdentifier from `FTagMetaData`, hit-test, and an `AXManualAccessibility`
switch so no VoiceOver is needed. Performance risk: the 0.25 s timer plus per-tick tree build on a big editor (UNCERTAIN; Epic's
own comment: "tested with ~650 elements and still fairly responsive").

---

## B. Epic's SlateInspectorToolset

Plugin `E/Plugins/Experimental/Toolsets/SlateInspectorToolset` (EditorOnly, NoRedist, experimental, part of AllToolsets, console
`SlateInspectorToolset.Enable`). 14 tools in `SI/Public/SlateInspectorToolset.h`. All run on the game thread in-process.

| Tool | Params | Mechanism (file `SI/Private/SlateInspectorToolset.cpp`) |
|---|---|---|
| Snapshot | Ref="" (all windows), MaxDepth=30, bIncludeSourceLocations | Text tree from `GetAllVisibleWindowsOrdered`, one line per role: `button "Save" [pos=x,y size=w,h] [ref=b12]`. Renderer maps ~25 SWidget types to roles, collapses structural containers (SBox, SBorder, SHorizontalBox...), absorbs a lone STextBlock child as the label, uses `GetAccessibleText` first. `src=File:Line` tags (non-shipping). |
| Observe / Unobserve / ListObservers | Ref, MaxDepth | Observers re-render their subtree on `FSlateApplication::OnPostTick` every ~100 ms and keep refs alive (`ObserverManager.cpp`). A depth-0 root observer is created automatically. |
| Screenshot | Ref="" (active window) | `FSlateApplication::TakeScreenshot` -> Slate renderer readback of that window. Independent of OS occlusion. |
| Click | Ref, Button left/right/middle, DoubleClick, Modifiers{shift,ctrl,alt,cmd} | `SimulateClick`: `FSlateApplication::SetCursorPos(center)` + `ProcessMouseMoveEvent` + `ProcessMouseButtonDownEvent(Window->GetNativeWindow(), ..)` + `ProcessMouseButtonUpEvent`. Synthetic FPointerEvents, not OS events. |
| Hover | Ref | `SetCursorPos` + `ProcessMouseMoveEvent` |
| Type | Ref, Text, Submit | `SetKeyboardFocus(widget, SetDirectly)`, then **one `FCharacterEvent` per char via `ProcessKeyCharEvent`; no KeyDown/KeyUp**; Submit sends Enter KeyDown/Up. |
| PressKey | "Ctrl+Shift+Cmd+A", "Enter", ... | `ProcessKeyDownEvent` (+ a synthesized char for Backspace/Tab/Enter/Esc) + KeyUp. Goes to the Slate focus path. |
| SelectOption | Ref, Value | click combo, `Tick()` twice, BFS for STextBlock equal to Value across new windows first, click it. Refuses if called during input processing. |
| Drag | StartRef, EndRef, Modifiers | Down at start, **one** move jump to end, Up. No intermediate moves. |
| Windows | list / select(BringToFront + SetAllUserFocus) / close(RequestDestroyWindow), Index | list returns index + title of visible Slate windows. |
| WaitFor | Text, TextGone | **Non-blocking single check** of STextBlock/accessible text across all windows; caller polls. |
| FillForm | [{Ref, Value, FieldType textbox/checkbox/combobox}] | Type / Click-if-differs / SelectOption. |

Evidence from tests (`SlateInspectorToolsetTests.cpp`, `AI.Toolsets.SlateInspectorToolset`): click, double, right, modifiers, drag
between buttons, slider drag, checkbox toggle, type "hello", "a@b#c$d". '/' is not tested.

- **Focus and background:** Input goes through `FSlateApplication::Process*Event`, which routes along Slate's own focus path
  and hit-test (`LocateWindowUnderMouse(GetInteractiveTopLevelWindows)`), so it needs no OS key window. Covered windows are fine.
  What it does need: the game thread ticking. With "Use Less CPU in Background" on, our own workaround is `nr.Agent.KeepAwake`
  (ue-bridge skill lines 108, 128; `ue_job` sets it).
- **It moves the user's real mouse.** `SetCursorPos` -> `FMacCursor::SetPosition` -> `WarpCursor` -> `CGWarpMouseCursorPosition`
  (`AC/Private/Mac/MacCursor.cpp:318-337, 492-517`). Click/Hover/Drag/SelectOption all do this. Unusable while James works.
- **Refs are session counters** (`b12`, `tb3`, `co7`: `RefCache.cpp`), assigned in render order, not stable across restarts, layout
  changes or a Snapshot with reset. They live while the widget lives. No path like "Details > Transform > Location X".
- **Python reach:** `unreal.SlateInspectorToolset` exists in the stub but has **no methods** (functions are `meta=(AICallable)`,
  not Script-callable). Reach via the MCP `call_tool`, or `unreal.ToolsetRegistry.execute_tool(toolset_name, tool_name, json_input)`
  (stub line ~521439; toolset-name string UNCERTAIN; `ue_python` can try it). Calls from inside a ue-bridge job run in a Slate
  post-tick, so `SelectOption` (which calls `Tick()`) may hit its reentrancy ensure (UNCERTAIN).

### The '/' stop and dropped keys (cause NOT confirmed; ranked hypotheses)
1. `Type` never sends key-down, only chars. In the editor Cmd box (`SConsoleInputBox`, `E/Source/Developer/OutputLog/Private/SOutputLog.cpp`)
   every char fires `OnTextChanged` (line 376) which recomputes suggestions with `ForEachConsoleObjectThatContains` and calls
   `SuggestionBox->SetIsOpen(true/false)`. A '/' matches no console object, so the suggestion popup (an SMenuAnchor menu
   window) closes mid-string; closing a menu can move Slate focus, and later chars then go to a different widget. Most plausible,
   testable: type the same text with the suggestion box closed, or after `/`, check `HasKeyboardFocus`. UNCERTAIN.
2. `OnKeyCharHandler` swallows all chars until the widget's first `Tick` ("A printable key may be used to open the console...",
   `SOutputLog.cpp:874-880`), and `Type` calls `SetKeyboardFocus` then types in the same frame. A freshly shown box drops early chars.
3. Not frontmost: with background throttling the editor ticks ~3 fps, so popup creation and focus changes lag the synchronous
   char events. KeepAwake removes this class of problem.
4. I found no special-casing of '/' in `FSlateApplication::ProcessKeyCharEvent` (`SlateApplication.cpp:4909`), `FSlateEditableTextLayout::HandleKeyChar`
   or `SEditableText`. The '/' symptom itself is only in the task brief; no note in the workspace docs records it.
Safer in practice: `SystemLibrary.execute_console_command` via ue-bridge (already preferred in CLAUDE.md); use Type only for real UI.

---

## C. Other in-engine surfaces

| Surface | Facts (path) | Verdict for agents |
|---|---|---|
| **Slate Automation Driver** `E/Source/Developer/AutomationDriver` | `IAutomationDriver` / `IAsyncAutomationDriver` (module `AutomationDriver`). Locators `By::Id(tag)`, `By::Path("#Suite//Piano/Key//<STextBlock>")`, `By::Delegate/WidgetLambda`. Element ops: Hover, Click, DoubleClick, Scroll*, Type(text/key/chord), Press/Release, Focus, IsVisible/IsChecked/IsInteractable, GetText, GetAbsolutePosition. Uses a **fake cursor** (`AutomatedApplication.cpp:36-50`, real cursor only when `bAllowMessageHandling`), and `Enable()` stops real platform input from reaching the app. C++ only (no UCLASS/UFUNCTION). Used by TraceInsights, EditorTRSGizmoTests, AutomationDriverTests. | Best-designed (tag/path locators, no cursor warp) but the sync API deadlocks on the game thread (SlateInspector's own header says so), and the async one needs a worker. Only widgets with `FTagMetaData` or type paths; editor widgets are mostly untagged. A plugin could wrap it. |
| **FSlateApplication from a plugin** | `GetAllVisibleWindowsOrdered`, `FindWidgetWindow`, `GeneratePathToWidget`, `SetKeyboardFocus`, `ProcessMouse*/Key*`, `TakeScreenshot`, `OnPreTick/OnPostTick`, `OnWindowBeingDestroyed`, `OnFocusChanging`, `GetActiveModalWindow`, `CanAddModalWindow`. | Everything SlateInspector does is built on these. Window-created events: no delegate (poll the window list). |
| **Widget Reflector** `E/Source/Developer/SlateReflector` | Panel + `FWidgetReflectorNodeUtils`, pick-widget, snapshot service. Console `SlateDebugger.Start/Event.Start/Event.LogInputEvent` (`SlateCore/Private/Debugging/ConsoleSlateDebugger.cpp`) log input routing. | Useful to verify what a synthetic click hit; not an action surface. |
| **ToolMenus** (`unreal.ToolMenus`) | Python (stub 341795+): register/extend/find/remove menus and sections, `add_entry`, entry objects with `execute`. No "invoke existing entry by name" and `ExecuteStringCommand` is native-only (`ToolMenus.h:451`). | Can **add** a menu entry that runs a Python string; cannot press File > X. For built-in commands use the native Mac menu (A4) or the Slate button. |
| **Editor utilities (Python)** | `EditorUtilityLibrary` (selection, content-browser selection/path), `EditorDialog.show_message / show_suppressable_warning_dialog / show_object_details_view`, `EditorUtilitySubsystem.spawn_and_register_tab...` (open an Editor Utility Widget as a dock tab: you can author UMG panels the agent controls), `EditorAssetLibrary`. | Most "UI tasks" have a data API; use it. EUWs are a way to host agent-owned buttons/inputs in the editor. |
| **Epic EditorAppToolset** `E/Plugins/Experimental/Toolsets/EditorToolset/Source/EditorToolset/Private/EditorAppToolset.cpp` | CaptureEditorImage (every visible Slate window via `TakeScreenshot`, composited at screen positions), CaptureViewport, Get/SelectActors, Get/SetCameraTransform, FocusOnActors, GetVisibleActors, **WorldPosToScreenCoords / ScreenCoordsToWorld(trace)** (viewport ray pick), Get/SelectAssets, Get/SetContentBrowserPath, OpenEditorForAsset, StartPIE/StopPIE. | Covers viewport picks and content-browser navigation without any UI driving. |
| **MessageDialog / notifications** | `FMessageDialog::Open` (`Core/Private/Misc/MessageDialog.cpp:147-166`): returns the default immediately if `FApp::IsUnattended()` or `GIsRunningUnattendedScript` (`-RunningUnattendedScript`, `LaunchEngineLoop.cpp:6857`; Blutility's `EditorUtilityTask` sets it temporarily); else in the editor `UEditorEngine::OnModalMessageDialog` -> Slate `SMessageDialog` modal window (`EditorEngine.cpp:5089`), **falling back to `FPlatformMisc::MessageBoxExt` = native NSAlert** (`MacPlatformApplicationMisc.cpp:96`) when `CanAddModalWindow()` is false or off the game thread. Toasts: `FSlateNotificationManager` (`Slate/Public/Framework/Notifications/NotificationManager.h`), Slate windows of type Notification. No "dialog opened" delegate. | A Slate modal is visible to `SlateInspector.Windows`/`Snapshot` (it is a normal SWindow); detect by polling window titles, click its buttons by ref. A native NSAlert is OS-only. `-unattended` avoids most dialogs (side effects UNCERTAIN: also changes crash/reporting behaviour). |
| **-ExecCmds / console** | `unreal.SystemLibrary.execute_console_command(world, cmd)` (stub 413078) already used by ue-bridge; Epic's MCP has no console tool (REVIEW 2026-10-09). | Use instead of typing into the Cmd box. |
| **Screenshots** | `AutomationLibrary.take_high_res_screenshot(res_x,res_y,filename,camera,...,force_game_view=True)` (stub 436306), `take_automation_screenshot_of_ui` (latent), HighResShot console, `FScreenshotRequest`, VibeUE `ViewportService.capture_scene` (transient scene capture, no editor icons), ue-bridge `ue_capture`. | These render engine frames (viewport/UI via Slate renderer). OS capture (ScreenCaptureKit) is only needed for things outside the engine renderer: NSAlert/NSOpenPanel, other apps, splash. |
| **Hosting a Slate test in CI** | `CQTest` `FCQTestSlateComponent` (tick waits), Epic Automation `AutomationTestToolset`. | Tests, not driving. |
| **VibeUE** (`tools/vendor/VibeUE`) | `UWidgetService` is UMG asset authoring, `UViewportService` captures, `UInputService` is Enhanced Input assets. No Slate editor driving, no accessibility hooks (grep). | Not an alternative for B. |

---

## D. What stays OS-only

| Case | In-engine path? | Detail |
|---|---|---|
| File open/save pickers | None | `DesktopPlatformMac.cpp:282-299,389` uses `NSOpenPanel` / `NSSavePanel` `runModal` (native AppKit, blocks the game thread). Native AX + OS input only. |
| Native alert (NSAlert) | None | Used when Slate cannot host a modal (`MacPlatformApplicationMisc.cpp:96`) and by `FPlatformMisc::MessageBoxExt` generally. |
| macOS TCC / permission prompts, "app downloaded from internet", login/keychain | None | Not UE windows. |
| Crash Reporter (CrashReportClientEditor) | None | Separate process (`E/Binaries/Mac/CrashReportClientEditor.app`; ue-bridge `ue_recover`). Its UI is Slate in another process, no UE editor to ask. |
| Hung/not-ticking editor | None | Game-thread tools do nothing; `ue_job` stack dump + SIGKILL. SlateInspector is dead too. |
| Splash screen, early startup | None | `MacPlatformSplash.cpp`; before modules load. OCR/screenshot only. |
| Standalone game window / PIE in a separate window | Partly | Same FSlateApplication in-process, so SlateInspector sees the game's Slate/UMG; the game viewport itself (3D input) needs real key events (`desktop-control type mode:"keys"`, pid delivery works for keys, per skill). |
| Blender, TextEdit, Finder, browsers, launching apps | None | Not Unreal. |
| Editor window arrangement, which window is key, Spaces | Little | `Windows(select)` does BringToFront but not an OS activation request. |

Reading side for these is still fine with ScreenCaptureKit + OCR; clicking native sheets works through AX (native Cocoa, full tree).

---

## E. What an "agent desktop" plugin would add (vs SlateInspector + Python + VibeUE)

| Capability | Already in SlateInspector? | Gap / plugin value |
|---|---|---|
| Widget tree with refs, roles, labels, bounds | **Yes** (Snapshot/Observe) | Refs are counters. Add stable path ids (window title / tab id / ancestor labels / property name; `FTagMetaData` where present). |
| Click by label | Partly: Snapshot then Click(ref) | Add `ClickByText(role,label,within)`; avoids round trip and ref drift. |
| Click without moving the real cursor / stealing focus | **No** (`CGWarpMouseCursorPosition`) | Route events with the synthetic-cursor approach of the Automation Driver (`AutomatedApplication`) or skip `SetCursorPos`. High value while James works. |
| Type text | Partly (chars only) | Add real Key down/up + `SetText` on SEditableTextBox/Text. Fixes the console-box class of bugs. Property rows: commit via OnTextCommitted. |
| Set value on Details property rows | **No** | Better: data API (`set_editor_property`, ObjectTools). UI route only for things without one. A "set row by name" helper walking the Details SPropertyTable is plausible. |
| Drag/drop Content Browser -> viewport | Drag exists (1 jump) | Slate drag detection needs several moves past a threshold; add stepped moves + hold, and viewport drop. UNCERTAIN whether the current single jump starts a `FDragDropOperation`. Alternative: `SceneTools.add_to_scene_from_asset` (no UI). |
| Viewport ray pick | **Yes** (EditorAppToolset.ScreenCoordsToWorld; WorldPosToScreenCoords) | None; click-select in viewport needs mouse events (SlateInspector Click on the viewport widget). |
| Modal detection and answer | Partly: `Windows(list)` + Snapshot + Click; WaitFor is a single check | Add `OnWindowShown` hook, auto-dismiss rules, dialog text capture. Native NSAlert/NSOpenPanel stay OS-side. |
| Menu invocation | No (ToolMenus can't invoke) | Native Mac menu bar via OS AX (A4) already works; or click menu entry Slate buttons. Plugin could call `FToolMenuEntry` UIAction by name (C++). |
| Works covered/background | Mostly (in-process), **needs ticking** | KeepAwake already handled by ue-bridge. Screenshots via Slate renderer are occlusion-proof. |
| Widget screenshot | **Yes** (Screenshot, CaptureEditorImage) | None. |
| Wait/assert | Weak (WaitFor polls once) | Add blocking wait with timeout via tick. |
| Works with MCP and Python | MCP yes; Python only via ToolsetRegistry.execute_tool (UNCERTAIN) | A plugin with `BlueprintCallable` statics would be native in `ue_python`. |

Verdict on a plugin: mostly **wrapping and hardening what SlateInspector already does** (stable refs, no-cursor input, key events,
dialog hooks). Its source is small (3,000 lines incl. tests), the toolset registry is public, and the `create-toolset` skill exists.
A fork/extension is cheaper than greenfield.

---

## F. Web findings

- Epic API page for the toolset: https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/SlateInspectorToolset/USlateInspectorToolset
  and Python page https://dev.epicgames.com/documentation/en-us/unreal-engine/python-api/class/SlateInspectorToolset describe the
  same "Playwright-style" intent as the header; no extra behaviour. Docs do not state the introduction version.
- Screen-reader docs (https://dev.epicgames.com/documentation/en-us/unreal-engine/supporting-screen-readers-in-unreal-engine):
  `Accessibility.Enable=1`; supported: third-party readers on Windows, VoiceOver on iOS; macOS and the editor not mentioned;
  built-in UMG support for text block, editable text box, slider, button, checkbox; custom widgets override
  `SWidget::CreateAccessibleWidget`. UE5 also has Text To Speech, Screen Reader, Slate Screen Reader plugins.
- Searches for "Slate accessibility on Mac / editor VoiceOver / AX tree" returned no forum posts or bug reports: unreported, so treat
  Mac editor accessibility as unverified territory. Searches for Epic MCP community work found only general write-ups (a dev.to
  guide on UE 5.8 Unreal MCP safety: serial game-thread execution, no HTTP auth) and third-party servers (ue-mcp, Conduit, Jutsu,
  VibeUE); none documented Mac AX use.
- Other community UI voice-control plugin: "Accession" (editor voice control; tested on Windows only).

---

## Recommendation for desktop-control (decision input)

1. **Keep desktop-control; do not replace it.** Section D is a permanent OS-only set (NSOpenPanel/NSAlert, TCC, crash reporter,
   hung app, splash, other apps, game window keys). Improve those: `wait_for_window kind:dialog`, AX tree reads on native sheets.
2. **Do not extend desktop-control with Unreal-specific Slate hacking.** OCR + coordinate clicks on Slate is the weakest path,
   and SlateInspector is strictly better for in-editor Slate (refs, in-process, occlusion-proof screenshots), except for cursor warp.
3. **Run the cheap accessibility spike** (maybe half a day): add `Accessibility.Enable=1` to the Nairobi Racer `[SystemSettings]`,
   launch with VoiceOver on once, dump `get_ui_tree` + Accessibility Inspector. If the tree is useful, decide between (a) a 30-line editor
   module that calls `FMacApplication::OnVoiceoverEnabled()` (no VoiceOver) so desktop-control can read Slate by element and AXPress
   buttons/checkboxes with no focus and no cursor movement, or (b) skip it because SlateInspector covers reading. The unique value of (a) is
   **cross-process**: desktop-control could read the editor while the editor is hung-adjacent or from a session that does not own port 8000.
4. **Fix SlateInspector's two practical faults in a small plugin/fork** (only if UI driving becomes frequent): drop `SetCursorPos`
   from SimulateClick/Hover/Drag (or use a fake cursor), send real KeyDown/KeyUp for `Type`, add stable path ids, add stepped Drag.
5. Prefer data APIs over UI whenever one exists (`ue_python`, VibeUE, EditorAppToolset, `execute_console_command`); the UI paths are the
   fallback for dialogs, panels with no API, and visual confirmation.
6. Checks to run before relying on any of this: (i) does `unreal.ToolsetRegistry.execute_tool("SlateInspectorToolset", "Snapshot", ...)`
   work from `ue_python`; (ii) is the main-menu NSMenu populated in the editor (use `list_menu_bar` on UnrealEditor); (iii) type "/Game/x"
   into the Cmd box via `Type` with the suggestion popup closed vs open, to confirm hypothesis 1.
