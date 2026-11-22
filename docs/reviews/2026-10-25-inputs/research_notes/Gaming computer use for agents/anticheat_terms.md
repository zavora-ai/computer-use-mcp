# Anti-cheat, synthetic-input detection, and the terms and ethics of AI agents playing games

Research date: 2026-10-25. Scope: what happens when a general desktop computer-use agent (an MCP server that injects
input and captures the screen) drives games protected by anti-cheat; what publishers' terms say; what AI vendors say;
what responsible defaults look like. Items older than 2023 are flagged **[pre-2023, possibly outdated]**. Several
publisher pages returned 403/404/timeouts to the fetcher on 2026-10-25; where a claim rests on a search-result summary
rather than a fetched page, it says so. No evasion techniques are described here.

## 1. How anti-cheat detects injected input, and whether it blocks or bans

### Takeaway
User-mode injected input (SendInput on Windows) is trivially identifiable by any process that installs a low-level hook,
and the major kernel anti-cheats go further: they vet drivers, block virtual input devices and macro software, and in at
least one case (Riot Vanguard) reject input that does not come from the primary physical peripheral. The common first
response to automation software is a block, a kick or a refusal to launch, not a ban; bans come from behavioural
evidence (input patterns, aim statistics), from tampering with the game process, or from publisher discretion under the
terms of service, which give publishers the right to ban for automation whether or not it was technically detected.

### Cited Findings
**How injected input is marked (Windows)**
- Microsoft's `MSLLHOOKSTRUCT` documentation says testing `LLMHF_INJECTED` (bit 0) tells a low-level mouse hook whether
  an event was injected, and `LLMHF_LOWER_IL_INJECTED` (bit 1) whether it came from a lower-integrity process —
  [Microsoft Learn: MSLLHOOKSTRUCT](https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-msllhookstruct)
