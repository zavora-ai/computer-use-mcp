---
name: computer-use-forms
description: Fill and operate form fields. Accessibility where the app exposes it, the page's own DOM in a browser, pixels only when neither is available.
---

# Operating controls

**Goal:** put a value in the right field, and know that it landed.

**Order of preference.** Each step down is slower and less certain, so only take it
when the one above cannot do the job:

1. **Accessibility** — `fill_form`, `set_value`, `click_element`. Native apps, and a
   browser's own chrome including its dialogs.
2. **The page** — a browser-automation server acting by selector, or `browser_find`
   for an element's exact screen coordinates. Anything inside a web page.
3. **Pixels** — `screenshot`, then `left_click` and `type`. A canvas, a custom-drawn
   control, an app that exposes nothing.

## Facts you cannot infer, each measured

**A browser exposes its own controls, never its pages.** Measured on Chrome showing a
web app: 37 accessible nodes, one text field — the address bar. A page input returns
`[]` rather than an error, so two empty searches means stop searching, not search
harder. Toolbar buttons and dialogs like "Save password?" *are* accessible.

**A capture is smaller than the screen.** 2560 wide arrives 1024 wide, so one image
pixel is 2.5 real ones, against a field about 35 pixels tall. Every `screenshot` reply
states its own mapping — read it rather than deriving one. A window capture includes
the window's shadow so its scale is approximate; a screen capture is exact; a window
that could not be captured silently becomes a screen capture, and the reply says so.

**`zoom` takes desktop coordinates**, not window ones, and returns 1:1. Raise the
window first or you will capture whatever else is at those coordinates.

**A single-page app discards input typed before it hydrates.** A field still empty
after you typed is usually this, not a missed click.

**Focus order is not what you assume.** Do not Tab between fields you have not
verified; a wrong assumption puts a password in a username field. If you must use the
keyboard, establish where focus is by typing and looking, then move relatively.

## Invariants

- **Verify the value landed before you submit.** One capture. This catches nearly
  every failure in this loop, and skipping it is what makes the work slow, because the
  mistake then surfaces several calls later as something confusing.
- **Verify the outcome by something outside the form** — a window title, a URL,
  content you expect. Never conclude from the click that it worked.
- **Never chain two blind actions.** With no capture between them you cannot tell
  which one failed.
- **Say what you see before you decide.** Naming what is actually on screen is what
  stops you acting on what you assumed was there.

## When it is not working

Two cycles without progress means stop and report what the screen shows. A person can
often fix it in seconds, and a third guess is worse than asking.
