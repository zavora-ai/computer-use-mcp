---
name: blender-agent
description: Drive Blender with the official Blender MCP for everything inside the app, and computer-use only for what has no API. Never read Blender through the accessibility tree.
---

# Driving Blender with two MCP servers

Blender needs both servers, but they are not interchangeable. Route by capability,
not by habit.

## Setup gotchas that cost the most time

These were all found by running it, and each produces a misleading error.

**Blender's "Allow Online Access" must be on.** The addon's `register()` silently
refuses to start its server when `bpy.app.online_access` is false, and every
Blender tool then fails with `Cannot connect to Blender at localhost:9876`, which
reads like the addon is missing. It is not. Enable it once:

```python
bpy.context.preferences.system.use_online_access = True
bpy.context.preferences.addons['bl_ext.user_default.mcp'].preferences.use_autostart = True
bpy.ops.wm.save_userpref()
```

With both set, a GUI launch has the socket listening in about two seconds — no
clicking through Preferences, and no sidebar panel.

**The official and community servers share the name `blender-mcp`.** `uvx
blender-mcp` installs the *community* package from PyPI. The official Blender Lab
server has to come from `projects.blender.org/lab/blender_mcp` and be invoked by
path. They also default to the same port, 9876, so run only one.

**`get_screenshot_of_window_as_image` needs a small `size_limit_in_bytes`.** At
v1.0.2 it returns an image at 20 KB and 100 KB, and fails above that with
`Invalid response from Blender … Unterminated string`, which is a framing bug, not
a permissions problem. `get_screenshot_of_area_as_image` works fine — prefer it,
since one area is what you usually want anyway.

**Render paths are sandboxed to a basename.** `render_thumbnail_to_path` and
`render_viewport_to_path` discard the directory you pass and write into Blender's
per-session temp directory. Read the `filepath` out of the result rather than
assuming your own path was used.

**Never start a heavy render inside `execute_blender_code`.** A Cycles GPU render
launched through the addon's socket starved it and took the whole Blender process
down — the tool returned `Empty response from Blender`, then `Cannot connect`, and
the process was gone with the unsaved scene. Blender's addon server answers
synchronously on the main thread, so anything that blocks for tens of seconds is a
hazard.

Do this instead: keep the interactive session on EEVEE, which is fast enough to
answer immediately, and save the file. Then render the saved `.blend` outside the
session, either with `execute_blender_code_for_cli` or `blender -b file.blend`.
Measured on an M4: headless Cycles at 1280x720 and 128 samples takes about 68
seconds, which is fine out of process and fatal inside it.

## The routing detail worth knowing

`get_screenshot_of_window_as_json` returns each area's `type`, `x`, `y`, `width`,
`height` and space context. Those are Blender-window coordinates, so combined with
`desktop__get_window` bounds they tell you exactly where to click for something the
Python API cannot reach. That is the bridge between the two servers: Blender says
where its panels are, computer-use acts on them.

## The one rule that saves the most time

**Never call `get_ui_tree`, `find_element` or `list_menu_bar` on Blender.** Measured
on Blender 5.2.1: the accessibility tree contains six nodes — the window, three
title-bar buttons, a group and the title text. `find_element` for `File`, `Add` or
`Render` returns zero matches, because those menus are painted in OpenGL. The native
macOS menu bar carries only Apple, Blender and Window. `discover_applications`
reports `scriptable: false, accessible: false`.

Blender's structure comes from **Blender**, not from the operating system:
`get_screenshot_of_window_as_json` returns the window layout, areas, active object
and selection. Use that where you would normally use an accessibility tree.

## Routing

