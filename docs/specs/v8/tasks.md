# v8 tasks

From [`roadmap.md`](roadmap.md), which takes its user evidence from
[`docs/reviews/2026-10-25-computer-use-gaps.md`](../../reviews/2026-10-25-computer-use-gaps.md). James picked the
nine features on 2026-10-25. Each letter is one feature, and the release column follows the roadmap's order.

Status: `todo` → `in progress` → `done` (change + test green) → `blocked` / `needs hardware`.

## Spikes (run before the feature they gate)

| # | Spike | Release | Status | Pass | Tested by |
|---|---|---|---|---|---|
| D-S1 | Drag-and-drop timing on each OS: Finder → Mail, Explorer → Outlook, Nautilus → a GTK app, a tab tear-off, a list reorder | 8.1 | todo | Each case drops with one hold, step and hover setting; the settings recorded | |
| D-S2 | A helper window as the drag source for files: `NSDraggingSession`, `DoDragDrop` + `CF_HDROP`, a GTK drag source | 8.1 | todo | A file lands in Mail and in a chat app's message box on each OS | |
| T-S1 | `InjectSyntheticPointerInput` two-contact pinch and rotate in Photos, Maps, Edge (UTM Windows VM; touch laptop if available) | 8.1 | needs hardware | The map zooms and the image turns | |
| T-S2 | libei touch through portal `types` 7 on GNOME 46 and KDE 6 | 8.1 | todo | A two-finger pinch reaches a GTK 4 map | |
| T-S3 | macOS synthesized gesture events (magnify, rotate, swipe) in Preview, Maps, Safari | 8.1 | todo | Works, or the equivalent-shortcut route is chosen; decision recorded | |
| B-S1 | Windows background coverage: UIA patterns and posted messages across Notepad, Explorer, Office, an Electron app, a WinUI app | 8.1 | needs hardware | A matrix of what works without focus | |
| B-S2 | macOS menu commands through accessibility with the app in the background | 8.1 | todo | A menu command runs, frontmost app unchanged | |
| B-S3 | An agent display: a separate Windows desktop (`CreateDesktop`) and a macOS virtual display: capture and input there | 8.1 | todo | An app on the agent display is captured and driven; the person's screens untouched | |
| A-S1 | Token cost of an outline against a screenshot on 10 apps per OS | 8.0 | todo | Numbers recorded; sets the A6 target | |
| R-S1 | = v7.8 L1: a persistent stream with per-instance helper identities | 8.2 | todo | Two processes capture while one streams | v7.8 L1 |

## Features

