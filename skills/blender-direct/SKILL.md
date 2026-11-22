---
name: blender-direct
description: Drive Blender 5.3 with this server's mouse, keyboard and screen tools alone, with no Blender MCP or Python. Use when the Blender addon is not installed, not allowed, or the task is about the interface itself. Covers finding things by OCR and tooltips, menus by search, the redo panel, nodes, the sequencer, sculpting and drawing with pen pressure, pies, the file browser and renders.
---

# Driving Blender by hand

Blender draws its own interface, so the accessibility tree is empty (six nodes on 5.3) and `find_element` finds
nothing. Everything here is pixels, OCR and keys. If the official Blender MCP is available and the task is about the
scene rather than the interface, `skills/blender-agent` is faster. This skill is the route when it is not.

Every gesture below was run against Blender 5.3.0 on macOS 26.2 through this server, and the result was read back from
Blender's data. The table at the end gives every feature of the 5.3 release shown in the video: run end to end, not
possible here, tried without success, or not tried and why.

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
- **Brush size: `key "f"`, `type "150"`, `key "return"`.** The radial control takes a number, so the size is exact
  without knowing the current one (dragging it needs the current size, because it centres so that size sits at the
  pointer). 5.3's Size is a diameter; Blender 4.x showed a radius, so a tutorial's "Radius 76 px" is Size 152.
- **Delete is `forwarddelete` on a Mac.** `key "delete"` is Backspace, which deletes nothing in the viewport.
- **A key held across calls:** `hold_key {action: "down", keys: ["shift"]}`, then the drags, then
  `hold_key {action: "up", keys: ["shift"]}`. Shift held this way smooths in Sculpt Mode; C held blades in the
  sequencer. Held keys come up by themselves after 60 s and on Pause or Stop.

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

✅ run end to end through this server (mouse, keyboard, OCR) in Blender 5.3.0 on macOS 26.2, with the result read back
from Blender's own data. ✕ not possible on this route or machine. **Not proven**: tried, did not work through this
route. **Not tried**: no run yet, with the reason.

