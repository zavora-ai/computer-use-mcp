# User demand signals for open-source and developer computer-use tools (desktop and browser), as of 2026-10-25

Method, so the counts can be weighed. Everything was collected on 2026-10-25.
- **GitHub (primary).** The GraphQL API, through `gh`, returned repo metadata and the top issues per repo, sorted by reactions and by comments, for open and for all issues. `r=` is total reactions and `c=` is comment count at collection time. Dates are issue creation dates unless marked "closed".
- **Bug-class shares.** I pulled every issue title for 12 desktop repos and 7 browser repos, plus every issue titled "computer use" in openai/codex, anthropics/claude-code, NousResearch/hermes-agent and openclaw/openclaw. A keyword regex sorted the titles into classes. This is coarse: classes overlap and the regex has false positives (for example "token" also matches OAuth tokens). Treat the shares as relative signal, not measurement.
- **Hacker News.** Algolia API: stories since 2025-01-01, plus the top-level comments of eight threads.
- **Reddit.** reddit.com returned 403. The PullPush archive worked but was rate-limited, and its index appears to stop around 2026-10-13.
- **Downloads.** api.npmjs.org and pypistats.org.
- **Star growth.** GitHub's stargazer listing returned 404 for every repo. I estimated growth by reading the star-history.com chart SVGs, so the figures are approximate (about ±5%).
- **Reaction counts are low on most desktop repos.** Many repos, cua above all, have hundreds of issues filed by maintainers or agents with 0 reactions. Reactions are a weak demand signal outside the browser tools and the big agent harnesses.

## Q1. Which open issues and feature requests have the most reactions and comments, per repo?

### Takeaway
Where reaction counts are meaningful, the biggest demand signals are about where computer use runs at all:
- **Linux desktop apps for the agent harnesses.** Codex 1,464 reactions; Claude Desktop 655; OpenClaw 95.
- **Computer use from the CLI and on Windows.** Codex 43 and 42.
- **Attaching to the person's existing, signed-in browser.** Chrome DevTools MCP 61; plus extension debugging, 77.
- **Local or bring-your-own models.** Top request in UI-TARS, Bytebot, Agent S, Stagehand and Browser Use, 7 to 19 each.

On the desktop MCP servers themselves (cua, Peekaboo, Windows-MCP, macOS servers), the most-discussed threads are reliability and packaging, not features:
- background input on Hyprland;
- settle delays;
- cancellation;
- UAC prompts;
- an MSIX/Claude Desktop extension that ships a stale version.

### Cited Findings

