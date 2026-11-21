---
name: blender-direct
description: Drive Blender 5.3 with this server's mouse, keyboard and screen tools alone, with no Blender MCP or Python. Use when the Blender addon is not installed, not allowed, or the task is about the interface itself. Covers finding things by OCR and tooltips, menus by search, the redo panel, nodes, the sequencer, sculpting and drawing with pen pressure, pies, the file browser and renders.
---

# Driving Blender by hand

Blender draws its own interface, so the accessibility tree is empty (six nodes on 5.3) and `find_element` finds
nothing. Everything here is pixels, OCR and keys. If the official Blender MCP is available and the task is about the
scene rather than the interface, `skills/blender-agent` is faster. This skill is the route when it is not.

Every gesture below was run against Blender 5.3.0 on macOS 26.2 through this server, and the result was read back from
Blender's data. The table at the end says which features of the 5.3 release were run end to end and which reuse a
gesture that was.

## Setup

- `COMPUTER_USE_PROFILE=full` (or `ax`). `mouse_drag` is not in the default `desktop` profile, and Blender needs it for
  orbiting, sculpting, drawing, dragging strips, linking node sockets and reordering the outliner.
- Find the window once: `list_windows {bundle_id: "org.blenderfoundation.blender"}`, then `set_target {window_id}`.
  Blender's file browser, render window and preferences are separate windows. Target them by their own `window_id`
  (`wait_for_window {title: "Render"}` or `{title: "File View"}`).
- Close the splash with `key escape`.

## Seeing

- `read_window_text` is the main way to look. Blender's UI font reads well (confidence 1 on nearly every label). Pass a
  `region` to keep replies short. A screen point is `screen_origin + box centre`.
- OCR merges neighbours: "File Edit" comes back as one line. Click near the start of the box for the first word.
- Icon-only controls (properties tabs, header popovers): hover with `mouse_move`, wait about a second, then OCR. **The
  tooltip draws above the pointer near the right edge of the window**, so read a region above it, not below.
- Blender reports what it just did in the status bar ("Deleted 1 object(s)"). OCR the bottom strip to confirm an
  operator ran.
- Sidebar search (Ctrl+F) dims what does not match rather than hiding it, so OCR still reads every row.

## Keys

- Modifiers work as on a keyboard: `key "shift+a"`, `"ctrl+tab"`, `"alt+h"`, `"cmd+z"`. On macOS Blender's undo is
  Cmd+Z.
- Blender sends a hotkey to the editor under the pointer. `mouse_move` over the right editor before `key`.
- The numeric keypad has names: `numpad1` front, `numpad3` right, `numpad7` top, `numpad0` camera, `numpad_decimal`
  to frame the selection, `numpad5` perspective/ortho. The main-row digits do something else (select mode in edit
  mode, collection visibility in object mode).
- Typing in a text field: `type` sends short text as key events to Blender automatically, because Blender keeps only
  the first character of a pasted chunk. Longer or multi-line text is pasted with Cmd+V, which Blender's fields
  accept. Never `type` with the pointer over the viewport: letters are hotkeys there (I inserts a keyframe, M moves to
  a collection, N toggles the sidebar).
- Number fields: `click {count: 2}` on the value, `key "cmd+a"`, `type "3"`, `key "return"`. A modal transform takes
  keys: `key "r"`, `key "x"`, `type "-90"`, `key "return"`.

## Menus and operators

- **F3 searches every operator.** Hover the editor, `key "f3"`, `type "Relax Edge Loops"`, `key "return"`. This finds
  menu items without reading menus at all.
- **Add menus search as you type.** `key "shift+a"` over the viewport or a node editor, `type "Quad Sphere"` or
  `"Light Info"`, `key "return"`, then `click` where the node should go (a new node follows the pointer until you
  click).
- Dropdowns and "Add …" buttons in panels open menus that also search as you type (`Add Scene Effect`, `type "Bloom"`,
  `key "return"`).
- **The redo panel** ("Adjust Last Operation", bottom left of the viewport) holds the options of the operator that just
  ran. Click its title to expand it, then change dropdowns and fields as usual. It disappears when another operator
  runs.
- Pies: tap the key (`key "z"`, `"ctrl+tab"`, `"alt+a"` in weight paint), then `click` the item by its OCR text. A
  tapped pie stays open until you click.

## Pointer

- Orbit: `mouse_drag {button: "middle"}`. Pan: add `modifiers: ["shift"]`. Zoom: `scroll`, or `modifiers: ["ctrl"]`
  on a middle drag.
