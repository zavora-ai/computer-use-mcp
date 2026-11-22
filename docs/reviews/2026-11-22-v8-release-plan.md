# v8: ship the replay, the guide and the hand-off, then make a training video with them

v8 is mostly built. On branch `fix/blender-direct-input`, the 7.8.1 input fixes are committed and three features are
written and unit-tested but not committed: record and replay (`export_steps`, `expect` and `frame` on `run_steps`),
guide mode (the `guide` profile, the `guide-me` prompt, `agent_pointer {text, label}`), and a hand-off to the person at
sign-in and verification screens that is on by default. Together they answer the three things the 2026-10-25 gaps
review found users asking for and not finding: work they can repeat without re-checking it, a clean hand-back at the
login wall, and help learning software rather than an agent that does it for them. In the four weeks since, Claude and
Codex both shipped "record a skill", Gemini's Mac app got background computer use, Vercel's agent-desktop arrived as an
MCP server built on accessibility refs, and two open-source tools started making narrated walkthroughs. None of them
checks each replayed step against the screen, has a guide mode inside a desktop server, or refuses to type into a
sign-in screen, so the built work is still ahead where it counts. Apple then changed the ground under it: macOS 27.3
beta 2 splits the automation permission into per-app grants, and the server names a permission written before macOS 27
was ever run. What v8 still needs is small and mostly verification: run the new surface on Windows, Linux and macOS
27.3; finish the hand-off so it ends when the login window closes; label screen text untrusted; put a measured number
behind the replay claim; and give the pointer a path it can travel without a button held, because a training video in
which the cursor teleports between clicks is not watchable. Everything in the 2026-10-25 roadmap that needs a spike
first (background mode, drag-and-drop sessions, multi-touch, hand-off to another agent, task trees, prompted recording)
waits for 8.1 and 8.2; background mode, still the loudest ask, should lead 8.1. The showcase, a Blender trainer agent on
adk-rust 3.0 that drives Blender through this server and records a lesson, needs eight things: four exist, two
are musts (a pointer that travels, step times), the recorder is a should, and checking the scene belongs to Blender's
own API. Its live runs the same day landed 8 of 8 steps of a first lesson in Blender 5.3 and found eight gaps in this
server (T1 to T8): four were fixed that afternoon, two more (small text in a whole-window read, the pointer in
recordings) are shoulds, and the musts for the pointer and step times are built.

*Method and labels.* Read for this pass: `AGENTS.md`, `CHANGELOG.md`, `docs/STRATEGY.md`, the v8 roadmap and tasks
(`docs/specs/v8/`), the 2026-10-25 gaps, live-share and gaming reviews and the 2026-11-22 Blender review, `git status`
and `git diff` of the working tree, and `adk-rust` at `186ecc8`. Code claims point at the working tree of
`fix/blender-direct-input` (HEAD `af9a5b2` plus uncommitted changes) on 2026-11-22. Another session was editing
`src/session.ts` during this pass, so line numbers in that file are given with the function name and may have moved by
a few lines. Status words: **released** is on npm; **committed** is on this branch and unreleased; **uncommitted** is
in the working tree only; **not started** means a search of `src/`, `native/src/` and `libexec/` found nothing.
"Confirmed" means read or searched in this pass. Field research ran on 2026-11-22 through web search; every claim has
a link, and claims a search could not confirm are marked.

## What is built and not released

npm has 7.8.0 (published 2026-10-26, with the six platform packages at 7.8.0), but `CHANGELOG.md:92` still calls it
unreleased. Everything below is on top of it.

| Work | State | Where (confirmed) | Tested | What it lacks |
|---|---|---|---|---|
| **7.8.1 fixes**: modifiers pressed as keys on macOS; `type` into Blender as key events; the status card moves out of the way of a click; window captures of secondary windows map to the screen; `click`/`scroll` `modifiers`; `hold_keys`; `key_presses`; pen `pressure`; the numeric keypad; the pointer in captures; `hold_key` down/up | committed (`6e2bf2e`, `0c45eab`), unreleased; no 7.8.1 tag | `native/src/keyboard.rs` (`ModifierKeys`), `native/src/mouse.rs:613-670` (`post_button_event`, pen fields), `src/session/input-handlers.ts:43` (`ONE_CHARACTER_PER_KEY_APPS`), `:834` (`pressure_unsupported`), `libexec/macos-agent-helper.swift` (letterbox check) | 16 unit tests; every change run against Blender 5.3 on macOS 26.2 and read back from Blender (`docs/reviews/2026-11-22-blender-direct-control.md`) | Windows and Linux never run. The Windows card's move-aside is written to the macOS protocol and pinned only by a source test (Blender review, open item 10) |
| **Record and replay**: `export_steps {start, stop, export}`; `expect` (`changed`, `text`, `window`, `gone`, `region`) on each `run_steps` step; `frame` on `run_steps` | uncommitted | `src/session/step-journal.ts` (`JOURNAL_MAX` 300 at `:15`, `BATCH_MAX` 30 at `:17`, `REDACTED` at `:19`, `exportSteps` at `:168`); `src/session.ts` `exportStepsTool` (`:817`), `frame_changed` (`:1009`), `expect_failed` (`:1065`); schemas at `src/registry/definitions.ts:152-181`; refusals at `src/session/contract.ts:280-287` | 14 unit tests (`test/v8.0-record-replay.test.mjs`); since this plan was first written, checked live in Blender 5.3.0 (seven recorded actions replayed with every `expect` met, `CHANGELOG.md` v8.0.0) | The journal lives in session memory, so a restart loses it; the host must keep the export. `text` expects and the click-to-`click_text` conversion use OCR, so on Windows and Linux only `changed` and `window` expects work. No expect for an accessibility value or a file |
| **Guide mode**: `COMPUTER_USE_PROFILE=guide` (26 tools on macOS, 23 on Windows and Linux); the `guide-me` prompt; `agent_pointer {text, label}` | uncommitted | `src/tool-catalog.ts:83-91` (the profile rule: desktop tools that do not mutate, plus the overlay pointer), `src/prompts.ts:95`, `:142` (`guidePromptText`), `src/instructions.ts:35`, `src/registry/definitions.ts:89-97` | tool-count and doc-count tests (`test/v7.7-doc-counts.test.mjs`) | `text` pointing is macOS-only (OCR). No voice. The pointer overlay is excluded from capture by design: `screenshot {show_agent_pointer: true}` draws it into a still (`src/session/screenshot-handlers.ts:542`), but a screen recorder outside the server never sees it |
| **Hand-off at sign-in and 2FA**, on by default: `sign_in_required`, then `handed_off` until Resume; `hand_off {message, wait_ms, action: "done"}`; `COMPUTER_USE_AUTH_HANDOFF=off` | uncommitted | `src/session/auth-wall.ts` (78 lines: field, title and page-text checks, `BROWSERS` at `:22`, `typesText` at `:30`); the check in `src/session.ts` before the lock (`:540`) and `authWall` (`:900`); `handOffTool` (`:922`); `src/session/operator-control.ts:313`, `:440` (`handOff`), `:450` (`endHandOff`); `src/session/contract.ts:271-279` | 8 unit tests (`test/v8.0-hand-off.test.mjs`) | It ends only on Resume or `hand_off {action: "done"}`: the roadmap's `done_when: window_gone \| text_gone` (H1) is not built, so the agent cannot pick up by itself when the login window closes. The page-text check is macOS-only (`authWall` needs the macOS helper). It checks typing, not a click on "Sign in with Google" or "Pay". No elicitation for hosts without the card |

The byte budget is the constraint on everything new in the default profile: `desktop` lists 39 tools and 47,595 bytes on
macOS against a 48,000-byte ceiling under test (`test/v7.6-tool-surface.test.mjs:42`). Any must-have that adds a
parameter to a `desktop` tool has about 400 bytes to spend, or has to trim something first.

## What changed in the field since 2026-10-25

