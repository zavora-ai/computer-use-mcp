# v8 roadmap

Status: **proposed 2026-10-25.** James picked these nine features from the review
[`docs/reviews/2026-10-25-computer-use-gaps.md`](../../reviews/2026-10-25-computer-use-gaps.md). Nothing is built yet.
The tasks are in [`tasks.md`](tasks.md). This roadmap replaces the 2026-10-09 app-bridges draft (Unreal and Blender
bridges, dialogs, a supervision panel), which was approved in principle but never started. It was removed on
2026-10-25 and is in git history at `2b3a7ce` (`docs/specs/v8-app-bridges/`).

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

## Out of scope

These are carried over from the gaps review:

- **Hosting a cloud browser or VM.** That is another product; B3's agent display is local.
- **Solving CAPTCHAs.** A CAPTCHA is a hand-off (H1).
- **Scheduling.** That is the host's job.
- **Always-on screen memory.** Its own users turn it off.
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