- Select an edge loop: `click {modifiers: ["alt"]}` on an edge in edit mode. Extend a selection: `["shift"]`.
- Hold a key during a click or drag with `hold_keys`: `click {hold_keys: ["c"]}` is the sequencer's temporary blade,
  and `mouse_drag {hold_keys: ["d"]}` draws an annotation (which the "Fit Edge Loops to Annotation" tool follows).
- Press a key mid-drag with `key_presses`: `mouse_drag {path, key_presses: [{at: 2, key: "r"}]}` presses R once the
  drag reaches waypoint 2, with the button still down. The sequencer uses this: R ripple, S shuffle, V overwrite.
- **A click followed within about 0.35 s by a press at the same spot is a double-click to Blender.** A drag that starts
  right after a click on the same strip or node does nothing. Wait half a second, or skip the click (a drag selects
  what it grabs).
- Node links: drag from the output socket to the input socket. Sockets are small, so zoom the node editor first
  (`scroll` over it) or `zoom` the region to place the points.
- Reorder the outliner: drag a row onto the upper half of the row it should go above.

## Pen pressure (macOS)

`mouse_drag {pressure: …}` drags as a pen. A number is constant; a list is spread along the stroke, so `[0.1, 1, 0.1]`
tapers both ends. Grease Pencil stroke width and sculpt strength follow it: the same sculpt stroke moved the mesh 0.375
at 0.15 and 2.437 at 1.0. The stroke ends at full pressure on purpose, because Blender keeps the last pressure it saw
until a pen leaves the tablet, and a synthetic pen cannot leave. A plain mouse drag afterwards behaves as before.

## The file browser

Blender's file browser is its own window titled "Blender File View". Target it by `window_id`:
1. `read_window_text` on that window to find the directory field (the path near the top).
2. `click {count: 2}` on it, `key "cmd+a"`, `type "/path/to/folder/"`, `key "return"`.
3. `click {count: 2}` on the file's name in the list to open or import it, or type a name in the bottom field and
   press the confirm button (its label says what it does: "Import PLY", "Save As").

Do not guess positions in the file browser. Its toolbar has a new-folder button beside the directory field, and a
misplaced double-click makes folders in whatever directory is showing.

## Rendering

`key "f12"` over the viewport, then `wait_for_window {title: "Render"}`, then `wait_for_stable {target_window_id,
quiet_ms: 1500}` on that window. OCR its header for "Frame:1 | Time:00:03.02" to confirm it finished, then `key
"escape"` on the render window to close it. For long Cycles renders give `wait_for_stable` a larger `timeout_ms`, or
wait for the "Time:" text with `wait_for_text`.

## Blender 5.3 release features by route

✅ run end to end through this server in Blender 5.3.0 on macOS, with the result read back from Blender.
◐ the same gestures as a ✅ row, not run end to end. ✕ not possible on this route or machine.

