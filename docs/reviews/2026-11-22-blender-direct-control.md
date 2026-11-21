# Blender 5.3 by mouse and keyboard alone

The goal was for an agent to do everything in Armin 5D's "Blender 5.3 Is the Biggest Update in Years" (13 minutes,
about 60 features across 35 areas) through this server's mouse, keyboard and screen tools, with no Blender MCP and no
Python. Blender draws its own interface, so the accessibility tree is empty and every action is a key, a pointer
gesture or OCR. Running the gestures the video needs against Blender 5.3.0 on macOS 26.2 found four defects that broke
ordinary Blender use and three gestures the server could not express. All are fixed in the working tree; the fixes
are pinned by 16 unit tests and were confirmed in Blender by reading the result back from Blender's own data.

## How it was checked

The video was transcribed on device (Speech framework `SpeechTranscriber`) and sampled into contact sheets; the
transcript is not kept here. Blender was started with a test fixture (`--python`) that writes the scene state to a
JSON file four times a second and runs set-up snippets: it is how the tester read results, never part of the route
under test. Raw CGEvent probes (Swift) settled what Blender reads before any server code changed. Then each feature
was driven through the server in-process (`createComputerUseServer` + `connectInProcess`) with OCR to find controls,
and the fixture said whether it happened.

## Defects found

| # | Defect | Where | How it was confirmed |
|---|---|---|---|
| 1 | macOS `key` set modifier flags on the key event and never pressed the modifier key. Blender tracks modifiers from flagsChanged events, so `key "shift+a"` arrived as `A` with shift false: every modified Blender shortcut was broken. | `native/src/keyboard.rs` `key_press_impl`, now `ModifierKeys` at `:530` and the press at `:658` | An in-Blender modal event logger recorded `["A","PRESS",…,shift false]`; after the fix `LEFT_SHIFT PRESS` then `A PRESS` with shift true, and the Add menu opened |
| 2 | macOS pointer gestures with `modifiers` did the same, so `mouse_drag {button: "middle", modifiers: ["shift"]}` orbited instead of panning (AGENTS.md documented it as panning). | `native/src/mouse.rs` `post_button_event` `:607`, modifier keys at `:650` | View rotation changed and location did not; after the fix location moved (−0.02 → −1.93) and rotation stayed |
| 3 | `type` posted Unicode text 20 characters per key event; Blender keeps one character per event, so "Relax Edge Loops" in F3 search arrived as "R". | `src/session/input-handlers.ts` `ONE_CHARACTER_PER_KEY_APPS` `:41`, `#readsOneCharacterPerKey` `:916` | Screenshot of the search field holding "R"; with key events `MESH_OT_relax_edge_loops` ran |
| 4 | The capture helper's window capture returned Blender's 1280×922 main window letterboxed into the 1060×632 frame of its file browser window, while the reply still mapped `screen = origin + image`. A double-click computed from OCR on that window hit the browser's new-folder button and created two empty folders in the home directory (removed straight away; both empty, created at the second of the click). | `libexec/macos-agent-helper.swift` `captureWindow`, fallback at `:147`, `isLetterboxed` `:166` | Side-by-side captures: window filter gave the main window, `SCContentFilter(display:including:)` with `sourceRect` gave the browser. Edge-midpoint alpha was 0 on the bad capture and 255 on good ones; after the fix OCR on the browser read its own path field at the right place |

## Gestures that could not be expressed

| Gesture | Needed for | Added |
|---|---|---|
| A click with a modifier | Alt+click edge loops (loop tools), shift-extend | `click {modifiers}`; macOS `mouseClickModified` (`native/src/mouse.rs:727`), elsewhere press/release with the real keys |
| A key held through a click or drag | Sequencer blade while C is held; annotation while D is held | `hold_keys` on `click` and `mouse_drag` (`#withHeldKeys`, `input-handlers.ts:395`) |
| A key pressed mid-drag | Sequencer R/S/V while a strip is dragged | `mouse_drag {key_presses: [{at, key}]}` (`#dragKeyPresses` `:947`) |
| Pen pressure | Grease Pencil width, sculpt strength, the pressure curves in the video | macOS `mouse_drag {pressure}` (`mousePenEvent`, `native/src/mouse.rs:667`; `pressureAt`, `input-handlers.ts:50`) |
| The numeric keypad | Blender's views (1/3/7, 0 camera, decimal to frame) | `numpad0`…`numpad_equals` on all three platforms (`native/src/keyboard.rs:108`, `:509`, `:1159`; `src/session/keys.ts`) |
| Modifiers on the wheel | Ctrl+wheel and shift+wheel in Blender | `scroll {modifiers}`; macOS `mouseScrollModified` (`native/src/mouse.rs:736`) |

