---
name: analytics-agent
description: Work an organisation's real dashboards the way a person does — log in, filter, drill, zoom — while a BI MCP server supplies the authoritative numbers. For Apache Superset, Metabase, Power BI, Tableau, Looker, Qlik and QuickSight.
---

# Working a dashboard with a BI server and computer use

Two servers, and they do different jobs. The BI server answers *what is true*.
Computer use *operates the dashboard* — logs in, applies filters, drills into a
chart, zooms in to read a label. Use both. An agent that only calls the API has
nothing to show; one that only reads pixels cannot be trusted about a number.

## The one rule

**Numbers you state come from a query. Pixels are what you and the person see.**
Cite `bi_chart_data`, `bi_insights` or `bi_query` for every figure. Read the screen
to navigate, to check that what you are showing is what you think, and to notice
something the API did not tell you — then confirm it with a query before claiming it.

Where the screen and the query disagree, that is a finding worth reporting, not a
number to average. Say which one you trust and why.

## Two different logins, and this is the trap

**The BI server's API token and the browser's session are unrelated.** The server
authenticates over REST with its own bearer token. The browser you drive with
computer use has its own cookie session and knows nothing about that. So the API
can be answering perfectly while the browser sits on a **login page**.

This actually happened: the agent authenticated server-side, opened the dashboard
URL, captured the window, narrated "so you can see it while I measure it" — and the
frame was Superset's login form. The analysis was sound and the picture was useless.

So:

1. **Look at the frame you captured.** `run_progress` with `capture: true` returns
   the image *to you*. Inspect it. If it shows a login form, an error, a spinner or
   a blank panel, you have not shown the dashboard.
2. **Log in through the page with clicks, not accessibility** — see below.
3. **Then capture again and check again.** Only narrate "here is the dashboard" once
   you have seen that it is.

Never tell a person you are showing them something you have not confirmed is on
screen.

## A browser exposes its own controls, never the page

Measured on Chrome showing Superset: the window's accessibility tree has **37 nodes
and exactly one `AXTextField` — "Address and search bar"**. Superset's username and
password fields are not in it. Neither are its charts or filters.

What Chrome *does* expose is its own furniture:

```
Back | Forward | Reload | Bookmark this tab | New tab | Close | Never | No, thanks | Save
```

So the boundary is sharp, and worth committing to memory:

| Target | Approach |
|---|---|
| Browser furniture — toolbar, tabs, and its dialogs like "Save password?" | `find_element` + `click_element`, which work well |
| Anything inside the page — fields, filters, links | **`browser_find`**, which returns the element's screen coordinates ready to click |
| A chart drawn on a canvas, with no element behind it | pixels: `screenshot`, then `left_click` |

`find_element` for a page field returns `[]`, not an error, so an agent can loop
looking for a field that will never appear. If two label searches inside a page come
back empty, stop searching and read the screen instead. And `find_element` needs at
least one of `role`, `label` or `value` — calling it with only a `window_id` is an
error, not a way to dump the tree; use `get_ui_tree` for that.

### Filling any form in a page

Use the loop in the `computer-use-forms` skill: **look, map through the window's
edges, settle, click each field, verify the text landed, submit, verify by something
outside the form.** It is the same for a login, a filter panel or a search box, on any
platform, which is why it is worth having as a habit rather than as one app's layout.

Two BI-specific notes. A dashboard's filter controls are page content, so they are
pixels too — the accessible path will not find them. And after a sign-in the browser
offers to save the password directly over the dashboard you just opened; that dialog
*is* browser furniture, so `click_element(role: "AXButton", label: "Never")` clears it
before the person sees it in every frame.

## Opening it — first, not last

Put the dashboard on screen early, before the measuring. The person should see what
you are discussing from the start, not two minutes in after a wall of narration.

**Open a new window, or you will navigate away from the console.** The console you
report into is itself a page in that browser. `command+l` focuses the frontmost
window's address bar, which is very often the console, so typing a URL there
replaces the person's view of your run. An agent did this too. Press `command+n`
first.

```
bi_list_dashboards      → find the one being asked about
bi_dashboard_url        → the link, with any filters already in it
open_application        → com.google.Chrome
key command+n           → a NEW window, so the console's window survives
key command+l           → address bar of that new window
type <url> press_enter  → a URL is text, so type; key is only for combinations
wait 3                  → let it render
list_windows            → the dashboard's window, never the console's
run_progress capture:true window_id:<id>   → then LOOK at what came back
```