| Feature | Route | |
|---|---|---|
| Gaussian splats: import PLY/SPZ/USD/glTF | File > Import > format, file browser steps above | ◐ (file browser ✅ with a PLY) |
| Splat object data Type (Points / 3D Gaussian Splat), rotate −90° X | Object Data tab dropdown; sidebar Rotation X typed, or `r x -90 return` | ◐ |
| Splat lit by a Diffuse BSDF | Shader editor: Shift+A search, link sockets by drag | ◐ (both ✅) |
| EEVEE Light Accumulation, Light Info, Light Evaluation, Shadow Raycast | Shift+A, type the name, return, click to place; link by drag. Light Info is only valid inside a Light Accumulation (the link turns red outside it) | ✅ Light Info, link |
| Principled BSDF dispersion | Expand Transmission, set Dispersion Scale and Abbe Number | ✅ |
| Glass BSDF anisotropic roughness | Same as dispersion, on the Glass BSDF | ◐ |
| EEVEE panoramic camera (equirectangular, fisheye, mirror ball) | Select camera, camera data tab (last tab), Type → Panoramic, Panorama Type → Mirror Ball | ✅ |
| Compositor & Effects tab: Bloom, chromatic aberration, film grain, vignette | Tab found by tooltip; Add Scene Effect, type the name, return | ✅ Bloom |
| Grease Pencil: select and move strokes in Draw mode, stroke menu | Click/drag in Draw mode; Stroke menu by OCR | ◐ |
| Grease Pencil Carver, fill across regions, gradient fill | Pick the tool, then `mouse_drag` a closed lasso / across regions | ◐ (drawing ✅) |
| Grease Pencil flip canvas, reset roll | View > Navigation > Flip View / Reset Roll | ◐ |
| Grease Pencil drawing with pressure | `mouse_drag {pressure}` in Draw mode | ✅ tapered width |
| Sequencer ripple / shuffle / overwrite while dragging | `mouse_drag` a strip with `key_presses` R, S or V | ✅ R and V |
| Sequencer ripple delete, blade preview and box mode | Select and key; blade tool from the toolbar | ◐ |
| Sequencer temporary blade (hold C) | `click {hold_keys: ["c"]}` on a strip | ✅ |
| Search any sidebar | Hover the sidebar, `key "ctrl+f"`, type | ✅ |
| Outliner custom order | Drag a row above another | ✅ |
| Comment node with markdown | Shift+A "Comment", click the pencil, type; Shift+Return for a new line, Return to finish | ✅ |
| Quad Sphere, Even Area / Even Angle | Shift+A > Mesh > Quad Sphere; redo panel Method and Segments | ✅ |
| Relax / Curve Edge Loops, Fit Edge Loops to Annotation | Alt+click a loop; F3 and the operator name; annotation by D-drag | ✅ Relax, annotation |
| Edit-mode Dimensions in the sidebar | N, double-click the Dimensions field, type | ✅ |
| Snap to Origin | Header snap popover (the arrow beside the magnet), click Origin | ✅ |
| Undo order across object and mesh edits | Cmd+Z | ✅ |
| DLSS viewport denoiser | Render tab > Sampling > Viewport > Denoiser | ✕ needs an NVIDIA RTX GPU |
| DLSS Render add-on from the video | Third-party paid add-on | ✕ not part of Blender |
| F12 pauses a rendered viewport | F12 and the render waits above | ✅ render |
| Shader Switch, Index Switch, Boolean/Integer Math, string nodes | Shift+A search | ◐ |
| Workbench hardware ray-traced shadows | Viewport shading popover > Shadow | ◐ (needs a GPU with ray tracing) |
| Sculpt pressure curves (hardness, auto-smooth, spacing), Shape panel | Brush settings; `mouse_drag {pressure}` strokes | ✅ pressure strokes, ◐ curves |
| Multires textures in sculpt, transform-only pivot, hair Cut brush | Toolbar and drags | ◐ |
| Vertex/weight paint automasking on the Alt+A pie | Tap Alt+A, click the item | ◐ (pies ✅) |
| Geometry Nodes grid nodes, Curve to Mesh miter scale, list nodes | Shift+A search, typed values | ◐ |
| World Space Animation panel, Ctrl+R convert rotation mode, paste pose factor, fix to camera | Sidebar Animation tab buttons; Ctrl+R in pose mode and its dialog | ◐ |
| Timeline scrubbing, wrap timeline navigation | Drag in the timeline; Playback popover | ◐ |
| Compositor group input/output, faster cached playback | Compositing workspace | ◐ |
| Sequencer thumbnails, drag text and colours into the timeline, OpenTimelineIO | Drag between editors; File > Import/Export | ◐ |
| Projects (File > Project), project settings, ACES 2.0 | File menu, file browser, project settings fields | ◐ |
| Asset libraries as extensions, Poly Haven | Preferences > Get Extensions (online access on) | ◐ |
| USD in a collection, Alembic, glTF export | File > Import/Export | ◐ |
| Shift+H in the outliner, Users column, greyed-out tooltips | Shift+H over the outliner; click the column; hover and OCR | ✅ Shift+H, tooltips |
| Chinese, Japanese and Korean input | `type` (one character per key event to Blender) | ◐ |
| Node editor Ctrl+X cut, Shift+X dissolve | Select the node, key | ✅ Ctrl+X |
| Vulkan default backend | Windows and Linux only | ✕ macOS uses Metal |
| Weight paint brush renames, sky texture sun disk | Brush asset shelf; World/shader properties checkbox | ◐ |

## Gotchas

| Symptom | Cause | Fix |
|---|---|---|
| A search field shows one letter | Text pasted as a chunk to Blender | Leave `type` without a mode; it sends key events to Blender |
| A shortcut acts as if no modifier was held | A server before 7.8.1 sent modifiers as flags only | Update; modifiers now go down as keys |
| A drag on a strip or node does nothing | It started within 0.35 s of a click on the same spot | Wait half a second between them |
| OCR finds the wrong things in a dialog | A server before 7.8.1 captured Blender's main window for its secondary windows | Update; the capture now checks it got the right window |
| Strokes draw at zero width after a pen stroke | A pen stroke that ended at zero pressure | `mouse_drag {pressure}` ends at 1.0 by itself |
| The sequencer shows no strips | In 5.x the sequencer shows the workspace's own sequencer scene | Pick the scene in the sequencer header, or use the Video Editing workspace |
| A popup closes before you can read it | The pointer left it | Read it with OCR while the pointer stays put |
