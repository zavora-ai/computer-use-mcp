---
name: computer-use-forms
description: Fill form fields using accessibility tools (fill_form, set_value) where the app exposes them, and a verified capture-click-type loop where it does not — web pages in a browser expose nothing.
---

# Form filling via accessibility

1. `list_windows` → pick `window_id`
2. `get_ui_tree(window_id)` or `find_element` for each field (role + label)
3. `fill_form` with `[{ role, label, value }, ...]` in one call
4. Prefer `set_value` for single fields; avoid coordinate `type` unless AX fails
5. Verify with another tree read or `zoom` on the field region

On label miss, use `similarLabels` from the error payload — do not retry the same wrong label.

`find_element` needs at least one of `role`, `label` or `value`; passing only a
`window_id` is an error. Use `get_ui_tree` to see everything.

# When accessibility returns nothing

Some apps expose no fields at all. **A web page in a browser is the common case**:
measured on Chrome showing a web app, the window's tree held 37 nodes and exactly one
`AXTextField` — the address bar. The page's own inputs were absent. Canvas-drawn apps
like Blender are the same.

A page field returns `[]` rather than an error, so an agent can loop forever looking
for it. **Two empty label searches means stop searching and read the screen.** Note
what *is* exposed: browser furniture — toolbar buttons, tabs, and dialogs such as
"Save password?" — so `find_element` and `click_element` still work for those.

Then use this loop. It is the same for any UI, which is why it is worth learning
rather than memorising one app's layout:

**Look → map → settle → type → verify it landed → submit → verify it worked.**

**Look.** `screenshot` the window; `zoom` a region whose text is too small. `zoom`
takes **desktop** coordinates, so raise the window first or you will capture whatever
else is there.

**Map through the window's edges as they appear in the image.** A window capture is
scaled *and* padded — the window sits inside the image with background around it:

```
scale     = window.bounds.width / (window_right_in_image - window_left_in_image)
logical_x = window.bounds.x + (image_x - window_left_in_image) * scale
logical_y = window.bounds.y + (image_y - window_top_in_image)  * scale
```

Treating the image's own size as the window's is the most common cause of clicks
landing near-but-wrong: one agent clicked 85 px high three times and never hit a field.

**Settle before typing.** A single-page app rebuilds its form on hydration and
discards anything typed before that. Measured: `tab` focused the right field, then two
typed strings both vanished. Wait after load, or capture twice and compare.

**Click each field, then type.** Do not Tab between fields you have not verified —
focus order in a web form is rarely what you assume, and a wrong assumption puts a
password into a username field. `command+a` first if the field may hold something.

**Verify the text landed.** Capture and look: the field should show your text, or dots
for a password. Empty means the keystrokes went nowhere. This one check catches almost
every failure in this loop, and skipping it is what makes the work slow — a mistake
surfaces several calls later as a confusing error instead of immediately.

**Submit, then verify by something outside the form** — a window title, a URL, content
you expect. Never conclude from the click that it worked.

If two capture-and-type cycles have not filled the form, stop and report what the
screen shows. A person can do it in seconds; a third guess is worse than asking.