| # | Task | Release | Status | Change | Tested by |
|---|---|---|---|---|---|
| X1 | Doctor check model: `evidence`, `fix` with a settings deep link, `auto_fix`; groups | 8.0 | todo | `src/session/doctor.ts` | |
| X2 | Platform checks: macOS (stale TCC grants, grant holder, Secure Input, CLT, helper identity, displays, Stage Manager); Windows (integrity levels, UAC, RDP, DPI per monitor, capture APIs, UIA, PowerShell, Smart App Control, layout); Linux (session, compositor, portals, restore token, libei, ydotool, XTest, AT-SPI, GTK, utilities, logind, inhibitor, layout, Flatpak/Snap); common (Node, addon ABI, profile, policy, audit, leases, client, live share) | 8.0 | todo | `src/session/doctor.ts`, native probes as needed | |
| X3 | `doctor {live: true}` self-test in a scratch window | 8.0 | todo | | |
| X4 | `doctor {bundle: true}` redacted support report; `computer-use-mcp doctor` CLI with the host-grant warning | 8.0 | todo | | |
| A1 | `observe`: outline, then OCR, then image; token estimate; `since` deltas | 8.0 | todo | | |
| A2 | Element refs on `click`, `type`, `set_value`, `drag_and_drop`, `run_steps`; `stale_ref` | 8.0 | todo | `src/session/contract.ts` (refusal) | |
| A3 | `observe`, `find_element`, `click_element`, `set_value` in `desktop`; schemas trimmed under 48,000 bytes; instructions say observe first | 8.0 | todo | `src/tool-catalog.ts`, `src/instructions.ts` | byte-budget test |
| A4 | Windows OCR (`Windows.Media.Ocr`): `read_window_text`, `click_text`, `wait_for_text` on Windows | 8.0 or 8.1 | todo | | |
| A5 | Untrusted-data label on every screen-derived text; a note on image results | 8.0 | todo | `src/session/agent-desktop-handlers.ts`, `src/session/screenshot-handlers.ts` | |
| A6 | Published benchmark: 10 tasks per OS, image-first against tree-first | 8.0 | todo | `docs/EFFICIENCY.md`, README | |
| C1 | `confirm_action` | 8.0 | todo | | |
| C2 | `COMPUTER_USE_CONFIRM_LABELS` on semantic clicks and on coordinate clicks by hit test | 8.0 | todo | `src/session/legacy-policy.ts` | |
| C3 | The confirmation panel (crop, values, Confirm / Cancel / Always for this app this session); MRTR and token fallbacks; remembered scope; audit with frame hash | 8.0 | todo | the three cards in `libexec/`, `src/approval-ledger.ts` | |
| H1 | `hand_off {to: "person"}`: card prompt and Done, `done_when`, `waiting_for_person`, no take-over during it, elicitation fallback | 8.0 | todo | `src/session/operator-control.ts`, the cards | |
| H2 | `hand_off {to: "agent"}` and `{action: "claim"}`: hand-off record, lease transfer, `desktop_handed_off`, notifications, audit | 8.1 | todo | `src/session/lock.ts` | |
| H3 | `control_status` reports hand-offs and the lease holder | 8.0 | todo | | |
| D1 | `drag_and_drop {from, to}` with drag-session timing and drop-target read-back | 8.1 | todo | `native/src/mouse.rs`, `src/session/input-handlers.ts` | |
| D2 | `drop_files {paths, to}` through a helper drag source on each OS | 8.1 | todo | | |
| D3 | Background drag on macOS; `drag_and_drop_session` refusal | 8.1 | todo | `src/session/pid-delivery.ts` | |
| T1 | `touch` (10 contacts, pressure) and named gestures; contacts released on Stop, Pause, cancel | 8.1 | todo | `native/src/` (new touch module), `native/src/linux_ei.rs` | |
| T2 | Per-app touch support in `get_app_capabilities` | 8.1 | todo | | |
| B1 | Background mode (`COMPUTER_USE_MODE`, `set_mode`); `would_take_over`; card state | 8.1 | todo | | |
| B2 | Background routes: macOS pid drags and accessibility menus; Windows UIA patterns and posted messages; Linux AT-SPI; recorded per app | 8.1 | todo | | |
| B3 | Agent display: Linux Xvfb or headless Wayland; Windows separate desktop or agent workspace; macOS virtual display | 8.1 | todo | `src/isolated-worker.ts` as the Linux starting point | |
| P1 | Task tree document format and store | 8.2 | todo | | |
| P2 | First run verifies every `expect`; verified nodes frozen and hashed; `export_steps {since}` | 8.2 | todo | | |
| P3 | Replay without model turns; `tree_mismatch` with hint; edits clear verification | 8.2 | todo | | |
| P4 | Checkpoints across restarts, MCP progress and tasks, checklist on the console and card, pause, skip and approve per node, `for_each` | 8.2 | todo | `src/agent-run.ts`, `src/mcp-tasks.ts`, `src/run-console.ts` | |
| R1 | `record_screen {prompt}`: rule and triage start and stop, idle cuts, chapters, highlights and captions in frames | 8.2 | todo | `src/session/live-watcher.ts`, `src/live-driver.ts` | |
| R2 | Encoding on each OS: SCRecordingOutput or AVAssetWriter; Windows.Graphics.Capture and Media Foundation; ScreenCast portal, PipeWire and GStreamer | 8.2 | todo | `libexec/macos-agent-helper.swift` | |
| R3 | Recording privacy: card state, Pause and Stop, blanked credential managers, blurred secure fields, retention, opt-in | 8.2 | todo | | |

## Ideas after 8.2 (not scheduled)

From the roadmap's section [Ideas after 8.2](roadmap.md#ideas-after-82-watching-listening-and-working-beside-the-person),
written up on 2026-11-22. None has a release yet; the "Could start" column is the roadmap's guess.