Capture the **window**, not the desktop — without a `window_id` you get the whole
screen including your own terminal. And never capture the console's own window:
`list_windows` returns it too, and capturing it puts the console inside the console.

## Operate it like a person

This is the part worth doing. A dashboard is interactive; use it.

| To do this | Use |
|---|---|
| Read a value or label too small to see | `zoom` on that region — full resolution, no downscaling |
| Reach a chart below the fold | `scroll` on the dashboard window |
| Apply a dashboard filter | `screenshot`, then `left_click` the control and `type` |
| Drill into a chart in the UI | `left_click` the chart, follow its own drill menu |
| Re-open with filters already applied | `bi_dashboard_url` with filters, then navigate |
| Confirm what you just read | `bi_chart_data` or `bi_insights` on that chart |

A good rhythm: **zoom in to read it, query to confirm it, drill to explain it,
capture so they see it.** Each step gives the person something and gives you a
number you can stand behind.

`bi_drill_down` reports rows before and after. If they are equal your filter
matched everything, so say the step found nothing rather than presenting it as a
result. The same scepticism applies to a UI drill: if the chart looks identical
after you filtered it, the filter did not take.

## Routing

| Need | Use |
|---|---|
| What this platform can and cannot do | `bi_backend_info` — call it first |
| What dashboards exist, what is on them | `bi_list_dashboards`, `bi_get_dashboard` |
| The numbers behind a visual | `bi_chart_data` |
| Direction, change, extremes, outliers | `bi_insights` |
| Narrow by filter, break down by dimension | `bi_drill_down` |
| Something no saved chart answers | `bi_query` (SQL, DAX or explore) |
| A picture of the numbers, no browser | `bi_render_chart` |
| A link with filters applied | `bi_dashboard_url` |
| Logging in, filtering, drilling, zooming, showing | computer use, by coordinates |
| A browser dialog in the way | `find_element` + `click_element` |
| Where a control is, inside the page | `browser_find` — exact coordinates, no estimation |

`bi_get_dashboard` lists each chart's drillable dimensions. Those names are the
drill paths — use them instead of guessing column names.

## Talking to the person watching

`run_plan` first, 3 to 7 steps in plain language, with showing the dashboard among
the first. Before each step `run_progress` with `status: "active"` and a narration
written for a person — no tool names, no ids. When a step finishes,
`status: "done"` with a `note` holding the actual finding: a figure, a name, a
measurement. Never the word "done".

`Classic Cars 33,992, Trains 2,712, mean 14,152.4` tells them something.
`Analysed the chart` does not.

## Failure modes

**A failed BI call means stop, not improvise.** If the BI server errors you have no
data, so you have nothing to analyse. `run_progress` with `state: "failed"` and the
error verbatim enough for an operator to act on. Do not go spelunking through the
desktop, the terminal or the filesystem to reverse-engineer how the environment is
wired — that is not analysis, and it costs a call to learn nothing.

**A Superset access token is valid for 15 minutes.** Shorter than a real session. If
you see `Token has expired`, the server needs `SUPERSET_USERNAME` and
`SUPERSET_PASSWORD` so it can refresh its own. Say that and stop.

**"Not supported" beats an empty result.** These servers report a missing capability
as an error naming the platform and the workaround. Pass it along. "No rows" is a
claim about the business; "this platform has no data API" is a claim about the tool,
and only one of them is true.

**Nothing here writes.** You are reading a business's real reporting and cannot
change it. Clicking a filter changes your view, not their data. Be careful what you
claim it means.

## Order of work

1. `bi_backend_info` — learn the platform's limits
2. `run_plan` — 3 to 7 steps, showing the dashboard among the first
3. `bi_list_dashboards`, then `bi_get_dashboard` on the one being asked about
4. **Open it in a new window, capture, look at the frame, log in if needed,
   capture again.** The person can now see what you are discussing.
5. `bi_insights` on the charts worth understanding; cite its numbers
6. Work the UI where it earns something: `zoom` to read a label, `scroll` to reach a
   chart, click a filter — capturing as the screen changes
7. `bi_drill_down` where a statistic points somewhere: an outlier, a large change, a
   flat line you expected to move
8. `run_progress` with `state: "done"` and what you found, with the figures
