# v8 roadmap

Status: **proposed 2026-10-25.** James picked these nine features from the review
[`docs/reviews/2026-10-25-computer-use-gaps.md`](../../reviews/2026-10-25-computer-use-gaps.md). Nothing is built yet.
The tasks are in [`tasks.md`](tasks.md). This roadmap replaces the 2026-10-09 app-bridges draft (Unreal and Blender
bridges, dialogs, a supervision panel), which was approved in principle but never started. It was removed on
2026-10-25 and is in git history at `2b3a7ce` (`docs/specs/v8-app-bridges/`). The section
[Ideas after 8.2](#ideas-after-82-watching-listening-and-working-beside-the-person) was added on 2026-11-22; it is
not scheduled.

## Why these nine

In 2026 the hosted computer-use products moved onto the person's own machine. Claude's computer use reached macOS and
Windows. ChatGPT Work replaced the cloud-VM agent. Operator, ChatGPT agent, Atlas and Mariner were retired. The
complaints that remain belong to the layer a local server owns:

- permissions that break after updates
- fights over the cursor
- a person who must step in at a login and hand back
- irreversible actions taken without a check
- token cost
- long workflows that fail halfway

Users praise control and continuity more than autonomy. In the gaps review's matrix, computer-use-mcp is ahead on 7 of
42 features and partial on 22. Its partial ratings fall on the features users love most. The nine below close those
rows and add two the review found no one doing well: prompted recordings and verified task trees.

| # | Feature | Letter | The user evidence (from the gaps review) |
|---|---|---|---|
| 1 | Drag and drop | D | Failure analyses list drag among the actions agents still fail at. cua-driver shipped background drag and an honest `drag_and_drop_session` refusal (0.36.0). The competitor study deferred pid drag. |
| 2 | Multi-touch | T | Thin evidence, and no desktop agent was found injecting touch. The case is coverage: touch-first and kiosk apps, maps, drawing apps, and testing touch UIs. |
| 3 | Hand-off to a person or an agent | H | The second most-loved feature, and complaint rank 5. Gemini's agent resumed after the person cleared 2FA. Requests for human-in-the-loop (browser-use #221, 18 reactions), several agents on one desktop (Chrome DevTools MCP #926, 24) and a remote agent with local tools (Hermes #18715, 44). |
| 4 | A full doctor on every OS | X | Permission grants that go stale after macOS updates are 9.7% of Claude Code's computer-use issues, and Codex #18896 stayed open six months. Windows is in 48% of Codex's computer-use titles. Wayland is 20% of the newest Linux project's. |
| 5 | Background mode | B | Background operation without taking the cursor became the headline feature in April 2026 (Codex's virtual cursors, cua-driver). "Fights over the screen" recurs in hosted-agent complaints. |
| 6 | Prompted screen recording | R | Buyers want replayable evidence: 47% of CISOs can identify their agents (Okta), EU AI Act Art. 12 requires logging, and ProofShot drew attention on HN. People want to record a bug once. |
| 7 | Confirm before acting | C | Stopping at the irreversible step is the third most-loved feature. Harm reports: 1,000 emails deleted, the wrong subscription tier cancelled, a purchase on a fake store. Over-confirmation is also a complaint (Codex #7740), so confirmations must be targeted and rememberable. |
| 8 | Accessibility before screenshots | A | "Computer Use is 45x more expensive than structured APIs" (495 points on HN). Developers switch tools on context cost. MacStories credits the accessibility tree for Codex's precision. |
| 9 | Verified task trees for long runs | P | "Explore once, then script it" (the Gemini Computer Use HN thread), Understudy (120 points), Muscle-Mem (226), Libretto (134). Long workflows complete 44-49% of the time at best (OSWorld 2.0). |

## Rules every feature keeps

- **The person stays in charge.** Every new state shows on the status card: recording, waiting for you, handed to an
  agent, confirm, step 14 of 52. Pause and Stop reach every new action: touch contacts and drags are released, a
  recording pauses or ends, a task tree stops at its node, and a hand-off ends. No new surface can be clicked by the
  agent: the card stays out of captures, and input inside it is refused.
- **Honest results.** Each new tool reports through the 7.7 contract (`effect`, `route`, `delivery`, `hint`,
  `next_call`; `src/session/contract.ts`). New refusals go into the one table there: `drag_and_drop_session`,
  `touch_unsupported`, `waiting_for_person`, `desktop_handed_off`, `would_take_over`, `stale_ref`,
  `confirmation_declined`, `confirmation_timeout`, `tree_mismatch`.
- **Cheapest route first.** Use the app's own API, then scripting, the accessibility tree, OCR, and pixels last (as
  `src/instructions.ts` already says). v8 makes that the default observation instead of advice.
- **Local only.** Recordings, task trees, hand-off records and evidence frames stay on the machine, under owner-only
  permissions, with a retention setting. Nothing is uploaded.
- **Additive.** A setting that changes behaviour is opt-in: background mode, label confirmations, recording. The
  `desktop` profile stays under its 48,000-byte budget, which is under test.
- **Three OSes, stated per OS.** Every feature says what each OS gets. Where an OS gets less, the tool says so with a
  refusal; it is not just listed.

## 1. Drag and drop (D)

**Today.**
- `mouse_drag` and `left_click_drag` work on macOS, Windows and Linux. The native path is a press, interpolated
  `mouse_drag_to` moves and a release (`native/src/mouse.rs`), with modifiers held throughout.
- **No DnD session model.** The OS drag-and-drop session is not modelled: there is no hold before moving, no
  deliberate pass over the drag threshold, and no hover over the target.
- **No background drag.** Drags cannot go through `delivery: "pid"` (`PID_DELIVERY_TOOLS`,
  `src/session/input-handlers.ts`).
- **No file drops.** A file that is not on screen cannot be dropped into an app.

**v8.**
- **D1 `drag_and_drop {from, to, hold_ms?, hover_ms?}`.** `from` and `to` each take a point, an element `ref` (A2),
  OCR text or a window. The gesture follows a real drag session:
  1. Press.
  2. Hold (default 150 ms).
  3. Step past the platform's drag threshold.
  4. Move in steps.
  5. Hover over the target (default 300 ms, for spring-loaded folders and tab strips).
  6. Release.

  `effect` is read back from the drop target: an accessibility value or child count changed, a window appeared or
  changed title, or a file appeared in a target folder. When nothing can confirm the drop, the result is `unverified`
  with a `next_call` to observe the target.
- **D2 `drop_files {paths, to}`.** This drags files that are not on screen. A small helper window under the pointer
  becomes the drag source, and the OS pointer carries the drag to `to`. `paths` must exist and must pass `filesystem`
  roots (`COMPUTER_USE_FS_ROOTS`) and the sensitive-app gate.
- **D3 Background drag on macOS.** The press, the moves and the release are posted to the window's process. AppKit
  drag-and-drop follows the hardware pointer, so a background drag that starts a DnD session is refused with
  `drag_and_drop_session`; it does not report false success.

| OS | D1 | D2 drag source | D3 |
|---|---|---|---|
| macOS | HID events (existing path) with session timing | Swift helper: `NSDraggingSession` with file URLs | pid-posted drag; refuse DnD sessions |
| Windows | `SendInput` with session timing; UIPI refusals stay `input_blocked` | Helper: `DoDragDrop` with a `CF_HDROP` data object | Not planned (posted mouse messages don't start OLE drags) |
| Linux | libei, XTest or ydotool with session timing | GTK drag source (XDND on X11, wl_data_device on Wayland) | Not planned |

**Spikes first.** D-S1 compares timing variants on each OS: Finder to Mail, Explorer to Outlook, Nautilus to a GTK
app, browser tab tear-off, a list reorder and a Content Browser tile to a viewport. It records which hold, step count
and hover each one needs. D-S2 tests the helper drag source on each OS.

**Accepted when** each D-S1 case passes from a single `drag_and_drop` call with `effect: verified` or `changed`.
`drop_files` puts a PDF into a Mail compose window and a Slack message box on macOS and Windows. A background drag into
a canvas succeeds, and one into a Finder window is refused by name.

## 2. Multi-touch (T)

**Today.** There is no touch input. The Linux portal session asks for keyboard and pointer devices only (`types` 3 in
`native/src/linux_ei.rs`), and the libei seat binds no touch capability.

**v8.**
- **T1 `touch {contacts: [{path: [[x, y], …], pressure?}], duration_ms}`** takes up to 10 contacts, each moving
  along its own path. It also takes named gestures: `pinch {center, from_distance, to_distance}`,
  `rotate {center, degrees}`, `swipe {fingers, direction, distance}` and `long_press {point, ms}`. Contacts are tracked
  like held buttons, so Stop, Pause and cancel lift every finger (the 7.7 release guarantee).
- **T2 per-app support.** `get_app_capabilities` reports whether an app took touch, recorded like pid delivery
  (`src/session/pid-delivery.ts`).

| OS | Route | Notes |
|---|---|---|
| Windows | `InjectSyntheticPointerInput` with `PT_TOUCH` (10 contacts); `PT_PEN` with pressure and tilt for drawing apps | Windows 10 1809+. Works for touch-aware apps; precision-touchpad gestures cannot be injected |
| Linux | Portal `types` 7 (adds touchscreen) and libei touch down, motion and up on GNOME 46+ and KDE 6.1+; `uinput` multitouch where the person has allowed `/dev/uinput` | The portal asks for consent once, as today |
| macOS | No public touch injection. Trackpad gestures (magnify, rotate, swipe, smart zoom) by synthesized gesture events, a private event type, only if the spike passes; otherwise the app's equivalent (pinch to ⌘-scroll or ⌘+/−) with `route: "equivalent"` | Each gesture reports which route it took; `touch_unsupported` when neither exists |

**Spikes first.** T-S1: a two-contact pinch and a rotate in Photos, Maps and Edge on Windows (the UTM VM in
`docs/TESTING-IN-UTM.md`, plus a real touch laptop if one is available). T-S2: libei touch on GNOME 46 and KDE 6.
T-S3: macOS gesture events in Preview, Maps and Safari; decide from the result whether a private event type is
acceptable.

**Accepted when** a pinch zooms a map and a two-finger rotate turns an image on Windows and on GNOME. A pen stroke with
varying pressure draws a tapered line in a Windows drawing app. On macOS a pinch zooms Preview by one of the routes
above, and the result names that route.

## 3. Hand-off to a person or an agent (H)

**Today.**
- Take-over pauses the agent when the person moves the mouse or types, and resumes 5 s after they stop
  (`src/session/operator-control.ts`).
- The control state is `running`, `paused` or `stopped`, plus `watching` on the live-share branch.
- A cross-process lease decides which server instance may act (`src/session/lock.ts`).
- The agent has no way to ask anyone to step in.

**v8.**
- **H1 hand-off to a person: `hand_off {to: "person", reason, done_when?, timeout_ms?}`.**
  - The card shows "Your turn: {reason}" with a Done button. `agent_pointer` can mark the field (`native/src/overlay.rs`).
  - `done_when` is `person` (Done pressed), `window_gone` or `text_gone`. The last two reuse the `wait_for_window` and
    `wait_for_text` machinery, so the hand-off ends by itself when the login window closes.
  - While it lasts, mutating calls return `waiting_for_person`. The person's input is expected, so it neither trips
    take-over nor the user-active guard.
  - Nothing is captured while a secure field or a credential manager is frontmost.
  - Hosts without the card get an MRTR elicitation instead.
- **H2 hand-off to an agent: `hand_off {to: "agent", agent?, reason, context?}`.**
  - It writes a hand-off record: the session target, the task-tree node (P), notes and a reference to the last frame.
  - It then releases the desktop lease to the named agent, or to the first one that claims it.
  - The receiver is another MCP client of a server on this machine, or the console's live driver. It calls
    `hand_off {action: "claim"}` and receives the context.
  - The card shows who holds the desktop; 2026-07-28 clients are told through `subscriptions/listen`.
  - A server that loses the lease answers mutating calls with `desktop_handed_off`.
  - Every hand-off and claim goes in the audit log.
- **H3 `control_status`** reports an open hand-off, who it waits for, and the current lease holder.

| OS | H1 | H2 |
|---|---|---|
| macOS | Card button (Swift panel) | Lease in `~/Library/Caches/computer-use-mcp/` |
| Windows | Card button (WPF) when the card is on; elicitation otherwise | Lease in the existing Windows lock path |
| Linux | Card button (GTK) when the card is on; elicitation otherwise | Same |

**Accepted when** an agent calls `hand_off` at a fake login window, the person signs in, the window closes, and the
agent's next call succeeds with no Done press. A second MCP client claims a hand-off, receives the session target and
notes, and acts, while the first gets `desktop_handed_off`.

## 4. A full doctor on every OS (X)

**Today.** `doctor` (`src/session/doctor.ts`) runs 15 checks, each `pass`, `warn`, `fail` or `skip` with remediation
text. Accessibility and Screen Recording are read from TCC on macOS.

**v8.**
- **X1 one check model.** Each check keeps its status and adds:
  - `evidence`: what was measured.
  - `fix`: exact steps, plus a settings deep link (`x-apple.systempreferences:` on macOS, `ms-settings:` on Windows).
  - `auto_fix`: whether `doctor {fix: true}` may apply the fix itself. Only safe fixes qualify: open the right pane,
    trigger the permission prompt, compile the helper, renew the portal token, start the AT-SPI bus.

  Checks are grouped: install, permissions, capture, input, accessibility, person control, policy and host.
- **X2 platform checks.**
  - macOS:
    - TCC for each permission, including **stale grants** (TCC says granted but the behaviour fails: remove and re-add
      the host)
    - which host process holds the grant
    - Secure Input on, and the pid holding it (it silently blocks typing)
    - Command Line Tools present
    - the helper's signature and per-instance identity
    - ScreenCaptureKit
    - macOS 27 pane names
    - displays and scaling
    - Stage Manager and Spaces
  - Windows:
    - the integrity levels of the host and of the target apps (UIPI)
    - UAC and the secure desktop
    - console or RDP session
    - DPI awareness and the scale of each monitor
    - Windows.Graphics.Capture and `WDA_EXCLUDEFROMCAPTURE` support
    - UI Automation
    - PowerShell version and execution policy
    - Smart App Control or Defender blocking the addon
    - keyboard layout
    - touch injection (T)
  - Linux:
    - X11 or Wayland, the compositor and its version
    - RemoteDesktop and ScreenCast portal versions, and whether the restore token is still valid
    - libei, ydotool and `/dev/uinput`
    - XTest
    - the AT-SPI bus and toolkit accessibility
    - python3-gi and GTK for the card
    - each utility the session would use
    - logind
    - a keep-awake inhibitor
    - keyboard layout (libei typing is US-only today)
    - whether the host runs inside Flatpak or Snap
  - Everywhere:
    - Node, and the addon's ABI and version
    - the profile, with tool counts
    - the policy posture
    - whether the audit log is writable
    - lock and lease holders
    - the MCP client name
    - whether live share is configured (the API key is never shown)
- **X3 `doctor {live: true}`.** It opens a scratch window it owns and runs, then reports: capture, OCR, an
  accessibility read, an input round trip, the card appearing and staying out of a capture, pid delivery, a touch tap
  (T) and a drag (D). It closes the window, and it needs the person's hands off for about ten seconds.
- **X4 a support bundle and a CLI.** `doctor {bundle: true}` writes a redacted JSON report for bug reports, with no
  window titles, values or paths outside the package. `computer-use-mcp doctor` runs it from a terminal and warns that
  a terminal's grants are not the host app's.

**Accepted when** each of these produces a named failure with a working fix in the CI desktops or the UTM VMs:
- a revoked Screen Recording grant
- a stale grant (the app re-signed)
- Secure Input held by a password field
- an elevated target on Windows
- a missing portal on Linux
- a stopped AT-SPI bus

`doctor {live: true}` passes on macOS 26, Windows 11 and GNOME 46.

## 5. Background mode (B)

**Today.**
- On macOS `delivery: "pid"` covers `click`, `scroll`, `type`, `key` and `click_text`, but not drags or menus.
  `auto` uses it only for apps recorded as working (`src/session/pid-delivery.ts`).
- Accessibility actions don't take focus.
- OCR reads covered windows.
- The user-active guard refuses to take focus while the person works.
- A Docker Linux desktop worker exists for embedding hosts (`src/isolated-worker.ts`).

**v8.**
- **B1 background mode: `COMPUTER_USE_MODE=background`, or `set_mode {mode: "background"}`.** This is a guarantee:
  the server never activates an app, never moves the cursor and never posts HID input. Each tool takes a
  non-intrusive route. If none exists, it refuses with `would_take_over`, a hint and `next_call` (a `hand_off` or the
  semantic tool that would work). The card says "Working in the background".
- **B2 routes for each OS**, each verified on first use per app and recorded, like pid delivery today:
  - macOS: pid delivery extended to drags (D3) and to menus (accessibility press on menu items, no activation).
  - Windows: UI Automation patterns (Invoke, Value, Toggle, Selection, ExpandCollapse, Scroll), and posted window
    messages for classic Win32 controls.
  - Linux: AT-SPI actions and editable-text.
- **B3 an agent display.** Apps the agent launches run where the person's screens are not, captured and driven there:
  - Linux: a private Xvfb or headless Wayland display, using the isolated worker's setup without Docker.
  - Windows: a separate desktop (`CreateDesktop`) or the Windows agent workspace where available.
  - macOS: a virtual display. This is private API, behind a spike.

**Spikes first.**
- B-S1: a coverage matrix of UIA patterns and posted messages across Notepad, Explorer, Office, an Electron app and a
  WinUI app.
- B-S2: macOS menu presses through accessibility with the app in the background.
- B-S3: capture and input on a separate Windows desktop, and on a macOS virtual display.

**Accepted when**, with background mode on, a 20-step form fill in TextEdit or Notepad, a menu command and a drag
complete while the person types in another app: the cursor never moves and the person's app keeps focus. A tool with
no background route refuses by name and suggests the route that would work.

## 6. Prompted screen recording (R)

**Today.**
- There is no video.
- The live-share watcher samples a window or the screen and turns changes into events (`src/session/live-watcher.ts`,
  `src/session/change-gate.ts`, on the live-share branch).
- A persistent ScreenCaptureKit stream failed in the 7.8 spike S1 because every helper shared one code identity. The
  per-instance identity (#54) removes that cause, and v7.8 L1 re-runs the spike.

**v8.**
- **R1 `record_screen {prompt, target?, max_duration_s, until?}`** returns an MP4 path and a sidecar JSON with
  chapters and events. The prompt decides when to start, when to stop and what to keep:
  - "Record the next build failure in Terminal": starts on a matching event, keeps 10 s before it.
  - "Record me reproducing the bug": starts now, stops when the person presses Stop recording on the card.
  - "Record the agent filling the form, 30 s at most".

  Watcher events, OCR text and window changes start and stop recordings by local rules. Open-ended prompts use the
  live driver's Haiku triage (`src/live-driver.ts`) when an API key is configured. Long idle stretches are cut, and
  chapters come from the agent's actions and the watcher's events. Click highlights and captions are drawn into the
  frames, never on the screen.
- **R2 capture and encoding for each OS:**
  - macOS: `SCStream` with `SCRecordingOutput` (macOS 15+) or `AVAssetWriter` (macOS 14), in the Swift helper
    (`libexec/macos-agent-helper.swift`).
  - Windows: Windows.Graphics.Capture with a Media Foundation H.264 sink writer.
  - Linux: the ScreenCast portal with PipeWire and GStreamer; `ffmpeg` with `x11grab` on X11 where present.
- **R3 privacy:**
  - The card shows a red Recording state. Pause pauses the recording; Stop ends it.
  - Credential-manager windows are blanked, and secure fields are blurred using their accessibility bounds.
  - The card and the pointer overlay are never in the video.
  - Files are local, owner-only, with `COMPUTER_USE_RECORDING_RETENTION_DAYS`.
  - Recording is opt-in (`COMPUTER_USE_RECORDING=true`, or `recording: true` for an embedding host).

**Accepted when** each of the three example prompts produces a playable MP4 of the right span on macOS. A recording
that crosses a 1Password window shows it blank. Pause leaves a gap, not frames. Windows and Linux produce the same
from the same prompts.

## 7. Confirm before acting (C)

**Today.** Approvals are policy gates per tool (`COMPUTER_USE_REQUIRE_APPROVAL_FOR` and the rest), answered by host
elicitation or the shared token, and one-shot (`src/approval-ledger.ts`). The competitor study deferred remembered
scopes.

**v8.**
- **C1 `confirm_action {summary, preview?: "window" | "region" | "none", timeout_ms?}`.** The agent calls it before a
  submit, a send or a purchase. It returns `confirmed`, or refuses with `confirmation_declined` or
  `confirmation_timeout`.
- **C2 confirmations triggered by labels.** `COMPUTER_USE_CONFIRM_LABELS` lists labels such as Send, Submit, Buy,
  Pay, Delete and Place order (the list is configurable, and off by default). A confirmation is required when one of
  them matches the element that `click_element`, `press_button` or `click_text` would hit. It also applies to the
  accessibility element under a coordinate click, found by hit test, so a raw click on Submit is caught too.
- **C3 the dialog.** A card panel (excluded from capture, like the card) shows:
  - the action;
  - the app and window;
  - a crop with the target highlighted;
  - the values the form is about to send, read from accessibility with sensitive fields redacted.

  Its buttons are Confirm, Cancel and "Always for this app this session". The last is the remembered approval scope
  the competitor study deferred, kept in `src/approval-ledger.ts`. Remote hosts get an MRTR elicitation with the same
  summary and crop; headless runs use the approval token. The outcome and a hash of the shown frame go in the audit log.

**Accepted when** an agent filling a web form in the person's browser stops at Submit and shows the values it entered.
Cancel leaves the page unsubmitted, and Confirm submits it. "Always for this app" lets the next Send through without a
dialog until the session ends. A coordinate click on a Delete button is caught by the hit test.

## 8. Accessibility before screenshots (A)

**Today.**
- Accessibility trees work on all three OSes: AX on macOS, UI Automation on Windows, AT-SPI on Linux.
- The default `desktop` profile lists neither `find_element`, `click_element` nor `set_value` (`src/tool-catalog.ts`).
- There are no element refs.
- The default observation is a screenshot.
- Unchanged captures already return text instead of an image (`src/session/screenshot-handlers.ts`).

**v8.**
- **A1 `observe {target?, prefer?: "auto" | "tree" | "text" | "image", since?}`** returns the cheapest view that
  answers:
  1. A compact outline of interactive elements (role, label, value, bounds, `ref`) when the tree has controls.
  2. OCR lines with boxes when it does not.
  3. An image only when asked for, or when neither of the first two has content (a canvas).

  Each result carries an estimate of its token cost. With `since`, it returns only what changed since that
  observation.
- **A2 element refs.** `click`, `type`, `set_value`, `drag_and_drop` and `run_steps` steps accept `ref`, which acts
  semantically and falls back to the element's centre. A ref is valid until its element leaves the tree; a stale one is
  refused with `stale_ref` and a `next_call` to observe again.
- **A3 semantic tools in `desktop`.** `observe`, `find_element`, `click_element` and `set_value` join the default
  profile, paid for by trimming the largest schemas to stay under 48,000 bytes. The generated instructions say
  "observe first, screenshot when you need to see".
- **A4 Windows OCR** (`Windows.Media.Ocr`), so self-drawn apps on Windows also get text instead of images. This
  brings `read_window_text`, `click_text` and `wait_for_text` to Windows.
- **A5 untrusted labels.** Every screen-derived text (outlines, OCR, `read_window_text`, `wait_for_text` matches, tree
  names and values) carries the untrusted-data label `browser_page_text` already uses. Image results carry a one-line
  note.
- **A6 a published benchmark.** Ten tasks per OS, each run image-first and tree-first, recording model turns, input
  tokens, wall time and success, with the table in the README (extending `docs/EFFICIENCY.md`).

**Accepted when**, on the A6 tasks, tree-first uses at least 50% fewer input tokens than image-first at equal success,
with the number published. A ref survives an unrelated UI change and is refused after its element closes. The desktop
profile stays under budget.

## 9. Verified task trees for long runs (P)

**Today.**
- `run_steps` runs up to 30 validated steps and stops at the first failure.
- The run console declares a plan and reports progress (`run_plan`, `run_progress`; `src/run-console.ts`).
- The tasks extension serves long calls (`src/mcp-tasks.ts`).
- The audit log records every call.
- Nothing is replayed.

**v8.**
- **P1 a task tree document.** It is reviewable JSON under `~/.computer-use-mcp/trees/`, or at a path given. Each node
  has:
  - an id and a title;
  - its steps: `run_steps` actions whose targets are semantic (refs resolved to role and label, OCR text, window kind);
  - `expect` checks: a window appears, text is present, an accessibility value equals something, a file exists;
  - variables;
  - its children.
- **P2 the first run verifies.** The agent writes a tree, or exports one from a run that worked
  (`export_steps {since}`), then runs it with every `expect` checked. A node that passes is marked `verified`, and its
  resolved targets are frozen and hashed.
- **P3 later runs replay.** Verified nodes run with no model turns. At the first mismatch the run stops on that node
  with `tree_mismatch`, a `hint` and what was expected against what was seen, and the model repairs only that node.
  Editing a node clears its verified mark.
- **P4 long runs:**
  - Checkpoints survive a restart, kept with the run store (`COMPUTER_USE_RUN_STORE`, `src/agent-run.ts`).
  - Progress goes out as MCP progress and through the tasks extension.
  - A checklist shows in the console and on the card ("14 of 52 · Export invoices").
  - The person can pause, skip or approve a node.
  - A node can call `hand_off` (H) or `confirm_action` (C).
  - `for_each` runs a subtree over the rows of a CSV.

**Accepted when** a 40-step tree (export ten invoices from a demo app into a folder) passes its first run with every
node verified. The second run finishes with no model calls in a fraction of the time. Moving a button between runs
stops the tree at the right node with a useful `hint`. A restart mid-run resumes from the checkpoint.

## New tools and where they go

| Tool | Profile | Note |
|---|---|---|
| `observe` | core | Replaces screenshot-first observation |
| `hand_off` | core | Person control, beside `control_status` |
| `confirm_action` | core | |
| `drag_and_drop` | desktop | `mouse_drag` stays for raw gestures |
| `drop_files` | desktop | Paths checked against `filesystem` roots |
| `touch` | desktop on Windows and Linux; full on macOS until T-S3 decides | Listed only where a route exists |
| `set_mode` | core | Only with background mode allowed |
| `record_screen` | opt-in (`COMPUTER_USE_RECORDING`) | Like live share, outside the profile budgets |
| `tree_run`, `tree_status`, `export_steps` | desktop | |

The tool-count test in `test/` derives counts from the catalog. AGENTS.md, the README and the computer-use skill are
updated with each release.

## Release order

| Release | Contents | Depends on | Why this order |
|---|---|---|---|
| **8.0** | X (doctor), A (observe, refs, untrusted labels; A4 Windows OCR may slip to 8.1), C (confirm), H1 (hand-off to a person) | 7.7.0 tagged, live share merged | Mostly TypeScript and the card. The strongest user evidence. The doctor diagnoses everything that follows. Refs are what D, B and P target. |
| **8.1** | D (drag and drop), T (multi-touch), B (background mode), H2 (hand-off to an agent) | The D, T and B spikes; A2 refs | Native work per OS, behind spikes; needs the Windows VM and a touch device. |
| **8.2** | P (task trees), R (recording) | A2, C, H; v7.8 L1 (the stream re-run) for R | P builds on refs, confirmations and hand-off. R needs a persistent stream. |

The 7.8 follow-ups (L1 the stream, L2 voice, L3 host reach, L4 Windows change regions) stay in
[`../v7.8/tasks.md`](../v7.8/tasks.md); R depends on L1.

## Ideas after 8.2: watching, listening and working beside the person

Status: **ideas, not scheduled (written up 2026-11-22).** They come from a design discussion with James after 7.8.0
shipped. It started with whether live share could watch and hear a YouTube or Vimeo stream, and went on to what a
desktop agent could do that none does yet. Nothing here is built or has a release. Each idea says what exists today,
what it needs, the first test that would show whether it works, and when it counts as done. The rules above apply to
every one, and so does the out-of-scope list below: nothing remembers the screen unless the person started a watch.

There are two groups:

- **W, watching and listening (W0 to W7).** Live share grows from sampled frames into a stream it can see and hear,
  and local detectors do most of the watching.
- **M, two at one desk (M1 to M8).** The agent works beside the person on the same machine instead of taking it over.

### Write a watcher, then wake the model only when it fires

Live share today samples a target every 500 ms at 640 px wide, gates the changes, and lets Haiku triage each event
(`src/session/live-watcher.ts`, `src/session/change-gate.ts`, `src/live-driver.ts`). That suits a screen that changes
now and then. In a video almost every frame changes, so the gate fires at its 3 s ceiling (`GATE_MAX_DELAY_MS`) and
every event is a triage call; there is no sound at all. The W ideas turn this around. When the person asks "tell me
when they announce the pricing", the model writes a small watch program once:

```
watch: window "Keynote - YouTube"
when:  transcript contains "pricing" or screen text matches /\$\d+/
also:  sound "applause", scene cut
then:  wake triage with the last 20 s
```

The program runs locally on every frame and on the sound, and the model sees only the moments that match. Watching
then costs per event, not per second.

### W0. The base: see and hear one app, with a short memory

**Today.**
- The watcher samples a window, an app or a display, with no sound. The capture helper has no audio code
  (`libexec/macos-agent-helper.swift`).
- A kept-open ScreenCaptureKit stream is v7.8 L1, not run yet.
- Live share holds frames in memory only.

**Needs.**
- A kept-open stream (v7.8 L1) that also carries the target app's own sound, and never the microphone:

  | OS | Picture | Sound of one app |
  |---|---|---|
  | macOS | `SCStream` (L1) | ScreenCaptureKit audio for the filtered app (macOS 13+), excluding the server's own process |
  | Windows | Windows.Graphics.Capture kept open (v7.8 L4) | Process loopback capture (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, Windows 11) |
  | Linux | ScreenCast portal and PipeWire | The app's PipeWire output node |

- Local senses, each optional:
  - speech to text on the device: Apple's SpeechAnalyzer on macOS 26, `SFSpeechRecognizer` with on-device recognition
    before it; on Windows and Linux a local Whisper model the person installs;
  - sound events from Apple's SoundAnalysis built-in classifier (applause, laughter, music, speech, sirens);
  - scene cuts from the frame difference the helper already computes;
  - screen text by OCR on changed regions only.
- A short memory: the last 10 minutes (configurable) of keyframes at scene cuts, the transcript, sound events and
  screen text, with timestamps. It is kept in memory only and dropped when the watch stops.
- New event kinds in `live_events`: `speech`, `sound`, `scene`, `text` and `trigger`.
- Storyboards: up to nine keyframes tiled 3×3 with their timestamps into one image the size of a single frame. One
  triage call then sees a sequence for the price of one frame (about $0.0002 on Haiku 5.5, measured for 7.8).

**Privacy.** Sound is off until the person turns it on for that watch, and the card shows "Listening" apart from
"Watching". Transcripts stay on the machine. Nothing is sampled while a credential manager is frontmost, as today.

**First test (W-S1).** On macOS 26, one helper keeps a stream with sound open on a YouTube window in Safari for 30
minutes while a second server takes screenshots. Measure the transcription's delay and its word accuracy against the
video's own captions. Note which protected (DRM) videos capture as black.

**Accepted when** a 30-minute talk yields a timestamped transcript less than 2 s behind the speech, keyframes at scene
cuts and sound events; no frame or transcript is held after the watch stops; and the card shows Listening while sound
is captured.

### W1. The agent controls time in a recorded video

**The idea.** A recorded video does not have to be watched in real time, because the agent can drive the player. On
YouTube the keys 0 to 9 jump to 0-90% of the video, J and L skip 10 s back and forward, and comma and period step one
frame while paused. "Find where the talk gets to pricing" becomes a search: read the ten jump points, then keep halving
the gap where the topic changes. For a talk that follows its agenda, two hours narrow to five seconds in about 11
jumps. The agent can also pause to look closer, go back to check, or play at 2× while W0's detectors keep up.

**Today.** Everything it needs is in the default profile: `key`, `read_window_text` (macOS) and `wait_for_stable`.
`browser_page_text` (opt-in) reads captions shown on the page and the player's time display in the person's own
browser.

**Needs.** A skill with the search loop and the shortcuts of each player (YouTube, Vimeo, QuickTime, VLC). No server
change.

**First test.** Five recorded talks: find a named slide or topic by jumping, and compare with a person finding it by
hand. Count jumps, tool calls, input tokens and seconds. Confirm the shortcuts against YouTube's own list.

**Accepted when** the skill finds the moment to within 10 s in at least four of the five talks, with at most 20 tool
calls each.

### W2. Reflexes, triage, thought

**The idea.** Three speeds, like a body:
- **Reflexes** run locally on every frame and cost no tokens. The model looks at one frame once and writes small
  detectors: a region turns red, a word appears on screen or in the transcript, a sound, a scene cut. Each can trigger
  an action from a short allowed list: pause or play the video, mute, mark the moment, keep a clip from W0's memory,
  notify.
- **Triage** is Haiku, given a storyboard and the transcript when a reflex fires.
- **Thought** is Opus, which answers or acts.

**Today.** The gate and the live driver are the triage and thought tiers. Between frames nothing runs but the diff.

**Needs.**
- A watch program format (JSON: detectors and actions), validated before it runs and shown on the card in one line
  ("Pausing when 'pricing' is said").
- Detectors in the helper: a pixel probe on a region (a colour or hash change), OCR text in a region, transcript
  words, sound classes, scene cuts.
- The allowed actions. Pause and play are a key posted to the watched app, which goes through the same gates as any
  input (the user-active guard, Pause, Stop). Never a click, typing, send, submit or buy. Pause on the card stops
  reflexes too.

**First test (W-S2).** The model writes programs from five sentences ("pause when someone says my name", "mark each
goal", "tell me when the build log turns red"), and each runs against prepared clips with scripted moments.

**Accepted when** each program fires within 500 ms of its moment with no model call, does not fire in 10 minutes of
unrelated footage, and stops when the person presses Pause.

### W3. Watch together, like someone on the couch

**The idea.**
- **Talk instead of typing.** Push to talk on the card, with on-device speech (v7.8 L2).
- **It answers out loud.** It lowers the video's sound or pauses the video, explains, and resumes.
- **Point and ask.** The person circles something with the mouse and says "what's that?". The pointer's path says
  what "that" is.
- **It draws on the screen**, like a sports telestrator: circles, arrows and labels over the live video, in an overlay
  kept out of captures.
- **Subtitles for anything.** Speech in another language is transcribed and translated on the device (Apple's
  Translation framework, macOS 15+) and shown over the video.

**Today.** `agent_pointer` is one dot that never appears in a capture (`native/src/overlay.rs`: show, move, hide).
Guide mode's `label` puts text on the card. The take-over monitor already reads where the person's pointer is
(`native/src/activity.rs`).

**Needs.** W0's speech, v7.8 L2's voice, overlay shapes (circle, arrow, box, text) that follow a region, a pointer
trail of the last few seconds kept during a watch only, and a translation step.

**First test.** On a sports clip, the agent circles a named player and keeps the circle on them for 5 s of play. A
French talk gets English subtitles, with their delay measured.

**Accepted when** no drawing appears in a capture or a W0 keyframe, subtitles trail the speech by less than 3 s, and
"what's that?" over a circled region is answered about that region in at least eight of ten tries.

### W4. Share meaning, not pixels

**The idea.**
- A helper (a person or their agent) subscribes to a watch's events, redacted to the level the person sets. They see
  "Disk full dialog in Finder", not the inbox.
- An agent passes its watch to another agent with the memory so far (with H2).
- The reverse: when the agent works on its own display (B3), the person watches that display in the console like a
  stream, with chapters from the step journal, at 4×, and can go back.

**Today.** Live share events are already text (`live_events`). 2026-07-28 clients have `subscriptions/listen`. The
bundled HTTP runner is loopback only; a remote host embeds `createComputerUseHttpHandler` and checks OAuth itself.

**Needs.** A redaction level per subscriber (event kinds only; plus app names; plus titles and text), a list of
subscribers on the card, and the console view of B3's display.

**First test.** A second MCP client subscribes at "kinds and app names" for 30 minutes of ordinary work, and every
event it receives is checked for a title or text.

**Accepted when** no redacted field reaches the subscriber, the card lists who is subscribed, and Stop ends every
subscription.

### W5. Any camera is a screen

**The idea.** The watch does not care where frames come from:
- iPhone Mirroring (macOS 15) is a window, so the agent can watch the phone and, where input reaches it, drive it.
- Continuity Camera's Desk View shows paper notes or a whiteboard.
- A capture card turns a console or another computer into a window.
- A webcam can watch a 3D printer, a lab instrument or a door.

**Today.** Any window can be watched. A camera is not a source.

**Needs.** A camera source in the helper (AVFoundation on macOS, Media Foundation on Windows, V4L2 or PipeWire on
Linux), opt-in per watch, with the OS's camera indicator left as it is.

**First test (W-S3).** Whether the iPhone Mirroring and Desk View windows can be captured, and whether input reaches
the mirrored phone. Then a webcam watch with a W2 reflex on a 3D printer's progress.

**Accepted when** each source works with the same detectors and card states, or the first test records why it cannot.

### W6. Learn by watching the person

**The idea.** The person does a task once while the server records it. For each of their clicks the server asks the
accessibility tree, or OCR, what was under it, so the record says "the Export button in the Invoices window" rather
than a coordinate. The result is `run_steps` batches with an `expect` on each step, the same format `export_steps`
writes for the agent's own actions, and later a task tree (P).

**Today.** `export_steps` records the agent's actions, and with `{action: "start"}` it reads the text under each click
(`src/session/step-journal.ts`). The person's input is seen only as counts, timing and pointer movement, for take-over
(`native/src/activity.rs`). The code has deliberately never recorded what the person types.

**Needs.** An opt-in "learn from me" recording, started on the card and shown there for its whole length; the
person's clicks and keys from the event tap, during that recording only; an accessibility hit test (none exists in
`native/src` today, and C2 needs one too); typed text in sensitive fields replaced with the `export_steps`
placeholder.

**First test.** The person exports a report in a demo app; the exported batches replay it with every `expect` met.

**Accepted when** a 15-step demonstration replays with no model call in four of five runs, no typed secret appears in
the export, and nothing is recorded outside the recording.

### W7. Watch many things at once

**The idea.** Eight windows, eight sets of W2 detectors, and one model call when one of them fires. Cost grows with
events, not with the number of streams. It fits esports analysts, a trading desk, a newsroom covering eight press
conferences, or a team watching dashboards, logs and a deploy at once.

**Today.** A watch has one target (`live_watch {action: "start"}`).

**Needs.** Several targets per watch, a budget per target, and the card listing everything watched.

**First test.** Eight windows playing video for 30 minutes, one reflex each, on an Apple-silicon Mac: CPU, memory and
the time from a moment to its reflex.

**Accepted when** every reflex fires within 1 s and the eight watches stay inside a CPU budget set from the first
test.

### Two at one desk

Desktop agents take the machine over: one pointer, one focus, and the person waits. The M ideas let the person and the
agent work at the same time, see what the other is doing, and undo it. A few have a cousin elsewhere, such as gray
autocomplete text in code editors and Figma's multiplayer cursors; the new part is doing them in every app on the
machine. No search has yet ruled out that someone has built them.

### M1. Two cursors in one app

**The idea.** The person keeps working in a spreadsheet while the agent fills another column. The agent's cursor is
drawn on screen with its name, and the person's pointer never moves. When the person reaches toward where the agent is
working, it steps aside.

**Today.** `delivery: "pid"` posts clicks, keys and scrolls to a process without moving the pointer, for apps recorded
as accepting it (`src/session/pid-delivery.ts`). Accessibility actions don't take focus. The overlay draws one dot.

**Needs.** B2's background routes: an app has one keyboard focus, so the agent writes through accessibility values,
not by typing. A named cursor in the overlay that moves with the agent's actions. Stepping aside: when the person's
pointer comes near the agent's target, the agent waits (the take-over monitor already reads the pointer).

**First test.** In Numbers and Excel, the agent fills column C through accessibility while the person types in column
A. Does the person's caret or selection ever move?

**Accepted when** 50 agent edits complete while the person types, the person's caret never moves, and an app that
would take focus is refused by name (`would_take_over`).

### M2. Accept the next click with one key

**The idea.** While the person works, the agent predicts the next few steps and draws them faintly: an outline on the
button they are about to press, ghost text in the next field. One key accepts, Esc dismisses, and pressing the key
again runs the rest of a routine it has seen before.

**Today.** Nothing predicts. W6 would supply the person's past routines and P the replay.

**Needs.** W6's records of the person's routines. A local matcher (the current window and the last few steps) that
proposes only routines it has seen, never invented ones. The overlay drawing an outline and ghost text. An accept key
the event tap swallows only while a suggestion is shown: Tab is the natural key, but apps use it to move focus, so it
needs a reliable way to keep it from the app, or a chord the person picks.

**First test.** Replay a week of one person's recorded routines offline and count how often the top suggestion would
have been right.

**Accepted when** the suggestions shown are right at least 80% of the time (it stays quiet otherwise), an accepted one
runs with every `expect` checked, and nothing runs without the accept key.

### M3. See the result before it happens

**The idea.** Before a risky change, the agent does it on a copy, on its own display, and shows the result as a
see-through layer over the real window: "this is your deck after the reformat". If the person accepts, it does it for
real.

**Today.** Nothing rehearses. B3 (the agent display) is planned for 8.1. `run_steps` with `expect` can run the same
steps twice and check both.

**Needs.** B3; a copy of the document (an APFS clone on macOS, a plain copy elsewhere) opened on the agent display; the
overlay showing the captured result over the real window; and a refusal for what cannot be copied, such as a web form
that sends or an email.

**First test.** Reformat a Keynote or PowerPoint deck on a copy on the agent display, and show before and after.

**Accepted when** the real document is untouched until the person confirms, the real result matches the rehearsed one
afterwards (frame hashes within a tolerance), and an action that cannot be rehearsed says so.

### M4. Undo for the whole computer

**The idea.** Every action the agent takes is recorded with how to reverse it: the old value of a field, a copy of a
file before a move or delete, where a window was. "Undo the last 10 minutes" walks back across apps. Each action is
labelled before it runs, undoable or one-way, and one-way actions (send, pay, permanent delete) go through C.

**Today.** The audit log records each call and `set_value` reads its value back. Nothing keeps the state from before
an action.

**Needs.** An undo journal beside the step journal (`src/session/step-journal.ts`) holding each action's inverse or
"one-way"; `undo {last | since}`, which runs inverses newest first with an `expect` on each; file copies kept with
owner-only permissions and a retention; and the label on the card before a one-way action.

**First test.** A 20-action session across TextEdit, Finder and a form app, then undo all of it.

**Accepted when** every undoable action is reversed and checked, every one-way action is listed as not undone, and
nothing the agent did not do is touched.

### M5. A new face for any app

**The idea.** The agent builds a small panel over a complicated app. An old ERP's 40 fields become the 4 the person
uses, and filling them in drives the real app through accessibility. The same layer can:
- translate an app's interface where it sits;
- rewrite a form full of jargon in plain language;
- give large text and high contrast to an app without them;
- cover email addresses and account numbers while the screen is shared. Unlike the card, this overlay has to be
  included in captures.

**Today.** Accessibility trees on all three OSes, no element refs yet (A2), and overlays always excluded from capture.

**Needs.** A2 refs; a panel window (built with each OS's card toolkit) that maps each field to a ref; a per-overlay
choice to be excluded from or included in captures (`NSWindowSharingNone` on macOS, `WDA_EXCLUDEFROMCAPTURE` on
Windows); and redaction that follows the covered text when windows move.

**First test.** A 4-field panel over a demo app with 40 fields, and the redaction overlay during a Zoom or Meet share,
checked from the receiving side.

**Accepted when** the panel fills the real form with every value read back, and no covered value is visible to the
receiving side during a 10-minute share with windows moving.

### M6. Drop anything onto anything

**The idea.** Pick up someone's name from a video call and drop it on the CRM, and a contact appears with its fields
filled in. Pick up a table from a paused video and drop it into Excel, and it arrives as a table. It copies meaning and
pastes structure between apps that know nothing about each other. A video frame cannot start a real OS drag, so the
gesture is a pick-up chord over the source and a drop chord over the target, or a request to the agent.

**Today.** `mouse_drag` moves pixels and OCR reads text. Nothing maps one app's content to another app's fields.

**Needs.** OCR or accessibility to read the source; one model call to map the content to the target's fields (A2
refs); C's confirmation showing the mapping before anything is saved; and D1's drag session where the source can
really be dragged.

**First test.** Ten pick-up and drop pairs: a name tag into Contacts, a table in a paused video into Numbers, an
address in a PDF into a form. The mapping is shown each time.

**Accepted when** at least eight of ten land with the right fields after Confirm, and Cancel saves nothing.

### M7. See where the agent is looking

**The idea.** While the agent reads the screen, faint outlines show what it is reading at that moment: this line of
OCR text, that button, this region. The person can follow its attention, and notices when it reads something it
should not, such as a private message in a corner.

**Today.** The server knows every OCR region and accessibility element it reads, at the moment it reads it. The
overlay draws one dot.

**Needs.** Overlay outlines (a rectangle that fades within about a second) drawn for each read; a setting for when
(always, only for reads outside the target window, only while the person hovers over the card); outlines never in a
capture.

**First test.** A 10-minute run with outlines on; the person says whether it helped them follow and whether it
distracted them.

**Accepted when** each outline appears within 100 ms of its read, none appears in a capture, and in a scripted test
the "outside the target window" setting outlines every read of another app.

### M8. Apps become MCP servers by being watched

**The idea.** Once the agent has learned an app (W6 and P), it writes a small adapter with real tools, such as
`invoices.export(month)` or `crm.add_contact(...)`, each one a checked task tree underneath. Adapters go into the MCP
registry with an `mcp-server.toml` like any other server, signed and reviewed, so the next person's agent does not
have to learn the app.

**Today.** `export_steps` produces checked batches. The registry and its manifest format exist for this project's own
servers (`mcp-server.toml`).

**Needs.** P's stored trees with variables; a generator that turns a tree with variables into an MCP tool with a
schema; version checks against the app (its version and a layout hash); review and signing before anything is
published; and P3's repair when the app changes.

**First test.** Generate an adapter from three recorded exports in a demo app and call it from a second MCP client.

**Accepted when** the adapter's tools pass their `expect` checks on a fresh machine with the same app version, refuse
by name on another version, and hold no recorded secret.

### Where these could land

Sizes use the release plan's scale (XS under a day, S a few days, M one to two weeks, L longer or needs hardware the
project lacks) and are guesses until each first test has run.

| Idea | Builds on | Could start | Rough size |
|---|---|---|---|
| W1 jumping through video | Today's tools | Now, as a skill | XS |
| M7 where the agent looks | Overlay outlines | After 8.0 | S |
| M4 undo | C, the step journal | With C | M |
| W6 learn by watching the person | `export_steps`, an accessibility hit test (shared with C2) | After 8.0 | M |
| W0 see and hear one app | v7.8 L1 and L2 | With R (8.2) | L |
| W2 reflexes | W0 | After W0 | M |
| W3 watch together | W0, v7.8 L2, overlay shapes | After W0 | M |
| W5 any camera | W0 | After W0 | M |
| W7 many streams | W2 | After W2 | M |
| W4 share meaning | Live share, H2, B3 | After 8.1 | M |
| M6 drop anything onto anything | A2, C, D1 | After 8.1 | M |
| M1 two cursors | B2, A2 | After 8.1 | L |
| M3 result before it happens | B3 | After 8.1 | L |
| M5 a new face for any app | A2 | After A2 | L |
| M2 accept the next click | W6, P | After 8.2 | L |
| M8 apps as MCP servers | P, W6 | After 8.2 | L |

The two cheapest that show the most are W1, which is a skill with no server change, and M7, which needs only outlines
in the overlay. M4's undoable and one-way labels could ship with C.

## Out of scope

These are carried over from the gaps review:

- **Hosting a cloud browser or VM.** That is another product; B3's agent display is local.
- **Solving CAPTCHAs.** A CAPTCHA is a hand-off (H1).
- **Scheduling.** That is the host's job.
- **Always-on screen memory.** Its own users turn it off. W0's short memory lasts only as long as a watch the person
  started.
- **The Unreal and Blender bridges.** Removed with the old draft; recoverable from `2b3a7ce` if game-engine work
  returns.

## Open questions for James

1. **Private macOS APIs.** Synthesized gesture events (T) and a virtual display (B3) are private. Are they acceptable
   behind a spike and an off switch, or public APIs only?
2. **Who receives an agent hand-off (H2).** Only other MCP clients on this machine and the console's driver, or also a
   named remote agent through the HTTP runner?
3. **Recording retention.** What default retention for recordings (R3)? The proposal is 7 days.
4. **Label confirmations.** Should `COMPUTER_USE_CONFIRM_LABELS` (C2) ship with a default list switched on, or off
   until set?
5. **An app's sound (W0).** Should sound be captured only when the person turns it on for a watch (the proposal), or
   whenever a watch runs?
6. **The person's own input (W6, M2).** Learning from the person means recording their clicks and keys while a "learn
   from me" recording runs, with typed text in sensitive fields dropped. Is that acceptable, and opt-in per recording?
7. **Publishing adapters (M8).** May an adapter learned on one machine be published to the registry, and who reviews
   it before it is?