- Raymond Chen (Microsoft, 19 March 2025): SendInput "is treated like real input, and it goes through the input system
  like hardware input", but "Synthetic input can still be detected, for example, by looking for the `LLKHF_INJECTED`
  flag in the `KBDLLHOOKSTRUCT`'s flags" —
  [The Old New Thing, "You can't simulate keyboard input with PostMessage, revisited"](https://devblogs.microsoft.com/oldnewthing/20250319-00/?p=110979)
- A NULL `RAWINPUTHEADER.hDevice` is not a clean injection signal: developers report NULL handles from real built-in
  touchpads — [Microsoft Q&A](https://learn.microsoft.com/en-za/answers/questions/1666513/getrawinputdata-header-hdevice-is-null-for-builtin)
- These flags only mark software-level injection; input from a driver or a hardware device is not flagged this way,
  which is why anti-cheat vendors police drivers and devices instead (see Vanguard, Javelin and Ricochet below). Riot's
  Vanguard kernel driver "checks other drivers and blocks those with known vulnerabilities" —
  [PC Gamer explainer](https://www.pcgamer.com/uk/the-controversy-over-riots-vanguard-anti-cheat-software-explained/)

**Riot Vanguard (Valorant, League of Legends)**
- Riot Vanguard team post (4 Feb 2025, Phillip Koskinas): "Vanguard already outright rejects input from your
  non-primary peripheral device." Pixelbots/colorbots (screen-reading cheats) are "as easy to detect as they are to
  install"; North American cheaters moved to DMA hardware costing "more than $1000". Ranked games with a cheater were
  brought "back down below 1%" globally; the median cheater in 2024 completed 6 games before a ban —
  [playvalorant.com dev post](https://playvalorant.com/en-us/news/dev/vanguard-hits-new-bans-per-second-record/)
- 2020: Riot said the Interception keyboard/mouse driver was "not supported" and Vanguard stopped the game launching
  while it was loaded; Riot said it preferred non-blocking solutions going forward **[pre-2023, possibly outdated]** —
  [Ginx](https://www.ginx.tv/en/valorant-vanguard-hotfix-mouse-keyboard-input-device-driver);
  [ComicBook](https://comicbook.com/gaming/news/valorant-updates-anti-cheat-system/?nb=1)
- League of Legends on macOS uses an application-level "Embedded Vanguard (mVG)", not the kernel driver (community
  wiki, 2024-era) — [League wiki](https://wiki.leagueoflegends.com/en-us/Riot_Vanguard)
- From 6 October 2026 Riot blocks game-memory access by default for all unknown third-party apps across League, TFT and
  Valorant; approved tools have until April 2027 to move to official APIs; Riot says the change "does not in itself lead
  to bans" (published 29 Sept 2026) —
  [Riot Support](https://support.riotgames.com/ar-ae/riot/performance/game-memory-access-removed-for-third-party-apps)

**EA Javelin (Battlefield 6, EA FC)**
- EA's 2026 update (10 Sept 2026) lists "Multiple updates blocking malicious input devices, macro software, and synthetic
  input tools", DMA-hardware blocking, Secure Boot (4.8M players enabled it) and a TPM 2.0 requirement for Battlefield 6;
  EA says each detection must be "effective against cheaters without impacting legitimate play styles or accessibility
  tools" and "We could ban more, faster, but we'd risk false positives" —
  [EA](https://www.ea.com/news/ea-javelin-anticheat-2026-update)
- An EA anti-cheat team post (about 2025; page 403 to the fetcher, content from search summary) says EA blocked a
  remapping product's virtual devices after its users shared scripts that automated skill checks, and pointed players to
  Steam Input or Microsoft's Keyboard Manager for accessibility —
  [EA Forums](https://forums.ea.com/discussions/ea-forums-general-discussion-en/ea-javelin-anticheat--recent-software-blocks/12218073)
- EA's help pages identify blocked software by driver name — [EA Help](https://help.ea.com/fr/help/pc/ea-anticheat/);
  a user reports a block on "Interception" after the driver's service was gone (possible leftover-component false
  positive) — [EA Forums](https://forums.ea.com/discussions/fc-26-technical-issues-en/ea-javelin-anticheat-falsely-detects-interception-on-windows-11-steam-version/13540404)

**Activision Ricochet (Call of Duty)**
- Season 02 of Black Ops 7 (Feb 2026) targets "unapproved third-party hardware, such as Cronus Zen and XIM Matrix" that
  simulates "machine-perfect aim and recoil control"; Ranked Play adds remote, cloud-based attestation with Microsoft that
  blocks tampered systems before matches (official page timed out to the fetcher; content from search summary) —
  [Call of Duty blog](https://www.callofduty.com/blog/2026/02/call-of-duty-black-ops-7-ricochet-anti-cheat-season-02)
- Coverage says the detection analyses input behaviour over extended periods rather than looking for a plugged-in device —
  [Gfinity](https://www.gfinityesports.com/article/black-ops-7-season-02-could-be-bad-news-for-cronus-and-xim-players-in-ranked-play);
  an earlier "Unsupported Device Warning" escalates to "mitigations or a permanent ban" —
  [Windows Central](https://windowscentral.com/gaming/xbox/activision-takes-a-stand-against-xim-cheating-in-call-of-duty-with-new-ricochet-countermeasures)

**FACEIT, BattlEye, Easy Anti-Cheat, VAC**
- FACEIT AC requires an app plus a kernel-mode driver loaded at boot, and Windows Secure Boot and TPM 2.0 (support page
  403 to the fetcher; from search summary) —
  [FACEIT Support](https://support.faceit.com/hc/en-us/articles/9394666828188-What-is-FACEIT-Anti-cheat-and-how-does-it-work);
  dust2.us reports Windows 10 support ends 14 Oct 2026 and IOMMU and VBS become required —
  [dust2.us](https://www.dust2.us/news/66964/faceit-announces-major-anti-cheat-update). FACEIT developer docs say known
  cheat software is blocked immediately — [FACEIT Labs docs](https://labs-docs.faceit.com/AntiCheat/GettingStarted/). A
  third-party blog lists the client error "AutoHotkey is forbidden" (secondary) —
  [Profilerr](https://profilerr.net/pl/faceit-antycheat-blad-uruchamiania/)
- BattlEye can scan all RAM and game- and system-related files while the game runs (Ubisoft-hosted 2016 FAQ
  **[pre-2023, possibly outdated]**) — [Ubisoft BattlEye FAQ](https://www.ubisoft.com/en-us/game/rainbow-six/siege/news-updates/2999gdyIXLbeiZP78R7545/battleye-faq);
  Rockstar's FAQ says it collects information about running processes, drivers and other executable code —
  [Rockstar](https://support.rockstargames.com/articles/1nenwhZlVrJY6CTFeSS2Fx/grand-theft-auto-online-battleye-faq);
  Epic's help page says a "Disallowed Program" kick (macro and automation tools among common triggers) is "not a ban" —
  [Epic Help](https://www.epicgames.com/help/technical-support-c-36624475/c-Trending_0/disallowed-program-kick-battleye-a20061018)
- Easy Anti-Cheat: a game developer's FAQ lists "cheat software, untrusted and/or unknown system files, debuggers, or
  otherwise suspicious software" as flag causes; bans are set per game by the developer (no official EAC page found) —
  [Saber EAC FAQ](https://support.saber.games/hc/en-us/articles/22303848570001-Easy-Anti-Cheat-FAQ)
- ARC Raiders (Embark) flags a disallowed-software list that "often" includes AutoHotkey scripts; the error is not a
  ban, but playing on with the flagged process can bring disciplinary action (page 404 on 2026-10-25; from search
  summary) — [Embark FAQ](https://id.embark.games/arc-raiders/support/faq/163-fatal-error-cheat-software-detected)
- Valve CS2 (19 Aug 2024): players suspected of turning one input into several actions (null binds, Snap Tap) can be
  kicked from Valve official servers; multi-command binds are ignored by default —
  [dust2.us](https://www.dust2.us/news/51933/cs2-8-19-update-null-binds-snaptap-and-jump-binds-banned-in-latest-update);
  [esports.gg](https://esports.gg/news/counter-strike-2/valve-ban-snap-tap-and-other-movement-automations-in-cs2)

**Ban examples showing the risk to legitimate software (2023-2026)**
- Oct 2023: VAC banned CS2 players using AMD's Anti-Lag+, which Valve said was implemented "by detouring engine dll
  functions"; Valve later unbanned them — [PCWorld](https://www.pcworld.com/article/2106874/amd-anti-lag-is-causing-player-bans-in-counter-strike-2-apex-legends.html);
  [TechRaptor](https://techraptor.net/gaming/news/amd-latest-driver-can-get-you-banned-in-counter-strike-2);
  [Ensigame](https://ensigame.com/news/cs-2/valve-has-granted-amnesty-to-all-players-who-mistakenly-received-vac-bans-in-cs2)
- Jan 2025: Marvel Rivals' anti-cheat banned macOS and Steam Deck players (bans ran to 2124); NetEase reversed them —
  [GamingOnLinux](https://gamingonlinux.com/2025/01/marvel-rivals-team-issue-a-statement-on-recent-bans-for-steam-deck-and-macos-players);
  [Slashdot/Ars](https://games.slashdot.org/story/25/01/03/1929250/marvel-game-developer-reverses-century-long-bans-on-linux-mac-users)
- AI/vision cheats: the Userviz capture-card + YOLO aimbot was discontinued in 2021 after Activision complained
  **[pre-2023, possibly outdated]** — [DeepLearning.AI The Batch](https://www.deeplearning.ai/the-batch/fake-aim);
  [Gigazine](https://www.gigazine.net/gsc_news/en/20210715-auto-aim-cheat-development-stop). Anti-Cheat Expert (Tencent)
  wrote in 2025 that visual AI cheats mimic human inputs —
  [ACE](https://intl.anticheatexpert.com/resource-center/content-60.html)

### Inferences
- A computer-use server that posts input through SendInput (Windows) or CGEventPost (macOS) cannot be invisible to a
  game that cares, and should not try to be. In Vanguard-protected Valorant its clicks would most likely just be
  ignored; under Javelin or FACEIT the server, or a driver it installs, could stop the game launching; in CoD, CS2 or
  any game that scores input behaviour, sustained agent play is ban risk.
- "Blocked, not banned" holds only for the first encounter. The terms (Q3) let publishers ban for automation whatever
  the detector found, and behaviour-based systems (Ricochet, Vanguard's pixelbot work) look at the result, not the API.
- The two false-positive episodes (Anti-Lag+, Marvel Rivals) show that injecting into a game process or running in an
  unusual environment can get legitimate users banned. A server that hooks into game processes (for example a capture
  hook, see Q2) carries more risk than one that only captures windows and posts OS-level events.
- Single-player: no source says kernel anti-cheat bans for synthetic input in offline single-player modes. The risk sits
  in online modes, in games whose anti-cheat runs in every mode, and in account-level progress (achievements, see Steam
  §4.C in Q3).

### Gaps
- No source examined how macOS games or anti-cheats treat synthetic CGEvents (the event carries source fields such as
  `kCGEventSourceUnixProcessID`, but no source showed a game using them). Apple's `CGEventField` docs would be the start.
- No official EAC or BattlEye page on synthetic input or macro policy was reachable; the game-specific pages above are
  the best available.
- No 2024-2026 report was found of an account banned specifically for letting a general AI computer-use agent (Claude,
  Operator, Gemini) play a game. The absence may reflect low usage, not tolerance.

## 2. Do anti-cheat systems block or flag screen capture or OCR? DRM and protected content

### Takeaway
No source shows a major anti-cheat flagging OS-level capture (Desktop Duplication, Windows.Graphics.Capture,
ScreenCaptureKit) or OCR as such. What anti-cheat does block is hook-based capture that injects into the game process
(OBS "Game Capture"), where window or display capture is the documented fallback. Screen-reading cheats are caught
through what they do with the screen (moving the mouse), not through the capture itself. Games do not normally use DRM
capture protection; a window can opt out of capture with `SetWindowDisplayAffinity`.

### Cited Findings
- OBS users report a Roblox anti-cheat update blocking Game Capture (black screen); Window Capture works —
  [OBS Forum](https://obsproject.com/forum/threads/roblox-game-capture-not-working-just-a-black-screen.167811)
- Riot describes pixelbots as reading "the screen" and applying "a simplified image classifier to each frame", then needing
  "a method" to move the mouse, which Vanguard counters by rejecting non-primary-device input; Riot says it puts "most of
  them down pretty quickly" — [Riot](https://playvalorant.com/en-us/news/dev/vanguard-hits-new-bans-per-second-record/)
- Riot's October 2026 memory-access block does not mention screen capture or input automation —
  [Riot Support](https://support.riotgames.com/ar-ae/riot/performance/game-memory-access-removed-for-third-party-apps)
- `SetWindowDisplayAffinity` makes a window disappear from screenshots, screen shares and Recall snapshots; IOActive
  argues the flag is weaker than vendors suggest — [IOActive](https://www.ioactive.com/the-drm-flag-that-isnt-drm/)
- Microsoft's own Gaming Copilot takes gameplay screenshots from the Xbox Game Bar (Aug 2025 Insider beta, later wider
  rollout) — [Xbox Wire](https://news.xbox.com/en-us/2025/08/06/gaming-copilot-beta-begins-rolling-out-to-xbox-insiders-on-game-bar-today/);
  [PCWorld](https://www.pcworld.com/article/2916658/microsofts-copilot-is-coming-to-inject-ai-into-your-windows-pc-games.html).
  Commentators asked whether anti-cheat would detect or mistakenly block it, without an answer from Microsoft or a vendor —
  [Igor's Lab](https://www.igorslab.de/en/microsoft-brings-gaming-copilot-to-the-xbox-game-bar-useful-helper-or-just-ballast/);
  one outlet says it is not yet "officially greenlit by tournament organizers or anti-cheat vendors" (secondary) —
  [WindowsNews.ai](https://windowsnews.ai/article/microsofts-gaming-copilot-beta-hits-windows-11-voice-help-for-gamers-with-an-18-age-gate.381394)
- Oct 2025: a user reported Gaming Copilot sending captures, including from an NDA game, to Microsoft; Microsoft said
  screenshots are used to understand gameplay and not to train models, while text and voice conversations may be —
  [Tom's Guide](https://www.tomsguide.com/ai/copilot/gaming-copilot-ai-under-fire-but-microsoft-says-its-not-training-ai-models-on-your-data);
  [heise](https://heise.de/-10900114)
- Riot's developer policy bars in-game apps and overlays that give real-time data that "would improve a player's
  performance immediately by altering player behavior (i.e. 'go here now')" and apps that track opponents or predict
  their plays; post-game coaching is allowed —
  [Riot Developer API Policy](https://support-developer.riotgames.com/hc/en-us/articles/22698732381587);
  [Valorant developer docs](https://developer.riotgames.com/docs/valorant)

### Inferences
- Capture through the compositor (the macOS ScreenCaptureKit helper, Windows.Graphics.Capture) is the low-risk path;
  this server should never inject a capture hook into a game process.
- Even capture-only use is not policy-neutral: in Riot titles, an agent that watches the screen and gives live tactical
  advice falls under the "go here now" prohibition, whether or not anti-cheat sees it.
- An NDA build is a confidentiality risk if captures leave the machine; the Gaming Copilot episode shows players
  notice.

### Gaps
- No vendor documentation was found that says whether Vanguard, EAC, BattlEye, FACEIT or Ricochet flag a process that
  repeatedly calls Desktop Duplication or Windows.Graphics.Capture on the game window. Needs vendor contact or testing
  with a throwaway account in a title whose terms allow it.
- No source on games using `SetWindowDisplayAffinity` or protected swap chains to blank captures.

## 3. What publishers' terms say about bots, macros, automation and AI agents

### Takeaway
Every major publisher's terms prohibit unauthorised bots, scripts, macros and automation, and none carves out AI agents.
The wording differs in scope: Riot and Blizzard ban automation of their services "in any way, for any purpose" or
"automated control of a Game" with no single-player distinction; Epic ties the ban to advantage over other players;
Valve's Steam Subscriber Agreement (updated 10 Sept 2026) has a separate "Automation" section that, as fetched, has no
single-player or accessibility exception and covers earning progress without genuine user input. Nintendo now reserves
the right to make a device "permanently unusable". No publisher has published an explicit AI-agent policy that we
could find.

### Cited Findings
- **Valve, Steam Subscriber Agreement** (last updated 10 Sept 2026): §4.B "You agree that you will not create Cheats or
  assist third parties in any way to create or use Cheats" and will not "disable, circumvent, or otherwise interfere with
  the operation of software designed to prevent or report the use of Cheats"; the Cheats definition refers to
  "multiplayer versions". §4.C, titled "Automation": "You may not use any form of scripts, bots, macros, or other
  non-human-controlled systems"; as summarised by the fetch, it lists automating account creation, faking gameplay
  statistics, earning rewards or progress without genuine user input, and automated participation in review systems such
  as Overwatch. §4.D: enforcement by "automated detection methods and human review"; Valve "may restrict or terminate
  your Account(s)... for any conduct... that... constitutes a Cheat or Automation", without notice. The fetch found no
  single-player or accessibility exception in §4 —
  [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/)
- **Riot Games Terms of Service** (last modified 1 Dec 2024), §7.1: prohibits "Using any unauthorized third party
  programs, including mods, hacks, cheats, scripts, bots, trainers and automation programs that interact with the Riot
  Services in any way, for any purpose", including programs that "intercept, emulate, or redirect any communication" or
  read game memory; §9.2: "we may require you to install anti-cheat software to play our games"; cheat claims are carved
  out of arbitration — [Riot ToS](https://www.riotgames.com/en/terms-of-service)
- **Blizzard EULA** (revised 21 Mar 2024), §1.C: prohibits "bots; i.e. any code and/or software, not expressly
  authorized by Blizzard, that allows the automated control of a Game" and "cheats; i.e. methods not expressly authorized
  by Blizzard"; Blizzard "MAY MONITOR YOUR COMPUTER... MEMORY FOR UNAUTHORIZED THIRD PARTY PROGRAMS" —
  [Blizzard EULA](https://www.blizzard.com/en-us/legal/fba4d00f-c7e4-4883-b8b9-1b4500a402ea/blizzard-end-user-license-agreement).
  Blizzard's input-broadcasting policy treats software that mirrors one keystroke to several WoW clients as actionable
  **[pre-2023, possibly outdated: 2020-2021]** —
  [Blizzard News](https://news.blizzard.com/en-us/article/23558957/policy-update-for-input-broadcasting-software)
- **Epic, Fortnite EULA** (last updated 17 Dec 2024): prohibits "running or using methods which are not authorized by
  Epic and which interfere with the outcome and/or the course of the Software (including Cheats, bots, scripts, or mods
  not expressly authorized by Epic) by giving you and/or another user an advantage over other players"; refusing or
  disabling Cheat Detection terminates the licence; Cheat Detection "may collect and transmit details about your account,
  gameplay, and potentially unauthorized programs or processes"; "Cheats" are processes that "may give players an unfair
  competitive advantage" — [Epic Fortnite EULA (PDF)](https://cdn1.epicgames.com/eulatracking-download/fn/en/v9/r8/3b853b765f5c4f9129b31e349d0775c5.pdf).
  Epic has sued cheat users and sellers for copyright infringement and breach of contract **[2017-2018, possibly
  outdated]** — [GameSpot](https://www.gamespot.com/articles/epic-games-sues-alleged-fortnite-cheaters/1100-6454041/)
- **Roblox**: the official Terms of Use returned 403 to the fetcher. A community wiki lists bot use and
  "exploiting (cheating)" among prohibited conduct under the Community Standards (secondary) —
  [Roblox Wiki](https://roblox.fandom.com/wiki/Roblox_Terms_of_Use). Roblox's Hyperion/Byfron anti-cheat blocked running
  under Wine on Linux and Steam Deck in 2024 — [It's FOSS](https://itsfoss.com/news/roblox-linux-end/);
  [GamingOnLinux](https://www.gamingonlinux.com/2024/03/game-over-for-roblox-on-linux-steam-deck-as-its-now-blocked/page=1)
- **Mojang / Minecraft**: the EULA (fetch timed out; from search summary) lets Java Edition owners modify the game with
  mods, tools or plugins, and the Usage Guidelines are permissions Mojang may "withdraw... at any time without notice";
  anti-cheat on multiplayer servers is set by each server, not Mojang — [Minecraft EULA](https://www.minecraft.net/en-us/eula)
- **Nintendo**: the Nintendo Account User Agreement effective 7 May 2025 says Nintendo may "render the Nintendo Account
  Services and/or the applicable Nintendo device permanently unusable in whole or in part" for violations, which now
  explicitly include unauthorised software or hardware —
  [Android Authority](https://www.androidauthority.com/nintendo-user-agreement-update-3556245);
  [Nintendo Everything](https://nintendoeverything.com/nintendo-says-it-could-brick-switch-systems-if-users-bypass-modify-decrypt-defeat-tamper-with-their-games-in-updated-agreement/).
  Emulators: Yuzu's developers settled with Nintendo in March 2024 for $2.4M and stopped distribution; the settlement set
  no court precedent —
  [TechRaptor](https://techraptor.net/gaming/news/creators-of-switch-emulator-yuzu-surrender-to-nintendos-demands-and-settle-out-of-court);
  [MobileSyrup](https://mobilesyrup.com/2024/03/04/nintendo-yuzu-settlement-payout-emulator-shutdown/);
  [Galaxus](https://www.galaxus.de/en/page/switch-emulator-yuzu-is-dead-32086)
- **AI-specific policies**: an extended search found 2026 policy activity on AI-generated content disclosure (Steam,
  Google Play) and Unity's AI-training terms, but no publisher policy on AI agents playing games —
  [Legal Moves (Steam AI policy)](https://legalmoveslawfirm.com/steam-ai-policy/) (secondary)

### Inferences
- Under Riot, Blizzard and Steam (§4.C) terms, an AI agent that plays the game for the user is "automation" or a "bot"
  on the plain wording, including in solo or PvE modes. Epic's wording is narrower (advantage over other players), so
  Fortnite Creative or solo play is less clearly covered, but Epic still reserves sole judgment.
- Steam §4.C's "earn rewards or progress without genuine user input" (fetch summary; verify the verbatim text) would
  reach an agent unlocking achievements or grinding items in a single-player Steam game. That is account-level risk that
  does not depend on any anti-cheat.
- The safest legal ground is: games the user develops or has a licence to test; open-source games; publisher-sanctioned
  research partnerships (as SIMA had, Q5); and the user's own legally obtained copies played offline, where the residual
  risk is a terms breach the publisher is unlikely to see, not a ban.
- Emulators: running a ROM the user dumped from their own cartridge is a different legal question from downloading
  one; a general server cannot tell which is which and should not ship or fetch ROMs.

### Gaps
- Official Roblox Terms of Use and Community Standards text (403), the current Pokémon Company and Nintendo game EULAs,
  Ubisoft, EA User Agreement, Take-Two/Rockstar, Krafton and Microsoft/Xbox (Microsoft Services Agreement, Code of
  Conduct) were not retrieved.
- §4.C of the Steam agreement was read through a summarising fetch; the exact sentence boundaries of the "including"
  list should be verified before quoting it in a published document.
- No court decision was found on whether automation clauses bind single-player, offline use.

## 4. Accessibility exceptions

### Takeaway
There is no formal accessibility exemption from anti-automation rules at any major publisher. Platforms provide
sanctioned accessibility paths instead (Xbox Copilot controller pairing, adaptive hardware, Steam Input, Microsoft
Keyboard Manager), and anti-cheat vendors say they try not to break assistive tools while blocking macro and virtual-input
software. An AI agent cannot claim an accessibility exception that does not exist.

### Cited Findings
- Xbox "Copilot" (the controller feature, not the AI) links two controllers so "you can use them as if they were one
  controller" — [Xbox Accessibility](https://www.xbox.com/en-IE/community/for-everyone/accessibility); only the pilot
  account earns achievements — [SlashGear](https://www.slashgear.com/1414047/xbox-feature-combine-two-controllers-copilot/)
- EA Javelin: key remapping has accessibility uses, so EA points players to Steam Input or Microsoft's Keyboard Manager,
  while blocking a vendor's virtual devices (about 2025; from search summary) —
  [EA Forums](https://forums.ea.com/discussions/ea-forums-general-discussion-en/ea-javelin-anticheat--recent-software-blocks/12218073);
  EA's 2026 update says detections must not impact "accessibility tools" — [EA](https://www.ea.com/news/ea-javelin-anticheat-2026-update)
- Blizzard forum replies suggest contacting Blizzard directly when input software is needed for accessibility (player
  forum, not policy) — [Blizzard Forums](https://us.forums.blizzard.com/en/wow/t/autohotkey-to-stop-alt-tab/834171)
- 2009: AbleGamers reported GameGuard blocking on-screen keyboards and other assistive tools along with cheats
  **[pre-2023, possibly outdated]** — [IGDA GA-SIG](https://igda-gasig.org/?p=3106)
- Steam §4 has no accessibility exception as fetched — [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/)
- Players with disabilities losing remapping setups in THE FINALS and HELLDIVERS 2 (anecdotes) —
  [Steam Community](https://steamcommunity.com/app/2073850/discussions/0/4133808627031990988)

### Inferences
- A computer-use server can be an accessibility tool in general (voice-driven desktop control), but in a protected game
  it should send the user to the platform-sanctioned path (Steam Input, the console's own features, the game's
  accessibility options) rather than present agent play as an exemption.
- If the team wants an accessibility mode for games, the precedent is per-title permission from the publisher, not a
  global switch.

### Gaps
- No publisher's written accessibility-exemption process for automation was found (Riot, Valve, Blizzard, Epic,
  Microsoft). Microsoft's Xbox Accessibility Guidelines were not reviewed for automation guidance.

## 5. How AI game-agent projects position themselves

### Takeaway
The public game-agent projects run on single-player titles, mostly through emulators or with studio partnerships, and
present themselves as research or benchmarks. None of the sources found discusses publisher terms, ROM provenance or
anti-cheat. The only project with an explicit licensing arrangement is DeepMind's SIMA, built with partner studios.

### Cited Findings
- **Claude Plays Pokémon** (Anthropic, Feb 2025): Claude 3.7 Sonnet played Pokémon Red on Twitch with "basic memory,
  screen pixel input, and function calls to press buttons"; Anthropic called Pokémon "a useful benchmark" —
  [TechCrunch 24 Feb 2025](https://techcrunch.com/2025/02/24/anthropic-used-pokemon-to-benchmark-its-newest-ai-model);
  [TechCrunch 25 Feb 2025](https://techcrunch.com/2025/02/25/anthropics-claude-ai-is-playing-pokemon-on-twitch-slowly).
  Sources conflict on who runs it: TechCrunch says Anthropic launched it, Tom's Guide calls it "a passion project made by
  a person who loves Claude and loves Pokémon" —
  [Tom's Guide](https://tomsguide.com/ai/claude-ai-has-been-continously-playing-pokemon-red-for-over-a-month-it-still-cant-beat-it).
  Secondary coverage says the harness reads emulator RAM —
  [Artificial Advantage](https://artificialadvantage.substack.com/p/ai-vs-pokemon-how-gemini-and-claude)
- **Gemini Plays Pokémon** (2025): run by Joel Z, unaffiliated with Google; Gemini 2.5 Pro finished Pokémon Blue with a
  harness supplying RAM data and a pathfinding tool; Joel Z says it is not a fair benchmark —
  [TechCrunch](https://techcrunch.com/2025/05/03/googles-gemini-has-beaten-pokemon-blue-with-a-little-help);
  [LessWrong mirror](https://www.greaterwrong.com/posts/7mqp8uRnnPdbBzJZE/is-gemini-now-better-than-claude-at-pokemon)
- **Cradle** (BAAI and others, Mar-Jul 2024): screenshots in, keyboard and mouse out, on four commercial games
  (Red Dead Redemption 2, Cities: Skylines, Stardew Valley, Dealer's Life 2) plus apps; the paper page has no legal or
  ethics discussion — [arXiv 2403.03186](https://arxiv.org/abs/2403.03186)
- **SIMA** (Google DeepMind, Mar 2024): trained and evaluated with eight game studios on nine games plus research
  environments; a research project, not a product —
  [DeepMind](https://deepmind.google/blog/sima-generalist-ai-agent-for-3d-virtual-environments/);
  [SiliconANGLE](https://siliconangle.com/2024/03/13/google-deepminds-sima-ai-agent-can-play-video-games-never-seen/)
- **VideoGameBench** (May 2025, revised May 2026): ten 1990s games played from raw frames, three kept secret; no
  licensing or ROM discussion on the abstract page — [arXiv 2505.18134](https://arxiv.org/abs/2505.18134)

### Inferences
- The field's norm is single-player, offline or emulated, research framing. Nobody is publicly running general agents
  in ranked online play, which matches the terms in Q3.
- The Pokémon projects rely on emulator RAM access and custom tools, not pure screen-and-input play. A general desktop
  server that offers only pixels and synthetic input is harder for agents to use and has no special legal standing.

### Gaps
- No project disclosed ROM provenance or an agreement with Nintendo or The Pokémon Company; no statement from either on
  AI streams was found.
- Cradle's full paper (beyond the abstract) was not reviewed for an ethics statement.

## 6. What AI computer-use products say about games, CAPTCHAs and anti-bot systems

### Takeaway
None of the major computer-use products names video games or anti-cheat in its public policy. They converge on three
patterns this server can reuse: hand off human-verification (CAPTCHAs) and legal consent to the user; block or downgrade
categories of apps and sites by default (trading, crypto, adult, piracy); and a usage policy that forbids getting around
other platforms' terms and security controls.

### Cited Findings
- **Anthropic computer-use tool docs**: recommends a dedicated VM or container, a domain allowlist, and "Asking a human
  to confirm decisions that might result in meaningful real-world consequences and any tasks requiring affirmative
  consent, such as accepting cookies, completing financial transactions, or agreeing to terms of service"; classifiers
  scan screenshots for prompt injection —
  [Claude Platform docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- **Claude Code / Claude Desktop computer use**: per-session per-app approval; "browsers and trading platforms are
  view-only, terminals and IDEs are click-only, and everything else gets full control"; global Esc abort whose key press
  is consumed "so prompt injection can't use it to dismiss dialogs" (no games category is named) —
  [Claude Code docs](https://code.claude.com/docs/en/computer-use). Safety article: "some sensitive apps (investment and
  trading platforms, cryptocurrency) are blocked by default"; users can add a blocklist —
  [Claude Help Center](https://support.claude.com/en/articles/14128542-computer-use-safety)
- **Claude in Chrome**: blocks adult and known pirated-content sites; asks before financial sites (the 2025 launch post
  blocked financial sites outright) — [Claude Help Center](https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely);
  [Anthropic](https://www.anthropic.com/news/claude-for-chrome)
- **Anthropic Usage Policy** (version fetched 2026-10-25 shows an effective date of 12 Nov 2026): prohibits actions
  "that circumvent the guardrails or terms of other platforms or services"; "Bypass security controls such as
  authentication systems, endpoint protection, or monitoring tools without authorization"; and "Utilize automation in
  account creation or to engage in spammy behavior". It does not mention games, cheating or CAPTCHAs —
  [Anthropic AUP](https://www.anthropic.com/legal/aup)
- **OpenAI Operator / ChatGPT agent** (Jan 2025): "trained to proactively ask the user to take over for tasks that
  require login, payment details, or when solving CAPTCHAs"; Operator was later folded into ChatGPT agent (page 403 to the
  fetcher; from search summary) — [OpenAI](https://openai.com/index/introducing-operator/)
- **Google Gemini computer use** (docs updated 2026-10-22): every action carries a `safety_decision`; on
  `require_confirmation` the client must prompt the user; categories include `ACCOUNT_CREATION`,
  `LEGAL_TERMS_AND_AGREEMENTS` and `USER_CONSENT_MANAGEMENT`; the sample system instruction says "You MUST NEVER attempt
  to solve or bypass" CAPTCHAs "(of any kind)" and "Any other anti-robot or human-verification mechanisms, even if you are
  capable" — [Gemini API docs](https://ai.google.dev/gemini-api/docs/computer-use). In Oct 2025 Simon Willison watched
  Gemini 2.5 Computer Use solve a Google CAPTCHA unprompted in Browserbase's demo —
  [Simon Willison](https://simonwillison.net/2025/Oct/7/gemini-25-computer-use-captchas-retracted)
- **Microsoft Gaming Copilot**: advisory only (tips when stuck), uses gameplay screenshots in Voice Mode, controllable
  under Capture Settings; the announcement says nothing on anti-cheat or fair play —
  [Xbox Wire](https://news.xbox.com/en-us/2025/08/06/gaming-copilot-beta-begins-rolling-out-to-xbox-insiders-on-game-bar-today/)

### Inferences
- Anti-cheat is plausibly a "monitoring tool" and publisher terms are "terms of other platforms" under Anthropic's AUP,
  so an agent built on Claude that is used to beat anti-cheat or break game terms is a usage-policy problem for the
  user, separate from any ban.
- The CAPTCHA pattern (refuse, hand off to the human) maps directly onto anti-cheat: a game's anti-cheat is a
  human-verification mechanism in effect, and Gemini's sample instruction would cover it by its "any other anti-robot"
  wording.
- Microsoft's first-party product positions itself as a coach that watches, not a player that acts. That is the
  publicly sanctioned ceiling for AI in commercial games today.

### Gaps
- OpenAI's and Microsoft's usage policies were not fetched for game-specific language. No vendor statement on agents
  playing games, or on anti-cheat, was found.

## 7. Practical recommendations: detect anti-cheat and refuse or warn? Precedents

### Takeaway
Yes. There is direct precedent for category-based defaults in computer-use products (Anthropic's app tiers and
blocklists, Claude in Chrome's site categories, Gemini's anti-robot instruction, Operator's CAPTCHA handoff) and in the
gaming ecosystem (Riot's developer policy, EA's preference for sanctioned accessibility paths). A responsible default for
this server: detect protected games, refuse input to them by default with a clear reason, keep capture and coaching
available with a warning, never hide or disguise synthetic input, and let the user opt in per title only for games they
own, develop or have permission to automate.

### Cited Findings
- Claude Code computer use: app-category control levels (view-only, click-only, full), default-blocked sensitive apps,
  user blocklist, per-app session approval —
  [Claude Code docs](https://code.claude.com/docs/en/computer-use);
  [Claude Help Center](https://support.claude.com/en/articles/14128542-computer-use-safety)
- Claude in Chrome category blocklist (adult, piracy) and ask-first for finance —
  [Claude Help Center](https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely)
- Gemini: "Any other anti-robot or human-verification mechanisms, even if you are capable" listed under "MUST NEVER
  attempt to solve or bypass" — [Gemini API docs](https://ai.google.dev/gemini-api/docs/computer-use)
- Operator: hands control to the user for CAPTCHAs — [OpenAI](https://openai.com/index/introducing-operator/)
- Riot: no real-time "go here now" advice during matches; unknown third-party apps blocked from game memory from 6 Oct
  2026 — [Riot Developer API Policy](https://support-developer.riotgames.com/hc/en-us/articles/22698732381587);
  [Riot Support](https://support.riotgames.com/ar-ae/riot/performance/game-memory-access-removed-for-third-party-apps)
- Steam §4.B forbids interfering with anti-cheat; §4.C forbids automation —
  [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/)
- Automation communities: the AutoHotkey forum drafted rules against game cheating and code that bypasses security
  measures "including games"; the AutoIt forum disallowed game-related threads entirely **[pre-2023, possibly
  outdated]** — [AutoHotkey forum](https://autohotkey.com/boards/viewtopic.php?p=183029);
  [AutoIt forum](https://autoitscript.com/forum/topic/190509-the-letter-c-could-ban-me-from-this-forum)
- False positives exist and are sometimes reversed (Anti-Lag+, Marvel Rivals), so a ban is a real cost even when
  unintended — [PCWorld](https://www.pcworld.com/article/2106874/amd-anti-lag-is-causing-player-bans-in-counter-strike-2-apex-legends.html);
  [GamingOnLinux](https://gamingonlinux.com/2025/01/marvel-rivals-team-issue-a-statement-on-recent-bans-for-steam-deck-and-macos-players)
- This server already has the hooks: a sensitive-app gate that requires approval, `COMPUTER_USE_BLOCKED_APPS`,
  `COMPUTER_USE_CREDENTIAL_APPS`, the guidance never to pass `force: true` unless the person asked, and structured
  refusals with `hint` and `next_call` —
  `/Users/jameskaranja/Developer/projects/mcp-servers/computer-use-mcp/AGENTS.md`

### Inferences (proposed defaults for computer-use-mcp)
1. **Detect, don't guess.** Add a built-in "anti-cheat-protected" category next to the credential-app list, matched on
   known anti-cheat services, drivers and launcher processes (Vanguard, EAC, BattlEye, FACEIT, Javelin, Ricochet,
   Hyperion and others) and on the target window's process. Report it in `doctor` and `get_app_capabilities`.
2. **Default to refusing input, not capture.** For a protected target, input tools, `run_steps` and accessibility actions
   return a named refusal (for example `anticheat_protected`) with the ban risk stated and a read-only `next_call`.
   Screenshots and OCR stay allowed, with a one-time warning that live advice may itself break a title's rules (Riot) and
   that captures of NDA builds are confidential.
3. **Opt-in only per title, by the person.** An env allowlist (for example `COMPUTER_USE_GAME_AUTOMATION_ALLOWED=<app ids>`)
   for the user's own game, a dev build, an open-source game, or a title whose publisher permits automation. Never a
   blanket switch, and never enabled by anything the model reads on screen.
4. **Never conceal.** No driver-level injection, no virtual HID devices, no clearing of injection markers, no
   timing "humanisation" aimed at detectors, no hooks inside game processes. Steam §4.B, Riot §7.1 and Anthropic's AUP all
   point the same way, and concealment would turn a terms breach into deliberate circumvention.
5. **Treat human-verification as a handoff.** CAPTCHAs, "are you a robot" checks and anti-cheat challenges go to the
   person, as Operator and Gemini do.
6. **Say what is safe.** Document that emulators with user-owned ROMs, single-player games offline, games the user
   develops and engine editors (Unreal, Blender) are the intended game uses, and that online multiplayer, ranked play and
   account progress on Steam, Riot, Blizzard or Epic are not.
7. **Accessibility.** Point users to platform-sanctioned tools (Steam Input, console accessibility settings) rather than
   offering agent play as an accessibility exception, because no publisher grants one.

### Gaps
- A verified list of anti-cheat process, service and driver names per platform (Windows, macOS, Linux/Proton) is needed;
  none was compiled from a primary source here, and names change with versions.
- No precedent was found of a general-purpose automation or computer-use product that detects anti-cheat and refuses;
  the precedents above are category blocklists and CAPTCHA handoffs, so this server would be setting the pattern.
- Whether refusing on detection could itself break legitimate use (for example a game developer testing their own
  EAC-integrated build) needs a design decision; the per-title allowlist is the proposed answer.
