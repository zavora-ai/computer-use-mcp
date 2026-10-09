# Desktop / computer-use tools: gaps, praise, game-engine UIs, hybrids, MCP Apps
Research date 2026-10-09. Sources: official docs, GitHub issues (read via `gh`), HN, vendor blogs. "[?]" = uncertain / secondhand.
Issue counts and dates are snapshots from today. Github org for Peekaboo is now `openclaw/Peekaboo` (was steipete).

## 0. Headline findings (read this first)
1. The closest competitor is **trycua/cua "cua-driver"** (29k stars, Rust rewrite, MCP/CLI/SDK, macOS+Windows+Linux). It already does what we do (pid+window_id targeting, window-only capture, background input, AX element tokens) and goes further: one-use `capture_id`, an `effect` field (delivered/unverifiable), structured refusal codes, permission modes, trajectory recording. Its own issue tracker is the best map of what is still hard.
2. Anthropic's built-in computer use (Claude Code CLI/Desktop, research preview since 2026-03) is still **full-screen, hides other apps, one session machine-wide lock**, and users are filing exactly the requests we already solve (window-scoped screenshot, no takeover, unattended approval). Its tool API (`computer_toolset_20260801`) has batching, zoom, hold_key, wait.
3. **Nobody solves canvas / OpenGL / game input in the background.** cua says so itself: canvas apps (Blender, Unity) need foreground activation; its RFC #3531 proposes an **in-app input bridge** (Blender helper queues events on Blender's main thread) because process-routed events are discarded. That is the hybrid design our Blender/Unreal setup already points to.
4. **MCP Apps (ui://)** is real and supported in Claude (web, Desktop), VS Code Copilot, ChatGPT, Cursor, Goose etc., but **not in Claude Code** (open request #95149). A local stdio server can render an app in Claude Desktop. A live screenshot/approve panel is feasible there, with caveats (section 6).

## 1. Per-tool survey
Format: capture / element access / click targeting / background+focus / HiDPI+multi-mon / waiting / safety / cost / complaints.

### Anthropic computer use (API tool + Claude Code CLI + Desktop/Cowork)
- Docs: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool , https://code.claude.com/docs/en/computer-use
- Capture: full-screen screenshots only; Claude Code downscales (3456x2234 Retina -> ~1372x887, "no setting to change"). API: long edge 2576px / ~3.75MP on Claude 5.5+ (1568px / 1.15MP earlier). Docs recommend 1024x768..1280x720, nothing above 1920x1080; Retina must be halved by the harness.
- Element access: none in the API tool (pure vision). Claude Code adds app-level tiers (browsers view-only, terminals/IDEs click-only, rest full). Prefers MCP > Bash > Claude in Chrome > screen control ("broadest and slowest").
- Targeting: pixel coordinates. API toolset 20260801 has 17 members: screenshot, zoom, left/right/middle/double/triple click, left_click_drag, mouse_move, left_mouse_down/up, cursor_position, scroll, type, key, hold_key (<=300 s), wait (<=300 s). Batches of actions return one result.
- Background/focus: CLI hides all non-approved apps while it works, restores after; terminal excluded from screenshots. Background mode (hidden windows, user keeps working) announced 2026-09-02, macOS 15+ [? third-party: https://aitoolsreview.co.uk/insights/claude-background-computer-use]. Windows: computer use yes, background no.
- Waiting: `wait` member, advice to add 0.5 s sleeps; "Claude sometimes assumes an action succeeded without checking".
- Safety: per-app approval per session, sentinel warnings (Terminal/Finder/System Settings), consumed global Esc abort, machine-wide lock file, injection classifiers on screenshots.
- Cost: ~1,000-1,800 input tokens per screenshot; docs suggest keep last 3 screenshots, prune every 25 turns.
- Known weak spots (docs): dropdowns, scrollbars; coordinate offset from scaling.
- Issues on anthropics/claude-code (all open unless noted):
  - Operate one app without taking over the workstation: https://github.com/anthropics/claude-code/issues/87115
  - Window-scoped screenshot (got wrong window; 3840x2160 -> 1456x819 scale error; privacy): https://github.com/anthropics/claude-code/issues/95978
  - Non-allowlisted windows minimized on both monitors: https://github.com/anthropics/claude-code/issues/69286 ; Windows dual-monitor takeover minimizes everything: #90241
  - Machine lock only released at session exit: https://github.com/anthropics/claude-code/issues/98166 ; concurrent sessions deadlock capture stream (closed): #69447
  - Pre-approve apps for unattended runs: https://github.com/anthropics/claude-code/issues/86649 ; trust apps permanently: #100433
  - macOS 26.4: every click rejected because Dock layer-20 surface hit-tests everywhere: https://github.com/anthropics/claude-code/issues/50719
  - Tool failures silently swallowed, agent carries on: https://github.com/anthropics/claude-code/issues/67477
  - Mixed-DPI Windows: non-DPI-aware process gets virtualized coords while UIA gives physical pixels, 2x wrong clicks with no error: https://github.com/anthropics/claude-code/issues/93992
  - Failed screenshots still burn tokens (closed): #67691 ; screenshots masked solid grey on Windows: #91079
  - Suggestion to adopt Cua Driver for window-scoped/background use (closed): https://github.com/anthropics/claude-code/issues/55496
  - Permission prompt names Claude Code as a version number "2.1.232": #86706 ; helper bundle not provisioned after CLI auto-update: #92696
  - Press Esc/IME: Microsoft Pinyin candidate window broken by computer use on Windows: #97444

### OpenAI CUA / Operator / Codex Computer Use
- API CUA (computer-use-preview): model returns actions, your harness executes; 38.1% OSWorld at launch per Azure catalog https://ai.azure.com/catalog/models/computer-use-preview ; `pending_safety_checks` must be acknowledged on the next call or you get a 400 (forum: https://community.openai.com/t/computer-tool-has-unacknowledged-safety-check/1147615). Operator stalled on CAPTCHAs, password fields, complex UIs (TechCrunch launch coverage). Possibly being retired [? forum thread, unverified].
- Codex Computer Use plugin (macOS, April 2026): screenshots of target windows + AX tree, **own cursor per agent**, prefers an app-specific plugin first, per-app allowlist ("always allow"), cannot touch terminals / Codex itself / admin auth / macOS security prompts, no `codex exec`, two agents cannot use the same app, Mac must stay unlocked; not in EEA/UK/CH at launch. Source: https://codex.danielvaughan.com/2026/04/17/codex-app-computer-use-macos-background-gui-automation/ [secondary]. Not open source.
- Complaints (openai/codex): plugin "unavailable" / "Failed to spawn managed Computer Use service" (#18258, #52191, #43625); Windows cannot enumerate native apps (#48660, #46436); **window capture times out on GPU apps**: Minecraft Bedrock and Notepad "FrameArrived timed out" (https://github.com/openai/codex/issues/52259), SOLIDWORKS (https://github.com/openai/codex/issues/51291).
- Unofficial: https://github.com/bcharleson/codex-cu-mcp (exposes Codex's computer-use server to other MCP clients).

### trycua/cua "cua-driver" (closest rival) https://github.com/trycua/cua
- Capture: per-window PNG (pid+window_id), plus `ax` (tree only, no Screen Recording needed), `vision`, `som` (default: AX tree + screenshot). Optional `cua-perception` extension parses a window screenshot into text/icon regions with **OmniParser (AGPL)**; region clicks must carry the same one-use `capture_id` (README https://github.com/trycua/cua/tree/main/libs/cua-driver).
- Element access: indexed AX outline; element tokens; AX action fired directly, works on occluded windows, no coordinates. Pixel click is the fallback for non-AX surfaces.
- Background: private SkyLight SPIs (`SLEventPostToPid`, `SLPSPostEventRecordTo`, `_AXObserverAddNotificationAndCheckRemote` to keep Electron AX trees alive when occluded), decoy click at (-1,-1) to satisfy Chromium's user-activation gate, focus-without-raise (yabai trick). Write-up: https://cua.ai/blog/inside-macos-window-internals
- Honest limits (its own words): canvas/game apps (Blender GHOST, Unity) accept input only from `cghidEventTap` after a `mouseMoved`, so the driver **activates the app and moves the cursor** for them; right-click on web content coerced to left-click.
- Safety: modes `standard` / `bounded` (reviewed capability manifest) / `unrestricted`; `existing-profile` Chromium grant is explicit; opt-in encrypted "Computer History" of actions (metadata only).
- Contract: every action returns `delivery.mode`, `route`, `effect` (often "unverifiable"), exact refusal codes (`background_unavailable`, `background_occluded`, `background_uipi_blocked`...). Support ledger with oracle-based E2E per OS: https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/action-support.md ("does not prove raw pixel delivery to canvases or games").
- Open issues worth stealing lessons from (all open):
  - Unverified effects shown with a green check, text-only models trust it; one session re-snapshotted after 56 of 66 actions: https://github.com/trycua/cua/issues/4723
  - Background pixel click on custom-drawn NSView reaches the app but not the view (locationInWindow stamped with screen point): https://github.com/trycua/cua/issues/4631
  - Background pixel click on a canvas is converted to AXPress at the element centre and reported as success: https://github.com/trycua/cua/issues/4350
  - Another session's `get_window_state` invalidates this session's tokens: #4722 ; old tokens accepted after label change: #4696
  - Daemon permissions depend on who started it (LaunchServices vs child of a granted process); `permissions grant` can block forever; Screen Recording pane is admin-gated on macOS 26: https://github.com/trycua/cua/issues/4802
  - ~1 s "protection window" after every action holds a global lock; 2.64 s for a two-field form; RFC to separate dispatch from supervision: https://github.com/trycua/cua/issues/4771 , #4792
  - Memory growth ~5 KiB/connection in `serve`: #4904 ; Linux a11y bus quota / Qt apps hang: #4894 ; AT-SPI never activates on X11: #4874
  - Held keys for state-polled games (Doom) missing; taps do not move the player: https://github.com/trycua/cua/issues/3757
  - `list_windows` text output is only a count, rows only in structuredContent: #4719 ; `get_window_state` query silently returns nothing: #4725
  - Schema rejected by strict validators (Gemini/Moonshot) due to anyOf/oneOf without type: #4798, #4717
  - macOS click can hit parent buttons behind a modal sheet: #4697 ; Mac Catalyst popup menu item refused as outside window: #4619
- Praise: HN Show HN thread (https://news.ycombinator.com/item?id=47936312): "one of the coolest hacks", parallel UI tests, fills the gap between supervised access and a full VM. Main objection was default-on telemetry (several users said they would refuse the product).

### Peekaboo (openclaw/Peekaboo, 5.3k stars, macOS 15+, Swift CLI + MCP + menu-bar bridge) https://github.com/openclaw/Peekaboo
- Capture: `see` / `capture` with engine switch (ScreenCaptureKit vs CoreGraphics, `PEEKABOO_CAPTURE_ENGINE`), exact-window receipts, optional VQA. Doc: https://github.com/openclaw/Peekaboo/blob/main/docs/engine.md
- Element access: AX snapshot with opaque element IDs, snapshot refs `ps1_<128-bit>` bound to the producing host.
- Targeting: element ID > label/role/app > coordinates ("last resort"). Selectors are **fail-closed** (app XOR pid; at most one of window-id/title/index).
- Background: default when target pid known; raw chords need exact-window + fresh snapshot receipt, app-only chords need explicit foreground consent; `--space-switch` only with consent; `see` never focuses by default. Big surface: click/type/press/scroll/drag/set-value/action/menu/menubar/dock/dialog/space/clipboard/audio/browser, `human-mouse-move`, visualizer.
- Retry safety: outcomes tagged `dispatched_unverified`, retry-unsafe; accepted-unit counts so partial scrolls are not replayed.
- Complaints: cold background click does not reach a passive AppKit view (#922); window IDs from `window list` rejected by click/focus (#869); capture refused "Safe ScreenCaptureKit ownership cannot be proven" although all permissions granted (#748); simulator window bounds attribution lost via bridge (#881); idle MCP burns ~0.5 s CPU per app launch/quit (#1005). **SCK finding relevant to us:** a second process's SCK request hung after another process (the daemon) had used SCK, so Peekaboo added a per-user owner lease. See engine.md. Permissions split between app, daemon, CLI caller (docs/permissions.md).
- Idea noted in tracker: let agents *point* at UI for the human (arrow visualizer), #1008.

### mediar-ai/mcp-server-macos-use (357 stars) and mediar-ai/terminator (1.6k)
- macos-use: 5 tools (`open_application_and_traverse`, `click_and_traverse`, `type_and_traverse`, `press_key_and_traverse`, `refresh_traversal`), every action returns the new AX tree. Physical x/y clicks. Issues: click does not validate pid so it hits whatever app is frontmost (#12, a real safety bug); "InputGuard" overlay stuck after client disconnect (#7); server compiles Swift on every launch and blows the 30 s MCP connect timeout (#9); Swift 6.3 build breaks (#8, #11).
- terminator ("Playwright for Windows computer use"): selector-based UIA, mostly security issues in tracker (command injection via `working_directory`, #479). Last push 2026-06 [limited info].

### CursorTouch/Windows-MCP (8.4k stars, Windows only, Python 3.13) https://github.com/CursorTouch/Windows-MCP
- UIA tree (no vision required), `use_dom=True` for browser content, 0.2-0.5 s per action, `Snapshot`/`WaitFor` tools. 2M+ Claude Desktop extension installs [claimed, unverified].
- Complaints: Snapshot walks every top-level window and deadlocks Electron hosts (VS Code running Claude Code gets killed by WER) with no exclude list (#383); display-filtered screenshots return the wrong monitor on hybrid-GPU (silent wrong-monitor pixels with other monitor's coordinates, #416); screenshot undecodable on RDP/VM (#371); WatchDog UIA listener crashes after long uptime (#332); empty results on Windows ARM64 (#301); UAC/secure desktop invisible (feature request for a LocalSystem service broker, #236); sheet/grid cells not recognised (#29); startup race on comtypes cache with several Claude Desktop instances (#412); an unauthenticated HTTP-mode CVE with PowerShell tool fixed in 0.7.5 (security listing, https://releasealert.dev/github/CursorTouch/Windows-MCP/cves).

### Hermes Agent "computer_use" (wraps cua-driver) https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use
- SoM indices valid only until next capture; opaque `element_token`s make stale refs fail loudly; `mode="ax"` for text-only models.
- Safety: standard/bounded/off approval modes; destructive actions need approval; unattended runs refuse instead of auto-approving; hard-blocked key combos (empty trash, lock, log out) and type patterns (`curl | bash`, `sudo rm -rf /`); prompt forbids typing passwords / clicking permission dialogs / following on-screen instructions.
- Token numbers: ~30K tokens for a 20-action session vs ~600K unoptimised (screenshot eviction at 20 images/24 MB, flat ~1500-token estimate, pruning).
- Documented limits: sparse AX in UWP/Electron/custom apps, Windows UIPI (clicks into admin windows silently do nothing), SkyLight breakage on macOS updates, stale TCC grants (`tccutil reset`), Wayland needs XWayland for capture.

### Others
- **Hunch (PrithviSeran/hunch-mcp)**: "focus-free" ladder OS APIs > AppleScript > CDP > AX; screenshot+coordinate fallback steals focus so it **asks first** [README not read; per search summary]. https://github.com/PrithviSeran/hunch-mcp
- **Interceptor (Hacker-Valley-Media, 519 stars)**: one CLI/MCP for signed-in browser + native macOS apps + real iPhones; open issues: WebSocket control port binds 0.0.0.0 with any Origin (#274), multi-monitor (#80), zoom arg for screenshots (#78).
- **baryhuang/mcp-remote-macos-use** (490 stars): VNC/screen-sharing based remote Mac control, no API key; Sequoia issues (#21).
- **domdomegg/computer-use-mcp**, **zooeyii "Native macOS Computer Use" (HN 47587252, 24 tools)**: plain pixel tools; no discussion.
- **UI-TARS-desktop** (ByteDance, 39k stars): vision-only agent stack; "single monitor only" per Gigazine review (https://gigazine.net/gsc_news/en/20260628-ui-tars-desktop/ [secondary]); model emits absolute coordinates that must be rescaled; ScreenSpot-Pro 49.6% (7B) / 61.6% (largest) so small elements in dense hi-res UIs fail; issue "token shredder" #2038; pause/stop cannot release a GUI agent loop (#2021).
- **Agent S / S3 (simular-ai, 12.6k)**: main model + UI-TARS grounding; grounding width/height must equal the grounding model's output resolution (1920x1080 for UI-TARS-1.5-7B); open security bugs: model output reaches `eval()`/`exec`/`os.system` (#196, #199, #201); "coordinate offset" (#175). OSWorld 72.6% claimed [README]. Preprint cited: only ~33% of macOS apps have full accessibility support (https://arxiv.org/abs/2507.16704 [? as quoted by search summary]).
- **OmniParser (Microsoft, 25k)**: YOLO icon detector + Florence-2 captions; 0.6 s/frame A100, 0.8 s on a 4090 (model card); needs CUDA in practice; licensing question for commercial use (#365); Chinese OCR errors (#341). cua ships it only as an AGPL extension.
- **Open Interpreter OS mode**: v0.4 `--os` used Anthropic computer use; repo now described as a coding agent for open models, so OS mode status is unclear [?].
- **screenpipe** (21.9k): not control; screen history via AX-first then OCR fallback, SQLite FTS, REST on :3030, MCP search tools. Useful model for "AX first, OCR fallback" read path.
- **Desktop Commander (10k)**: terminal/filesystem only; commonly paired with GUI servers, no GUI.
- **Playwright MCP (38k) / browser-use (117k)**: aria-snapshot refs, no pixels. Contrast: snapshots in context cost 114K vs 27K tokens for CLI per one benchmark, disputed (Checkly 48-50K vs 45-48K); newer versions write snapshots to disk and return a link (https://www.checklyhq.com/blog/mcp-vs-cli-token-efficiency/). Lesson: return file paths/thumbnails, not blobs.
- **Chrome DevTools MCP**: Chrome steals focus on every CDP command on macOS (#1254); Orca: agent browser commands steal keyboard focus (#20595).

## 2. Top 15 recurring gaps (ranked by how many tools/trackers show them; my tally, qualitative)
1. **Focus / cursor / keyboard takeover; no real background mode.** Claude Code #87115, chrome-devtools-mcp #1254, Orca #20595, Unity MCP focus nudge pulling the wrong editor to the front (https://github.com/CoplayDev/unity-mcp/issues/1407), HN Show HN premise. Codex solves it with a second cursor; cua with SPIs.
2. **Full-screen capture instead of window capture; occluded or wrong window; other windows hidden/minimized.** CC #95978, #69286, #90241, #71929; cua/Peekaboo exist because of it.
3. **Permission/TCC identity friction** (who holds the grant: app vs daemon vs terminal; restart needed after Screen Recording; admin-gated pane). cua #4802, Peekaboo permissions doc and #748, CC #86706/#92696, Claude Code docs troubleshooting.
4. **Coordinate-space errors: HiDPI, mixed DPI, multi-monitor, hybrid GPU.** CC #93992 (2x wrong clicks, no error), #95978, Windows-MCP #416, UI-TARS single-monitor, Agent S grounding-resolution mismatch, Anthropic doc Retina halving.
5. **Silent false success / unverifiable effects.** cua #4723, #4350, #4631, Peekaboo `dispatched_unverified` (#922), CC #67477, Anthropic doc "assumes success". The fix both leaders converge on: return `effect` + `route` + never a green check for unverified.
6. **Stale or cross-session element references.** cua #4722, #4696, #4376; Peekaboo #869; mitigations: opaque tokens + generation + one-use capture ids.
7. **Sparse/empty accessibility trees** (Electron/Chromium need force-accessibility, Qt, UWP, custom-drawn, canvas). cua #4768, #4726, #4874; Hermes docs; Windows-MCP #29; ~33% macOS apps fully accessible [?].
8. **Canvas / OpenGL / game input not deliverable in background** (see section 4).
9. **Latency and settle/sync primitives.** cua's ~1 s protection window (#4771/#4792), Anthropic "slowest option", fixed sleeps in Anthropic docs, no universal "wait until UI idle / window appears / pixels stable" (only Windows-MCP `WaitFor` and our `wait_for_window` found).
10. **Token and image cost.** 1-1.8K tokens/screenshot; 20-image limit; Hermes 30K vs 600K; Playwright MCP snapshots; failed screenshots still billed (CC #67691); strict JSON-schema validators reject loose tool schemas (cua #4798/#4717).
11. **Single-session / single-agent locks and concurrency.** CC lock until session exit (#98166), Codex one agent per app, cua session tokens (#4722), Peekaboo SCK single-owner hang.
12. **Unattended approval and safety model.** CC #86649/#100433, Hermes refuses when no approver, Codex cannot approve OS prompts, UAC/secure desktop (Windows-MCP #236), password fields; injection from screenshots; Agent S code-exec bugs; Windows-MCP unauth HTTP CVE; Interceptor binds 0.0.0.0 (#274); macos-use clicks hit wrong frontmost app (#12).
13. **Install/start-up friction.** macos-use compiles on launch (> 30 s timeout), Swift 6.3 build failures, Windows-MCP Python 3.13 + MSIX paths + comtypes race, Codex plugin "unavailable", CC helper not provisioned after auto-update.
14. **Daemon hygiene.** stuck overlay (macos-use #7), leak (cua #4904), orphan computer-use bridge from /remote-control (CC #91143), UIA tree walk deadlocking the host app (Windows-MCP #383), always-on-top side panel (CC #95580), TUI freeze from Spotlight query in the MCP (CC #66927).
15. **OS-owned UI is invisible or inert**: UAC/secure desktop, Dock hit-test layer (CC #50719), IME candidate windows (CC #97444), Mac Catalyst popups (cua #4619), modal sheets (cua #4697), menu-bar extras, file dialogs.
Also frequent: tool results unusable by text-only models (cua #4719), poor `--help`/exit codes, telemetry default-on backlash (HN).

## 3. Features only one or two tools have, and users praise
- **No-focus-steal background driving incl. Chromium workaround** (cua only; praised on HN). Peekaboo does semantic-only background, with explicit foreground consent.
- **Honest delivery contract**: `delivery.mode`, `route`, `effect`, exact refusal codes, per-OS E2E "oracle" matrix (cua); retry-unsafe/`dispatched_unverified` receipts (Peekaboo). Users explicitly ask for more of this (#4723).
- **Snapshot/capture receipts**: one-use `capture_id` binding a pixel click to the observation it came from (cua); producer-bound snapshot refs, exact-window receipts, fail-closed selectors (Peekaboo).
- **Per-app tiers + sentinel warnings + consumed global Esc + terminal excluded from screenshots** (Anthropic). Esc consumption so injected text cannot dismiss dialogs is a neat guard.
- **Per-agent cursor with visible overlay** (Codex; cua cosmetic overlay) so the user can see what the agent targets.
- **Plugin-first routing** (Codex, Claude Code docs): computer use only when no API/MCP exists.
- **`zoom`, `hold_key`, batch actions** (Anthropic toolset 20260801).
- **Bounded capability manifest** fixed at launch, fail-closed (cua/Hermes); hard-blocked destructive key combos.
- **Screenshot eviction + flat token estimate** (Hermes); thumbnails/paths over inline blobs (Playwright CLI).
- **Menu bar / Dock / dialog / Space / clipboard / audio tools** (Peekaboo), `invoke_menu`, `set_window_frame` (cua).
- **Trajectory recording / action history** (cua).
- **Asking before stealing focus** (Hunch).
- **DOM mode for browsers in a desktop server** (Windows-MCP `use_dom`), existing-profile Chromium attach (cua).
- **Pointing at UI for the human** (Peekaboo visualizer idea #1008).

## 4. Game engines and OpenGL/Metal self-drawn UIs (Unreal, Unity, Blender)
Evidence is thin; no public study of agents clicking Unreal/Unity editors exists [search found none].
- **Accessibility trees are empty/minimal.** Unity's accessibility hierarchy is opt-in, developer-built and main-window only (https://docs.unity3d.com/6000.5/Documentation/Manual/accessibility/screen-readers-get-started.html). Unreal UMG/Slate have some screen-reader support but the editor UI is Slate-drawn, so expect the same ~6-node trees you already see in Blender [? third-party overview]. VR test guide: Unity/Unreal render to one surface so element lookup fails (https://github.com/Shrushrita/VR-Automation-3M-Plan).
- **Synthetic background input is dropped.** cua: Blender GHOST and Unity "accept input only from cghidEventTap preceded by mouseMoved", so cua activates the app and moves the cursor (blog above). Peekaboo #922 and cua #4631 show even plain custom `NSView`s lose background clicks. cua #3757: state-polled games (Doom/SDL) ignore taps; need bounded held input.
- **Capture of GPU apps can fail on the window-capture path.** Codex on Windows: Minecraft and SOLIDWORKS `FrameArrived timed out` (openai/codex #52259, #51291). Hybrid-GPU monitor mapping: Windows-MCP #416. Worth a ScreenCaptureKit-vs-CGWindowList fallback with a timeout and a clear error.
- **What works in practice**: pixel vision plus template/OCR matching (Airtest-style) and, above all, **engine-side APIs**: Blender MCP (Python + viewport screenshots; the viewport-screenshot add-on hides overlays/gizmos for a clean image, https://github.com/ahujasid/blender-mcp issues #187/#189), Unity MCP (14.8k stars, https://github.com/CoplayDev/unity-mcp, asks for Play-mode input simulation #1408, Game-view resolution #1436, video recording #1283), Epic's Unreal MCP + commercial wrappers (StraySpark, Flopperam, mcp-unreal) which use viewport capture to *verify* tool calls rather than click UI. UnrealGPT ships a "Computer Use" tool that is stubbed out and disabled "for safety" (https://github.com/TREE-Ind/Unreal-Agent).
- **Editor modal popups block agents**: Unity MCP #1411 ("Reload scene" popup, agent thinks it is importing). Same class as our dialog/toast detection; OCR `read_window_text` + `click_text` is exactly the missing piece there.
- Gap for us to own: **an OCR-first loop for dialogs and Slate/ImGui menus** (Apple Vision text + click_text) plus window kinds; competitors rely on AX or vision-model grounding and fail on these.

## 5. Hybrids: app plugin or API plus screen control
- **cua RFC #3531 "exact target-app input bridge for custom canvases"** (open since ~Aug 2026): a Blender-side helper queues input on Blender's main thread; the production `click` tool selected objects with foreground app and pointer unchanged. Proposed framework-neutral protocol bound to process generation + OS window token, input-only (no screen-recording prompt), honest delivery reporting. Only click was productionised; key/text via a demo client. https://github.com/trycua/cua/issues/3531
- **Claude Code / Codex routing order**: MCP > Bash > browser > screen (Claude Code docs); Codex prefers app-specific plugins.
- **Hunch**: ladder AppleScript > CDP > AX > screenshot, fails over to focus-stealing only with consent.
- **Interceptor**: browser (extension), native macOS and iPhones behind one MCP.
- **Peekaboo**: `browser-mcp`, menus/dialogs via AX, "Bridge host" app owning TCC permissions.
- **Unity MCP / Blender MCP / Epic Unreal MCP**: pure in-editor APIs; they fall back to OS focus hacks (Unity "focus nudge" via osascript activate to wake a throttled editor, issues #1407 and #1265: session re-registers only when the editor is focused on macOS).
- **Takeaway**: nobody combines "engine API for state + pid-targeted capture/OCR for the UI that the API does not expose" in one product. That is what your workspace already does by hand (ue-bridge + desktop-control). Surfacing it as a documented pattern (app plugin registers an "input/focus bridge" capability that desktop-control can discover) is a differentiator. Background throttling ("Use Less CPU when in Background") is the same trap Unity hit.

## 6. MCP Apps (SEP-1865, `ui://`) in 2026
- Spec: official extension id `io.modelcontextprotocol/ui`, MIME `text/html;profile=mcp-app`, spec version 2026-01-26 (https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx). Announced 2026-01-26 (https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/).
- Mechanics: tool declares `_meta.ui.resourceUri` -> host fetches `ui://` HTML, may preload before the call -> sandboxed iframe (nested iframe in Claude) -> JSON-RPC over `postMessage`. View->host: `ui/initialize`, `ui/message`, `ui/update-model-context`, `ui/request-display-mode` (inline/fullscreen/pip), `ui/notifications/size-changed`; host->view: `tool-input`, `tool-input-partial`, `tool-result`, `host-context-changed`. UI may call server tools (`callServerTool`); tools with `visibility: ["app"]` are hidden from the model (good for refresh/approve buttons). `_meta.ui.csp` (connect/resource/frame domains) and `permissions` (camera, microphone, geolocation, clipboardWrite). Spec does not describe polling; live data = repeated tool calls or host-pushed results.
- Client matrix (https://modelcontextprotocol.io/extensions/client-matrix): Claude web, Claude Desktop, VS Code GitHub Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam, **ChatGPT**, **Cursor**, Archestra, PostHog Code. Note: VS Code was Insiders-only at launch, later in the matrix; ChatGPT limits reported (no tool calls from UI at launch) [? third-party guide, may be outdated].
- **Claude Code (CLI): not supported.** Official quickstart says Claude Code shows the text result; feature request https://github.com/anthropics/claude-code/issues/95149 (open, 0 comments, 2026-09-17). Its suggested workaround: return an **image content block** next to the text, which Claude Code does render (non-interactive). **Claude Desktop "Code" tab**: no source confirms rendering [?]; Cowork reportedly renders via render-ui [? PostHog PR #111505].
- **Local stdio works in Claude Desktop**: add to `claude_desktop_config.json`, Claude asks "Allow / Always allow" before showing the app (https://claude.com/docs/connectors/building/mcp-apps/getting-started). `ui.domain` (hash of server URL) is unavailable for stdio. Results over ~150,000 chars are written to a sandbox file and the app never hydrates (claude.ai/Desktop); Claude Code's own cap is 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`). Dev tools: Help > Troubleshooting > Enable Developer Mode (https://claude.com/docs/connectors/building/mcp-apps/troubleshooting). Known renderer bug: app blank in claude.ai but fine in Inspector (ext-apps #615).
- **Could desktop-control use it for a live screenshot / approve / annotate panel?** Yes in Claude Desktop (and Cursor/VS Code/ChatGPT with a remote HTTP server), not in Claude Code today. Design sketch:
  - `show_window_panel` tool with `_meta.ui.resourceUri` returning a small HTML view; app-only tools (`visibility:["app"]`) `panel_refresh`, `panel_approve`, `panel_annotate` that the iframe calls; screenshots as base64 data URLs or `resource_link` through `callServerTool` (keep < 150K chars, so downscale/JPEG).
  - Approve/deny = a real human gate outside the model: the app calls an app-only tool; the host may also require user approval for UI-initiated calls. Annotate: draw boxes/arrows in a canvas and send as `ui/update-model-context` or `ui/message` (an affordance Peekaboo's tracker #1008 wants).
  - Live view: host pushes `tool-result` only on tool completion; for continuous frames the view must poll an app-only tool (spec has no streaming), so budget ~1-2 fps and mind the nested-iframe CSP (`connect-src 'none'` by default, so keep it all via `callServerTool`).
  - Must keep working without it: advertise check on `io.modelcontextprotocol/ui` (Claude Code does not advertise it), fall back to an image content block + the existing console/approval path. Image block is the only visual that Claude Code renders today.
  - Risk: screenshots may contain secrets, and the iframe is third-party-sandboxed but the host proxies tool calls, so apply the same masking you use for model screenshots. The security model forbids reaching the parent DOM; nothing in the spec lets the panel move the real cursor.
- Spec churn: a 2026-07-28 spec revision reportedly removes the `initialize` handshake / session id (stateless) [? secondary: https://ecorpit.com/mcp-apps-server-rendered-ui-extension-build-guide-2026/]; the client matrix now talks about `server/discover` and per-request `_meta` capabilities, consistent with that. Re-check SDK `@modelcontextprotocol/ext-apps` versions before building.

## 7. What this suggests for our server (short, mapped to current features)
Already ahead of Anthropic's built-in tool: window-targeted + covered-window capture, pid-targeted input, OCR `click_text`, `wait_for_window`, window kinds, user-active guard, agent run console. Cheapest, highest-value additions seen in the field:
1. **Result honesty contract**: every action returns `delivery` (background/foreground/hid), `route` (ax/pid-event/hid), `effect` (verified/unverifiable/no-change) and a neutral summary line when unverified; refuse with typed codes instead of silently degrading (cua #4723/#4350, Peekaboo receipts). Text content must carry window rows, not just counts (cua #4719).
2. **Capture-bound coordinates**: one-use `capture_id` (or generation) so a pixel click is tied to the screenshot it came from; opaque element tokens that fail loudly when stale (cua, Hermes).
3. **Settle/sync primitives beyond windows**: `wait_for_text` (Vision OCR), `wait_for_stable` (frame diff below N% for M ms), `wait_for_dialog`; avoid cua's blanket 1 s post-action lock.
4. **Capture robustness for GPU apps**: timeout + automatic fallback between SCK and CGWindowList, a clear error (Codex FrameArrived issues, Peekaboo SCK ownership hang: one SCK owner per user, avoid two processes).
5. **Game/canvas path**: detect "canvas" windows (empty AX) and choose HID-with-activation + restore, or a plugin bridge (section 5); add bounded `hold_key`/`mouse_down/up` (Anthropic has them; cua RFC #3757).
6. **Focus honesty**: report when an action needed foreground, restore previous frontmost app and pointer after (cua does not promise restoration for canvas apps), and offer "ask before stealing focus" (Hunch).
7. **Unattended approvals**: pre-approved app allowlist with tiers, refuse (not auto-approve) when no approver; hard-block lists for destructive key combos and pipe-to-shell typing; consumed global Esc (Anthropic, Hermes).
8. **Token hygiene**: file-path/thumbnail returns, `zoom`/region captures, eviction guidance; keep JSON schemas strict-validator friendly (explicit `type` on every enum/anyOf branch; cua #4798/#4717).
9. **Install hygiene**: ship a prebuilt signed binary (macos-use #9), TCC identity that does not depend on the launcher (cua #4802), explicit permission status tool.
10. **MCP Apps panel** as an optional extra for Claude Desktop/Cursor/VS Code, with image-block fallback for Claude Code; track #95149.

## 8. Not found / could not verify
- No pywinauto/uiautomation-specific MCP servers surfaced in searches beyond Windows-MCP and terminator; not surveyed.
- No public data on Unreal/Unity editor computer-use performance; only indirect evidence (section 4).
- OpenAI's own CUA docs not fetched (only Azure catalog and forums); CUA latency numbers not found. Codex Computer Use is closed source, details are secondary.
- Open Interpreter OS mode current status unclear. Agent S "33%" accessibility figure comes via a search summary of an arXiv preprint.
- Peekaboo/macos-use latency numbers not published; cua says background events 5-20 ms via SkyLight vs direct HID (via Hermes docs).
- Dates of Anthropic background mode (2026-09-02) and macOS 15 requirement are third-party.