| Feature | Route | |
|---|---|---|
| Gaussian splats: import PLY | File > Import > Stanford PLY, file browser steps above | ✅ (a POINTCLOUD object) |
| Gaussian splats: SPZ, USD and glTF splat files | Same menus | Not tried: no sample files |
| Splat object data Type (Points / 3D Gaussian Splat) | Object Data tab dropdown | ✅ both ways |
| Rotate a splat −90° on X | Sidebar Rotation X, double-click, type `-90`, return | ✅ |
| Splat lit by a Diffuse BSDF | Material tab: swap the Emission for a Diffuse BSDF | ✅ |
| EEVEE Light Accumulation, Light Info, Light Evaluation, Shadow Raycast | Shift+A, type the name, return, click to place; link by drag to the "Diffuse Light", "Glossy Light", "Transmission Light" inputs | ✅ all links valid |
| Principled BSDF dispersion | Expand Transmission, set Dispersion Scale and Abbe Number | ✅ |
| Glass BSDF anisotropic roughness | Anisotropy field on the Glass BSDF, typed | ✅ |
| Sky texture sun disk | World node tree, Sun Disk checkbox | ✅ |
| EEVEE panoramic camera (equirectangular, fisheye, mirror ball) | Camera data tab, Type → Panoramic, Panorama Type → Mirror Ball | ✅ |
| Compositor & Effects tab: Bloom, chromatic aberration, film grain, vignette | Tab found by tooltip; Add Scene Effect, type the name, return | ✅ all four |
| New compositor tree starts with Group Input and Output; Kuwahara | Compositing workspace, New; Shift+A search | ✅ |
| Compositor gains Integer Math, Boolean Math, Index Switch | Shift+A search in the compositor | ✅ |
| Grease Pencil: Stroke menu in Draw mode | OCR the header, click Stroke | ✅ |
| Grease Pencil: select and move strokes without leaving Draw mode | Lasso by `mouse_drag`, then `g x 1 return` | ✅ only the lassoed stroke moved |
| Grease Pencil fill across regions in one drag | Fill tool, `mouse_drag` across both regions | ✅ one fill spanning both |
| Grease Pencil gradient fill | Material Fill Style → Gradient (a ColorRamp) | ✅ |
| Grease Pencil Carver | Carver tool, `mouse_drag` a closed lasso across a stroke | ✅ stroke cut in two |
| Grease Pencil flip canvas, reset roll | F3 "Flip View" (camera view only), F3 "Reset Roll" | ✅ |
| Grease Pencil drawing with pressure | `mouse_drag {pressure}` in Draw mode | ✅ tapered width |
| Sequencer ripple / shuffle / overwrite while dragging | `mouse_drag` a strip with `key_presses` R, S or V | ✅ all three |
| Sequencer ripple delete | Select, key | ✅ gap closed |
| Sequencer blade preview and box blade | Blade tool from the toolbar; hover; `mouse_drag` a box | ✅ |
| Sequencer temporary blade (hold C) | `click {hold_keys: ["c"]}` on a strip | ✅ |
| Sequencer text strip thumbnail | Add > Text | ✅ |
| Drag a colour into the timeline | Drag a colour swatch onto the timeline | ✅ colour strip |
| Drag text from another app into the timeline | Drag selected text from TextEdit | Not proven: two synthetic drags started no drag session |
| Sequencer defaults: Shuffle overlap, handles not clamped | Read in a new file | ✅ |
| OpenTimelineIO export and import | File > Export / Import > Open TimelineIO | ✅ import makes a new scene |
| Search any sidebar | Hover the sidebar, `key "ctrl+f"`, type | ✅ |
| Outliner custom order | Drag a row above another | ✅ |
| Comment node with markdown | Shift+A "Comment", click the pencil, type; Shift+Return for a new line, Return to finish | ✅ |
| Quad Sphere, Even Area / Even Angle | Shift+A > Mesh > Quad Sphere; redo panel Method and Segments | ✅ |
| Relax / Curve Edge Loops, Fit Edge Loops to Annotation | Alt+click loops; F3 and the operator name; annotation by D-drag | ✅ all three |
| Edit-mode Dimensions in the sidebar | N, double-click the Dimensions field, type | ✅ |
| Snap to Origin | Header snap popover (the arrow beside the magnet), click Origin | ✅ |
| Undo order across object and mesh edits | Cmd+Z | ✅ |
| DLSS viewport denoiser | Render tab > Sampling > Viewport > Denoiser | ✕ needs an NVIDIA RTX GPU (not listed on this Mac) |
| DLSS Render add-on from the video | Third-party paid add-on | ✕ not part of Blender |
| F12 pauses a rendered viewport | Cycles rendered viewport, F12 | ✅ status bar "Rendering Paused" during F12 |
| Shader Switch, Index Switch, Boolean/Integer Math, string nodes | Shift+A search | ✅ |
| Node editor Ctrl+X cut, Shift+X dissolve | Select the node, key | ✅ both |
| Workbench hardware ray-traced shadows | Preferences, Hardware Raytracing | ✕ greyed out on macOS: needs Vulkan |
| Tooltips say why a control is greyed out | Hover, wait, OCR | ✅ |
| Sculpt pressure toggles and curves: hardness, auto-smooth, spacing | Brush Shape and Stroke panels; drag on the curve | ✅ all three, curve edited |
| Sculpt pressure strokes | `mouse_drag {pressure}` | ✅ |
| Sculpt Transform Only: Pivot | Sculpt header Options popover | ✅ gizmo moved, mesh did not |
| Hair Cut brush | Curves sculpt, Cut brush, `mouse_drag` across the hair | ✅ 92 curves → 80 |
| Multires textures and colours in Sculpt Mode | Viewport colour → Attribute | ✅ not black |
| Weight paint: Add brush default, Paint renamed Set Weight | Asset shelf, OCR | ✅ |
| Weight paint defaults: multipaint, auto-normalize, mirror vertex groups | Read in a new file | ✅ |
| Weight paint automasking on the Alt+A pie | Tap Alt+A, click the item (or its number key) | ✅ Topology toggled |
| Geometry Nodes: Rasterize Points, Grid Solve Poisson, Combine List, other 5.3 nodes | Shift+A search | ✅ |
| Curve to Mesh miter scale, Realize Instances preserve normals | Add the node, read its sockets | ✅ |
| World Space Animation copy and paste | Sidebar Animation tab, Copy / Paste | ✅ prop follows the bone exactly |
| Ctrl+R convert rotation mode in pose mode, with Bake | Ctrl+R, dialog | ✅ keys converted Euler → Quaternion |
| Paste Pose factor | Paste, then the redo panel Factor | ✅ factor 1, 0.5, 0.25 |
| Fix to Camera | One key on the object first (I), then Fix to Scene Camera | ✅ object fixed in frame |
| Wrap timeline navigation | Timeline Playback popover | ✅ end → start and back |
| Scrubbing during playback | Space, then `mouse_drag` in the timeline | ✅ behaviour; smoothness not measured |
| Faster cached compositor and sequencer playback | Performance claim | Not tried: no measure |
| Projects (File > Project > New), ACES 2.0 project colour | File menu, file browser, Project Settings | ✅ `.blender_project/project.toml` written |
| Asset libraries install like extensions: Poly Haven | Preferences > Get Extensions > Allow Online Access; search, Install (an Asset Library entry). Asset Browser (editor-type menu), library dropdown "Poly Haven Lite", Models; click a thumbnail's download button, then drag it into the viewport | ✅ 393-byte install; the Pocket Watch (11.2 MB) placed as a collection instance |
| Private asset libraries that unlock with a token | Repositories > + > Add Remote Repository, Authentication: Requires Access Token | Not tried: no private repository or token; the field is there |
| USD export; a collection that imports a USD file and refreshes it | File > Export; new empty collection, Collection properties > Add Importer (file browser), Import to Collection, press it again to refresh | ✅ |
| Alembic subdivision schema, export and import | File > Export > Alembic, Use Schema; import | ✅ Subdivision modifier restored |
| glTF export | File > Export > glTF 2.0 | ✅ |
| Stable saving (unchanged file saves byte for byte the same) | Cmd+S, reopen, save | Not proven: hashes differed in the GUI and in `blender -b`, so it is the file, not the route |
| New collections land in the Scene Collection | Outliner right-click > New Collection with another active | ✅ |
| Dragging a parent into a collection takes its children | Outliner drag | ✅ |
| Shift+H in the outliner, Users column fake user | Shift+H over the outliner; Blender File view, click the column | ✅ both |
| Chinese, Japanese and Korean text | `type` into a name field (one character per key event) | ✅ "猴子モデル원숭이"; an input-method composition was not tried |
| Grease Pencil frame durations from old files, scene and mask strip thumbnails | Need old files and media | Not tried |
| Vulkan default backend | Windows and Linux only | ✕ macOS uses Metal |

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
| A click lands about 30 points too high | `read_window_text` boxes and screenshot pixels are window coordinates | Add `screen_origin` to the box before clicking |
| The first click after another app was in front does nothing | It only brought Blender to the front | Click again, or `activate_app` first |
| A click after a pie menu does nothing | The pie was still open and took the click | `key "escape"` before the next click |
| An outliner row is half off screen and a click misses it | The row sits under the header | Hover the outliner and walk to it with `down` |
| A dialog runs before every field is set | Return in a field confirms the whole dialog | Set fields by clicking, press Return only to finish |
| OCR reads "88~" or "O Pan View" | Icons beside text are read as letters | Match with `contains` or a regex and check the result in Blender |
| Flip View does nothing | It works in camera view only | `key "numpad0"` first |
| Fix to Camera does nothing | The object has no keys | Insert one key (`i`) first |
| Paste Pose Factor seems ignored | The bone's own keys win on the next frame change | Paste onto a bone without keys, or key the result |
| A collection importer is set on the wrong collection | The importer fills the collection it belongs to | Make a new, empty collection for it first |
| Values change by themselves after opening the Compositing workspace | Playback is running | Stop it with Space over the timeline before reading anything |
| Where 5.3 options live | Wrap timeline navigation: timeline Playback popover. Transform Only: Pivot: sculpt header Options popover. Hardware ray-traced shadows: Preferences | Open the popover, OCR, click |
| Header buttons are missing (symmetry X Y Z, X-ray, shading) | The viewport is narrower than its header | Middle-drag the header (`mouse_drag {button: "middle"}`) to slide it; Alt+Z toggles X-ray |
| A value changed by itself | Ctrl+wheel over a header field changes the field, it does not scroll the header | Slide the header with a middle drag instead |
| A tutorial's navigation drags do nothing | The teacher uses a pen with Emulate 3 Button Mouse | Preferences > Input > Emulate 3 Button Mouse, then Alt+drag orbits, Ctrl+Alt zooms, Shift+Alt pans |
| Undo stops going back | Blender keeps 32 undo steps by default | Save a copy before a long run, or raise Preferences > System > Undo Steps |
| Where is the cursor in this capture? | Captures leave the pointer out | Every capture reports it; `screenshot {include_pointer: true}` draws Blender's real cursor |
| A stroke near the outline moves nothing | The press landed just off the mesh | Press a few pixels inside the outline; measure the view's scale from a known object (a UV sphere of radius r is 2r across) |
| A drag from another app into Blender does nothing | Synthetic drags between apps start no drag session | Not solved; add the strip from Blender's own Add menu |
| A remote asset will not drag | It is not downloaded yet (globe icon on the thumbnail) | Click the thumbnail's download button, wait for the globe to go, then drag |
| A test session changes the person's recent files and bookmarks | Blender saves them even with `--factory-startup` | Start the test Blender with `BLENDER_USER_RESOURCES` set to a scratch folder. Remote assets still cache in `~/Library/Caches/Blender/remote-assets` |