| # | Spike or idea | Could start | Status | Pass, or accepted when | Tested by |
|---|---|---|---|---|---|
| W-S1 | A kept-open stream with the target app's sound on macOS 26 (YouTube in Safari, 30 min, a second server capturing); on-device transcription delay and accuracy; which DRM videos capture black | With R-S1 | todo | Transcript under 2 s behind, the second server's captures unaffected, DRM behaviour recorded | |
| W-S2 | Watch programs written from five sentences, run on prepared clips | After W0 | todo | Each fires within 500 ms with no model call, none in 10 min of unrelated footage | |
| W-S3 | Capturing iPhone Mirroring and Desk View windows; input to the mirrored phone; a webcam source | After W0 | todo | Each source works or the reason is recorded | |
| W0 | See and hear one app: stream with app sound (macOS, Windows process loopback, Linux PipeWire), on-device speech, sound events, scene cuts, OCR deltas, a 10-minute memory dropped at stop, `speech`/`sound`/`scene`/`text`/`trigger` events, 3×3 storyboards, Listening on the card | With R (8.2) | todo | The W-S1 talk passes; nothing held after stop | |
| W1 | A skill that searches a recorded video by driving the player (YouTube, Vimeo, QuickTime, VLC shortcuts) | Now | todo | Moment found to within 10 s in four of five talks, at most 20 calls each | |
| W2 | Reflexes: watch program format, helper detectors (pixel probe, region OCR, transcript words, sound classes, scene cuts), an allowed action list through the usual input gates, one line on the card | After W0 | todo | W-S2 passes; Pause stops reflexes | |
| W3 | Watch together: push to talk, spoken replies that lower or pause the video, point and ask from a pointer trail, overlay shapes that follow a region, translated subtitles | After W0 | todo | Drawings never captured, subtitles under 3 s behind, eight of ten "what's that?" answered about the right region | |
| W4 | Share meaning: redaction levels per subscriber, subscribers on the card, watch hand-over with H2, the agent display as a stream in the console | After 8.1 | todo | No redacted field reaches a subscriber in 30 min; Stop ends every subscription | |
| W5 | Any camera is a source: AVFoundation, Media Foundation, V4L2 or PipeWire, opt-in per watch | After W0 | todo | W-S3 sources work with the same detectors and card states | |
| W6 | Learn by watching the person: an opt-in recording on the card, the person's clicks and keys from the event tap, an accessibility hit test (shared with C2), sensitive text replaced | After 8.0 | todo | A 15-step demonstration replays with no model call in four of five runs; no secret in the export | |
| W7 | Several targets per watch, a budget per target, the card listing them | After W2 | todo | Eight video windows, every reflex within 1 s, inside the CPU budget the first test sets | |
| M1 | Two cursors: accessibility writes (B2), a named overlay cursor, stepping aside when the person's pointer comes near | After 8.1 | todo | 50 edits while the person types, their caret never moves; a focus-taking app refused with `would_take_over` | |
| M2 | Accept the next click with one key: a matcher over the person's past routines (W6), outline and ghost text in the overlay, an accept key swallowed only while a suggestion shows | After 8.2 | todo | Shown suggestions right at least 80% of the time; nothing runs without the key | |
| M3 | Result before it happens: a copy of the document rehearsed on the agent display (B3), the result shown over the real window, a refusal for what cannot be copied | After 8.1 | todo | Real document untouched until Confirm; result matches the rehearsal | |
| M4 | Undo for the whole computer: an undo journal beside the step journal, `undo {last \| since}` with an `expect` per inverse, kept file copies, undoable and one-way labels on the card | With C | todo | A 20-action session fully undone where possible; one-way actions listed | |
| M5 | A new face for any app: a panel mapped to A2 refs, per-overlay capture inclusion, redaction that follows moving text | After A2 | todo | The panel fills the real form with values read back; no covered value seen by the receiving side of a share | |
| M6 | Drop anything onto anything: pick-up and drop chords, one mapping call, the mapping confirmed through C | After 8.1 | todo | Eight of ten pairs land with the right fields; Cancel saves nothing | |
| M7 | Where the agent looks: fading outlines for each read, a when-to-show setting, never captured | After 8.0 | todo | Outline within 100 ms of each read; none in a capture | |
| M8 | Apps as MCP servers: trees with variables turned into tools, app version checks, review and signing, P3 repair | After 8.2 | todo | Tools pass on a fresh machine at the same app version and refuse on another; no secret held | |

## Docs with each release

| # | Task | Status |
|---|---|---|
| G1 | AGENTS.md, README, CHANGELOG and the computer-use skill updated for each new tool and setting; tool counts by profile from the catalog test | todo |
| G2 | The open questions in the roadmap answered and recorded here | todo |
