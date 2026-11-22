# Structured, non-pixel routes for agents to control and test games (engine MCP servers, game test automation, in-game accessibility, remote consoles)

Research date: 2026-10-25. GitHub star counts and last-push dates were read from the GitHub REST API on 2026-10-25 (`gh api repos/<owner>/<repo>`); each is cited to the repository URL. Where a claim comes only from a third-party blog or aggregator, it is marked as such.

## 1. Engine and editor MCP servers (2025-2026): who ships what, and what they can do

### Takeaway
By October 2026 every major engine has an official or de facto MCP route. Epic (UE 5.8, June 2026, experimental), Roblox (built into Studio, March 2026) and Blender (Blender Lab MCP, 2026) ship official servers. Unity shipped one in its AI beta and has already deprecated it in favour of a CLI. Godot, GameMaker and Defold rely on community servers. The newest servers do much more than edit scenes: Roblox, the leading community Unity and Unreal servers, and paid Godot servers can start play mode, send synthetic input in play and return viewport or game-view images. That covers most of what a desktop computer-use server would otherwise do with pixels inside the editor.

### Cited Findings

**Unreal Engine: Epic's official Unreal MCP (UE 5.8)**
- Unreal MCP is an experimental plugin that runs an MCP server inside the Unreal Editor process. Epic's page says "use caution when shipping with it" — [Epic: Unreal MCP in Unreal Editor](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-mcp-in-unreal-editor)
- It binds to `http://127.0.0.1:8000/mcp` by default (port and path configurable) and "Supports HTTP and Server-Sent Events only", so there is no stdio or WebSocket — [Epic docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-mcp-in-unreal-editor)
- Tools come from the Toolset Registry subsystem. A toolset derives from `UToolsetDefinition` (Python: `unreal.ToolsetDefinition`). Tools are functions marked `UFUNCTION(meta = (AICallable))` in C++ or `@toolset_registry.tool_call` in Python. Changes need `ModelContextProtocol.RefreshTools`, and a new C++ UFUNCTION needs an editor restart — [Epic docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-mcp-in-unreal-editor)
- The AllToolsets plugin enables the default toolsets. The page names `SceneTools`, `ActorTools`, `MaterialInstanceTools` and `ObjectTools` as examples and mentions an experimental `GASToolsets` plugin, but gives no full list. It does not mention PIE control, viewport screenshots or reading runtime game state — [Epic docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-mcp-in-unreal-editor)
- Tool invocations run "on the game thread serially", so clients should not overlap calls — [Epic docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-mcp-in-unreal-editor)
- Security: loopback-only by default, and requests with non-loopback `Origin` headers are rejected. "There is no authentication layer; the plugin is not safe to expose beyond the local machine" — [Epic docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-mcp-in-unreal-editor)
- Epic's 5.8 materials describe the plugin as letting agentic AI systems connect to the editor, with built-in exposure to Blueprints, assets, levels, materials and meshes. The release notes also name an animation assistant toolset and a MetaHumanGenerator toolset, and a PCG toolset has its own guide — [UE 5.8 release notes](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes), [MetaHuman 5.8 release notes](https://dev.epicgames.com/documentation/metahuman/metahuman-5-8-release-notes-in-unreal-engine?lang=en-US), [PCG with Unreal MCP](https://dev.epicgames.com/documentation/unreal-engine/working-with-pcg-and-llms-using-unreal-mcp-in-unreal-engine?lang=en-US)
- UE 5.8 release date June 17, 2026 (third-party blog; Epic's news page returned 403 to the fetch tool) — [Ludus Engine blog](https://ludusengine.com/blog/unreal-engine-built-in-ai-assistant)
- The 5.8.1 hotfix included several MCP fixes (seen in search summaries, not fetched) — [Epic forum: 5.8.1 Hotfix](https://forums.unrealengine.com/t/5-8-1-hotfix-released/2738864)
- A forum user reported that the toolset registries must be enabled by hand or "the MCP doesn't do anything". This is a user report, not Epic guidance — [Epic forum](https://forums.unrealengine.com/t/free-ue-5-8-plugin-guided-setup-for-epic-s-native-mcp-workflow/2832596)
- Unreal MCP came to UEFN on Aug 20, 2026. Agents can read, write and compile Verse, place and configure devices, create Scene Graph entities, build UMG UI, and run play sessions to test results. Not every UE 5.8 toolset works in UEFN yet — [Epic forum announcement](https://forums.unrealengine.com/t/unreal-mcp-is-now-available-in-uefn/2745278), [Inven Global](https://www.invenglobal.com/articles/24955/speeding-up-development-with-ai-uefn-supports-unreal-mcp-plugin-starting-aug-20)
- A separate `MCPClientToolset` plugin connects Unreal to an external MCP server, which is the reverse direction — [Epic API: MCPClientToolset](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/MCPClientToolset)

**Unreal Engine: community servers (stars / last push as of 2026-10-25)**
- `ChiR24/Unreal_mcp`: 975 stars, pushed 2026-10-24. Talks to a native C++ "Automation Bridge" plugin and supports UE 5.0-5.8. Its `control_editor` tool covers "Play-In-Editor, synthetic input, screenshots, viewport camera". The 0.6 line puts its 23 internal tools behind one `unreal` gateway tool — [GitHub](https://github.com/ChiR24/Unreal_mcp)
- `flopperam/unreal-engine-mcp`: 1,113 stars, pushed 2026-06-26, "now owned by Aura". It recommends a hosted "Flop MCP" with 50+ tools, including `window_capture` (viewport screenshots) and `pie_test_bp` / `pie_test_scene` (PIE test harnesses with 30+ assertion types). The local Python server in the repo is a simpler, separate codebase — [GitHub](https://github.com/flopperam/unreal-engine-mcp)
- `chongdashu/unreal-mcp`: 2,103 stars, last push 2025-04-22 (stale); `kvick-games/UnrealMCP`: 613 stars, last push 2025-06-22 (stale) — [chongdashu](https://github.com/chongdashu/unreal-mcp), [kvick-games](https://github.com/kvick-games/UnrealMCP)
- `runreal/unreal-mcp`: 117 stars, last push 2025-06-06, "uses Unreal Python Remote Execution", so it needs no C++ plugin — [GitHub](https://github.com/runreal/unreal-mcp)

**Unity**
- Unity's official MCP server (AI Assistant package) exposes Editor capabilities as MCP tools for external clients through a relay to the editor's MCP bridge. The v2.20 docs state: "Unity MCP server is deprecated. Use the Unity command-line interface (CLI) instead", citing faster iteration, better stability and "the ability to target runtime and the Editor" — [Unity AI Assistant 2.20 docs](https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.20/manual/integration/unity-mcp-overview.html)
- Approval model: AI Gateway connections are auto-approved. Direct external MCP clients need approval in Project Settings, and approved clients are remembered — [Unity docs](https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.20/manual/integration/unity-mcp-overview.html)
- Unity's May 11, 2026 blog lists the official server's tools: scene management, script editing, console logs, GameObject component read/write, build settings, and custom C# tools. It needs Unity 6 (6000.0)+, a Unity Cloud-connected project, and an AI tools beta trial or subscription. It does not mention play mode, screenshots or tests — [Unity blog: Unity MCP how to get started](https://unity.com/blog/unity-ai-mcp-how-to-get-started)
- The Unity CLI is "experimental". Unity Hub installs it, and Editor control needs the "Unity pipeline package". The docs have a sub-page titled "Replace MCP Server with Unity CLI" (the guessed URL returned 404) — [Unity CLI docs](https://docs.unity.com/en-us/unity-cli)
- Unity's marketing pages disagree on whether the MCP server needs paid AI tiers. Both statements were seen in search summaries, and which page says which was not verified — [Unity AI features](https://unity.com/features/ai), [What is Unity AI](https://unity.com/resources/what-is-unity-ai)
- Community `CoplayDev/unity-mcp` ("MCP for Unity"): 15,385 stars, v10.3.0 released 2026-10-04. It manages assets, scenes and scripts, runs tests, and supports tool groups, multi-instance routing and remote-hosted servers with auth — [GitHub](https://github.com/CoplayDev/unity-mcp)
- Community `IvanMurzak/Unity-MCP`: 4,526 stars, pushed 2026-10-24. It has 70+ tools, including `screenshot-game-view`, `screenshot-camera`, `screenshot-scene-view`, `editor-application-set-state` (start, stop or pause play mode), `tests-run` (EditMode/PlayMode), and `reflection-method-call` ("Call any C# method"). It also "works inside your compiled game" (runtime), and an InputSystem extension adds tools for the Input System — [GitHub](https://github.com/IvanMurzak/Unity-MCP)
- Community `CoderGamester/mcp-unity`: 1,995 stars, pushed 2026-10-11 — [GitHub](https://github.com/CoderGamester/mcp-unity)

**Roblox Studio (official)**
- The MCP server is built into Studio. Roblox recommends it over its open-source server, and its tools stay at parity with Assistant (announced Mar 5, 2026) — [Roblox DevForum](https://devforum.roblox.com/t/assistant-updates-studio-built-in-mcp-server-and-playtest-automation/4474643)
- The docs list 25 tools, including `start_stop_play`, `get_studio_state`, `get_console_output`, `screen_capture` (viewport image with an optional camera position), `character_navigation`, `user_keyboard_input`, `user_mouse_input` (which can target UI instances or screen coordinates), and `execute_luau` (with a `datamodel_type` of Edit, Client or Server). There are also script read, edit and grep tools, `search_game_tree`, `inspect_instance`, and a `subagent` tool with a `playtest` type for "gameplay scenarios and verifying outcomes". It is enabled from Assistant → Manage MCP Servers — [Roblox docs: Studio MCP](https://create.roblox.com/docs/studio/mcp)
- `character_navigation` "doesn't simulate real player input. It bypasses the input system". Multi-instance support is experimental — [Roblox DevForum](https://devforum.roblox.com/t/assistant-updates-studio-built-in-mcp-server-and-playtest-automation/4474643)
- Roblox warns that "MCP clients can read and modify content in your open Roblox places" — [Roblox docs](https://create.roblox.com/docs/studio/mcp)
- The older standalone `Roblox/studio-rust-mcp-server` (tool `run_code`) is archived: 496 stars, last push 2026-04-03 — [GitHub](https://github.com/Roblox/studio-rust-mcp-server)

**Blender (official Blender Lab plus community)**
- Blender Lab MCP Server: hosted at projects.blender.org/lab/blender_mcp, add-on v1.0.3, needs Blender 5.1+. It "executes LLM-generated code in Blender without guards", and the page recommends a VM or a machine without sensitive data — [blender.org Lab: MCP server](https://www.blender.org/lab/mcp-server/)
- Third-party reports give a release history (first tag 2026-04-10, v1.0.0 on 2026-04-27, v1.0.3 on 2026-09-11) and link it to Anthropic's 2026-04-28 creative-tools connectors announcement — [StraySpark blog](https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026), [DEV Community](https://dev.to/_903a3934b362f0afe2a8/blender-mcp-servers-for-ai-agents-october-2026-which-ones-control-the-scene-and-which-one-3ica)
- Hands-on notes from this repo (v1.0.2, Blender 5.2.1):
  - Official tools include `get_screenshot_of_window_as_image`, `get_screenshot_of_area_as_image`, `get_screenshot_of_window_as_json` (area type, x, y, width, height), `render_viewport_to_path`, `render_thumbnail_to_path`, `execute_blender_code` and `execute_blender_code_for_cli`.
  - The official and community servers both default to port 9876, and `uvx blender-mcp` installs the community package.
  - The addon will not start unless "Allow Online Access" is on.
  - A Cycles render inside `execute_blender_code` crashed Blender, because the addon answers synchronously on the main thread.
  - [computer-use-mcp skills/blender-agent/SKILL.md](https://github.com/zavora-ai/computer-use-mcp/blob/main/skills/blender-agent/SKILL.md)
- Community `ahujasid/blender-mcp`, renamed `mcp-for-blender`: 32,271 stars, pushed 2026-10-24, the most-starred server in this survey — [GitHub](https://github.com/ahujasid/mcp-for-blender)
  - Nine tools: `execute_blender_code`; `look` (viewport, camera, auto-framed multi-angle sheets or animation frames, in solid, material, rendered, wireframe or x-ray shading); `get_scene_info`; `generate_3d`; `search_assets` / `import_asset` (Poly Haven, Sketchfab, Poly Pizza); and telemetry controls.
  - It adds an MCP Apps inline live viewport for clients that support it.
  - Telemetry: by default it sends an anonymous per-tool usage record. Prompts, code and screenshots are collected only after opt-in.

**Godot**
- `Coding-Solo/godot-mcp`: 6,330 stars, last push 2026-04-16. It launches the editor, runs projects in debug mode, captures debug output (`get_debug_output`), stops projects, creates scenes and adds nodes. Its README lists no screenshot or input tools — [GitHub](https://github.com/Coding-Solo/godot-mcp)
- Other Godot servers — [GitHub search, "godot mcp", sorted by stars](https://github.com/search?q=godot+mcp&type=repositories&s=stars):
  - `youichi-uda/godot-mcp-pro`: 634 stars, paid ($15 one-time), "162 MCP tools", including input simulation and runtime analysis
  - `tugcantopaloglu/godot-mcp`: 499 stars, 157 tools, "Tested with Godot 4.7"
  - `yurineko73/Godot-MCP-Native`: 861 stars, MCP server implemented on Godot's native HTTP
  - `IvanMurzak/Godot-MCP`: 304 stars
  - `ee0pdt/Godot-MCP`: 621 stars, last push 2025-03-19 (stale)

**Minecraft**
- `PrismarineJS/mineflayer`: 7,640 stars, pushed 2026-10-24, "Create Minecraft bots with a powerful, stable, and high level JavaScript API" — [GitHub](https://github.com/PrismarineJS/mineflayer)
- `yuniko-software/minecraft-mcp-server`: 793 stars, last push 2026-04-04. Built on Mineflayer, with tools such as `get-position`, `move-to-position`, `look-at`, `place-block`, `dig-block`, `find-blocks`, `list-inventory`, `equip-item`, `smelt-item`, `find-entity`, `send-chat`, `read-chat` and `detect-gamemode`. The bot joins as a network client, so no screen is involved — [GitHub](https://github.com/yuniko-software/minecraft-mcp-server)

**GameMaker and Defold (community only, small)**
- GameMaker: `yearningss/gamemaker-mcp` has 23 stars (225 tools, GML analysis, builds). `mehdivijeh/gamemaker-mcp` has 0 stars and claims live control of the running game (variables, instances, input, screenshots) through Igor on macOS — [GitHub search](https://github.com/search?q=gamemaker+mcp&type=repositories&s=stars)
- Defold: `Fulviuus/defold-mcp` has 13 stars and claims to "build, bundle, run, hot-reload and inspect Defold projects, drive the running engine". `zrnge/defold-mcp` has 6 stars — [GitHub search](https://github.com/search?q=defold+mcp&type=repositories&s=stars)

### Inferences
- The common shape of a 2026 engine server: run inside the editor process; execute arbitrary code (Python, Luau or C#) as the escape hatch; add structured scene and asset tools on top; and return images through the engine's own renderer (Roblox `screen_capture`, `mcp-for-blender` `look`, Unity-MCP `screenshot-game-view`, ChiR24 `control_editor`). An engine-side capture renders only the viewport, but it does not depend on window focus, occlusion or Screen Recording permission.
- Play-mode input injection now exists inside several engine servers (Roblox `user_keyboard_input` / `user_mouse_input`, ChiR24 PIE synthetic input, Godot MCP Pro input simulation). Epic's official toolset does not document PIE control or screenshots, so for stock UE 5.8 a desktop server still covers "watch the viewport" and "press keys in PIE" unless a community server is added.
- Vendors are diversifying away from MCP-only. Unity deprecated its MCP server for a CLI; AltTester added a CLI plus "AI Skills"; IvanMurzak's Unity-MCP now sells itself as "AI Skills, MCP Tools, and CLI". A desktop server's hand-off guidance should therefore name engine CLIs and skills, not only MCP endpoints.
- Several engine servers listen on fixed loopback ports: UE 5.8 on 8000/mcp; both Blender servers on 9876; ChiR24 on 3000 (from its README screenshot caption). A desktop server can detect a running engine process and then probe or advise on these endpoints. Port collisions between official and community servers are a real failure mode.
- Local observation, not web-sourced: this research session had an `unreal-engine-skills-for-claude-code` plugin installed whose skills reference `ToolsetRegistry` toolsets (`BlueprintTools`, `StaticMeshTools`, `ObjectTools`, `LevelTools`, `MaterialTools`). Unreal MCP is being packaged together with host skills.

### Gaps
- Could not fetch Epic's full toolset list or confirm whether any official UE 5.8 toolset controls PIE or captures the viewport. The Epic news page returned 403.
- The claim that Epic's UE6 will have an "MCP layer" with Claude and Gemini integrations, targeting late 2027, appeared only in a search-engine summary of third-party blogs ([GameEngineHub](https://gameenginehub.com/insights/unreal-engine-ai-epic-mcp-developer-assistant-ai-native-workflow)). Unverified.
- The Unity CLI command reference (whether it can enter play mode, capture, inject input or target players) was not retrieved.
- No official MCP was found for Godot, GameMaker or Defold. Community GameMaker and Defold servers are tiny, and their live-control claims are unverified.
- Minecraft Bedrock routes (Script API, `/wsserver` WebSocket) were not researched.

## 2. Runtime game automation and test frameworks (in-game drivers, engine test harnesses, gym environments, emulators)

### Takeaway
Game testing has long used in-process instrumentation instead of pixels. An SDK compiled into the build (AltTester, GameDriver, Poco) or an engine test harness (Unreal Automation Driver, Gauntlet, Unity InputTestFixture) exposes the object tree and injects input below the OS. The commercial tools (AltTester, GameDriver) added MCP servers in 2025-2026. Research environments (ALE, stable-retro, PyBoy, mGBA, BizHawk, FLE) give agents RAM, state and frame-stepping APIs. The Pokémon agent harnesses that worked combined RAM-read state with screenshots, because raw-pixel play alone performs very poorly.

### Cited Findings

**Commercial in-game drivers**
- AltTester: Unity SDK repo has 122 stars, pushed 2026-09-23. It "helps you find objects in your game and interacts with them using tests written in C#, Python, Robot or Java" — [GitHub](https://github.com/alttester/AltTester-Unity-SDK)
- AltTester has "officially launched our AI Extension with MCP server support", rolled out Secure WebSocket (WSS), and introduced the AltTester CLI and AI Skills, "built for Unity and Unreal alike" (Gamescom post, Jul 27, 2026) — [AltTester blog](https://alttester.com/alttester-at-gamescom-2026-ai-assisted-testing-for-game-dev-and-whats-next/)
- AltTester Unity SDK v2.3.1 and Unreal SDK v1.2.1 were announced Apr 3, 2026. From July 1, 2026 prices rise, the Community plan is no longer self-serve, and the trial extends from 14 to 30 days. The CLI shipped with Desktop 2.3.2 and covers object discovery, input simulation, state inspection and Robot Framework runs (search summary of AltTester pages) — [AltTester product updates](https://alttester.com/category/product-updates-releases/), [AltTester Desktop docs](https://alttester.com/docs/desktop/latest/search.html)
- GameDriver's 2025.06 release added a local MCP server to its Test Assistant "to interface with Claude, enabling intelligent test script suggestions", plus replay and NUnit integration. The 2025.01 Test Assistant runs without opening the Unity or Unreal editor. GameDriver supports Unity, Unreal and Godot — [GameDriver 2025.06 release](https://www2.gamedriver.io/blog/2025.06-release-update), [Silicon UK press release](https://www.silicon.co.uk/press-release/gamedriver-unveils-standalone-test-assistant-for-unity-and-unreal-alongside-transparent-pricing)
- GameDriver has a Nintendo middleware partnership (2023) and supports Xbox and Switch testing — [BusinessWire 2023-08](https://www.businesswire.com/news/home/20230822638745/en/GameDriver-Announces-Nintendo-Middleware-Partnership-to-Enhance-Game-Development-on-Nintendo-Switch), [BusinessWire 2023-04](https://businesswire.com/news/home/20230425005037/en/GameDriver-Announces-Testing-Support-for-Xbox-Nintendo-Switch-and-More-With-New-2023.04-Version-Update/)

**NetEase Airtest / Poco**
- Airtest (9,618 stars, last push 2026-03-23) is image-recognition based: it "uses image recognition technology to locate UI elements so that you can automate games and apps without injecting any code". Works on Android, iOS and Windows — [GitHub](https://github.com/AirtestProject/Airtest)
- Poco (1,961 stars, last push 2024-01-08, effectively dormant) "retrieves UI Elements Hierarchy in game's runtime" through a `poco-sdk` integrated into the game. Supports Unity3D, cocos2dx-js/lua and Android/iOS native; can be extended to private engines; lists Python 2.7/3.3-3.6 compatibility — [GitHub](https://github.com/AirtestProject/Poco)

**Unreal engine test harnesses**
- Automation Driver: simulates user input "through the application using fluent syntax" by swapping shims into Core's input interfaces.
  - Locators: `By::Id` (needs `FDriverMetaData::Id` tags), `By::Path` ("most brittle and powerful"), `By::Cursor` and `By::Delegate`. They find Slate elements, and can be extended "to work with scene actors or beyond".
  - Limits: keyboard and mouse only, with no controller, touch or motion yet. The synchronous API must not run on the GameThread, or it deadlocks.
  - [Epic docs: Automation Driver](https://dev.epicgames.com/documentation/en-us/unreal-engine/automation-driver-in-unreal-engine)
- Gauntlet runs sessions of Unreal projects that test and validate results, possibly multi-process (clients plus server), "on a variety of platforms". It needs no game-side framework. The optional Gauntlet plugin's `TestController` is for "puppeteering and monitoring a game instance" — [Epic docs: Gauntlet](https://dev.epicgames.com/documentation/en-us/unreal-engine/gauntlet-automation-framework-in-unreal-engine)

**Unity test harnesses**
- `InputTestFixture` drives input from code without platform backends, and that input is treated "the same as input generated at runtime by actual platform code". Each test starts with a blank Input System with no devices, and `TearDown()` restores the previous state. Helpers: `Press`, `Release`, `PressAndRelease`, `Set`, `Trigger`, plus low-level `StateEvent` / `InputSystem.QueueEvent` — [Unity Input System docs: Testing](https://docs.unity3d.com/Packages/com.unity.inputsystem@1.11/manual/Testing.html)
- ML-Agents: 19,794 stars, latest release `release_23` (2025-09-02), pushed 2026-10-23. It "enables games and simulations to serve as environments for training intelligent agents" — [GitHub](https://github.com/Unity-Technologies/ml-agents)

**Gym-style environments and emulators**
- Arcade Learning Environment: 2,461 stars, pushed 2026-10-22, Atari 2600 for agents — [GitHub](https://github.com/Farama-Foundation/Arcade-Learning-Environment)
- Stable-Retro: 1,099 stars, pushed 2026-10-25. A fork of gym-retro, which is "in maintenance", turning classic games into Gymnasium environments, with an integration tool for new games — [GitHub](https://github.com/Farama-Foundation/stable-retro)
- MineRL: 980 stars, last push 2025-01-22 (stale) — [GitHub](https://github.com/minerllabs/minerl)
- PyBoy: 5,230 stars, pushed 2026-10-22. API: `pyboy.button('a')`, `pyboy.tick()`, `pyboy.memory[0xC345]`, `pyboy.screen.image`, and `set_emulation_speed(0)` (no speed limit). Its README links Pokémon Red RL experiments — [GitHub](https://github.com/Baekalfen/PyBoy)
- mGBA: 7,524 stars, pushed 2026-10-25, with a scripting API (Core, MemoryDomain, callbacks) — [GitHub](https://github.com/mgba-emu/mgba), [mGBA Scripting API](https://mgba.io/docs/scripting.html)
- `mcp-mgba` runs a `bridge.lua` inside mGBA 0.10+ that listens on loopback TCP 8765. Its MCP tools "read and write GBA memory, inject button presses, take screenshots, and step the emulator" — [mcp-mgba README](https://cdn.jsdelivr.net/npm/mcp-mgba@0.3.3/README.md)
- BizHawk: 2,805 stars. Offers "programmatic control over core and frontend with Lua or C#.NET" and an `--lua=` launch flag — [GitHub](https://github.com/TASEmulators/BizHawk)

**Pokémon agent harnesses**
- The "Claude Plays Pokemon - Starter Version" (David Hershey; 205 stars; last push 2025-04-03) uses PyBoy and a `memory_reader.py` that extracts game state from emulator memory. Each step sends a screenshot plus the memory-read state to Claude, which replies with emulator commands — [GitHub](https://github.com/davidhershey/ClaudePlaysPokemonStarter)
- The Gemini 2.5 Pro Pokémon Blue harness used mGBA:
  - Screen text was extracted from RAM, because the model struggled to read the screen.
  - The model got a textual minimap and a grid overlay, plus a pathfinder tool backed by an XML map model.
  - Sub-agents handled pathfinding and boulder puzzles, and the developer sometimes intervened.
  - [The Decoder](https://the-decoder.com/googles-reasoning-llm-gemini-2-5-pro-beats-pokemon-blue-with-a-little-help/), [Drew Breunig](https://www.dbreunig.com/2025/06/17/an-agentic-case-study-playing-pokémon-with-gemini.html)
- LessWrong compares the two harnesses: Claude's navigator "can only navigate to coordinates that are onscreen", and "we have limited information on both of the agent harnesses" — [LessWrong](https://www.lesswrong.com/posts/7mqp8uRnnPdbBzJZE/is-gemini-now-better-than-claude-at-pokemon)
- VideoGameBench (Princeton, arXiv 2505.18134) gives models "only raw visual inputs" for 1990s games. The best models (Gemini 2.5 Pro, Claude 3.7 Sonnet) completed 0.48% of VideoGameBench and 1.6% of the Lite variant, which pauses while the model thinks. Latency was a major limit — [arXiv](https://arxiv.org/abs/2505.18134v2)

**Factorio Learning Environment (FLE)**
- FLE: 1,205 stars, pushed 2026-09-18, NeurIPS 2025 Datasets & Benchmarks. Agents write Python against an API inside a REPL. FLE requires Factorio 1.1.110 and Docker — [GitHub](https://github.com/JackHopkins/factorio-learning-environment), [NeurIPS 2025](https://proceedings.neurips.cc/paper_files/paper/2025/hash/75f3a62e55187bc3e5e5961fa2a46bcf-Abstract-Datasets_and_Benchmarks_Track.html), [arXiv](https://arxiv.org/html/2503.09617v1)
- FLE's `lua_manager.py` imports `factorio_rcon.RCONClient` and pushes Lua through RCON. The cluster README assigns each instance an RCON TCP port (27000 + n) with password "factorio" — [lua_manager.py](https://github.com/JackHopkins/factorio-learning-environment/blob/main/fle/env/lua_manager.py), [cluster README](https://github.com/JackHopkins/factorio-learning-environment/blob/main/fle/cluster/README.md)

### Inferences
- The harnesses that make progress (Claude and Gemini Pokémon, FLE, Mineflayer bots) all replace "read the screen" with "read memory or an object model" and replace "click" with "call the game's own actions". Pixels are kept for perception the state API lacks. VideoGameBench's ~1% completion with raw pixels alone is the strongest available evidence that pixel-only play is not viable for current models.
- Commercial game-test vendors (AltTester, GameDriver) now provide MCP or CLI front doors to SDK-instrumented builds. For a studio's own game, the structured route is "instrument the build", which a desktop server cannot replace and should hand off to.
- Engine-native input injection (Automation Driver shims, `InputTestFixture` events, Roblox `user_*_input`) enters below the OS. It works on a background or headless instance and is not marked as injected at the OS level. OS-level input is the only option once the game is a shipped binary with no SDK.

### Gaps
- Unreal Functional Testing (`AFunctionalTest`), Automation Spec and the Unity Test Framework itself were not fetched. Their play-mode details come only from the MCP servers that wrap them (IvanMurzak `tests-run`, CoplayDev test running).
- AltTester's MCP tool list and GameDriver's 2026 roadmap were not found in primary docs.
- Anthropic's official Claude Plays Pokémon production harness (knowledge base, navigator) is not public. Only the starter repo and secondary descriptions were found.

## 3. In-game accessibility trees: can UIA, AX or AT-SPI see game UI?

### Takeaway
By default, no. Self-drawn engine UIs expose almost nothing to the OS accessibility APIs. This repo measured Blender at six nodes. Since 2025, though, every major engine has an opt-in bridge to the native APIs: AccessKit (Godot 4.5), Unity 6.3's Accessibility module (Narrator and VoiceOver), and Unreal's Slate accessibility (Windows screen readers). A game built with these and running with them active can publish a real UIA, AX or AT-SPI tree. Coverage depends on what the developer builds, and some implementations publish the tree only when a screen reader is detected.

### Cited Findings
- AccessKit is accessibility infrastructure "in toolkits that render their own user interface elements". Its adapters implement UI Automation on Windows, NSAccessibility on macOS, AT-SPI on Unix, plus Android and iOS, with a web/canvas adapter planned. The adapters are "at rough feature parity" but "don't yet support all types of UI elements" and don't support rich text. 1,548 stars, pushed 2026-10-24 — [GitHub](https://github.com/AccessKit/accesskit)
- Godot 4.5 added screen-reader support through AccessKit for Control nodes, plus bindings to customise any Node. The feature is "still in its experimental phase", and editor coverage is partial (Project Manager, standard UI nodes, inspector) — [Godot 4.5 release](https://godotengine.org/releases/4.5/), [Can I Play That](https://caniplaythat.com/?p=15209)
- Unity: "Unity 6000.3.0a5 brings native screen reader support to Windows and macOS" (Sep 2, 2025). Developers build an `AccessibilityHierarchy` and set `AssistiveSupport.activeHierarchy`; the sample does this only when `AssistiveSupport.isScreenReaderEnabled` is true. Neither UI Toolkit nor uGUI is said to be exposed automatically. A Windows 10 Narrator crash was fixed in April 2026 — [Unity Discussions](https://discussions.unity.com/t/native-desktop-screen-reader-support-now-available-in-unity-6-3/1681788)
- The Unity Accessibility module covers Narrator (Windows 10 21H1+), VoiceOver (macOS 11+), TalkBack and iOS VoiceOver. Its node hierarchy is separate from the GameObject hierarchy, and an Accessibility Hierarchy Viewer shows it live in Play mode — [Unity Manual: Accessibility module](https://docs.unity3d.com/Manual/accessibility/module-intro.html), [Unity 6.3 LTS accessibility](https://docs.unity3d.com/Manual/accessibility.html)
- Unreal Engine supports third-party Windows screen readers (NVDA and JAWS are named) and iOS VoiceOver, covering common UMG widgets.
  - Enable it with `Accessibility.Enable=1`. Custom Slate widgets override `SWidget::CreateAccessibleWidget()`, and `bCompileWithAccessibilitySupport=false` compiles the support out.
  - [Epic docs: Supporting screen readers](https://dev.epicgames.com/documentation/en-us/unreal-engine/supporting-screen-readers-in-unreal-engine)
- Unreal's Slate Screen Reader plugin, a plug-and-play option for Slate and UMG, is Experimental — [Epic docs: Blind accessibility overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/blind-accessibility-features-overview-in-unreal-engine), [SlateScreenReader plugin index](https://dev.epicgames.com/documentation/unreal-engine/API/PluginIndex/SlateScreenReader)
- The Xbox Accessibility Guidelines are at v3.2 (Jun 8, 2023; index updated Aug 2026). They are best practices, "aren't intended to act as a checklist to validate any type of compliance". XAG 112 asks for a consistent narration reading order and focus order, full keyboard/controller digital navigability, and in-game narration on by default when the platform's "Let Games Read to Me" setting can't be read — [XAG index](https://learn.microsoft.com/en-us/gaming/accessibility/guidelines), [XAG 112](https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/112)
- Measured with this repo: on Blender 5.2.1 the macOS accessibility tree has six nodes (window, three title-bar buttons, a group, the title text). `find_element` for `File`, `Add` or `Render` returns nothing because the menus are painted in OpenGL — [computer-use-mcp AGENTS.md](https://github.com/zavora-ai/computer-use-mcp/blob/main/AGENTS.md), [skills/blender-agent/SKILL.md](https://github.com/zavora-ai/computer-use-mcp/blob/main/skills/blender-agent/SKILL.md)

### Inferences
- For a desktop server, the accessibility tree of a game is "empty unless the game opted in". When the game opted in, the tree may be gated on a screen reader being active, as in Unity's sample pattern, so an automation client that is not a screen reader may still see nothing. On Windows, a game might publish its tree only when Narrator or NVDA is running. This is worth testing before telling agents to try UIA on Unity 6.3+ titles.
- XAG 112's "narration and focus order" and "fully navigable by keyboard digital input" are useful for agents even without a tree. An XAG-compliant game's menus can be driven by deterministic arrow, Tab and Enter sequences instead of coordinate clicks, and its in-game TTS output could in principle be captured as a text channel.
- AccessKit's planned web/canvas adapter and Godot's adoption make AT-SPI and UIA trees from Godot 4.5+ games plausible on Linux and Windows. Its maturity disclaimers mean tree coverage will be partial.

### Gaps
- No source confirmed which native API Unity 6.3 uses on Windows (presumably UIA) or whether non-screen-reader UIA clients trigger `isScreenReaderEnabled`.
- No source confirmed how Unreal's Windows screen-reader path maps to UIA, or whether macOS VoiceOver is supported on desktop Unreal (the docs cite iOS VoiceOver).
- No reliable list was found of shipped PC games with OS-level screen reader trees, as opposed to self-voiced in-game TTS.

## 4. Remote control and debug interfaces (Unreal Remote Control, RCON, Steam)

### Takeaway
Long-standing remote consoles give agents structured, text-only control without pixels. Unreal's Remote Control API (HTTP on 30010, Beta) calls UFunctions and reads or writes properties in editor, PIE and `-game`. Source-protocol RCON gives command execution on Minecraft Java and Factorio servers, and FLE uses Factorio RCON to drive its agents. All of these are unauthenticated or weakly authenticated and must stay on loopback or a LAN.

### Cited Findings
- Unreal Remote Control API: the server listens on HTTP port 30010 (configurable), binds to 127.0.0.1 by default, and is started with `WebControl.StartServer` / `WebControl.EnableServerOnStartup`. Epic warns: "Do not attempt to open the hostname and port of your Unreal Engine application to the open Internet". Status: Beta — [Epic docs: Remote Control quick start](https://dev.epicgames.com/documentation/en-us/unreal-engine/remote-control-quick-start-for-unreal-engine)
- Endpoints: `GET remote/info`; `PUT remote/object/call` (BlueprintCallable functions); `remote/object/property`; `remote/object/describe`; `remote/search/assets`; `remote/batch`; and an experimental `remote/object/event` (requires `WebControl.EnableExperimentalRoutes=1`). In `-game` or PIE, a property must be BlueprintVisible, and to write it, not BlueprintReadOnly — [Epic docs: Remote Control HTTP reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/remote-control-api-http-reference-for-unreal-engine)
- `runreal/unreal-mcp` uses Unreal Python Remote Execution instead of a C++ plugin — [GitHub](https://github.com/runreal/unreal-mcp)
- Minecraft RCON is Java Edition only. It is enabled with `enable-rcon=true`, `rcon.password` and `rcon.port` (default 25575), and "implements the Source RCON protocol" (packet types 3 = login, 2 = command, 0 = response; responses can be split into 4096-byte packets). Many commands return no output, it "is not encrypted", and exposing it to the internet is dangerous — [Minecraft Wiki: RCON](https://minecraft.wiki/w/RCON)
- Factorio: FLE drives the game by sending Lua over RCON (`factorio_rcon.RCONClient`), one RCON port per instance — [FLE lua_manager.py](https://github.com/JackHopkins/factorio-learning-environment/blob/main/fle/env/lua_manager.py), [FLE cluster README](https://github.com/JackHopkins/factorio-learning-environment/blob/main/fle/cluster/README.md)
- Emulator debug bridges serve the same role for retro games: mGBA Lua scripting with a loopback TCP bridge (`mcp-mgba`), and BizHawk Lua or C# control — [mcp-mgba](https://cdn.jsdelivr.net/npm/mcp-mgba@0.3.3/README.md), [BizHawk](https://github.com/TASEmulators/BizHawk)

### Inferences
- For a running Unreal game (PIE or `-game`), Remote Control is the closest thing to an "app API" for runtime state: read a property, call a BlueprintCallable function. It is available without the 5.8 MCP plugin. A desktop server could suggest it when it sees an Unreal process and port 30010 open.
- RCON-style interfaces are server-side, admin-level command channels. They suit game state, world edits and test setup, but not UI or player input. An agent still needs a client (Mineflayer, or OS-level input on the real client) to act as a player.

### Gaps
- The Unreal Remote Control WebSocket port and packaged-build enablement flags were not confirmed. The fetched pages did not state them, so I am not reporting the commonly cited 30020.
- Source engine console/RCON (Valve developer wiki) and Steam's browser protocol (`steam://rungameid/`) could not be fetched (403). Steam game recording and any agent-facing Steam APIs were not researched.
- "Unity Remote" (a mobile preview app) was not researched; it does not appear relevant to agent control.
- Minecraft Bedrock's Script API and WebSocket `/connect` were not researched.

## 5. How engine servers are combined with screen-level computer use, and what only OS-level input covers

### Takeaway
In practice the engine server is the primary route and desktop computer use is the bridge. The engine server says what exists and where (scene graph, area layout, viewport images). The desktop server handles everything outside the engine's API: OS and editor dialogs, launchers, focus, panels the API cannot reach, and closed-source shipped games. Gaps that only OS-level input covers are launchers and sign-in, shipped titles with no SDK or console, OS permission dialogs, and anything where the injected-input path itself is under test. Anti-cheat makes OS-level input on protected titles risky, but this research found no authoritative vendor documentation on how it treats injected input.

### Cited Findings
- The pattern measured in this repo for Blender:
  - "Route by capability, not by habit".
  - The official Blender server's `get_screenshot_of_window_as_json` returns each area's type and x/y/width/height in Blender-window coordinates. Combined with the desktop server's window bounds, that says exactly where to `click` for "something the Python API cannot reach", so "Blender says where its panels are, computer-use acts on them".
  - Agents should never use the OS accessibility tree on Blender.
  - [computer-use-mcp skills/blender-agent/SKILL.md](https://github.com/zavora-ai/computer-use-mcp/blob/main/skills/blender-agent/SKILL.md)
- Same source: heavy work inside the engine server's synchronous main-thread socket (a Cycles render via `execute_blender_code`) crashed Blender. Heavy work belongs out of process (`blender -b`) — [skills/blender-agent/SKILL.md](https://github.com/zavora-ai/computer-use-mcp/blob/main/skills/blender-agent/SKILL.md)
- This repo's generated server instructions give the route order: the app's own API or MCP server first, then scripting, accessibility, OCR for self-drawn apps, and coordinates last. They no longer tell hosts to prefer the accessibility tree, "which is empty on Unreal, Blender and games" — [computer-use-mcp AGENTS.md](https://github.com/zavora-ai/computer-use-mcp/blob/main/AGENTS.md)
- Engine servers increasingly return their own images (Roblox `screen_capture`; `mcp-for-blender` `look` with multi-angle sheets and an MCP Apps inline viewport; Unity-MCP `screenshot-game-view` and `screenshot-camera`; ChiR24 screenshots; Flop `window_capture`). The visual-verification loop can run without OS screen capture — [Roblox docs](https://create.roblox.com/docs/studio/mcp), [mcp-for-blender](https://github.com/ahujasid/mcp-for-blender), [IvanMurzak/Unity-MCP](https://github.com/IvanMurzak/Unity-MCP), [ChiR24/Unreal_mcp](https://github.com/ChiR24/Unreal_mcp), [flopperam/unreal-engine-mcp](https://github.com/flopperam/unreal-engine-mcp)
- Roblox's `character_navigation` "bypasses the input system". Real input-path testing needs `user_keyboard_input` / `user_mouse_input` or OS-level input — [Roblox DevForum](https://devforum.roblox.com/t/assistant-updates-studio-built-in-mcp-server-and-playtest-automation/4474643)
- Engine-server security baselines are weak:
  - Epic's Unreal MCP has "no authentication layer" — [Epic docs](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-mcp-in-unreal-editor)
  - Blender Lab runs model code "without guards" — [blender.org](https://www.blender.org/lab/mcp-server/)
  - `mcp-for-blender` warns that `execute_blender_code` runs arbitrary Python — [GitHub](https://github.com/ahujasid/mcp-for-blender)
  - Roblox: "only connect clients you trust" — [Roblox docs](https://create.roblox.com/docs/studio/mcp)
  - RCON is unencrypted — [Minecraft Wiki](https://minecraft.wiki/w/RCON)
- At the OS level, Windows marks synthesized input. Low-level keyboard hooks see `LLKHF_INJECTED` ("the event was injected") and `LLKHF_LOWER_IL_INJECTED`, so any process with a low-level hook, including anti-cheat or the game itself, can tell injected keystrokes from hardware ones — [Microsoft Learn: KBDLLHOOKSTRUCT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-kbdllhookstruct)
- Kernel-level anti-cheat (EAC, BattlEye) runs at Ring 0 with behavioural analysis. Only secondary, low-quality sources were found, and none says specifically how `SendInput` is treated — [awesome-game-security anti-cheat skill (secondary)](https://tessl.io/registry/skills/github/gmh5225/awesome-game-security/anti-cheat-systems)
- Raw-pixel play by frontier VLMs completes ~0.5-1.6% of classic games, with latency a key limit — [VideoGameBench](https://arxiv.org/abs/2505.18134v2)

### Inferences
- How a general desktop computer-use MCP server should hand off:
  1. Detect the engine or game (process or bundle: UnrealEditor, Unity, Godot, Blender, RobloxStudio, mGBA or RetroArch, Minecraft) through `discover_applications` / `get_app_capabilities`.
  2. Report an `engine_api` hint: known server, endpoint and port (UE 5.8 `127.0.0.1:8000/mcp`; UE Remote Control `:30010`; Blender `:9876`; mcp-mgba `:8765`), whether the endpoint answers, and the install or enable step. Roblox needs the Assistant setting, Unreal needs AllToolsets, and Blender needs Allow Online Access.
  3. Have `get_tool_guide` return "use the engine server" for scene, asset, play-mode and state tasks.

  This is a read-only probe of loopback ports. It must not start servers or change engine settings.
- What the desktop server should keep doing for games:
  - OS-level and editor-chrome dialogs (crash reporters, shader-compile and save prompts, plugin-enable restarts, license and sign-in windows, OS permission sheets)
  - Launchers (Steam, Epic, Battle.net), which have no agent API in this research
  - Whole-window capture when the engine's viewport capture omits editor panels
  - OCR (`read_window_text`, `click_text`) for self-drawn editor panels the engine API does not expose
  - Viewport navigation gestures (`mouse_drag` with middle button and modifiers)
  - Shipped closed-source games with no SDK, console or RCON
- Engine servers serialise on the game or main thread (Unreal "serially", Blender synchronous socket). A desktop server's `wait_for_stable` / `wait_for_text` can supervise long engine jobs without holding the engine socket. The desktop server should avoid sending input while an engine tool call is in flight.
- On anti-cheat-protected multiplayer titles, a desktop server should warn rather than act. Injected input is detectable by design (`LLKHF_INJECTED`), and automating such games may breach terms of service even when it works. This is a policy concern beyond the scope of the sources found.
- Because Unity deprecated its MCP for a CLI and AltTester and others add "AI Skills", the hand-off should take the form of skills or guides that name the right tool (MCP, CLI or SDK). Hard-coding one server per engine would not be enough.

### Gaps
- No vendor documentation was found on how EAC, BattlEye or Vanguard treat OS-injected input (`SendInput`, CGEvent, uinput) or MCP-driven automation. This should be stated as unknown, not assumed.
- No published case study or measurement was found comparing engine-server-only, desktop-only and combined workflows (success rate, calls, tokens) for Unreal or Unity. The only quantified evidence in scope is this repo's Blender measurements and VideoGameBench.
- Whether Steam, Epic Games Launcher or console platforms expose any agent-usable launch or state API beyond URL protocols was not verified.