**Agent harnesses with built-in computer use (largest reaction counts in the field)**
- openai/codex: 931 issues titled "computer use", all created in 2026 — [search](https://github.com/openai/codex/issues?q=is%3Aissue+%22computer+use%22+in%3Atitle). Top ones:
  - [#20851](https://github.com/openai/codex/issues/20851) first-class Computer Use from the Codex CLI: r=43 c=20, 2026-05-03, open.
  - [#18258](https://github.com/openai/codex/issues/18258) "Computer Use plugin unavailable" on macOS: r=42 c=41, 2026-04-17.
  - [#19305](https://github.com/openai/codex/issues/19305) full Computer Use for Codex Desktop on Windows: r=42 c=17; closed 2026-08-05.
  - [#21700](https://github.com/openai/codex/issues/21700) Computer Use Chrome extension unavailable in the Web Store: r=37 c=33.
  - [#25178](https://github.com/openai/codex/issues/25178) Windows 10 22H2 screenshot fails when SetIsBorderRequired is called: r=32 c=89.
  - [#49458](https://github.com/openai/codex/issues/49458) Windows dot-started tasks lack Computer Use tools: r=26 c=97.
  - [#29343](https://github.com/openai/codex/issues/29343) browser and computer use refuse certain sites: r=19 c=55.
  - [#18404](https://github.com/openai/codex/issues/18404) and [#42514](https://github.com/openai/codex/issues/42514) Intel Mac unsupported: r=19 c=28 and r=17 c=26.
  - [#38455](https://github.com/openai/codex/issues/38455) desktop app spawns Computer Use workers until a V8 out-of-memory crash: r=16 c=41.
  - [#25271](https://github.com/openai/codex/issues/25271) cannot determine the Chrome URL on Windows: r=12 c=64.
  - [#35446](https://github.com/openai/codex/issues/35446) Windows 10 deadlock in FrameArrived: c=51.
- openai/codex [#11023](https://github.com/openai/codex/issues/11023) "Codex desktop app for Linux": r=1,464 c=209, 2026-02-07, closed 2026-08-11.
- anthropics/claude-code [#65697](https://github.com/anthropics/claude-code/issues/65697) official Claude Desktop build for Linux: r=655 c=55, closed 2026-06-30.
- anthropics/claude-code, 176 issues titled "computer use" — [search](https://github.com/anthropics/claude-code/issues?q=is%3Aissue+%22computer+use%22+in%3Atitle):
  - [#39558](https://github.com/anthropics/claude-code/issues/39558) Chrome extension steals focus and hijacks keyboard input: r=19 c=14.
  - [#38783](https://github.com/anthropics/claude-code/issues/38783) Windows: computer-use tools missing after update: c=15.
  - [#50719](https://github.com/anthropics/claude-code/issues/50719) all clicks blocked by a Dock layer-20 hit-test surface on macOS 26.4: c=13, open.
  - [#50735](https://github.com/anthropics/claude-code/issues/50735) "permission(s) not yet granted" on macOS 26.5 despite TCC grants: c=9.
  - [#54833](https://github.com/anthropics/claude-code/issues/54833) and [#82300](https://github.com/anthropics/claude-code/issues/82300) computer use in the CLI on Windows; [#103071](https://github.com/anthropics/claude-code/issues/103071) the same on Linux, 2026-10-17.
  - [#87115](https://github.com/anthropics/claude-code/issues/87115) operate one app "without taking over the user's workstation": r=2 c=2, 2026-08-16.
- openclaw/openclaw [#75](https://github.com/openclaw/openclaw/issues/75) Linux/Windows apps (macOS-only Peekaboo-era desktop control): r=95 c=116, 2026-01-01, closed 2026-08-06. Also [#178355](https://github.com/openclaw/openclaw/issues/178355), shared desktop ownership between native MCP computer use and Browser, 2026-10-20.
- NousResearch/hermes-agent (computer_use, backed by cua-driver):
  - [#18715](https://github.com/NousResearch/hermes-agent/issues/18715) remote Hermes agent with local tool execution: r=44 c=31.
  - [#6839](https://github.com/NousResearch/hermes-agent/issues/6839) lazy tool-schema loading to cut token overhead: r=21 c=32; closed 2026-09-02 (implemented).
  - [#52010](https://github.com/NousResearch/hermes-agent/issues/52010) macOS Full Disk Access revoked after every Hermes Desktop update: c=22.
  - [#108215](https://github.com/NousResearch/hermes-agent/issues/108215) macOS daemon restart wedges computer_use forever: c=8.
  - [#32766](https://github.com/NousResearch/hermes-agent/issues/32766) cua-driver backend "too fragile": c=6.
  - [#103932](https://github.com/NousResearch/hermes-agent/issues/103932) drive cua-driver on another machine.

**Desktop tools**
- trycua/cua (30.9k stars; 1,406 issues, 1,240 created in 2026; reactions mostly 0). All-time top:
  - [#118](https://github.com/trycua/cua/issues/118) "Windows support?": r=10, closed 2025-09-30, since shipped.
  - [#22](https://github.com/trycua/cua/issues/22) publish a lume VM image to a custom registry: r=5 c=12.
  - [#28](https://github.com/trycua/cua/issues/28) expand macOS VM disk: r=4, closed 2026-09-07.
  - [#1215](https://github.com/trycua/cua/issues/1215) a Claude computer-use mode in lume setup to replace "brittle presets": r=3.
  - [#183](https://github.com/trycua/cua/issues/183) uninstaller: r=3.

  Most-commented open:
  - [#353](https://github.com/trycua/cua/issues/353) no arm64 Docker image: c=13.
  - [#1808](https://github.com/trycua/cua/issues/1808) about 50% CPU when idle: c=13.
  - [#3550](https://github.com/trycua/cua/issues/3550) RFC: isolated background input on Hyprland: c=12.
  - [#3971](https://github.com/trycua/cua/issues/3971) configurable post-action observation and settle delays in MCP: c=10.
  - [#3796](https://github.com/trycua/cua/issues/3796) RFC: cooperative cancellation of an in-flight driver call: c=10.
  - [#3458](https://github.com/trycua/cua/issues/3458) Safari windows off the current Space expose 0 AXWindows: c=8.
  - [#2794](https://github.com/trycua/cua/issues/2794) RFC: bounded action composition and visual verification: c=8.
- openclaw/Peekaboo (5.4k stars, 5 open issues):
  - [#52](https://github.com/openclaw/Peekaboo/issues/52) Swift continuation leak hangs see/image/permissions on macOS Tahoe: r=8, closed 2026-05-05.
  - [#57](https://github.com/openclaw/Peekaboo/issues/57) publish releases to GitHub and Homebrew: r=6.
  - [#708](https://github.com/openclaw/Peekaboo/issues/708) root-level oneOf schemas rejected by the Anthropic API: closed 2026-09-12.
  - Open: [#922](https://github.com/openclaw/Peekaboo/issues/922) a cold background left click does not reach a passive AppKit receiver (c=4); [#1008](https://github.com/openclaw/Peekaboo/issues/1008) let agents point at UI for the human; [#1009](https://github.com/openclaw/Peekaboo/issues/1009) scoped audio capture; [#1145](https://github.com/openclaw/Peekaboo/issues/1145) `peekaboo mcp` exits when another MCP process holds the ScreenCaptureKit lease (2026-10-24).
- CursorTouch/Windows-MCP (10.3k stars):
  - [#188](https://github.com/CursorTouch/Windows-MCP/issues/188) automate Windows Server through RDP sessions: r=2 c=6, closed 2026-08-05.
  - [#24](https://github.com/CursorTouch/Windows-MCP/issues/24) State-Tool not working: c=21.
  - [#11](https://github.com/CursorTouch/Windows-MCP/issues/11) vision works on one monitor only: c=12, closed 2026-01-21.
  - [#236](https://github.com/CursorTouch/Windows-MCP/issues/236) service mode to see and handle UAC prompts: c=11, open.
  - [#82](https://github.com/CursorTouch/Windows-MCP/issues/82) incorrect click location: c=11.
  - [#77](https://github.com/CursorTouch/Windows-MCP/issues/77) choose a screen when there are several: c=10.
  - Packaging under the Claude Desktop MSIX: [#370](https://github.com/CursorTouch/Windows-MCP/issues/370), [#356](https://github.com/CursorTouch/Windows-MCP/issues/356), [#488](https://github.com/CursorTouch/Windows-MCP/issues/488). The extension directory still ships 0.7.2: [#395](https://github.com/CursorTouch/Windows-MCP/issues/395), [#401](https://github.com/CursorTouch/Windows-MCP/issues/401).
- bytedance/UI-TARS-desktop (39.4k stars; only 90 of 575 issues created in 2026):
  - [#43](https://github.com/bytedance/UI-TARS-desktop/issues/43) Ollama: r=15. [#9](https://github.com/bytedance/UI-TARS-desktop/issues/9) Linux support: r=14, open since 2025-01-22. [#295](https://github.com/bytedance/UI-TARS-desktop/issues/295) Ollama provider: r=8.
  - [#39](https://github.com/bytedance/UI-TARS-desktop/issues/39) setting to rescale the image before sending it to the model: r=5.
  - [#268](https://github.com/bytedance/UI-TARS-desktop/issues/268) Windows support for Agent TARS: c=23.
  - [#591](https://github.com/bytedance/UI-TARS-desktop/issues/591) "Missing clicks": c=20.
  - [#311](https://github.com/bytedance/UI-TARS-desktop/issues/311) Mac permissions granted but it still cannot act: c=11.
- simular-ai/Agent-S (12.7k stars):
  - [#44](https://github.com/simular-ai/Agent-S/issues/44) Ollama: r=7, closed 2026-05-13.
  - [#113](https://github.com/simular-ai/Agent-S/issues/113) package it as an MCP server, 2025-06-24; [#172](https://github.com/simular-ai/Agent-S/issues/172) fixed-interval schedules, 2026-01-16.
  - [#181](https://github.com/simular-ai/Agent-S/issues/181) "Is this still alive?", 2026-03-03. Last release v0.3.2 on 2025-12-16 — [repo](https://github.com/simular-ai/Agent-S).
- bytebot-ai/bytebot (11.1k stars, archived; last push 2025-09-12):
  - [#101](https://github.com/bytebot-ai/bytebot/issues/101) OpenRouter: r=15. [#151](https://github.com/bytebot-ai/bytebot/issues/151) LM Studio: r=4.
  - [#84](https://github.com/bytebot-ai/bytebot/issues/84) "All task failed": c=17. [#158](https://github.com/bytebot-ai/bytebot/issues/158) huge VNC delay. [#150](https://github.com/bytebot-ai/bytebot/issues/150) "It is slow". [#138](https://github.com/bytebot-ai/bytebot/issues/138) it cannot click where it wants.
- openinterpreter/openinterpreter (68.7k stars) now describes itself as a coding agent for open models — [repo](https://github.com/openinterpreter/openinterpreter). Its top issues date from 2023: [#117](https://github.com/openinterpreter/openinterpreter/issues/117) input and keyboard control (r=22) and [#152](https://github.com/openinterpreter/openinterpreter/issues/152) privacy (r=14).
- OthersideAI/self-operating-computer (10.3k stars; 6 issues in 2026; last release 2025-02-28):
  - [#3](https://github.com/OthersideAI/self-operating-computer/issues/3) Set-of-Mark prompting: r=11, closed 2024.
  - [#142](https://github.com/OthersideAI/self-operating-computer/issues/142) Wayland: r=4, open since 2024-01-19.
  - [#109](https://github.com/OthersideAI/self-operating-computer/issues/109) non-QWERTY keyboards.
- microsoft/OmniParser (25.5k stars; last push 2026-07-20). [#130](https://github.com/microsoft/OmniParser/issues/130) a 0-byte config on Hugging Face: r=12. The OmniTool Windows-VM setup dominates comments:
  - [#156](https://github.com/microsoft/OmniParser/issues/156) Windows host not responding: c=30.
  - [#155](https://github.com/microsoft/OmniParser/issues/155) Boot0002 fails to load: c=23.
  - [#258](https://github.com/microsoft/OmniParser/issues/258) unable to start the service: c=20.
  - [#187](https://github.com/microsoft/OmniParser/issues/187) too slow on an M3 Pro: c=15.
- screenpipe/screenpipe (22.1k stars): [#1139](https://github.com/screenpipe/screenpipe/issues/1139) uninstall procedure (r=10) and [#1842](https://github.com/screenpipe/screenpipe/issues/1842) remote telemetry (r=9), both closed 2026-01-22. Open: [#7679](https://github.com/screenpipe/screenpipe/issues/7679) capture stops silently while /health reports OK.
- microsoft/UFO (10.1k stars): [#2](https://github.com/microsoft/UFO/issues/2) local models (c=16); [#135](https://github.com/microsoft/UFO/issues/135) Ollama (c=15).
- farzaa/clicky (7.8k stars; created 2026-04-07, last push 2026-04-28):
  - [#21](https://github.com/farzaa/clicky/issues/21) Windows version: r=7. [#26](https://github.com/farzaa/clicky/issues/26) Windows Electron rewrite: c=18. [#63](https://github.com/farzaa/clicky/issues/63) Windows: c=9.
  - [#44](https://github.com/farzaa/clicky/issues/44) "Critical Security Issues": r=6.
  - [#27](https://github.com/farzaa/clicky/issues/27) use my own Codex or Claude key: c=6.
  - [#24](https://github.com/farzaa/clicky/issues/24) not working on multiple monitors.
- Smaller Mac, Windows and Linux MCP servers:
  - mediar-ai/mcp-server-macos-use (355 stars): [#8](https://github.com/mediar-ai/mcp-server-macos-use/issues/8) build fails under Swift 6.3.2/Xcode 26.5; [#9](https://github.com/mediar-ai/mcp-server-macos-use/issues/9) rebuilds from source on every launch, so it exceeds the 30 s client connect timeout; [#7](https://github.com/mediar-ai/mcp-server-macos-use/issues/7) the input-guard overlay stays on screen after the client disconnects mid-call.
  - CursorTouch/MacOS-MCP (225 stars): [#32](https://github.com/CursorTouch/MacOS-MCP/issues/32) unresolvable Accessibility-permission loop; [#5](https://github.com/CursorTouch/MacOS-MCP/issues/5) AX polling causes a 1-2 s system-wide freeze in Chrome; [#7](https://github.com/CursorTouch/MacOS-MCP/issues/7) AX observer leak of 10-17 MB/min.
  - domdomegg/computer-use-mcp (387 stars): [#31](https://github.com/domdomegg/computer-use-mcp/issues/31) MCPB package not cross-platform because of native dependencies; [#16](https://github.com/domdomegg/computer-use-mcp/issues/16) linux/arm64.
  - ashwwwin/automation-mcp (413 stars; dormant since 2025-06): [#12](https://github.com/ashwwwin/automation-mcp/issues/12) AppleScript command injection (CWE-78), 2026-10-23.
  - steipete/macos-automator-mcp is archived — [repo](https://github.com/steipete/macos-automator-mcp).
  - AB498/computer-control-mcp: [#7](https://github.com/AB498/computer-control-mcp/issues/7) black capture of GPU-accelerated windows; [#5](https://github.com/AB498/computer-control-mcp/issues/5) add a wait tool.
  - agent-sh/computer-use-linux (739 stars, created 2026-05-13): [#125](https://github.com/agent-sh/computer-use-linux/issues/125) Wayland click lands about 25 px off (c=7); [#272](https://github.com/agent-sh/computer-use-linux/issues/272) X11 type_text silently corrupts keysyms (c=6); [#31](https://github.com/agent-sh/computer-use-linux/issues/31) GTK 4 apps return an empty tree; [#118](https://github.com/agent-sh/computer-use-linux/issues/118) completion or hand-off sound/notification.
- aaif-goose/goose (formerly block/goose) computer controller: [#5348](https://github.com/aaif-goose/goose/issues/5348) extension errors after enabling (c=13); [#4425](https://github.com/aaif-goose/goose/issues/4425) unable to screenshot apps; [#7385](https://github.com/aaif-goose/goose/issues/7385) Linux automation dependency warning.

**Browser tools**
- ChromeDevTools/chrome-devtools-mcp (54.1k stars):
  - [#96](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/96) browser extension development and debugging: r=77 c=24; closed 2026-04-21.
  - [#140](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/140) automatic connection to an existing Chrome session: r=61 c=29; closed 2025-12-11.
  - [#131](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/131) WSL: r=30 c=55.
  - [#1254](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1254) macOS: Chrome steals window focus on every CDP command: r=27 c=15; closed 2026-05-07.
  - [#825](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/825) persist the remote-debugging approval: r=27 c=19.
  - [#926](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/926) multi-session parallel browsers: r=24.
  - [#239](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/239) allowed and blocked origins: r=23; closed 2026-06-16.
  - Open: [#1921](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1921) hangs or crashes with many tabs (r=14 c=18); [#694](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/694) multiple profiles (r=8); [#3070](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/3070) multiple sessions and instances (c=10); [#2199](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2199) password dialogs block dispatched input.
- microsoft/playwright-mcp (38.6k stars, 2 open issues):
  - [#424](https://github.com/microsoft/playwright-mcp/issues/424) evaluate/run scripts: r=25. [#442](https://github.com/microsoft/playwright-mcp/issues/442) custom tools: r=18.
  - [#148](https://github.com/microsoft/playwright-mcp/issues/148) "controlled by automated test software" banner: r=16.
  - [#123](https://github.com/microsoft/playwright-mcp/issues/123) capture codegen from the prompt-driven flow: r=16.
  - [#395](https://github.com/microsoft/playwright-mcp/issues/395) snapshot too long, paginate it: r=14. [#889](https://github.com/microsoft/playwright-mcp/issues/889) limit each tool's output size: r=13 c=15.
  - [#994](https://github.com/microsoft/playwright-mcp/issues/994) Electron support: r=13.
  - [#1211](https://github.com/microsoft/playwright-mcp/issues/1211) a corrupted screenshot causes a permanent API 400: c=30.
  - [#734](https://github.com/microsoft/playwright-mcp/issues/734) record human actions into a trace: r=6.
  - Since 2026, MCP issues are filed in microsoft/playwright, for example [#42973](https://github.com/microsoft/playwright/issues/42973) (2026-09-28): background extension mode so several agents share the logged-in browser without taking the screen.
- browser-use/browser-use (119k stars). All-time:
  - [#947](https://github.com/browser-use/browser-use/issues/947) human-like browsing: r=20.
  - [#2605](https://github.com/browser-use/browser-use/issues/2605) gpt-oss on Ollama: r=19.
  - [#221](https://github.com/browser-use/browser-use/issues/221) human-in-the-loop: r=18 c=24; closed 2025-09-07.
  - [#1520](https://github.com/browser-use/browser-use/issues/1520) Chrome 136+ blocks CDP on the default profile: c=36.

  Open, 2026:
  - [#4798](https://github.com/browser-use/browser-use/issues/4798) agent.pause() inside tool calls: c=17.
  - [#4742](https://github.com/browser-use/browser-use/issues/4742) a screenshot blob poisons the context, then every later turn returns API 400: c=15.
  - [#4634](https://github.com/browser-use/browser-use/issues/4634) scoped delegation (governance between the model and real clicks): c=13.
  - [#5137](https://github.com/browser-use/browser-use/issues/5137) structured action evidence for no-op and changed actions: c=13.
  - [#5841](https://github.com/browser-use/browser-use/issues/5841) persistent verified memory of websites: c=12.
  - [#6031](https://github.com/browser-use/browser-use/issues/6031) known-answer false-success regressions: c=10.
  - [#4824](https://github.com/browser-use/browser-use/issues/4824) strict `==` dependency pins: r=5 c=10.
- browserbase/stagehand (25.8k stars):
  - [#183](https://github.com/browserbase/stagehand/issues/183) Ollama: r=19, closed.
  - [#507](https://github.com/browserbase/stagehand/issues/507) attach to an existing Playwright page: r=18.
  - [#1645](https://github.com/browserbase/stagehand/issues/1645) Vercel AI SDK v3: r=16, open.
  - [#389](https://github.com/browserbase/stagehand/issues/389) return the plan for extraction: r=16 c=13.
  - [#1880](https://github.com/browserbase/stagehand/issues/1880) semantic verification layer for actions.
  - [#2148](https://github.com/browserbase/stagehand/issues/2148) headed browse CLI steals focus on every command.
- Skyvern-AI/skyvern (23.3k stars; low reactions): [#991](https://github.com/Skyvern-AI/skyvern/issues/991) OpenRouter (r=8). Recurring quickstart failures: [#3915](https://github.com/Skyvern-AI/skyvern/issues/3915), [#5756](https://github.com/Skyvern-AI/skyvern/issues/5756). [#6226](https://github.com/Skyvern-AI/skyvern/issues/6226) expose token usage.
- nanobrowser/nanobrowser (14.2k stars): [#37](https://github.com/nanobrowser/nanobrowser/issues/37) Firefox (r=9); [#123](https://github.com/nanobrowser/nanobrowser/issues/123) MCP client (c=12); [#147](https://github.com/nanobrowser/nanobrowser/issues/147) replay of tasks (r=3); [#173](https://github.com/nanobrowser/nanobrowser/issues/173) knowledge store.

### Inferences
- The highest-reacted computer-use requests in 2026 are about reach: Linux, Windows, the CLI, Intel Macs and the person's existing browser. Precision features rank lower. Hosts users love, such as Codex and Claude Code, gate computer use to one OS or one surface, and that gap is where a cross-platform MCP server is most visibly wanted.
- On the desktop MCP servers, reactions are near zero. The demand shows up as long comment threads on reliability: settle timing, cancellation, the ScreenCaptureKit lease, AX freezes, MSIX paths.
- Several big 2024-25 projects are archived or have stalled, and their open top requests (local models, Linux, Windows) stay unanswered: Bytebot is archived; Self-Operating Computer, OmniParser/OmniTool and UI-TARS-desktop have little activity; Open Interpreter repositioned away from OS mode.

### Gaps
- GitHub Discussions were not ranked. GraphQL search has no reliable upvote sort for them.
- Goose's computer controller, Open Interpreter OS mode and the e2b open-computer-use repo were covered only lightly; their issue volume on computer use is small.
- Microsoft Windows-native agents (UFO2/UFO³) were not read beyond their top issues.

## Q2. Which bug classes recur across tools?

### Takeaway
Ranked by volume across repos:
1. Windows parity and capture failures. This is the largest class by far: 48% of Codex computer-use issue titles mention Windows.
2. Installation and packaging.
3. Click and input reliability.
4. Screenshot capture.
5. Hangs, CPU and memory.

macOS permission breakage after OS updates is concentrated in the Claude Code (10% of its computer-use titles), Peekaboo (8%) and Hermes threads, especially around macOS 26.4/26.5 Tahoe.

The classes the brief named fall into three groups:
- Recur in every tool but at low volume: focus stealing, multi-monitor, DPI and coordinate scaling, apps with no accessibility tree.
- Dominate the newest Linux-first project: Wayland, 20% of computer-use-linux titles.
- Dominate browser tools and the HN conversation rather than desktop issue trackers: token cost.

### Cited Findings

**Share of issue titles per class (keyword classification; coarse)**

| Class | cua (1,406) | Windows-MCP (182) | Peekaboo (143) | computer-use-linux (151) | Codex CU (931) | Claude Code CU (176) | Hermes CU (149) |
|---|---|---|---|---|---|---|---|
| Mentions Windows | 12.7% | 22.0% | 1.4% | 0% | 48.2% | 18.2% | 19.5% |
| Install / build / packaging | 14.7% | 18.7% | 5.6% | 37.7% | 13.6% | 11.9% | 9.4% |
| Clicks / typing / input | 11.5% | 11.0% | 9.1% | 13.2% | 8.2% | 8.5% | 12.8% |
| Screenshot / capture | 6.8% | 8.2% | 20.3% | 6.0% | 10.7% | 10.2% | 17.4% |
| Hang / slow / CPU / memory | 3.9% | 7.1% | 7.0% | — | 8.2% | 10.8% | 3.4% |
| macOS permissions / TCC | 2.8% | 0.5% | 7.7% | 0% | 2.5% | 9.7% | 4.0% |
| Wayland / X11 / compositor | 6.5% | 0% | 0% | 19.9% | 0.1% | 0% | 7.4% |
| No-AX apps / element trees | 6.5% | 8.8% | 1.4% | 4.0% | 2.5% | 1.1% | 12.1% |
| Focus / takeover / cursor | 2.9% | 1.1% | 2.8% | 3.3% | 1.6% | 5.1% | 3.4% |
| DPI / scaling / coordinates | 2.2% | 5.5% | 4.9% | 3.3% | 1.2% | 2.8% | 1.3% |
| Multi-monitor | 0.6% | 0.5% | 0.7% | 0% | 0.4% | 2.3% | 0.7% |
| Tokens / cost / image size | 1.9% | 0% | 1.4%* | 0% | 0.4% | 1.7% | 1.3% |

Sources: issue lists of [trycua/cua](https://github.com/trycua/cua/issues), [Windows-MCP](https://github.com/CursorTouch/Windows-MCP/issues), [Peekaboo](https://github.com/openclaw/Peekaboo/issues), [computer-use-linux](https://github.com/agent-sh/computer-use-linux/issues), and the "computer use" title searches in [codex](https://github.com/openai/codex/issues?q=is%3Aissue+%22computer+use%22+in%3Atitle), [claude-code](https://github.com/anthropics/claude-code/issues?q=is%3Aissue+%22computer+use%22+in%3Atitle) and [hermes-agent](https://github.com/NousResearch/hermes-agent/issues?q=is%3Aissue+computer_use+in%3Atitle). *Peekaboo's token hits are OAuth tokens, a false positive.

Browser tools on the same method:
- browser-use (1,725 issues): local models and providers 7.5%; install 5.5%; hangs 4.3%; security 2.8%; token cost 1.7% — [issues](https://github.com/browser-use/browser-use/issues).
- Chrome DevTools MCP (694): install 8.1%; hangs 7.8% — [issues](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues).
- Playwright MCP (916): install 9.2%; hangs 4.1%; capture 3.1%; token limits 2.2% — [issues](https://github.com/microsoft/playwright-mcp/issues).

**macOS permission setup and macOS 26 regressions**
- Claude Code computer-use MCP crashed on macOS Tahoe 26 at checkAccessibility/registerEscape — [#42404](https://github.com/anthropics/claude-code/issues/42404) (c=7), [#41278](https://github.com/anthropics/claude-code/issues/41278) (c=8), [#41188](https://github.com/anthropics/claude-code/issues/41188).
- On macOS 26.5 it reports permissions not granted despite TCC grants — [#50735](https://github.com/anthropics/claude-code/issues/50735).
- On macOS 26.4, a Dock layer-20 surface blocks all clicks — [#50719](https://github.com/anthropics/claude-code/issues/50719) (c=13, open).
- Hermes:
  - macOS repeatedly asks for Screen Recording when computer_use runs in some contexts — [#90647](https://github.com/NousResearch/hermes-agent/issues/90647).
  - Full Disk Access is revoked after every Hermes Desktop update — [#52010](https://github.com/NousResearch/hermes-agent/issues/52010) (c=22).
- Other macOS servers:
  - MacOS-MCP: "unresolvable Accessibility permission loop" — [#32](https://github.com/CursorTouch/MacOS-MCP/issues/32).
  - Peekaboo: permissions command hangs on Tahoe — [#52](https://github.com/openclaw/Peekaboo/issues/52) (r=8).
  - UI-TARS: permissions granted but actions still fail — [#311](https://github.com/bytedance/UI-TARS-desktop/issues/311) (c=11).
  - Codex: the helper requests microphone permission unprompted — [#18507](https://github.com/openai/codex/issues/18507) (r=4 c=11).

**Wayland and Linux input and capture**
- [#9](https://github.com/bytedance/UI-TARS-desktop/issues/9) UI-TARS Linux support: r=14, open since 2025-01. [#142](https://github.com/OthersideAI/self-operating-computer/issues/142) Self-Operating Computer Wayland: r=4, open since 2024.
- [#3550](https://github.com/trycua/cua/issues/3550) cua: isolated background input on Hyprland: c=12.
- Hermes:
  - doctor is all-green on Wayland while captures find no windows — [#130824](https://github.com/NousResearch/hermes-agent/issues/130824);
  - the X11 agent pointer can crash a whole KDE Plasma session — [#66392](https://github.com/NousResearch/hermes-agent/issues/66392);
  - a multi-monitor X11 overlay can steal all desktop input — [#81220](https://github.com/NousResearch/hermes-agent/issues/81220).
- computer-use-linux:
  - Wayland click offset of about 25 px — [#125](https://github.com/agent-sh/computer-use-linux/issues/125);
  - X11 typing corrupts keysyms — [#272](https://github.com/agent-sh/computer-use-linux/issues/272);
  - GTK 4 trees empty — [#31](https://github.com/agent-sh/computer-use-linux/issues/31).
- Codex: Linux computer use is requested in [#42846](https://github.com/openai/codex/issues/42846); a community XDG-portal KDE prototype is in [#52654](https://github.com/openai/codex/issues/52654).
- HN commenters repeatedly complain that new desktop agents are macOS-only:
  - on the Agent-desktop launch, 2026-05-02 — [thread](https://news.ycombinator.com/item?id=47982708);
  - on Understudy, 2026-03-12, one comment calling macOS overserved and Linux underserved — [thread](https://news.ycombinator.com/item?id=47353957).

**Multi-monitor and DPI or coordinate scaling**
- Windows-MCP:
  - vision worked on one monitor only — [#11](https://github.com/CursorTouch/Windows-MCP/issues/11) (c=12);
  - choose the screen — [#77](https://github.com/CursorTouch/Windows-MCP/issues/77) (c=10);
  - fails at 2560×1440+ — [#59](https://github.com/CursorTouch/Windows-MCP/issues/59);
  - physical-versus-logical pixel misalignment — [#86](https://github.com/CursorTouch/Windows-MCP/issues/86);
  - a screenshot-scale variable to stay under a 1 MB limit — [#156](https://github.com/CursorTouch/Windows-MCP/issues/156).
- cua: UIA bounds return a -32000 sentinel on a secondary monitor — [#2015](https://github.com/trycua/cua/issues/2015).
- Claude Code:
  - screenshots over 2000 px on Retina fail every session — [#50530](https://github.com/anthropics/claude-code/issues/50530);
  - the docs lack multi-monitor guidance — [#39625](https://github.com/anthropics/claude-code/issues/39625).
- Peekaboo: a tracking issue to make screenshot-to-input coordinate spaces explicit and Retina-safe — [#309](https://github.com/openclaw/Peekaboo/issues/309).
- Browser tools:
  - Chrome DevTools MCP returns images at twice the bound on HiDPI — [#2531](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2531);
  - Stagehand returns device-pixel dimensions — [#3237](https://github.com/browserbase/stagehand/issues/3237).
- Clicky does not work on multiple monitors — [#24](https://github.com/farzaa/clicky/issues/24).
- Codex's helper wakes external displays every ~10 minutes — [#43445](https://github.com/openai/codex/issues/43445).

**Focus stealing and taking over the person's mouse**
- [#1254](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1254) Chrome DevTools MCP: Chrome steals focus on every CDP command: r=27 c=15.
- [#39558](https://github.com/anthropics/claude-code/issues/39558) Claude's Chrome extension hijacks keyboard input: r=19 c=14.
- [#2148](https://github.com/browserbase/stagehand/issues/2148) Stagehand headed mode steals focus.
- [#41323](https://github.com/openai/codex/issues/41323) Codex: target-window-only capture plus background input on Windows: r=5 c=8. [#49175](https://github.com/openai/codex/issues/49175) the pointer goes invisible over a game window, 2026-10-02.
- [#87115](https://github.com/anthropics/claude-code/issues/87115) Claude Code: work in one app without taking over the workstation. [#95580](https://github.com/anthropics/claude-code/issues/95580) Windows computer use leaves the desktop window stuck always-on-top: c=8.
- A Windows computer-use server shipped a takeover indicator after a user said they were constantly fighting the agent for the pointer — [dsh-computer-use-win #28](https://github.com/Yu-tao-Li/dsh-computer-use-win/issues/28).
- The cua launch "drive any macOS app in the background without stealing the cursor" drew 192 points and 43 comments, 2026-04-28 — [HN](https://news.ycombinator.com/item?id=47936312).

**Flaky clicks and false success**
- [#591](https://github.com/bytedance/UI-TARS-desktop/issues/591) UI-TARS "Missing clicks": c=20. [#138](https://github.com/bytebot-ai/bytebot/issues/138) Bytebot cannot click where it wants. [#82](https://github.com/CursorTouch/Windows-MCP/issues/82) Windows-MCP incorrect click location: c=11.
- [#922](https://github.com/openclaw/Peekaboo/issues/922) Peekaboo background click not received by a cold AppKit app. [#50728](https://github.com/openai/codex/issues/50728) Codex typing and paste duplicated.
- False success is a filed class of its own:
  - browser-use [#6031](https://github.com/browser-use/browser-use/issues/6031) and [#5137](https://github.com/browser-use/browser-use/issues/5137);
  - Open Interpreter [#1926](https://github.com/openinterpreter/openinterpreter/issues/1926), completion reported without the work being done;
  - Stagehand v4 click returns without committing — [#2486](https://github.com/browserbase/stagehand/issues/2486).

**Screenshot token cost and latency**
- HN, "Computer Use is 45x more expensive than structured APIs": 495 points, 271 comments, 2026-05-05 — [HN](https://news.ycombinator.com/item?id=48024859), [post](https://reflex.dev/blog/computer-use-is-45x-more-expensive-than-structured-apis/). Top comments say token count blocks mass adoption, and suggest caching window handles or learned UI maps instead of re-reading pixels.
- Claude Desktop injects the computer-use MCP, 27 tools plus about 1.4K tokens of instructions — [#68022](https://github.com/anthropics/claude-code/issues/68022). Hermes lazy schema loading got r=21 c=32 — [#6839](https://github.com/NousResearch/hermes-agent/issues/6839).
- Browser MCP output size:
  - Playwright MCP [#395](https://github.com/microsoft/playwright-mcp/issues/395) (r=14), [#889](https://github.com/microsoft/playwright-mcp/issues/889) (r=13 c=15), [#806](https://github.com/microsoft/playwright-mcp/issues/806) (r=9);
  - a screenshot poisons the context into permanent 400s: browser-use [#4742](https://github.com/browser-use/browser-use/issues/4742) and Playwright MCP [#1211](https://github.com/microsoft/playwright-mcp/issues/1211) (c=30).
- Cost visibility is requested:
  - UI-TARS image rescale, [#39](https://github.com/bytedance/UI-TARS-desktop/issues/39);
  - Anthropic's demo token meter, [#116](https://github.com/anthropics/claude-quickstarts/issues/116);
  - browser-use [#804](https://github.com/browser-use/browser-use/issues/804);
  - Stagehand per-call usage, [#268](https://github.com/browserbase/stagehand/issues/268);
  - Skyvern [#6226](https://github.com/Skyvern-AI/skyvern/issues/6226).
- Hangs and resource leaks:
  - cua about 50% CPU when idle — [#1808](https://github.com/trycua/cua/issues/1808); Hermes reports the same of cua-driver — [#28152](https://github.com/NousResearch/hermes-agent/issues/28152).
  - Codex spawns Computer Use workers until it runs out of memory — [#38455](https://github.com/openai/codex/issues/38455).
  - Chrome DevTools MCP hangs with many tabs — [#1921](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1921).
  - MacOS-MCP: AX freeze, [#5](https://github.com/CursorTouch/MacOS-MCP/issues/5); leak, [#7](https://github.com/CursorTouch/MacOS-MCP/issues/7).
  - Windows-MCP: UIA watchdog crash after long uptime — [#332](https://github.com/CursorTouch/Windows-MCP/issues/332).
  - Bytebot "It is slow" — [#150](https://github.com/bytebot-ai/bytebot/issues/150); VNC delay — [#158](https://github.com/bytebot-ai/bytebot/issues/158).

**Installation and native build pain**
- Windows-MCP: Microsoft Store Python venv breakage, [#345](https://github.com/CursorTouch/Windows-MCP/issues/345); MSIX path virtualization, [#370](https://github.com/CursorTouch/Windows-MCP/issues/370) and [#488](https://github.com/CursorTouch/Windows-MCP/issues/488); ARM64, [#301](https://github.com/CursorTouch/Windows-MCP/issues/301) and [#122](https://github.com/CursorTouch/Windows-MCP/issues/122).
- Swift toolchain breaks: macos-use [#8](https://github.com/mediar-ai/mcp-server-macos-use/issues/8); Peekaboo needs swiftformat and swiftlint to build, [#294](https://github.com/openclaw/Peekaboo/issues/294).
- Native dependencies break cross-platform MCPB packaging — [domdomegg #31](https://github.com/domdomegg/computer-use-mcp/issues/31).
- OmniTool VM boot failures — [#156](https://github.com/microsoft/OmniParser/issues/156), [#155](https://github.com/microsoft/OmniParser/issues/155).
- cua has no arm64 Docker image — [#353](https://github.com/trycua/cua/issues/353).
- Browser installs:
  - Chrome not found on Windows: Playwright MCP [#13](https://github.com/microsoft/playwright-mcp/issues/13) (r=12 c=18);
  - WSL: Chrome DevTools MCP [#131](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/131) (r=30 c=55);
  - Chrome location hardcoded: [#889](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/889);
  - browser-use strict pins: [#4824](https://github.com/browser-use/browser-use/issues/4824), [#4285](https://github.com/browser-use/browser-use/issues/4285).
- Codex: Windows Defender flags the unsigned `codex-computer-use.exe` as a trojan — [#31419](https://github.com/openai/codex/issues/31419).

**Windows parity**
- Codex Windows capture:
  - SetIsBorderRequired fails on Windows 10 — [#25178](https://github.com/openai/codex/issues/25178) (r=32 c=89);
  - FrameArrived deadlock — [#35446](https://github.com/openai/codex/issues/35446) (c=51);
  - window capture times out for Notepad and Electron on Windows 10 — [#52754](https://github.com/openai/codex/issues/52754);
  - cannot read Chrome or Edge URLs — [#25271](https://github.com/openai/codex/issues/25271) (c=64), [#51524](https://github.com/openai/codex/issues/51524) (c=38).
- Windows-MCP screenshots are undecodable on VM/RDP desktops — [#371](https://github.com/CursorTouch/Windows-MCP/issues/371).
- Hermes: UIPI blocks UIA on elevated windows — [#49067](https://github.com/NousResearch/hermes-agent/issues/49067).
- Claude Code: Windows computer use breaks the CJK IME candidate window — [#69887](https://github.com/anthropics/claude-code/issues/69887).
- Clicky's Windows requests — [#21](https://github.com/farzaa/clicky/issues/21), [#26](https://github.com/farzaa/clicky/issues/26).

**Apps with no accessibility tree (Electron, games, canvas, Unity)**
- Claude computer use cannot discover the Unity Editor (LSBackgroundOnly) — [#38339](https://github.com/anthropics/claude-code/issues/38339).
- cua: Safari off-Space exposes 0 AXWindows — [#3458](https://github.com/trycua/cua/issues/3458); Electron background demos record blank — [#1942](https://github.com/trycua/cua/issues/1942).
- Windows-MCP cannot see elements in a spreadsheet — [#29](https://github.com/CursorTouch/Windows-MCP/issues/29).
- GPU-accelerated windows capture black (OBS, games, Discord) — [AB498 #7](https://github.com/AB498/computer-control-mcp/issues/7).
- Playwright MCP Electron support: r=13 — [#994](https://github.com/microsoft/playwright-mcp/issues/994).
- Hermes: AX/set-of-marks element bounds always zero — [#44763](https://github.com/NousResearch/hermes-agent/issues/44763).
- On HN, one commenter asked why tools use pixels rather than the AX tree; another wanted support for immediate-mode GUIs (egui, Dear ImGui) — [thread](https://news.ycombinator.com/item?id=47982708).

### Inferences
- **Windows.** For a cross-platform server, Windows capture robustness is the largest single source of user-filed pain in the field. Codex's Windows computer use alone generated over 400 titled issues in 2026, around WGC border consent, frame deadlocks, VM/RDP sessions and browser URL reads.
- **macOS permissions.** The pain is less about first-time setup and more about grants that silently break after OS or app updates (macOS 26.4/26.5, app re-signing). A `doctor` that detects "granted in Settings but not effective" would answer a repeated complaint.
- **Token cost.** This is the top theme in public discussion: HN, Reddit, and browser-tool issue threads. It shows up rarely in desktop-server trackers, probably because desktop users hit reliability first.

### Gaps
- No quantitative cross-tool latency data from users was found; complaints are qualitative ("slow", "VNC delay").
- The input-monitoring permission (needed by takeover detection) was not found as a user-reported pain point in any tracker searched.
- The keyword classification was not hand-validated; precision per class is unknown.

## Q3. What features do users ask for that no tool has, or that only one tool has?

### Takeaway
Six requests recur:
1. Background operation without taking over the person's machine.
2. Multi-agent or multi-session use of one desktop or browser.
3. Pause and human hand-off inside a run.
4. Honest action evidence and verification instead of false success.
5. Record-and-replay or "teach once" that compiles to something deterministic.
6. Remote or VM execution with local tools.

Several have been shipped by exactly one project, each in its own way: cua for background input, Understudy, OpenAdapt and screenpipe for learning from demonstration, Chrome DevTools MCP for multi-session. Desktop MCP servers mostly lack them. I found little or no explicit demand for undo, and only isolated demand for audit trails with the "why", scheduling, and voice.

### Cited Findings
- **Background, non-takeover operation:**
  - Claude Code [#87115](https://github.com/anthropics/claude-code/issues/87115).
  - Codex [#41323](https://github.com/openai/codex/issues/41323) (target-window-only capture, background input).
  - Playwright [#42973](https://github.com/microsoft/playwright/issues/42973) (several agents use the logged-in browser without taking the screen).
  - cua's background-driving launch: 192 points — [HN](https://news.ycombinator.com/item?id=47936312).
  - An Ex-Apple commenter on that thread valued running many UI tests at once, and criticised telemetry being on by default — [HN](https://news.ycombinator.com/item?id=47936312).
  - A voice-control user asked for an agent that never moves the real pointer, with an optional overlay — [oh-my-openagent #9887](https://github.com/code-yeongyu/oh-my-openagent/issues/9887).
- **Multi-agent and multi-session:**
  - Chrome DevTools MCP multi-session: r=24, closed 2026-02-23 (shipped) — [#926](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/926). Multiple instances still requested — [#3070](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/3070).
  - Parallel Claude Code agents interfere in Playwright MCP — [#893](https://github.com/microsoft/playwright-mcp/issues/893).
  - cua: Streamable-HTTP transport for true multi-agent parallelism, closed 2026-08-09 — [#1799](https://github.com/trycua/cua/issues/1799).
  - OpenClaw: shared desktop ownership between computer use and browser — [#178355](https://github.com/openclaw/openclaw/issues/178355).
  - Reddit r/LocalLLaMA: open-source multi-cursor background computer use with Hermes plus Qwen (15 points, 2026-04-24) — [post](https://reddit.com/r/LocalLLaMA/comments/1suux6h/open_source_multicursorbackground_computeruse).
- **Human-in-the-loop, pause and hand-off:**
  - browser-use human-in-the-loop: r=18 c=24 — [#221](https://github.com/browser-use/browser-use/issues/221); agent.pause() inside tool calls: c=17 — [#4798](https://github.com/browser-use/browser-use/issues/4798).
  - Peekaboo: point at UI for the human — [#1008](https://github.com/openclaw/Peekaboo/issues/1008).
  - computer-use-linux: completion or hand-off signal — [#118](https://github.com/agent-sh/computer-use-linux/issues/118).
  - Claude Code: cannot approve computer-use access from the mobile Remote Control — [#87340](https://github.com/anthropics/claude-code/issues/87340).
  - Hermes: mutations fail open in headless dispatch without an approval callback — [#87724](https://github.com/NousResearch/hermes-agent/issues/87724).
  - Windows-MCP: handle UAC prompts — [#236](https://github.com/CursorTouch/Windows-MCP/issues/236) (c=11).
  - Self-Operating Computer: user confirmation before command execution (2023) — [#25](https://github.com/OthersideAI/self-operating-computer/issues/25).
- **Action evidence and verification:**
  - browser-use [#5137](https://github.com/browser-use/browser-use/issues/5137) (c=13) and [#6031](https://github.com/browser-use/browser-use/issues/6031) (c=10).
  - Stagehand semantic verification layer — [#1880](https://github.com/browserbase/stagehand/issues/1880).
  - cua RFC: bounded action composition and visual verification — [#2794](https://github.com/trycua/cua/issues/2794) (c=8).
  - cua: configurable settle delays — [#3971](https://github.com/trycua/cua/issues/3971) (c=10).
  - A Reddit r/Playwright thread argues that tests must be deterministic, so an MCP agent should not improvise around a failing flow (top comment 6 points, 2026-07-28) — [post](https://reddit.com/r/Playwright/comments/1v8swyu/are_we_using_playwright_mcp_for_testing_when_its/).
- **Record and replay, teach once, deterministic export:**
  - Playwright MCP: codegen capture, r=16, closed 2025-05-05 — [#123](https://github.com/microsoft/playwright-mcp/issues/123); record human actions into a trace, r=6 — [#734](https://github.com/microsoft/playwright-mcp/issues/734); video recording, r=10 — [#695](https://github.com/microsoft/playwright-mcp/issues/695).
  - browser-use: record clicks into a tutorial, r=8 — [#271](https://github.com/browser-use/browser-use/issues/271).
  - Midscene: export AI steps as Playwright scripts, r=4 — [#2240](https://github.com/web-infra-dev/midscene/issues/2240).
  - UI-TARS: export and replay agent workflows — [#1914](https://github.com/bytedance/UI-TARS-desktop/issues/1914). Nanobrowser: replay of tasks, r=3 — [#147](https://github.com/nanobrowser/nanobrowser/issues/147).
  - Shipped attempts drew attention:
    - "Understudy – teach a desktop agent by demonstrating once": 120 points, 41 comments, 2026-03-12. Commenters doubted one-shot robustness and complained it is macOS-only — [HN](https://news.ycombinator.com/item?id=47353957).
    - Screenpipe (YC S26), "record how you work and turn that into agents": 88 points, 67 comments, 2026-07-23 — [HN](https://news.ycombinator.com/item?id=49024620).
    - Libretto, deterministic AI browser automations: 134 points — [HN](https://news.ycombinator.com/item?id=47780971).
    - OpenAdapt repositioned around "a person or an agent shows" a workflow; release openadapt-desktop-v0.23.0 on 2026-10-25 — [repo](https://github.com/OpenAdaptAI/OpenAdapt).
  - On the 45x-cost thread, a commenter described an agent that explores an app's surfaces, then writes a repeatable workflow — [HN](https://news.ycombinator.com/item?id=48024859).
- **Persistent app or site memory:** browser-use persistent verified memory of websites (c=12) — [#5841](https://github.com/browser-use/browser-use/issues/5841); Nanobrowser knowledge store — [#173](https://github.com/nanobrowser/nanobrowser/issues/173) and memories (closed 2026-10-20) — [#144](https://github.com/nanobrowser/nanobrowser/issues/144).
- **Remote, VM and sandbox:**
  - Hermes: remote agent with local tool execution, r=44 — [#18715](https://github.com/NousResearch/hermes-agent/issues/18715); remote computer_use — [#103932](https://github.com/NousResearch/hermes-agent/issues/103932).
  - Windows-MCP: RDP sessions — [#188](https://github.com/CursorTouch/Windows-MCP/issues/188).
  - "Setting up your spare Mac for Claude Code to control": 251 points, 196 comments, 2026-07-18. Commenters proposed libvirt VMs or cloud VMs instead of hardware — [HN](https://news.ycombinator.com/item?id=48959392).
  - Agent Safehouse, macOS-native sandboxing for local agents: 823 points — [HN](https://news.ycombinator.com/item?id=47301085).
  - Adrafinil, keep a lid-closed Mac awake only while agents work: 124 points, 78 comments — [HN](https://news.ycombinator.com/item?id=48701512).
  - cua lume posts: 309, 159 and 154 points — [HN](https://news.ycombinator.com/item?id=42908061), [HN](https://news.ycombinator.com/item?id=43985624), [HN](https://news.ycombinator.com/item?id=46670181).
- **CLI and skills rather than MCP:**
  - Codex computer use from the CLI, r=43 — [#20851](https://github.com/openai/codex/issues/20851).
  - Claude Code computer use in the CLI on Windows and Linux — [#54833](https://github.com/anthropics/claude-code/issues/54833), [#103071](https://github.com/anthropics/claude-code/issues/103071).
  - Agent S: package as an MCP server — [#113](https://github.com/simular-ai/Agent-S/issues/113).
- **Scheduling, voice, audit, undo:**
  - Scheduling: Agent S fixed-interval schedules — [#172](https://github.com/simular-ai/Agent-S/issues/172); Claude Code computer-use request_access fails instantly on every unattended run — [#81949](https://github.com/anthropics/claude-code/issues/81949).
  - Voice: Peekaboo scoped audio capture — [#1009](https://github.com/openclaw/Peekaboo/issues/1009); Clicky is voice-first — [repo](https://github.com/farzaa/clicky).
  - Audit: one HN commenter asked how to explain the "why" of each click to a compliance team — [HN](https://news.ycombinator.com/item?id=47936312). browser-use: governance layer, [#4634](https://github.com/browser-use/browser-use/issues/4634); deterministic permission gating, [#5063](https://github.com/browser-use/browser-use/issues/5063).

### Inferences
Mapped against computer-use-mcp, checked against this repository's AGENTS.md (7.7/7.8), not re-verified in code:
- **Already covered:** pause and stop with the status card; the takeover pause; `delivery:"pid"` background input; the effect/`hint`/`next_call` evidence on every action; `run_steps`; waits; the audit log; approvals; live share.
- **Open demand it does not yet answer:**
  - record and replay, or teach once, compiled to a deterministic script;
  - a multi-agent or shared-desktop ownership model;
  - remote execution of tools on another machine;
  - per-site or per-app persistent memory;
  - a "why" field in audit records.
- **One-project claims.** "No tool has it" is rarely true by now: each request has at least one project claiming it. The differentiator is doing it cross-platform. Many commenters stress that tools are macOS-only.

### Gaps
- No explicit user requests for undo or rollback of desktop actions were found in any tracker searched.
- Demand for scheduling and voice is anecdotal: single issues, no reactions.

## Q4. Where users compare tools or say why they switched, what reasons do they give?

### Takeaway
The stated reasons converge on six:
1. **Token cost and context bloat.** Users leave MCP for CLI or skills, or for token-lean browser MCPs.
2. **Determinism.** They move to scripted Playwright with AI only where needed.
3. **Reach.** They abandon macOS-only tools, or ask for Linux and Windows.
4. **Reuse of the signed-in browser.**
5. **Local models.**
6. **Abandonment or fragility of the tool.**

Security worries about agents acting in logged-in accounts make some users turn computer use off after trying it.

### Cited Findings
- **Token cost drives switching away from Playwright MCP:**
  - "Playwright Skill for Claude Code – less context than playwright-MCP": 189 points, 45 comments, 2025-10-20. Commenters prefer having the agent write Playwright scripts or shell commands, and note MCP determinism versus skills' injection risk — [HN](https://news.ycombinator.com/item?id=45642911).
  - Reddit r/mcp, "OpenBrowser MCP … 3.2x more token-efficient than Playwright MCP": 216 points, 37 comments, 2026-02-21 — [post](https://reddit.com/r/mcp/comments/1rb2tme/openbrowser_mcp_give_your_ai_agent_a_real_browser/).
  - "Charlotte … 136x smaller than Playwright": 102 points — [post](https://reddit.com/r/mcp/comments/1rhjxet/charlotte_a_browser_mcp_server_built_for_token/).
  - "Microsoft recommends CLI over MCP for Playwright": 41 points, 2026-04-19 — [post](https://reddit.com/r/mcp/comments/1spvkrz/microsoft_recommends_cli_over_mcp_for_playwright/).
  - In a July 2026 thread, commenters disagree on whether the CLI still saves about 4x tokens or the MCP has caught up, citing a Checkly comparison — [post](https://reddit.com/r/Playwright/comments/1v8swyu/are_we_using_playwright_mcp_for_testing_when_its/), [Checkly](https://www.checklyhq.com/blog/mcp-vs-cli-token-efficiency/).
  - "Every agent browser I tried wasted tokens and died on React re-renders, so I built my own" (r/mcp, 23 points, 2026-08-06) — [post](https://reddit.com/r/mcp/comments/1vh9wex/every_agent_browser_i_tried_wasted_tokens_and/).
- **From autonomous browser agents to deterministic scripts:**
  - r/LangChain, "Anyone moved off browser-use for production…" (11 points, 2026-03-06). Replies cite token burn from sending the full DOM every step, and recommend deterministic Playwright with AI only for extraction, or Stagehand's act/extract/observe — [post](https://reddit.com/r/LangChain/comments/1rm5lx8/anyone_moved_off_browseruse_for_production_web/).
  - An HN commenter stopped Codex's screenshot-and-click loop and went back to CLI tools for speed and tokens — [HN](https://news.ycombinator.com/item?id=48024859).
- **Reach (macOS-only fatigue):** HN threads on Agent-desktop and Understudy, quoted in Q2 — [HN](https://news.ycombinator.com/item?id=47982708), [HN](https://news.ycombinator.com/item?id=47353957). The top demand signals for Linux and Windows apps are in Q1, for example [codex #11023](https://github.com/openai/codex/issues/11023) and [openclaw #75](https://github.com/openclaw/openclaw/issues/75).
- **Using the person's own browser:**
  - Chrome DevTools MCP existing-session request: r=61 — [#140](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/140).
  - A blog post quotes an r/ClaudeCode commenter calling Chrome DevTools MCP faster and more capable than Playwright MCP (console logs, scripts) — [Tower of Kubes](https://www.towerofkubes.com/articles/chrome-devtools-mcp/).
  - Nanobrowser positions itself on "your real, logged-in browser" — [repo](https://github.com/nanobrowser/nanobrowser).
  - The Chrome DevTools MCP launch post drew 604 points and 234 comments, 2026-03-15 — [HN](https://news.ycombinator.com/item?id=47390817).
- **Local models:** a r/LocalLLaMA thread on Bytebot (2025-09-30, 31 comments) reports switching from Ollama to LM Studio because Ollama tool calling was unreliable for computer use, and asks for open-weight computer-use models — [post](https://reddit.com/r/LocalLLaMA/comments/1nugpbu/bytebot_why_no_hype_train_for_these_guys_t). Local-model requests top the UI-TARS, Bytebot, Agent S, Stagehand and browser-use trackers (Q1).
- **Security and trust:**
  - On r/hermesagent's "Hermes Agent now supports computer use" (106 points, 2026-06-22), a commenter said they turned it off after testing because of the risk to logged-in accounts — [post](https://reddit.com/r/hermesagent/comments/1ucuwk5/hermes_agent_now_supports_computer_use/).
  - An HN commenter compared computer use to giving a stranger the house keys — [HN](https://news.ycombinator.com/item?id=48024859).
  - Clicky "Critical Security Issues": r=6 — [#44](https://github.com/farzaa/clicky/issues/44).
  - browser-use pulled a malicious litellm in its install script: r=9 — [#4505](https://github.com/browser-use/browser-use/issues/4505).
- **Fragility and abandonment:**
  - "Is this still alive?" on Agent S — [#181](https://github.com/simular-ai/Agent-S/issues/181).
  - Hermes calls its cua-driver backend "too fragile" — [#32766](https://github.com/NousResearch/hermes-agent/issues/32766).
  - "Migrate from OpenClaw" (Hermes docs): 122 points, 105 comments, 2026-06-18. Commenters frame Hermes as more polished and OpenClaw as deeper; others question the need for either beyond Codex or cron — [HN](https://news.ycombinator.com/item?id=48586005).
  - Bytebot archived — [repo](https://github.com/bytebot-ai/bytebot).
- **Roundups.** Blog roundups of 2026 computer-use MCP servers name the built-in Claude Code server, Cua Driver (most-starred, background delivery), Peekaboo (deepest macOS toolset) and macOS-MCP (HTTP transport). These roundups are often affiliated with the tools they rank and disagree with one another — [Pinggy](https://pinggy.io/blog/best_computer_use_mcp_servers/), [DEV](https://dev.to/saptadev27/let-ai-control-your-desktop-the-best-computer-use-mcp-servers-in-2026-49k4), [ModelPiper](https://modelpiper.com/blog/best-macos-mcp-servers-2026).

### Inferences
- The switching logic is "cheapest reliable route first". Users drop pixel loops for CLIs, scripts or the AX tree when they can, and keep computer use for what has no API. That matches computer-use-mcp's own route order. Token efficiency is the axis users compare on, so smaller default tool lists and unchanged-capture suppression are worth publicising with numbers.
- Being cross-platform is a stated reason to pick a tool, because so many new entrants are macOS-only.

### Gaps
- Reddit coverage is thin. reddit.com blocked API access, and the PullPush archive was rate-limited and indexed only to about 2026-10-13. r/macapps, r/selfhosted and r/ClaudeAI were not searched successfully.
- No Discord summaries were found.
- No user-written comparison naming computer-use-mcp was found.

## Q5. Which tools are growing fastest in 2026 (stars, downloads)?

### Takeaway
Browser-side developer tools are growing fastest by every measure:
- @playwright/mcp npm downloads rose about 5.9x, from 5.0M in January to 29.3M in September 2026.
- chrome-devtools-mcp rose about 6.1x (1.3M to 8.0M) and roughly tripled its stars (about 18k to 54k).
- agent-browser rose about 42x (0.16M to 6.7M).

Among desktop tools:
- cua (about 11k to 31k stars) and UI-TARS-desktop (about 20k to 39k) roughly doubled or tripled.
- Peekaboo grew about 5x from a small base (about 1k to 5.4k).
- The harness-integrated agents dwarf everything: OpenClaw 393k stars, Hermes 257k.
- The 2023-24 generation has plateaued: Self-Operating Computer, OmniParser and Open Interpreter.

### Cited Findings
- **Stars**, current figures from the GitHub API, 2026-10-25 — [cua](https://github.com/trycua/cua), [UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop), [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp). Approximate stars on 2026-01-01 are read from the [star-history.com](https://star-history.com) chart SVGs:
  - browser-use: about 73.0k to 119.2k (+46k).
  - chrome-devtools-mcp: about 18.2k to 54.2k (+36k; created 2025-09-11).
  - goose: about 24.1k to 55.8k.
  - cua: about 11.3k to 30.9k (+19.6k; about 18.9k on 2026-07-01).
  - UI-TARS-desktop: about 20.4k to 39.4k.
  - playwright-mcp: about 24.6k to 38.7k.
  - Peekaboo: about 1.0k to 5.4k.
  - Open Interpreter: about 60.5k to 68.7k.
  - Stagehand: about 19.5k to 25.8k.
  - screenpipe: about 16.0k to 22.1k.
  - Skyvern: about 19.3k to 23.3k.
  - Agent S: about 8.9k to 12.7k.
  - Nanobrowser: about 11.5k to 14.2k.
  - UFO: about 7.8k to 10.1k.
  - Bytebot: about 9.8k to 11.1k (archived).
  - OmniParser: about 23.7k to 25.6k.
  - Self-Operating Computer: about 9.9k to 10.3k.
- **Created in 2026:**
  - Clicky: 7.8k stars since 2026-04-07; no push after 2026-04-28 — [repo](https://github.com/farzaa/clicky).
  - computer-use-linux: 739 stars since 2026-05-13 — [repo](https://github.com/agent-sh/computer-use-linux).
  - CursorTouch/MacOS-MCP: 225 stars since 2026-03-24 — [repo](https://github.com/CursorTouch/MacOS-MCP).
- **Harness agents:** openclaw/openclaw has 393k stars (created 2025-11-24) — [repo](https://github.com/openclaw/openclaw). NousResearch/hermes-agent has 257k stars and 17,094 open issues (created 2025-07-22) — [repo](https://github.com/NousResearch/hermes-agent).
- **npm monthly downloads, January 2026 → September 2026** — [npm API](https://api.npmjs.org/downloads/point/2026-09-01:2026-09-30/@playwright/mcp):
  - @playwright/mcp: 5,003,926 → 29,303,739.
  - chrome-devtools-mcp: 1,313,461 → 7,988,548.
  - agent-browser: 157,325 → 6,673,866.
  - @browserbasehq/stagehand: 2,139,766 → 6,526,175.
  - @midscene/web: 38,821 → 256,154.
  - @modelcontextprotocol/server-puppeteer: 69,068 → 132,555.
  - @steipete/peekaboo: 431 → 7,812.
  - @zavora-ai/computer-use-mcp: 0 → 4,500 (3,790 in the last 30 days).
  - computer-use-mcp (domdomegg): 11,663 → 2,722 (falling).
  - @ui-tars/sdk: 11,491 → 1,509 (falling).
- **PyPI, last month** — [pypistats](https://pypistats.org/packages/browser-use):
  - browser-use: 8.06M.
  - cua-driver: 233k.
  - hermes-agent: 162k.
  - cua-computer: 92k.
  - windows-mcp: 39.5k.
  - open-interpreter: 28k.
  - cua-agent: 27k.
  - skyvern: 5.9k.
  - macos-mcp: 2.2k.
  - gui-agents (Agent S): 1.6k.
  - openadapt: 555.
  - self-operating-computer: 275.
- **HN attention** (points/comments): Gemini 2.5 Computer Use model, 636/325 — [HN](https://news.ycombinator.com/item?id=45507936); "Computer Use is 45x more expensive", 495/271 — [HN](https://news.ycombinator.com/item?id=48024859); Chrome DevTools MCP, 604/234 — [HN](https://news.ycombinator.com/item?id=47390817); Launch HN: Cua, 172/73 — [HN](https://news.ycombinator.com/item?id=43773563).

### Inferences
- Downloads say developers value browser-scoped, token-lean, existing-browser tooling most in 2026.
- On the desktop side, growth concentrates in projects that ship native background drivers, cross-OS coverage and a VM story (cua). Model-centric desktop agents stall (UI-TARS-desktop's newer issue activity has fallen; @ui-tars/sdk downloads fell 87%).
- computer-use-mcp's npm figure (about 4.5k a month) is already above domdomegg's computer-use-mcp and below Peekaboo's about 7.8k.

### Gaps
- **The star figures are estimates.** GitHub's stargazer API returned 404 for every repo, so 2026 star gains are interpolated from star-history.com charts. Two charts were unusable:
  - Windows-MCP's chart reads about 13.9k on 2026-01-01, higher than today's 10.3k. A star purge or chart artifact is possible, so its growth is unknown.
  - midscene's chart failed to parse.
- **Pre-2026 baselines are missing** for OpenClaw and Hermes star growth (the parsing was not run for them) and for most PyPI packages (pypistats keeps about 180 days).
- **cua-driver PyPI is inconsistent.** The last-week figure (293k) exceeds the last-month figure (233k).
- **Some packages were not measured:** Homebrew installs (Peekaboo, lume) and Windows-MCP's Claude Desktop extension installs.