| Need | Tool | Server |
|---|---|---|
| Create, modify, transform, material, light | `execute_blender_code` | blender |
| What is in the scene? | `get_objects_summary`, `get_object_detail_summary` | blender |
| Which panel/area/mode am I in? What is selected? | `get_screenshot_of_window_as_json` | blender |
| Correct `bpy` API before writing it | `search_api_docs`, `get_python_api_docs` | blender |
| How does a Blender feature work? | `search_manual_docs` | blender |
| Did it look right? | `render_thumbnail_to_path`, then read the returned `filepath` | blender |
| See one panel | `get_screenshot_of_area_as_image` | blender |
| See the whole app window | `desktop__screenshot` — the blender window tool fails above ~100 KB | computer-use |
| Frame an object, switch workspace | `jump_to_view3d_object_by_name`, `jump_to_tab_by_name` | blender |
| Audit a file: missing textures, links, polycount | `get_blendfile_summary_*` | blender |
| Batch work on a `.blend` without touching the session | `*_for_cli` variants | blender |
| Launch Blender, confirm it is up and past the splash | `open_application`, `list_windows`, `screenshot` | computer-use |
| Blender is hung, or a modal dialog is blocking the socket | `screenshot`, `left_click`, `key` | computer-use |
| Sculpt or paint strokes | `mouse_drag` | computer-use |
| Prove to a human what the screen showed | `screenshot` | computer-use |

## Write Python, don't click

`execute_blender_code` is the actuator. Setting a scale by dragging a slider is
strictly worse than assigning the value: it is slower, imprecise, and unverifiable.
Reserve pointer input for gestures that have no API — sculpting, painting.

Before writing an unfamiliar call, run `search_api_docs`. The docs are bundled, so
one search costs far less than a failed script plus a retry.

## Verify with a render, not a screenshot

`render_thumbnail_to_path` gives you the camera's view with no window chrome, no
scaling to undo, and no coordinate mapping. A desktop screenshot of Blender is a
picture of a user interface; a thumbnail is a picture of the scene.

Both screenshot tools accept `size_limit_in_bytes`. Use it — and for the whole
window prefer computer-use's `screenshot`, which has no size ceiling.

Reach for `computer-use`'s `screenshot` when the question is *about the application*
rather than the scene — is it responding, is a dialog up, did the render finish.

## Cost

Vision is the expensive resource. One full Blender window screenshot cost
`deepseek-flash` 6,959 reasoning tokens before its first word of output. A published
account of an agent modelling a donut through a Blender MCP reports two hours and
60% of a $200 monthly plan.

So:

1. Ask a question before taking a picture. `get_objects_summary` answers "is the
   chair there" for a fraction of a screenshot.
2. Verify in batches. Build three objects, then look once.
3. Never re-send an image to ask a question that text can answer.
4. Keep the conversation append-only. Prefix caching only hits on a full prefix
   match, so editing earlier turns to save tokens throws away a much larger saving.

## Order of work

1. Launch Blender and confirm the window exists (computer-use).
2. `get_blendfile_summary_path_info` — confirm the blender server is connected.
3. `get_objects_summary` — know the starting state before changing it.
4. Build in small steps with `execute_blender_code`, checking the returned error
   text after each. A traceback is cheaper to read than a screenshot.
5. `render_thumbnail_to_path`, look once, correct.
6. Save deliberately. Nothing else saves for you.

## Failure modes

| Symptom | Cause | Action |
|---|---|---|
| Every blender tool errors on connection | Addon not enabled, or its server not started | Enable `use_autostart` in addon preferences, or start it from the sidebar; verify with computer-use `screenshot` |
| A tool hangs | Modal dialog or file browser has the UI | `screenshot` to see it, dismiss with `key` `escape` |
| `execute_blender_code` reports an unknown attribute | API guessed, not looked up | `search_api_docs` for the real name, then retry |
| Objects intersect or float | No verification between steps | Query positions with `get_object_detail_summary` rather than eyeballing a render |

Blender's own warning applies: the MCP server executes generated Python with no
guards. Treat a Blender session driven this way as untrusted execution, and keep
`COMPUTER_USE_FS_ROOTS` scoped to a project directory.