**Apple changed the permission v8 depends on.** macOS 27.3 beta 2 (2026-11-16) splits "Device Control and Data Access"
in two. Automation tools get **System & App Protection Override**: the person picks which apps the tool may control
("Choose Apps"), sets each to "Ask First" or "At Any Time", and a blue menu-bar indicator shows while one app controls
another. Accessibility becomes the grant for assistive technologies, through an entitlement. Existing grants carry
over, and Apple says the entitlement details are coming "soon" ([Apple developer news](https://developer.apple.com/news/?id=oqng0zjk);
[Apple support](https://support.apple.com/en-us/149699); [Michael Tsai](https://mjtsai.com/blog/2026/11/17/system-app-protection-override/)).
For this server that is a new failure mode: input to an app the person did not choose will presumably fail, and the
server has one name for one grant. `doctor`, the `accessibility_permission_denied` hint and the native refusal all say
"Accessibility (on macOS 27 and later: Device Control and Data Access)" (`src/session/doctor.ts:9-13`,
`src/session/contract.ts:242`, `native/src/permissions.rs:88`), a name 7.7.0 adopted before anyone ran macOS 27; the
machine used for this pass runs macOS 26.2. The gaps review found permission breakage after updates to be 9.7% of
Claude Code's computer-use issues, and this one arrives with a point release. Checking it on 27.3 beta and naming the
new grant, per app, is a v8 must.

**Record and replay is now something the hosted products ship, as skills.** Claude's "Record a skill" and Codex's
"Record & Replay" both turn a demonstration into an editable skill that a model follows again, not into checked steps
([Claude release notes](https://support.claude.com/en/articles/12138966-release-notes);
[ChatGPT docs](https://learn.chatgpt.com/docs/extend/record-and-replay)). Claude's recordings capture every app on
screen, including apps an admin denied, stop on lock, sleep or account switch (2026-11-19), and are discarded after an
hour ([Cowork changelog](https://claude.com/docs/cowork/changelog);
[Team and Enterprise setup](https://support.claude.com/en/articles/18483812-set-up-computer-use-for-team-and-enterprise-plans)).
So `export_steps` is no longer first to the idea. What it still has that they do not: a check after every step that
stops the replay where the screen differs, no model turn for a step that passes, any MCP host, and Windows and Linux
(with `changed` and `window` checks only until Windows and Linux get OCR).
Two things to take from them: stop recording on lock and sleep, and never record an app the policy blocks.

**Hand-off at sign-in: vendors route the secret around the model.** No first-party "your turn at the login" flow was
found. Claude routes credentials through 1Password (macOS, through Claude in Chrome, the person approving each login,
the model never seeing the secret; [1Password](https://support.1password.com/1password-claude/)); Codex's docs tell the
person to stay present for credentials and payments and say the agent cannot approve security prompts
([ChatGPT docs](https://learn.chatgpt.com/docs/computer-use?surface=app)). Claude's third-party deployments now hide
recognised password, one-time-code, card and SSN fields from screenshots and page text (2026-11-12,
[Cowork changelog](https://claude.com/docs/cowork/changelog)). The v8 hand-off is in line with this, and blurring those
fields in captures is the next step (gaps review C6).

**Background work spread; Windows stays in front.** Gemini's Mac app got computer use on 2026-11-19 in an isolated
background window with a live preview, apps the person picks, pause, and approval of key actions (Apple silicon,
macOS 15+, paid plans, US English; [Google](https://blog.google/innovation-and-ai/products/gemini-app/computer-use-mac/)).
The Gemini API's Computer Use tool went GA on 2026-10-30 with browser, mobile and desktop environments
([AI Studio changelog](https://aistudio.google.com/docs/changelog)). Codex works in the background on macOS and is
foreground-only on Windows, where it takes the pointer and keyboard; it added an opt-in macOS "locked use" that unlocks
the Mac only during a turn and relocks on local input ([ChatGPT docs](https://learn.chatgpt.com/docs/computer-use?surface=app)).
None of the vendors checked offers background input on Windows, so keeping background mode out of 8.0 loses no ground
to them there; on macOS it does, against all three.

**Claude's computer use reached Team and Enterprise** on 2026-11-20 (macOS 14+ and Windows, off until an Owner turns it
on), with admin allow and block lists keyed by bundle ID on the Mac and file name or AUMID on Windows, and an MDM key
([release notes](https://support.claude.com/en/articles/12138966-release-notes)). Claude Code 2.1.329 moved macOS
computer use to stricter rules on 2026-11-19 ([changelog](https://code.claude.com/docs/en/changelog)). Claude Desktop
for Linux still has no computer use ([docs](https://code.claude.com/docs/en/desktop-linux)), so Linux reach is still
this server's lead. Newer Claude models accept only `computer_toolset_20260801` on the API; `computer_20251124` returns
400 outside Bedrock ([release notes](https://platform.claude.com/docs/en/release-notes/overview)). Nothing in this
repository names either version (searched `src/` and `examples/`), so it touches no MCP host and no shipped helper.

**Microsoft's Ignite (2026-11-17) is about finding local agents and MCP servers.** Intune local-agent controls, discovery
of local and "shadow" MCP servers, an MCP Firewall and agent IDs auto-assigned to local agents (Claude Code and GitHub
Copilot CLI first), all in preview; Execution Containers process controls in preview
([Book of News](https://news.microsoft.com/events/ignite/2026/book-of-news/);
[Windows blog](https://blogs.windows.com/windowsexperience/2026/11/17/microsoft-ignite-2026-building-windows-for-the-next-era-of-work/)).
This server will show up in those inventories as a local MCP server; an audit record that names the agent (row 26)
is what lets a buyer match it. Nothing new on the agent workspace or the on-device registry, and no touch or pen
injection news.

**In open source, the new rival is Vercel's agent-desktop.** It reached 1.0.0 on 2026-10-28, added an MCP server in
1.2.0 (2026-11-05) and a macOS VM sandbox in 1.3.0 (2026-11-12), and has 26.0k stars. It works from accessibility-tree
refs, and its ref actions run "without moving the pointer or taking focus"
([releases](https://github.com/vercel-labs/agent-desktop/releases)). That is the roadmap's A2 and part of B, shipped
by a team with reach, which raises the value of row 22. Elsewhere, star counts read through the GitHub API on
2026-11-22:

| Project | Latest | Stars | What moved since 2026-10-25 |
|---|---|---|---|
| cua / cua-driver | cua-driver-rs 0.57.0, 2026-11-22 | 32.8k | Background input without the pointer; trajectories recorded and rendered to MP4 (`recording render`); a nightly `agent_display`, a virtual display owned by the session on macOS ([repo](https://github.com/trycua/cua), [CLI](https://cua.ai/docs/reference/cua-driver/cli-reference)) |
| Windows-MCP | 0.9.0, 2026-11-22 | 12.0k | Desktop gate policies and deliberate mouse take-over (0.8.9); snapshot ids as refs ([releases](https://github.com/CursorTouch/Windows-MCP/releases)) |
| Peekaboo | 4.9.10, 2026-11-21 | 5.5k | Background delivery for targeted semantic and typed input ([release](https://github.com/openclaw/Peekaboo/releases/tag/v4.9.10)) |
| computer-use-linux | 0.7.59, 2026-11-20 | 918 | Background keys and a background pointer through a virtual pen and touchscreen on GNOME and KDE (0.7.57-0.7.59) ([releases](https://github.com/agent-sh/computer-use-linux/releases)) |
| Hermes Agent | 0.23.3, 2026-11-20 | 265k | "Bot Screen" lets the person take over a headless Linux desktop for logins and 2FA; a cua-driver replay-by-trajectory workflow ([docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use)) |
| Playwright MCP | 0.0.86, 2026-11-18 | 40.0k | `--background` in extension mode; recording to code and video ([releases](https://github.com/microsoft/playwright-mcp/releases)) |
| Browser Use | 1.0.8, 2026-11-22 | 121.7k | 1.0.0 (2026-11-10) is a rewrite on the DevTools protocol; login approval by device code ([1.0.0](https://github.com/browser-use/browser-use/releases/tag/1.0.0)) |
| agent-browser | 0.43.0, 2026-11-12 | 53.3k | Saved flows, experimental (0.42.0); `@e1` refs; `record` ([releases](https://github.com/vercel-labs/agent-browser/releases)) |
| Microsoft Skill Recorder | 0.9.0, 2026-11-12 | 5.9k | Records a session and writes a SKILL.md for an agent to follow; no replay engine ([repo](https://github.com/microsoft/skill-recorder)) |

**Agents that make tutorials appeared this month.** Screenplay (created 2026-11-02, in the MCP Registry from 0.1.6)
films narrated walkthroughs of web and native desktop apps with callouts, and its `check` command rehearses a
scenario before recording ([repo](https://github.com/gmpetrov/agent-screenplay)). OpenScreen 2.3.0 (2026-11-17) has an
in-app MCP server and a skill that goes from storyboard to recording to MP4 ([repo](https://github.com/getopenscreen/openscreen)).
Screenplay's rehearsal is the same idea as rehearsing with `expect`. Neither README says it drives an app with no
accessibility tree, or teaches a person live. The Blender trainer is the same product idea taken where those tools do
not claim to go; it also means the showcase has to look at least as good as theirs, which is why a pointer that
travels and step times are musts.

**Guide overlays stayed standalone.** Clicky's open repository now points to a closed app, HeyClicky, for Mac and
Windows ([repo](https://github.com/farzaa/clicky)); Teachy, an open fork, points, draws and asks before acting
([repo](https://github.com/VedSoni-dev/teachy)). No desktop MCP server found has a read-only guide surface.

**Blender and Unreal have official MCP servers.** Blender Lab's server is at 1.0.3 (2026-09-11) with 26 tools,
screenshots and code execution "without any guards" (from a third-party comparison; projects.blender.org refused the
fetch, [strayspark](https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026)). Unreal's MCP is
experimental in 5.8, and the 5.9 Preview notes (2026-11-09) add toolsets and an MCP client toolset
([Epic](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor)). Both work inside the app's
data model, which is what the trainer needs to check a scene, and neither moves a pointer a viewer can follow, which is
what it needs this server for. This keeps the bridges out of the server: route to them, do not rebuild them.

**Where this server is still first** (by the open-source survey): a replay that checks each native step by text, a
window or a changed region and stops where the check fails (others record trajectories, write skills, or replay
browsers only); a guide profile inside a full desktop server; refusing to type into a sign-in or code screen rather
than waiting for the person to take over (Libretto automates SMS codes); and pen pressure on macOS (only
computer-use-linux injects a pen or touch, and on Linux).

**What users ask for has not moved much in four weeks; the evidence below is what is strongest.** HN points come from
the Algolia API and GitHub reactions from the GitHub API, both read on 2026-11-22. X needs a login, so no X counts are
used.

| Ask | Strength | The best evidence |
|---|---|---|
| Background work that does not take the cursor | Strongest | cua's "drive any macOS app in the background without stealing the cursor", 192 points, where a commenter hates "that the cursor jumps around" and another asks for Windows ([HN](https://news.ycombinator.com/item?id=47936312)); the Chrome extension stealing focus, 19 reactions ([claude-code #39558](https://github.com/anthropics/claude-code/issues/39558)) |
| Record once, replay | Strong for browsers, thin for desktops | In the 45x-cost thread (495 points) commenters ask for "the agent explores the app, then writes a repeatable workflow" ([HN](https://news.ycombinator.com/item?id=48024859)); Muscle-Mem 226, Libretto 134, Workflow Use 69 ([HN](https://news.ycombinator.com/item?id=44007065)); a desktop-only launch got 1 point ([HN](https://news.ycombinator.com/item?id=46601429)) |
| Hand-off at sign-in, 2FA, CAPTCHA | Many asks, few reactions each | browser-use human-in-the-loop, 18 reactions ([#221](https://github.com/browser-use/browser-use/issues/221)); manual login and MFA, 11 ([#404](https://github.com/browser-use/browser-use/issues/404)); CAPTCHA threads at 84 and 108 points |
| Training videos and tutorials made by software | Shown by funding, not threads | Clueso raised a $10M Series A in October 2026 and reports over 1,000 companies using it ([HackerNoon](https://hackernoon.com/clueso-raises-$10m-from-dharana-capital-to-build-the-agentic-future-of-video-creation)); Guidde raised $15M ([TechCrunch](https://techcrunch.com/2025/02/19/guidde-taps-ai-to-help-create-software-training-videos)). Nothing found on agent-made Blender tutorials |
| A guide that points instead of acting | Thin on HN, strong in views | Ourguide, 52 points ([HN](https://news.ycombinator.com/item?id=46769422)); Clicky's 2.9M demo views (gaps review) |
| Creative apps by mouse and keyboard | High interest, mostly through APIs | "Anthropic joins the Blender Development Fund", 256 points ([HN](https://news.ycombinator.com/item?id=47936370)); Blender MCP Show HN, 151 ([HN](https://news.ycombinator.com/item?id=44622374)); DaVinci Resolve 21.1 ships its own MCP server ([Digital Production](https://digitalproduction.com/2026/09/08/resolve-21-1-adds-mcp-and-finally-gets-presets/)) |
| Touch, trackpad and pen for agents | Thin | No HN story or issue above 10 reactions; the signals come from tool builders (PenBridge added Mac gesture injection, [PR #111](https://github.com/Blake11/PenBridge/pull/111)) |

Two readings for v8. Background mode is still the loudest ask and stays out of 8.0 for cost, not for lack of demand;
it should lead 8.1. Training-video makers are a funded category that has not reached apps without an accessibility
tree, which is what makes the Blender showcase a fair test rather than a demo of something others already do.

## Input gaps found today

Three gestures that people make with a mouse or a trackpad have no route through the server.

**A pointer path with no button held.** `mouse_move` takes one coordinate (`src/registry/definitions.ts:187`); the
handler validates it and calls the native move once (`src/session/input-handlers.ts:561-570`); on macOS that posts a
single `kCGEventMouseMoved` (`native/src/mouse.rs:535-549`). `mouse_drag` interpolates a path but always presses a
button (`button` defaults to `left`, `definitions.ts:192-210`). So the pointer cannot glide across a window with Shift
held, cannot hover along a mesh in Blender to show where a brush would land, and every `click` arrives by jumping. Two
consequences matter for v8. Apps that act on hover motion (Blender's brush cursor and snapping previews, tooltips,
spring-loaded menus) see a jump, not a movement. And a screen recording of the agent shows the cursor teleporting from
one click to the next, which makes a training video hard to follow. The native layer already has what is needed:
`mouse_drag_to` interpolates, and modifiers already go down as keys before a gesture (7.8.1). A `path` (and optional
`duration_ms`) on `mouse_move`, plus a session setting that makes `click` and `mouse_drag` travel from the current
position instead of jumping, is a small change on all three systems.

**Two buttons at once.** Nothing presses left and right together and moves. `left_mouse_down` and `left_mouse_up` are
left-only (`native/src/mouse.rs:812-835`), and `mouse_drag` presses one button; on macOS each moving event takes that
one button's dragged type (`post_button_event`, `mouse.rs:613-640`), so a second held button would not be reported.
Some 3D tools and games use the chord (both buttons to dolly or to run forward). Evidence of demand is thin; the change
is a `buttons` list on `mouse_drag` and the right event type and button mask per system.

**Touch and trackpad gestures.** There is no touch code anywhere. The Linux portal session asks for keyboard and
pointer only (`types` 3, `native/src/linux_ei.rs:409`) and the libei seat binds no touch capability (`:505-512`); the
only touch symbols in `native/src` are the XInput raw-touch events the take-over monitor listens to
(`native/src/activity.rs:928-930`). Per system:

| System | What exists | Limits | Verdict for v8 |
|---|---|---|---|
| Windows | `CreateSyntheticPointerDevice` + `InjectSyntheticPointerInput`: `PT_TOUCH` (up to 256 contacts, `MAX_TOUCH_COUNT`) and `PT_PEN` (pressure 0-1024, tilt, rotation), Windows 10 1809+ ([Microsoft Learn](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-createsyntheticpointerdevice), [pen info](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-pointer_pen_info)) | Desktop apps only; coordinates on the virtual screen; one pen contact. Precision-touchpad gestures cannot be injected at all: they need a virtual HID touchpad driver ([Microsoft Learn](https://learn.microsoft.com/en-us/windows-hardware/design/component-guidelines/touchpad-windows-precision-touchpad-collection)). The docs do not say whether UIPI blocks it as it blocks `SendInput`; assume it does until tested | Touch and pen are reachable with one API; the pen closes Windows' `pressure_unsupported`. 8.1, after the T-S1 spike |
| Linux | libei `ei_touchscreen` down, motion, up ([libei](https://libinput.pages.freedesktop.org/libei/interfaces/ei_touchscreen/index.html)); the RemoteDesktop portal's touchscreen device type (bit 4) ([portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)); uinput multi-touch protocol B for a touchscreen, touchpad or pen ([kernel](https://docs.kernel.org/input/multi-touch-protocol.html)) | GNOME's portal offers touch when mutter reports it and KDE always lists types 7, both read from source, not run. libei refuses down and motion in one frame. uinput needs write access to `/dev/uinput`. No portal type for touchpad gestures. computer-use-linux already uses a virtual pen and touchscreen | Reachable on GNOME and KDE through the portal the server already uses (`types` 3 becomes 7). 8.1, after T-S2 |
| macOS | No public API: `CGEventType` has no gesture types ([Apple](https://developer.apple.com/documentation/coregraphics/cgeventtype.md)). Tool builders use undocumented gesture fields; CoreHID's `HIDVirtualDevice` (macOS 15) needs an entitlement Apple grants on request ([forum](https://developer.apple.com/forums/thread/764540)) | Undocumented fields reach the frontmost app and must be re-checked each release. A CoreHID virtual pen reports pressure 0 on 26.2, a bug Apple has accepted ([forum](https://developer.apple.com/forums/thread/845787)), while the server's tablet-point CGEvents do reach Blender | **Won't**, unless James accepts private API (roadmap question 1). The roadmap's fallback stands: pinch as ⌘-scroll or ⌘+/−, reported as `route: "equivalent"` |

For the two mouse gaps the platform notes agree with the plan. On Windows one `MOUSEINPUT` can carry left and right
down together, and a path should be sent with `MOUSEEVENTF_MOVE_NOCOALESCE` so moves are not merged
([MOUSEINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)). On macOS a chord is
two down events, and Apple does not document which dragged type to send while both are down; MagicChord sends both
downs and maps motion to one of them ([MagicChord](https://github.com/Eckobrew/MagicChord)), so the chord needs a test
in each target app before the server claims it. A hover with Shift held needs the modifier's own key-down first on
macOS, which is what 7.8.1 already does for clicks and drags. No sourced pitfalls were found for chords through XTest
or libei.

## The showcase: a Blender trainer on adk-rust 3.0

Another session is building it (`adk-rust` worktree `blender-trainer-agent-9768dc`, `examples/blender_trainer`). The
agent drives Blender 5.3 through this server, rehearses a lesson until every step passes, then performs it for a
recording with narration, and can switch to guide mode to coach a learner who does the steps themself.

**Its live runs, the same day.** Against this branch at `af9a5b2` plus the uncommitted v8 work, `full` profile,
macOS 26.2, the first lesson (`first-donut.json`, eight steps) landed 7 of 8 steps in run 2 and 8 of 8 in run 3, in
1 min 48 s of lesson, each step checked by OCR or a changed viewport (`examples/blender_trainer/docs/live-run.md`). Run 2's
miss was "Make it fatter": a whole-window `click_text "0.25"` found nothing in Blender's redo panel, and a region read
found it. The runs turned up eight gaps in this server, T1 to T8 below; four were fixed in the parent session the same
afternoon. Guide mode, replay of a take, recording and the video assembly have not run live yet.

| # | Gap from the live runs | Where it lands in the classification | State |
|---|---|---|---|
| T1 | No screen-recording tool: the trainer records with ffmpeg (AVFoundation), or the person does | Row 24 (macOS recorder), should | not started |
| T2 | The overlay pointer (and the card) are excluded from every capture, with no opt-in, so a recorded lesson never shows where the agent points or its "Look here" label | Row 29, raised to should: an operator opt-in for the overlay pointer only | not started |
| T3 | `mouse_move` jumped; only `mouse_drag` interpolated, so the cursor teleports on video | Rows 7 and 8 | done in the afternoon pass |
| T4 | `agent_pointer {text}` took no `region` or `nth`: a label shown twice ("Torus" in the outliner and the redo panel) was pointed at wherever OCR read it first | Row 29a | done in the parent session |
| T5 | `agent_pointer` took `target_app` but no `target_window_id` or `target_title`: it could not point inside a secondary window such as Blender's File View | Row 29a | done in the parent session |
| T6 | OCR reads Blender's decimal point as a comma and 0 as O ("1,000" for "1.000", "O°"), and `expect.text` had no `match` | Row 29b | done in the parent session |
| T7 | Whole-window OCR drops small text a region read keeps (`click_text "0.25"` in the redo panel) | Row 29c, should | partial: a checked recording now reads a band around each click; `click_text` and `wait_for_text` still read the whole window unless given a `region` |
| T8 | `export_steps` derived each step's `expect` from the recording and dropped the `expect` the `run_steps` step carried (an authored "Torus" check came back as `changed: true`) | Row 29d | done in the parent session |

What it needs from the server:

| Need | Why | Server today | v8 |
|---|---|---|---|
| Rehearse, then perform the same steps | A take must not improvise; a failed step must stop the take, not ruin it | `export_steps` and `expect` (uncommitted) | ship |
| A pointer that travels | Viewers follow the cursor; a jump between clicks loses them | Jumped (`mouse_move` was one event) | **must**: path moves and glide, built in the afternoon pass |
| Step times | Chapters, captions and narration line up with what happened | `run_steps` step records carry `index`, `tool`, `ok`, `effect`, `route`, `delivery`, `hint`, no time (`src/session.ts:1051-1056`); the journal keeps `at` but `export_steps` does not return it | **must**: `at_ms` and `ms` per step, built in the afternoon pass |
| Blender's gestures | Sculpt strokes with pressure, pans with Shift held, keypad views, keys held across calls | 7.8.1, macOS, proven against Blender 5.3 | ship; `mouse_drag` is only in `ax` and `full` (`src/tool-catalog.ts:178`), so the trainer runs `full` |
| A clean frame | The status card and its buttons must not appear in the video | The card and the overlay pointer are excluded from every capture on macOS and Windows | done for the card, and it stays so: the agent must never see, or be pointed at, its own controls |
| Pointing that shows in the video (T2) | A guide-mode lesson is about where to look; the recording shows no pointer at all | The overlay pointer is excluded from capture like the card; `screenshot {show_agent_pointer: true}` draws it into stills only | **should**: an operator opt-in (`COMPUTER_USE_POINTER_CAPTURABLE=true`, environment only, no tool argument) for the overlay pointer alone, with the label drawn beside the pointer instead of on the card |
| The recording itself (T1) | The lesson is a video | No recorder in the server (roadmap R, planned for 8.2) | the trainer records with ffmpeg (AVFoundation) for v8.0; a minimal `record_screen` on macOS is a should |
| Checks that survive OCR (T6, T7, T8) | A lesson's checks are numbers and labels in small panels; a replay must check what the lesson did | Digit-tolerant matching, `expect.match` and the step's own expect kept: done in the parent session. Small text in a whole-window read: still needs a `region` | ship; **should**: `click_text` and `wait_for_text` retry in tiles when a whole-window read misses (T7) |
| A learner mode | Coach a person instead of doing it | Guide mode, `wait_for_stable`, `live_events`; `agent_pointer` now takes `nth`, `region`, `target_window_id`, `target_title` (T4, T5) | ship; `text` pointing is macOS-only |
| A check that the scene is right | OCR can confirm a label, not that a mesh moved | Nothing in this server; the Blender review read state through a test fixture | route to Blender's own Python or MCP for read-back; never part of the input route |

**The adk-rust side calls tools this server does not have.** `adk-computer-use`'s live runtime,
`ComputerUseMcpRuntime`, calls `execute_action`, `get_execution_capabilities`, `preview_action`,
`acquire_control_lease`, `reserve_target`, `release_target_reservation`, `pause_session` and `emergency_stop`
(`adk-rust/adk-computer-use/src/runtime/mcp.rs:251-563`). A search of this repository's `src/` and `dist/` finds none
of those names; the `computer-use-supervisor` and `computer-use-remote` packages that may once have served them are
empty (gaps review, housekeeping row 9). Its README says the runtime should be "pointed at a running `computer-use-mcp`
server". Either the trainer drives the server through adk-tool's plain MCP toolset, or one side needs an adapter.
Settled for the showcase: the trainer drives the server through `adk-tool`'s plain `McpToolset` and is unaffected, and
the runtime itself is being fixed on the adk-rust side, with the other ADK-Rust gaps the runs found (`adk-audio`'s WAV
decoding, instruction templating).

## The classification

Class is for v8.0.0. **Must**: v8 does not ship without it. **Should**: ships in 8.0 if the musts are done in time,
else first in 8.1. **Could**: worth doing, no date. **Won't**: not in v8.0, with the reason. Size: XS under a day, S a
few days, M one to two weeks, L longer or needs hardware the project lacks.

| # | Feature | Class | Status | Evidence | Where it lives (confirmed) | Size |
|---|---|---|---|---|---|---|
| **Built on this branch** | | | | | | |
| 1 | Record and replay: `export_steps`, `expect` per step, `frame` | **must** | done, uncommitted; unit tests only | Record once, replay was the one new direction the gaps review backed (A17: Understudy 120 points, Muscle-Mem 226, Libretto 134); following the sculpting tutorial, replaying the teacher's 45 strokes gave her result where judging the outline did not (Blender review, run A against run B). Claude and Codex now ship recording as skills, and Skill Recorder (5.9k stars) writes SKILL.md; none checks each native step on replay | `src/session/step-journal.ts`; `src/session.ts` `exportStepsTool`, `run_steps`; `src/registry/definitions.ts:152-181` | done; a live run on each OS is row 16 |
| 2 | Guide mode: `guide` profile, `guide-me`, `agent_pointer {text, label}` | **must** | done, uncommitted | Clicky's demo drew about 2.9M views, and people used it to learn Blender and DaVinci Resolve (gaps review B8); guidance raised screen-reader users' task success (Stanford SCALE). Clicky went closed (HeyClicky); no desktop MCP server has a guide surface | `src/tool-catalog.ts:83-91`; `src/prompts.ts:95-142`; `src/instructions.ts:35`; `src/registry/definitions.ts:89-97` | done |
| 3 | Hand-off at sign-in and 2FA by default: `sign_in_required`, `handed_off`, `hand_off`, `COMPUTER_USE_AUTH_HANDOFF` | **must** | done, uncommitted | Second most-loved feature and complaint rank 5 in the gaps review (A4); "agents that cannot survive a 2FA wall are toys"; browser-use human-in-the-loop, 18 reactions. Hermes's Bot Screen and Windows-MCP rely on the person choosing to take over; Claude routes passwords through 1Password and hides secret fields in third-party deployments | `src/session/auth-wall.ts`; `src/session.ts` (`authWall`, `handOffTool`); `src/session/operator-control.ts:440-460`; `src/session/contract.ts:271-279` | done |
| 4 | The hand-off ends by itself: `done_when: window_gone \| text_gone`, reusing `wait_for_window` and `wait_for_text` | **must** | done in the afternoon pass, uncommitted | The roadmap's own acceptance test for H1 is "the agent's next call succeeds with no Done press"; Gemini picked the task back up after the person cleared 2FA (gaps review A4) | `handOffTool` polls `control.state()` only | S |
| 5 | The 7.8.1 input fixes (modifiers as keys, Blender typing, card dodge, capture mapping, `hold_keys`, `key_presses`, pen, keypad, pointer in captures, `hold_key` down/up) | **must** | done, committed, unreleased | 0 of 12 clicks on Blender's X-ray button landed with the card up, 12 of 12 after; 64 Blender 5.3 features proven by mouse and keyboard alone (Blender review) | `native/src/keyboard.rs`, `native/src/mouse.rs:613-670`, `src/session/input-handlers.ts`, `libexec/macos-agent-helper.swift` | done |
| 6 | Live share (`live_watch`, `live_events`, the tiered driver) | keep, no new work | released in 7.8.0 | 4.9 s from a change to Opus telling the person, at about $0.01 a run (`docs/specs/v7.8/tasks.md`) | `src/session/live-watcher.ts`, `src/live-driver.ts`, `src/live-tools.ts` | done |
| **Input gaps** | | | | | | |
| 7 | A pointer path with no button: `mouse_move {path, duration_ms}` with `modifiers` and `hold_keys` | **must** | done in the afternoon pass, uncommitted; not yet watched in Blender | Found today driving Blender, and T3 in the trainer's live runs: the cursor teleports between controls on video; Screenplay and OpenScreen set the bar for agent-made walkthroughs. Windows needs `MOUSEEVENTF_MOVE_NOCOALESCE` for a path | `definitions.ts:187`; `input-handlers.ts:561-570`; `native/src/mouse.rs:535-549` | S |
| 8 | Glide: `click` and `mouse_drag` travel from where the pointer is, at a set speed (`COMPUTER_USE_POINTER_MOTION=glide`, off by default) | **must** (for the showcase) | done in the afternoon pass, uncommitted | A viewer follows the cursor; the person watching a live run does too | `input-handlers.ts` click and drag paths | S |
| 9 | Two buttons held together while moving (`mouse_drag {buttons}`) | could | not started | Found today; demand thin. One `MOUSEINPUT` carries both on Windows; on macOS the dragged type with both down is undocumented, so each app needs a test | `native/src/mouse.rs:613-640` (one button per gesture), `:812-835` (left only) | S |
| 10 | Multi-touch and trackpad gestures (`touch`, pinch, rotate, swipe) | **won't** in 8.0; Windows and Linux could in 8.x; macOS won't | not started | Thin: no issue or HN story above 10 reactions. Windows has `InjectSyntheticPointerInput` (1809+); Linux has libei touch through the portal; macOS has no public route. Only computer-use-linux injects touch, on Linux | none; `native/src/linux_ei.rs:409` (`types` 3), `:505-512` (no touch capability) | L |
| 11 | Pen pressure on Windows and Linux | could | not started; refused with `pressure_unsupported` | Blender's sculpt and Grease Pencil tools read pressure | `input-handlers.ts:834` | M |
| 12 | `w+a` presses both keys; Windows scan codes | could | not started | The gaming review: every non-modifier part of a combo overwrites one `main_key` on macOS, Windows and X11; Windows sends `wScan: 0` | `native/src/keyboard.rs:214-226`, `:640-652`, `:1230-1242`, `:1212` | S |
| 13 | Space a click and a press so an app does not read them as a double-click | could | not started | Blender review, open item 6 | `input-handlers.ts` | S |
| 14 | Decide what `scroll {direction: "up"}` means | should | not started | It posts a negative delta, which Blender reads as wheel-down (zoom out); no test pins it (Blender review, open item 1) | `input-handlers.ts:623`, `:634` | XS |
| **Open items from the reviews** | | | | | | |
| 15 | Untrusted labels on screen-derived text (OCR lines, `wait_for_text` matches, tree names and values) and a note on images | **must** | done in the afternoon pass, uncommitted (before: 0 matches in the two handler files) | Gaps review P0-3: instructions hidden in screenshots were followed (Brave); Cowork exfiltration, 870 points. Guide mode and replay both feed OCR text to a model | `src/session/agent-desktop-handlers.ts`, `src/session/screenshot-handlers.ts` | XS |
| 16 | Run the v8 surface on Windows 11 and GNOME 46: the 7.8.1 input, the card's move-aside, the hand-off, replay with `changed` and `window` expects, guide with coordinates | **must** | not started (the Windows move-aside has never run) | Windows is in 48% of Codex's computer-use issue titles (gaps review A8); the Windows card has never run on Windows with the dodge (Blender review, open item 10) | `libexec/windows-status-card.ps1`; `docs/TESTING-IN-UTM.md` | M |
| 17 | `doctor`: the stale-grant fix text, and the addon's version against the package's | **must** | done in the afternoon pass, uncommitted | Gaps review P0-4 (Codex #18896 open six months; TCC is 9.7% of Claude Code's computer-use titles); a 7.8.0 addon under 7.8.1 code gave "Unknown key numpad_decimal … Valid keys: … numpad_decimal" (Blender review, open item 9) | `src/session/doctor.ts:13`; `src/session/keys.ts:146` | XS |
| 17a | macOS 27.3's System & App Protection Override: run on 27.3 beta; `doctor` names the new grant and which target apps the person chose; input to an app not chosen is refused by name with the fix | **must** | advice done in the afternoon pass; not run on 27.3 | Apple split the permission on 2026-11-16 (per-app "Choose Apps", "Ask First" or "At Any Time"); the server's one permission name was written before macOS 27 was run | `src/session/doctor.ts:9-13`; `src/session/contract.ts:242`; `native/src/permissions.rs:88` | S-M (needs a 27.3 machine or VM) |
| 18 | A measured replay number: three tasks run model-driven and replayed; turns, input tokens, wall time, success | **must** | measured 2026-11-22 (Calculator, TextEdit, Blender 5.3): two replays reached the end state 8x and 27x faster with no model call; the Blender replay stopped at step 5 of 33 (row 18a) | The 45x-cost thread drew 495 points (gaps review A3); `docs/EFFICIENCY.md` said the savings were not measured | `scripts/bench-replay.mjs`; `docs/EFFICIENCY.md`; `docs/reviews/2026-11-22-v8-release-plan-inputs/replay-bench.json` | S |
| 18a | Replays of a model's run that hold up: the export drops detours (actions a later action undid, keys that changed nothing) and marks a check it derived from an incidental change as soft (reported, not stopping), or `run_steps` paces steps by `offsets_ms` | should | partial: derived `changed` checks are soft (`soft_unmet` in the reply); with it the Blender pair ran again on a quiet desktop and its replay reached the end state (24 of 24 steps, 13.8 s against the model's 55.7 s); pacing and detour pruning not started | The Blender replay above: an Escape whose recorded change (most likely a hover tooltip it dismissed) does not happen at replay speed stopped the batch; the export kept 33 steps for a task of about 10 | `src/session/step-journal.ts` (`exportSteps`); `src/session.ts` (`run_steps`) | S-M; the soft half done the same evening (pacing and detour pruning not started) |
| 19 | The release itself: CHANGELOG relabelled (7.8.0 released, 7.8.1 folded into 8.0.0), counts, tag, staged publish of the main and six platform packages, `npx` start on three systems | **must** | publishing works; labels wrong | Housekeeping rows 1-4 | `CHANGELOG.md`, `mcp-server.toml`, `.github/workflows/ci.yml:564-605` | XS |
| 20 | Windows OCR (`Windows.Media.Ocr`): `read_window_text`, `click_text`, `wait_for_text` on Windows, and with them guide `text`, replay `text` expects and the browser sign-in check | should | not started | Gaps review P2-12 and A11; without it three of v8's features are macOS-only in part | `src/tool-catalog.ts:267-270` (darwin only) | M-L |
| 21 | `confirm_action` and label confirmations (Send, Buy, Pay, Delete) | should | not started | Stopping at the irreversible step is the third most-loved feature; over-confirming is also a complaint (gaps review A6, Codex #7740). The sign-in hand-off covers typing, not a click on Pay | `src/session/legacy-policy.ts`, `src/approval-ledger.ts` | M |
| 21a | Secret fields hidden in captures: password, one-time-code and card fields blurred in screenshots and left out of OCR, by their accessibility bounds | should | not started; accessibility results already blank the values | Claude's third-party deployments hide these fields from screenshots and page text since 2026-11-12; gaps review C6 | `src/session/screenshot-handlers.ts`, `src/session/agent-desktop-handlers.ts` (the `sensitive` facts already exist) | M |
| 22 | `observe`, element refs, and the accessibility tools in `desktop` (roadmap A1-A3) | should | not started | Precision from the accessibility tree (MacStories on Codex); refs at about 1,000 tokens a snapshot (gaps review B4); Vercel's agent-desktop (26.0k stars, MCP since 2026-11-05) is built on refs that act without the pointer | `src/tool-catalog.ts` (the profile), byte budget 47,595 / 48,000 | M |
| 23 | `mouse_drag` in `desktop` | should | not started | Blender needs it for nearly everything (Blender review, open item 2). It adds about 1.9 KB (the review measured 45,448 → about 47,400 bytes), so on today's 47,595 it crosses the 48,000 budget unless other schemas are trimmed | `src/tool-catalog.ts:178` | S |
| 24 | A minimal recorder on macOS: `record_screen {action: start \| stop, target}` to an MP4, with chapters from the step journal | should | not started | T1: the trainer records with ffmpeg (AVFoundation) outside the server. ProofShot proof bundles and buyers' demand for replayable evidence (gaps review B14, C5); cua renders trajectories to MP4, Playwright MCP and Chrome DevTools MCP record video, Screenplay and OpenScreen make narrated walkthroughs | new; the capture helper (`libexec/macos-agent-helper.swift`) | M |
| 25 | Step times in `run_steps` and `export_steps` results (`at`, `ms` per step) | **must** (for the showcase) | done in the afternoon pass, uncommitted | Chapters and captions need them | `src/session.ts` (`run_steps` records), `step-journal.ts:130` (`ExportedStep` has no time) | XS |
| 26 | Audit identity: principal, session and MCP client in each record | should | not started | 47% of CISOs can identify every agent (Okta, gaps review C1); Microsoft's Ignite previews discover local and "shadow" MCP servers and give local agents IDs | `src/session/spawn.ts:50`; the audit writer in `src/session.ts` | XS |
| 27 | Linux keep-awake (logind or ScreenSaver inhibitor) | should | not started | Gaps review P1-10 | `native/src/session_state.rs:280-282` | S |
| 28 | Replay that survives: the journal kept with the run store across restarts; `expect` on an accessibility value and on a file | could | not started | Roadmap P1-P2 | `src/session/step-journal.ts`, `src/agent-run.ts` | S |
| 28a | `export_steps` also writes a draft SKILL.md beside the batches, and stops recording on lock or sleep | could | not started | Claude, Codex and Skill Recorder turn recordings into skills; Claude stops recording on lock, sleep and account switch | `src/session/step-journal.ts` | S |
| 29 | The overlay pointer visible to captures by operator opt-in (`COMPUTER_USE_POINTER_CAPTURABLE=true`, environment only), with the "Look here" label drawn beside it; the card stays excluded | should | stills done (`screenshot {show_agent_pointer: true}`); recordings not started | T2: a recorded guide-mode lesson shows no pointer at all. The card's exclusion is a safety property (the agent must never see, or be pointed at, its own controls), so the opt-in covers the overlay pointer only, and the label has to travel with the pointer | `native/src/overlay.rs` (`NSWindowSharingNone`, `WDA_EXCLUDEFROMCAPTURE`); `src/session/screenshot-handlers.ts:542` | S |
| 29a | `agent_pointer {text}` takes `nth`, `region`, `target_window_id` and `target_title` | should | done in the parent session, uncommitted | T4: "Torus" in the outliner and the redo panel was pointed at wherever OCR read it first. T5: it could not point inside a secondary window such as Blender's File View | `src/session.ts` (`pointAtText`); `src/registry/definitions.ts` (`agent_pointer`) | XS |
| 29b | `run_steps` `expect.match` (`exact`, `contains`, `regex`), and digit-tolerant matching when a query has a digit (`click_text`, `wait_for_text`, `expect.text`) | should | done in the parent session, uncommitted | T6: OCR reads Blender's "1.000" as "1,000" and "0°" as "O°"; the trainer had worked around it with `[0O][.,]25` and a trailing `wait_for_text` | `src/session/agent-desktop-handlers.ts` (`digitTolerant`, `findText`); `src/session.ts` (`unmetExpect`) | XS |
| 29c | When a whole-window read misses, `click_text` and `wait_for_text` read again in tiles at full resolution before giving up | should | partial: a checked recording reads a band around each click; the tools still need a `region` | T7: whole-window `click_text "0.25"` failed in Blender's redo panel (run 2); with the editor's region it found "0.25 m" (run 3) | `src/session/agent-desktop-handlers.ts` (`ocrWindow`); `libexec/macos-agent-helper.swift` (OCR) | S |
| 29d | A `run_steps` step's own `expect` that held is what `export_steps` returns | should | done in the parent session, uncommitted | T8: an authored "Torus" check came back as `changed: true`, so a replay checked less than the lesson did | `src/session/step-journal.ts` (`annotate`, `exportSteps`); `src/session.ts` (`run_steps`) | XS |
| 30 | A full `doctor` (roadmap X1-X4: evidence, deep links, `auto_fix`, a live self-test, a support bundle) | could | not started | Gaps review A9-A10 | `src/session/doctor.ts` | M |
| 31 | Voice for guide mode (on-device speech in, spoken replies) | could | not started (v7.8 L2) | Voice is weak as agent control and strong in a tutor (gaps review) | — | M |
| 32 | A persistent capture stream (v7.8 L1) | could | not started | The base for a full recorder and for live share without sampling | `libexec/macos-agent-helper.swift` | M |
| 33 | App bridges inside the server for Unreal and Blender | **won't**; routing to their own MCP servers in skills and `get_tool_guide` is a should | removed from the roadmap 2026-10-25 | Blender Lab's official server (26 tools) and Unreal's MCP (experimental in 5.8, extended in the 5.9 Preview) own the app's data; the server's job is the pointer and the screen | `docs/specs/v8/roadmap.md:5-7`, `:447-448`; `skills/blender-agent` | S (routing) |
| 34 | Background mode (roadmap B1-B3) | **won't** in 8.0 | not started; spikes B-S1 to B-S3 not run | Headline feature since April 2026 (gaps review B3), but every route needs a spike and Windows hardware | `src/session/pid-delivery.ts` (macOS pid delivery only) | L |
| 35 | Drag-and-drop sessions and `drop_files` (roadmap D) | **won't** in 8.0; the D-S1 timing spike could | not started | Dragging TextEdit text into Blender's sequencer started no drag session (Blender review) | `native/src/mouse.rs`, `PID_DELIVERY_TOOLS` at `input-handlers.ts:81-83` | L |
| 36 | Hand-off to another agent (roadmap H2) | **won't** in 8.0 | not started | Several agents on one desktop, 24 reactions (gaps review A15) | `src/session/lock.ts` | M |
| 37 | Task trees beyond export and replay (roadmap P1, P3, P4: a stored tree, verified nodes, checkpoints, `for_each`) | **won't** in 8.0 | partial: export, `expect` and `frame` are P2's first half | Long workflows complete 44-49% of the time at best (OSWorld 2.0) | `src/agent-run.ts`, `src/mcp-tasks.ts` | L |
| 38 | Prompted recording (roadmap R1-R3: start on an event, idle cuts, blur secure fields) | **won't** in 8.0 | not started | Needs row 32 first | `src/session/live-watcher.ts` | L |
| 39 | Gamepad output and relative mouse motion | **won't** | not started | Every virtual-pad route needs an archived driver, a restricted capability or an Apple entitlement (gaming review) | — | L |
| 40 | Contained execution (Execution Containers, MSIX, a macOS VM recipe) | **won't** in 8.0 | not started | Gaps review P2-14 | `src/isolated-worker.ts` (Linux only) | L |
| 41 | CAPTCHA solving, scheduling, always-on screen memory | **won't** | — | Every major vendor prohibits the first; the second is the host's; users switch the third off (gaps review) | — | — |

## Status after the first implementation pass (2026-11-22, afternoon)

The musts that are code were built the same day, in the working tree of `fix/blender-direct-input` (not committed),
and pinned by `test/v8.0-pointer-and-checks.test.mjs` (19 tests, run against mock natives):

| Row | What was built | Where |
|---|---|---|
| 4 | The hand-off ends by itself: a detected sign-in window that closes or moves on to a title (and, in a browser, page text) that is no wall; `hand_off {done_when: window_gone \| text_gone, text, target_app}`. Two polls in a row must agree; a person's own pause is never ended | `src/session.ts` (`watchHandOff`, `handOffDone`, `HANDOFF_POLL_MS`) |
| 7 | `mouse_move {path, duration_ms, modifiers, hold_keys}`: a path with no button held, keys down throughout and released if stopped | `src/session/input-handlers.ts` (`#movePath`, `#travel`), `src/registry/definitions.ts` |
| 8 | `COMPUTER_USE_POINTER_MOTION=glide` (`pointerMotion` for a host): clicks, `click_text`, drags, scrolls and presses travel from where the pointer is, eased | `src/session/input-handlers.ts` (`#approach`), `src/session.ts`, `src/server.ts` |
| 15 | Untrusted labels: `untrusted` on OCR results, a second text block on accessibility reads (Linux included), a note on every screenshot and zoom | `src/session/untrusted.ts` and the four handlers |
| 17 | `doctor`: the stale-grant fix on every macOS permission; a `native_addon` check (functions this release calls, platform package version, a shadowed newer checkout build); a key error that blames an old addon instead of listing the key as valid | `src/session/doctor.ts`, `src/native.ts` (`describeLoadedAddon`), `src/session/keys.ts` |
| 17a | The advice half: on macOS 27.3 and later `doctor` names System & App Protection Override and Choose Apps; the refusal hint names both grants | `src/session/doctor.ts` (`hasAppProtectionOverride`), `src/session/contract.ts` |
| 25 | `at_ms` and `ms` on each `run_steps` step; `started_at` and `offsets_ms` from `export_steps` | `src/session.ts` |
| 29a, 29b, 29d | From the trainer's live runs (T4, T5, T6, T8), built in the parent session: `agent_pointer {text}` with `nth`, `region`, `target_window_id`, `target_title`; `expect.match` and digit-tolerant matching; a step's own `expect` kept by the export | `src/session.ts`, `src/session/step-journal.ts`, `src/session/agent-desktop-handlers.ts`; tests in `test/v8.0-record-replay.test.mjs` |

With both sessions' changes in, the full suite passed: 802 tests, 800 pass, 0 fail, 2 skipped (`npm test`, macOS 26.2),
and `eslint src` is clean.

The new parameters pushed `desktop` to 48,298 bytes; eight descriptions were shortened (same meaning) to bring it back
under. With the other session's `agent_pointer` targeting added the same afternoon it is 47,912 of 48,000, and `full` is
87,037: the budget has under 100 bytes left, so the next parameter in `desktop` needs a trim first.

Still open among the musts: **16** (a run on Windows 11 and GNOME 46), **17a**'s run on a 27.3 machine (whether an app
not chosen fails, and how, is unknown until then), and **19** (the release: tag, staged publish, `npx` on three systems). None of the new code has run on Windows
or Linux; glide and path moves have not yet been watched in Blender. Of the trainer's gaps, T1 (row 24), T2 (row 29)
and T7 (row 29c) are open shoulds.

**The pie-menu report, corrected.** A mutating call right after Ctrl+Tab seemed to close Blender 5.3's mode pie before
its own OCR. The parent session later found the pie never closed: `click_text` missed the item because OCR reads its
icon as a glyph ("• Object Mode"), so `match: "exact"` failed, and `seen` (the first 40 lines) hid the line. The fix,
in this branch: exact matching ignores symbols at either end of a line, and `text_not_found` lists `similar` lines;
live, Ctrl+Tab then `click_text "Sculpt Mode"` works. `scripts/probes/blender-pie-probe.mjs`, written while the report
stood, tested each part of the mutating path (the desktop lock and its run-loop pump, the take-over watch,
keep-awake, the card): 1 of 12 mutating calls read as closing the pie in its first run and none of 6 in the second
(`2026-11-22-v8-release-plan-inputs/blender-pie-probe.md`). None of those parts closes it; the one reading is
unexplained and most likely an OCR read of the pie, not a closed pie.

**Row 18 was measured the same day** (`scripts/bench-replay.mjs`, `docs/EFFICIENCY.md`): Calculator, model 25.1 s and
10 model calls ($0.13) against a replay of 3.0 s and none; TextEdit, 8.3 s and 3 calls ($0.02) against 0.3 s; Blender,
the model reached the end state in 79.1 s with 20 calls and 51 tool calls ($0.33), and its replay stopped at step 5 of
33 (row 18a). The Blender pair ran while another session drove a second Blender; the audit log shows the replay's five
steps went to its own window with no other input in that second, but it should be run again on a quiet desktop after
18a. The draft PR [zavora-ai/computer-use-mcp#63](https://github.com/zavora-ai/computer-use-mcp/pull/63) carries the
v8 work so CI runs it on Windows and Linux runners, which covers the unit suite there and the Linux desktop job; it is
not row 16's live run.

## Recommended scope and order

**v8.0.0 ships** the fourteen musts: what is built (rows 1, 2, 3, 5), the hand-off that ends by itself (4), pointer
paths and glide (7, 8), step times (25), untrusted screen text (15), the two `doctor` fixes (17), macOS 27.3's split
permission (17a), a run on Windows and Linux (16), a measured replay number (18), and the release mechanics (19). Of
the ten not yet done, the Windows and Linux run is M and the macOS 27.3 check needs a 27.3 machine; the rest are XS or
S. The shoulds go in by value and size if the musts land early: scroll direction (14) and audit identity (26) are
under a day each; Windows OCR (20) matters most because it makes guide `text`, replay `text` and the browser sign-in
check work beyond macOS; the macOS recorder (24) is what turns the showcase into a feature of the server rather than
of the trainer. The trainer's live runs add two shoulds that are small and decide how good the lesson video looks: a
whole-window read that retries in tiles before missing small text (29c, T7), and an opt-in that lets the overlay
pointer, and only it, appear in recordings (29, T2).

**8.1** starts with background mode, the loudest ask and the one every hosted rival now has on macOS, then takes the
rest of the roadmap's 8.0 (the full `doctor`, `observe` and refs, `confirm_action` if it slipped) and its 8.1 (drag
and drop, touch and pen on Windows and Linux, hand-off to another agent), each behind its spike. **8.2** keeps task
trees and prompted recording, on the persistent stream.

v8.0 does not change what the 2026-10-25 roadmap is for; it changes the order. The roadmap put record and replay in
8.2 and guide mode nowhere; following a tutorial in Blender showed they matter most, and they are built. It put the
full `doctor`, `observe` and `confirm_action` in 8.0; they are now shoulds or 8.1, because none is started and the
built work should not wait for them.

### Order of work

Steps 2 to 4 and the trainer fixes T4, T5, T6 and T8 were done on 2026-11-22 (see the status section above); the
first showcase dry run happened the same day (8 of 8 steps in run 3).

1. **Commit and label** (XS). With James's go-ahead, commit the 8.0 work on this branch; fix the CHANGELOG (rows 1-2 of
   the housekeeping table); update `docs/specs/v8/tasks.md` to show H1 done, P2 partial and guide mode done.
2. ~~**The quick musts**: untrusted labels (15), the `doctor` stale-grant text and version check (17), step times
   (25).~~ Done. The scroll decision (14) is still open.
3. ~~**The pointer**: path moves (7) and glide (8).~~ Built; still to watch in Blender: a Shift-held hover path, and a
   take recorded with glide on that a person can follow.
4. ~~**The hand-off ends by itself**: `done_when` (4).~~ Done, against mock natives.
5. **Windows, Linux and macOS 27.3** (M), from another session or the UTM VMs (UTM is installed; no VM exists yet):
   run row 16's list on Windows 11 and GNOME 46, fix what breaks, and write each system's result into the release
   notes. On a 27.3 beta, grant the host System & App Protection Override for one app and not another, and make
   `doctor` and the refusal say which (17a).
6. **The trainer's open gaps** (S each): retry in tiles when a whole-window read misses (29c, T7), then the overlay
   pointer opt-in for recordings with its label beside it (29, T2). Re-run the donut lesson with glide on and the
   pointer showing, and record it.
7. ~~**Measure replay**: the three tasks of row 18.~~ Measured; the table is in `docs/EFFICIENCY.md` and the README.
   Next: row 18a, then the Blender pair again on a quiet desktop, and the donut lesson's take
   (`takes/run-3/take.json`, eight steps as `export_steps` batches) as a fourth task.
8. **Shoulds by value**: Windows OCR (20), the macOS recorder (24, T1), `confirm_action` (21), secret fields hidden in
   captures (21a), `mouse_drag` in `desktop` with schema trimming (23; the budget has under 100 bytes left).
9. **Release**: counts and docs, tag `v8.0.0`, stage and approve the seven packages, start it with `npx` on all three
   systems.

### Open questions for James

1. **Glide by default?** A gliding pointer is slower (a few hundred milliseconds a click) and easier to watch. The
   proposal is off by default and on for recordings and guide mode.
2. **The recorder in 8.0 or not?** Without it the trainer records with ffmpeg or OBS, which is enough for the
   showcase. With it, a recording carries chapters from the steps and cannot capture the card.
3. ~~**The adk-computer-use runtime.**~~ Being answered on the adk-rust side: the trainer drives the plain tools through
   `McpToolset`, and the runtime is being fixed in adk-rust's own session. Nothing changes in this server.
4. **The pointer in recordings (T2).** Is an environment-only opt-in that lets the overlay pointer (never the card)
   appear in captures acceptable? It would also be visible to the agent's own screenshots while it is on.
5. **The roadmap's four questions** (private macOS APIs, who receives an agent hand-off, recording retention, label
   confirmations on by default) are still open, but none blocks 8.0.

## Housekeeping found in this pass

| # | The docs say | The code or the registry says | Confirmed |
|---|---|---|---|
| 1 | `CHANGELOG.md:92`: "v7.8.0 (unreleased)" | npm published 7.8.0 on 2026-10-26, and the six platform packages are at 7.8.0 | `npm view`, this pass |
| 2 | `CHANGELOG.md:40`: "v7.8.1 (unreleased)" as its own release | There is no 7.8.1 tag, and nothing on this branch is published. Fold it into 8.0.0, as 7.7.1 was folded into 7.7.0 | `git tag`, this pass |
| 3 | `docs/specs/v8/roadmap.md` and `tasks.md`: H1, P2 and the guide items are `todo`; task trees are 8.2; `hand_off {to, reason, done_when, timeout_ms}` with a `waiting_for_person` refusal | Built: `hand_off {message, action, wait_ms}`, refusals `sign_in_required` and `handed_off`, `export_steps`, `expect` and `frame` (the first half of P2) in 8.0. Neither spec file is modified in the working tree | `git status`, this pass |
| 4 | `mcp-server.toml:3`: `version = "7.8.0"` | The CHANGELOG heads `v8.0.0 (unreleased)` | read, this pass |
| 5 | `docs/EFFICIENCY.md:24`: the savings "are described, not measured" | Still true: no task benchmark exists for `run_steps` or replay | read, this pass |
| 6 | `AGENTS.md`: `COMPUTER_USE_PRINCIPAL_ID` and `_SESSION_ID` label audit records (gaps review row 10) | Still only stripped from scripts (`src/session/spawn.ts:50`) | grep, this pass |
| 7 | `AGENTS.md`: "The display stays awake" | Linux `hold_display_awake` still returns `false` (`native/src/session_state.rs:280-282`) | read, this pass |
| 8 | `docs/reviews/2026-10-11-end-to-end-review.md:104` lists issue #36 (per-platform packages) and PR #40 (Windows card) as open | Both are closed on GitHub, the platform packages are published, and 7.7.0 and 7.8.0 went through staged publishing. What remains of #40 is running the Windows card on Windows | `gh`, `npm view`, this pass |