Pen pressure has one twist. Blender keeps the last tablet pressure until the pen leaves proximity, and no synthetic
proximity event reached it: a standalone `kCGEventTabletProximity` and a mouse event with the proximity subtype, each at
the HID and session taps, all left the state alone. Ending the stroke with a release at pressure 1.0 parks it at full
pressure, which is what a plain mouse gives. Measured: Grease Pencil radius 0.0029 → 0.03 → 0.0029 for `[0.1, 1, 0.1]`
and a constant 0.03 for the mouse stroke after it; a sculpt stroke moved the mesh 0.375 at pressure 0.15, 2.437 at 1.0,
and 2.437 again for a mouse stroke afterwards.

Not a gap: number-field drags work without motion deltas. A drag on Location X moved the cube 0.67 with and without
`kCGMouseEventDeltaX/Y` set, so the window server derives them.

## Live results

Each row was driven through the server only and read back from Blender.

| Area | What ran | Result |
|---|---|---|
| Modeling | Shift+A > Mesh > Quad Sphere by OCR; redo panel Method → Even Angle, Segments typed 6; outliner click + Delete; numpad1, numpad decimal, Tab; alt+click equator loop; F3 Relax Edge Loops; sidebar Dimensions X typed 3 m; snap popover → Origin | all pass (24 of 218 vertices, one z level; width 3.000; `snap_elements {'ORIGIN'}`) |
| Shading | New material; Shift+A "Light Info"; socket drag Color → Base Color; Transmission Dispersion Scale typed 1; Comment node, two lines of markdown; Ctrl+X cut; Cmd+Z | all pass |
| Properties | Tabs found by tooltip; Compositor & Effects > Add Scene Effect > "Bloom"; camera Type Panoramic, Panorama Type Mirror Ball (EEVEE) | all pass |
| Outliner and sidebars | Drag Light above Camera; Shift+H, Alt+H; Ctrl+F over the sidebar and a filter | all pass |
| Grease Pencil | Pen strokes with pressure; D-drag annotation | pass |
| Sequencer | Drag C1 onto C2 pressing V (overwrite: C2 gone, C1 61–91); Cmd+Z; pressing R (ripple: C2, C3 shifted 30); C-held click (C0 cut at frame 16) | all pass |
| Sculpt | Strokes at 0.15, 1.0 and mouse | pass |
| Pies | Ctrl+Tab → Object Mode; Z → Wireframe, Z → Solid | pass |
| Rendering | F12, `wait_for_window` "Render", `wait_for_stable`, OCR "Frame:1 \| Time:00:03.02", Escape | pass |
| File browser | File > Import > Stanford PLY; directory typed (128 characters, pasted); double-click the file | pass after defect 4 |

Not possible on this route: the DLSS viewport denoiser needs an NVIDIA RTX GPU, the DLSS Render add-on is a paid
third-party add-on, and Vulkan is the default only on Windows and Linux. The rest of the video reuses gestures in the
table above; `skills/blender-direct` maps every feature and marks which were run end to end.

## Open items

1. **Scroll direction.** `scroll {direction: "up"}` posts a negative wheel delta, which Blender reads as
   WHEELDOWNMOUSE (it zoomed out). It has been so since 7.1 and no test pins the direction. Check it against a browser
   before deciding whether "up" means what a person expects.
2. **`mouse_drag` is not in the default `desktop` profile.** Blender needs it for nearly everything; the skill says to
   use `full`. Moving it to `desktop` would take the list to about 47.4k of its 48,000-byte budget.
3. **Windows and Linux are untested here.** The keypad maps there are written from the VK and evdev tables; pen
   pressure is refused on both.
4. `hold_keys` with a modifier name on macOS presses the key but does not flag the pointer events. Blender is fine;
   Cocoa apps that read flags off the mouse event are not. `modifiers` is the parameter for modifiers.
5. A fresh server seeds its user-active clock from `HIDIdleTime`, which this server's own posted events reset, so a
   server started within 4 s of another server's input refuses with `user_active`. Seen in the test harness, which
   started a server per step.
6. A click and a press at the same spot within about 0.35 s is a double-click to Blender: a strip drag started right
   after a click on the strip did nothing. Documented in the skill; the server does not space them.
