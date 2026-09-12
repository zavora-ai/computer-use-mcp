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

## Work from what is on screen, not from a remembered recipe

This is the part that decides whether you are quick or slow. There is no fixed
sequence that fits every UI, so do not carry one. Each cycle:

1. **Capture.** `screenshot` the window.
2. **Say what you actually see**, concretely, before deciding anything: what page is
   this, which fields and buttons exist, where are they, what is focused, is anything
   already filled, is there a dialog in the way, is it still loading. Naming it is
   what stops you acting on what you assumed rather than what is there.
3. **Choose one action from that description** — the smallest one that makes progress.
4. **Act, capture again, and compare.** Did the screen change the way your action
   predicted? If nothing changed, your click missed or the element is not interactive;
   do not repeat it unchanged. If something unexpected changed, describe that first.

An agent that skipped step 2 clicked the same wrong place three times, submitted a
form with an empty field, and reported success over a login page. All three were
visible in a capture it already had.

**Never chain more than one blind action.** Two clicks in a row without a capture
between them means you cannot tell which one failed.

## Use the keyboard. It is exact; coordinates are estimates

This is the difference between six actions and thirty.

A click coordinate is a guess derived from a downscaled image: the screen is 2560 px
wide and the capture is 1024, so every image pixel is 2.5 real ones and a small
misreading becomes a miss on a field only ~35 px tall. Tab, Shift+Tab, Enter and
Space carry no such error. **Reach for the keyboard first and the mouse only when
there is no keyboard path.**

The one thing you do not know is **where focus starts**. Do not guess it — measure it
once:

1. **Settle.** Wait for the page after load. A single-page app rebuilds its form on
   hydration and silently discards anything typed before that.
2. **Probe.** Press `tab`, type the value you want in the *first* field anyway, and
   `screenshot` once. Now look: whichever field holds your text tells you exactly
   where you are in the tab order.
3. **Navigate relatively from there.** `shift+tab` to step back, `tab` to step
   forward. This is deterministic — no arithmetic, no scale, no offset.
4. **Verify each value, then submit** with `return`.

Measured on Metabase's sign-in: one `tab` from a settled page lands on the
**password** field, not the email field. So the sequence is `tab`, `shift+tab`, type
the email, `tab`, type the password, `return`. Six keystrokes, zero coordinates. An
agent that instead hunted for the two fields by pixel made four clicks that all
missed — 15, 50 and 77 px out, the error growing with distance because its scale was
wrong — and never signed in.

The probe costs one capture. Deriving every field's coordinates costs a capture each
*and* can still be wrong.

**Do not assume the tab order on a different page.** It is worth exactly one probe to
find out, every time.

## When you do need the mouse

Some things have no keyboard path: a chart you must click to drill, a canvas, a
control the page never focuses. Then:

**Read the mapping out of the capture; never infer it.** Every `screenshot` reply
states, in its text, how to turn a point in the image into a point you can click:

```
1024x432 | screen 2560x1080
screen_x = image_x * 2.5000
screen_y = image_y * 2.5000
a screen capture scales uniformly with no offset, so this mapping is exact.
```

**Take a screen capture for clicking** — omit `target_window_id`. It scales uniformly
with no offset, so the arithmetic is exact. A window capture is for *showing* a person
one application: it includes the window's shadow, so its scale is approximate and the
reply says so.

**`zoom` is the precision tool.** It crops from a full-resolution capture, so a region
880 px wide comes back 880 px wide — 1:1, nothing to scale. Its mapping is just
`screen_x = region_x1 + image_x`. When a target is small, zoom into it rather than
squinting at a downscaled screenshot.

Two failures came from inferring instead of reading. One agent guessed a vertical
scale and missed by 30, 57 and 87 px — an error growing with distance is the signature
of a wrong scale, not a wrong offset. Another asked for a window, silently got the
whole screen because the window was not raised, and mapped every coordinate in the
wrong frame. The reply now names both cases; read it.

## Details that have each cost real time

**`zoom` takes desktop coordinates, not window ones.** Raise the window first, or you
capture whatever else is sitting at those coordinates — a zoom aimed at a form once
returned a terminal.

**A single-page app discards input typed before it hydrates.** Measured: `tab`
correctly focused a field, then two typed strings both vanished. If a capture shows
the field still empty after you typed, that is what happened — wait, then type again.

**Verify text landed before you submit.** Capture and look: the field should show your
text, or dots for a password. This single check catches nearly every failure in this
loop, and skipping it is what makes the work slow, because the mistake surfaces
several calls later as a confusing error instead of immediately.

**Verify the outcome by something outside the form** — a window title, a URL, content
you expect to appear. Never conclude from the click that it worked.

If two capture-and-act cycles have not moved you forward, stop and report what the
screen shows. A person can often fix it in seconds; a third guess is worse than asking.
