# User pain points and missing features in first-party / hosted computer-use and browser agents (state as of 2026-10-25)

Labels used throughout: **[User]** = forum post, store review, HN comment, GitHub issue; **[Press]** = journalist or independent reviewer opinion/test; **[Vendor]** = the company's own docs, help pages or claims; **[Third-party blog]** = SEO/affiliate/competitor content, lower weight. Dates are publication or post dates; "accessed 2026-10-25" means a live page with no absolute date. Reddit could not be read directly (the crawler is blocked from reddit.com), so Reddit sentiment only appears where press or blogs relay it.

Landscape changes that matter for reading older complaints:
- OpenAI: Operator (Jan 2025, cloud VM) became ChatGPT agent (Jul 17, 2025). Atlas (Oct 21, 2025, macOS only) shut down Aug 9, 2026. ChatGPT agent was removed in early Aug 2026. ChatGPT Work (launched Jul 9, 2026) replaced it, with computer use on the person's own Mac/Windows desktop, a cloud browser, and a Chrome extension. Codex has a Computer Use plugin (macOS and Windows). — [Wikipedia: ChatGPT Atlas](https://en.wikipedia.org/wiki/ChatGPT_Atlas); [TNW, 2026-07-10](https://thenextweb.com/news/openai-chatgpt-work-agent-launch); [Carly blog, updated 2026-08-11](https://www.usecarly.com/blog/chatgpt-agent-mode/); [TechCrunch, 2025-07-17](https://www.techcrunch.com/2025/07/17/openai-launches-a-general-purpose-agent-in-chatgpt)
- Google: Project Mariner shut down May 4, 2026. Its tech went into Gemini Agent, AI Mode and Chrome "auto browse". — [GIGAZINE citing The Verge, 2026-05-07](https://gigazine.net/gsc_news/en/20260507-google-shuts-down-project-mariner/); [Digital Trends](https://digitaltrends.com/computing/google-pulls-the-plug-on-project-mariner-the-ai-agent-that-browsed-the-web-like-a-human/)
- Anthropic: Claude for Chrome went from a research preview (Aug 26, 2025) to beta on all paid plans (Dec 18, 2025). Computer use in Cowork and Claude Code launched Mar 23, 2026 (macOS research preview). It is now in beta on macOS and Windows. — [Anthropic](https://www.anthropic.com/news/claude-for-chrome); [Claude help: Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome); [Engadget, 2026-03-23](https://www.engadget.com/ai/claude-code-and-cowork-can-now-use-your-computer-210000126.html); [Claude help: computer use in Cowork, accessed 2026-10-25](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
- Microsoft: Copilot Actions / agent workspace has been an Insider and Copilot Labs preview since Nov 17, 2025. I found no GA by Oct 2026. Copilot Studio computer use reportedly went GA May 13, 2026, but its hosted browser is still a preview. — [Windows Insider blog, 2025-11-17](https://blogs.windows.com/windows-insider/2025/11/17/copilot-on-windows-copilot-actions-begins-rolling-out-to-windows-insiders/); [digitalapplied (third-party)](https://www.digitalapplied.com/blog/copilot-studio-computer-use-agents-ga-deep-dive); [Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-where-computer-use-runs)

## What are the top complaints per product?

### Takeaway
Every product draws the same core complaints. The agent is unreliable on multi-step tasks: it loops, clicks the wrong thing, or declares success too early. It is slower than doing the task by hand, and it stalls at logins, 2FA and CAPTCHAs. Desktop-capable agents add another layer: macOS/Windows permission failures, the machine having to stay awake with the app open, no sandbox, and fights over the screen. Credit- and quota-metered products (Manus, Genspark, Cowork) draw the angriest billing complaints.

### Cited Findings

#### Anthropic: Claude in Chrome (extension)
- [Vendor] At launch (Aug 2025), Anthropic reported that its mitigations cut prompt-injection attack success in autonomous mode from 23.6% to 11.2%, on 123 test cases. It said vulnerabilities remained before general availability. — [The Register, 2025-08-26](https://www.theregister.com/2025/08/26/anthropic_claude_chrome_warnings/); [Anthropic](https://www.anthropic.com/news/claude-for-chrome)
- [User] The HN launch thread (Aug 26, 2025; 799 points, 406 comments) was dominated by the "lethal trifecta" argument: private data plus untrusted content plus the ability to act makes injection easy. Commenters asked for isolated agent profiles and cookies, so the agent cannot use logged-in sessions by default. They also reported agents losing track in multi-step tasks. — [HN 45030760](https://news.ycombinator.com/item?id=45030760)
- [Press] Critics such as Simon Willison called an 11.2% success rate still a catastrophic failure rate. — [Simon Willison's weblog (Anthropic tag)](https://www.simonwillison.net/tags/anthropic); [TechSpot thread](https://www.techspot.com/community/topics/claude-for-chrome-arrives-despite-11-prompt-injection-success-rate.294501/)
- [User] Chrome Web Store on 2026-10-25: 3.6/5 from about 1.9K ratings. Reviews from Oct 21-24, 2026 say the extension does not work in Chrome and the help loop repeated the same answer. They also ask for Arc support, complain of an over-restrictive refusal to summarize a public security article, and note that a paid plan is required. Several reviews are positive (delegating tasks, complex orders). An older search-indexed snapshot showed 2.8/5 from 1.7K ratings, with complaints that it did not work on Mac/Arc/Opera, that the Claude desktop connection broke, and that sites had to be re-approved repeatedly. That snapshot is undated, so the rating trend is indicative only. — [Chrome Web Store reviews](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn/reviews)
- [Press] A 2026 review (dated Mar 2026; the page's dates conflict) found it noticeably slower than doing the tasks manually. A product manager reported complex workflows taking 30 minutes to 2 hours. The reviewer says it loses context beyond 5-6 complex tabs, that scheduled tasks run only while Chrome is open and the computer awake, and that browser actions drain Claude limits faster than chat. At the time Pro users were limited to Haiku 4.5. The default "Ask before acting" mode adds friction. It supports Chrome and Edge only, not Brave, Arc, Firefox or mobile. — [AI Tool Analysis](https://aitoolanalysis.com/claude-in-chrome-review/)

#### Anthropic: computer use in Cowork / Claude Code (Claude Desktop) and the computer-use API
- [Vendor] Stated limitations (help page accessed 2026-10-25):
  - Beta for Pro and Max only; no Team/Enterprise access.
  - The computer must be awake and Claude Desktop open.
  - On macOS 15+ it works in background windows by default and asks before taking over the full screen. Background behavior on Windows is not described.
  - Per-app approval and a user blocklist; trading and crypto apps are off-limits by default.
  - No sandbox between Claude and the apps it operates; screenshots see whatever is on screen.
  - Prompt-injection scanning is imperfect, and a link can open in an app Claude was not granted.
  - Screen-driven tasks are slower and more error-prone than connectors; complex workflows may need a second attempt.
  — [Claude help](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
- [Vendor] At the Mar 23, 2026 launch it was a macOS-only research preview, and Anthropic advised against using it with sensitive information. — [Engadget, 2026-03-23](https://www.engadget.com/ai/claude-code-and-cowork-can-now-use-your-computer-210000126.html); [Claude blog](https://claude.com/blog/dispatch-and-computer-use)
- [User] Usage limits are the most cited complaint. A Pro subscriber reported hitting the limit after about 10 minutes of Cowork, then waiting about 6 hours for the reset. Another commenter pays roughly EUR 15 a month extra. Anthropic's help center confirms that Cowork tasks consume more of the allocation than chat. — [ruben.substack comments (undated)](https://ruben.substack.com/p/claude-computer/comments); [BetterClaw (third-party)](https://www.betterclaw.io/blog/claude-cowork-rate-limit-reached); [parix.ai (third-party)](https://parix.ai/blog/claude-cowork-not-working/)
- [Press] WIRED (Jan 15, 2026, via a roundup updated 2026-09-03): Cowork struggled to batch-archive mail, then carried out a request to delete 1,000 unread promotional emails, which shows how broad destructive actions can go. A purchase needed a human handoff. A 21-day tester hit Pro limits around day 12. A Tom's Guide-style reviewer noted that screen-driven operation is slower and sometimes needs a nudge. — [aireiter roundup](https://aireiter.com/blog/claude-cowork-computer-use-review)
- [User] Prompt injection made real: PromptArmor showed a hidden-text .docx causing Cowork to upload local files to an attacker's Anthropic account. The HN thread "Claude Cowork exfiltrates files" (about Jan 2026; 870 points, 399 comments) concluded that skills should be treated as executable code and that prompt-level defenses do not hold. — [HN 46622328](https://news.ycombinator.com/item?id=46622328)
- [Press] Cost and speed of screenshot agents in general: in Reflex's public benchmark, Claude Sonnet driving a web UI by screenshots (browser-use 0.12) took about 17 minutes and about 500K input tokens, and found 1 of 4 items. The same task through the app's API took about 20 seconds and about 12K tokens (about 45x fewer tokens). — [The Register, 2026-05-07](https://www.theregister.com/ai-and-ml/2026/05/07/ai-vision-agents-use-45x-more-tokens-than-apis-in-benchmark/5231346)
- [Third-party blog] Claude's browser-use toolset (Aug 19, 2026 release) is said to add about 6,600 input tokens per request before any screenshot, against about 4,500 for the computer-use toolset. Not verified against Anthropic docs. — [eCorpIT](https://ecorpit.com/claude-browser-use-toolset-token-overhead-docs-conflict-2026/)
- [User, older, about Dec 2024] An early Show HN launcher for the computer-use API was described by its own author as slow and error-prone. — [HN 42561147](https://news.ycombinator.com/item?id=42561147)

#### OpenAI: Operator, then ChatGPT agent (removed Aug 2026)
- [Press] Operator (Jan 2025) ran in a cloud VM with limited internet access and struggled with complex UIs. — [Wikipedia: OpenAI Operator](https://en.wikipedia.org/wiki/OpenAI_Operator)
- [Vendor] ChatGPT agent caps were 40 runs a month on Plus and 400 on Pro. Scheduled-task runs counted against the cap, plus concurrency limits. The help page advised using takeover mode for sensitive inputs. — [OpenAI help 11752874](https://help.openai.com/en/articles/11752874-chatgpt-agent)
- [Press, mid-2025] The Verge's test, as relayed by a secondary blog: an Etsy lamp search took about 50 minutes. The agent claimed it had added items to the cart, but they never appeared in the real cart because it acted in its own virtual browser. Another reviewer gave up waiting and did the task in a second tab. One expert rated it 6/10. — [ninetwothree (secondary)](https://www.ninetwothree.co/blog/chatgpt-agent-mode); [Medium, khaoskook](https://medium.com/@khaoskook/frankly-chatgpts-agent-mode-is-a-little-disappointing-087ebf77fdbb)
- [Press, about Aug 2025] CAPTCHAs: 4sysops found the agent would not solve reCAPTCHA v2, and on v3 it asked the user to take over. Researchers separately showed it could be tricked into solving CAPTCHAs. — [4sysops](https://4sysops.com/archives/can-chatgpt-agent-mode-solve-google-captcha-recaptcha-and-validate-the-cloudflare-turnstile-challenge/); [TechRadar](https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-can-now-beat-captcha-checks-so-get-ready-for-fake-posts-everywhere)
- [User] On Aug 8, 2026 a forum post said agent mode was removed with no real replacement: "Work is not a replacement for Agent Mode." What it lost: a real rendered browser, clicking through interactive sites (configurators, shipping selectors), and handing control back for sign-in. OpenAI support replied on Sep 7, 2026 that Work now has a separate cloud browser that can pause for sign-in or takeover on supported accounts. — [OpenAI community 1389601](https://community.openai.com/t/agent-mode-was-removed-with-no-real-replacement/1389601)
- [Third-party blog, competitor] The removal came without notice or a migration guide. Scheduled tasks that depended on agent mode can silently stop producing output. — [Carly](https://www.usecarly.com/blog/chatgpt-agent-mode/)

#### OpenAI: Atlas browser agent mode (Oct 2025 to Aug 9, 2026)
- [Press] In The Verge's test, Atlas took about ten minutes to add three items to an Amazon cart. Comet did it in about two. — [Futurism](https://futurism.com/artificial-intelligence/openai-atlas-web-browser-messy)
- [Press] Houston Chronicle: slow, bare-bones, privacy concerns. A 30-day tester saw about 80% of cart items added correctly in about 12 minutes. — [Houston Chronicle](https://www.houstonchronicle.com/business/tech/article/chatgpt-atlas-browser-review-21125059.php); [Booststash](https://booststash.com/chatgpt-atlas-review-30-days-later-shocking/)
- [Press] Security and privacy: LayerX's "Tainted Memories" CSRF/memory injection (The Register, Oct 27, 2025), which OpenAI could not reproduce. Axios raised prompt-injection worries on Oct 28, 2025. Anil Dash called it an "anti-web browser" on Oct 22, 2025. PCMag ran "Still No Windows or Mobile Versions" on Jan 22, 2026. It was shut down Aug 9, 2026 without ever shipping on Windows. — [Wikipedia: ChatGPT Atlas](https://en.wikipedia.org/wiki/ChatGPT_Atlas)

#### OpenAI: ChatGPT Work, Codex Computer Use, CUA API
- [Vendor/Press] Work (Jul 9, 2026) can operate the user's own computer on desktop, once or on a schedule. It is metered like Codex, so complex tasks use more of the plan, which makes costs less predictable. — [TNW, 2026-07-10](https://thenextweb.com/news/openai-chatgpt-work-agent-launch)
- [Third-party blog] Reviewers say Work cannot drive a logged-in browser session or hand control back mid-task the way the old agent could. Composio, which sells competing tooling, reported Work passing 45/47 tasks against Cowork's 47/47. — [search summary of leadwithai / smartailibrary / Composio](https://www.leadwithai.co/article/chatgpt-work-is-here-openais-answer-to-claude-cowork)
- [User] Codex Computer Use on macOS: GitHub issue #18896 (opened Apr 21, 2026, still open, 12 comments, last activity Oct 5, 2026) reports every app-control request denied without a prompt, even with Screen Recording and Accessibility granted. Similar issues: #21846 (permissions "not granted" on macOS 26.4.1) and #18258 ("plugin unavailable"). — [openai/codex #18896](https://github.com/openai/codex/issues/18896); [#21846](https://github.com/openai/codex/issues/21846); [#18258](https://github.com/openai/codex/issues/18258)
- [User] Codex Computer Use on Windows (forum thread Sep 14 to Oct 9, 2026): it detects Chrome through the extension but no native apps (empty app list, Notepad unavailable). Support said other Windows users had reported the same and suggested switching models as a workaround. Not confirmed fixed. — [OpenAI community 1397316](https://community.openai.com/t/computer-use-plugin-stopped-working/1397316)
- [Third-party blog] Codex on Mac: permission setup is tedious, Plus rate limits are hit quickly once Computer Use is added, and it does not activate on Intel Macs. — [findskill.ai](https://findskill.ai/blog/openai-codex-mac-48-hours/)
- [User, 2025] computer-use-preview API problems:
  - 404 "model does not exist" even at tier 3, with suspicion of an undisclosed trust tier.
  - Docs did not say coordinates must be normalized.
  - The model never emitted a "back" action.
  - In 2026, the .NET SDK sent the legacy tool name, which gpt-5.4 rejects.
  — [forum 1144255](https://community.openai.com/t/computer-use-preview-not-working-even-after-getting-tier-3/1144255); [forum 1143891](https://community.openai.com/t/how-are-the-computer-use-api-coordinates-calculated/1143891); [forum 1150440](https://community.openai.com/t/computer-use-preview-model-never-sends-a-back-action/1150440); [forum 1377868](https://community.openai.com/t/net-api-2-9-1-injects-computer-user-preview-instead-of-computer-incompatible-with-5-4-when-adding-cua-tool/1377868)

#### Google: Mariner, Gemini 2.5 Computer Use, Chrome auto browse, Gemini Agent
- [Press] Mariner required the $249.99/month AI Ultra plan. It was shut down May 4, 2026 with a landing-page notice and no formal announcement. WIRED had reported staff being reassigned in March. — [GIGAZINE, 2026-05-07](https://gigazine.net/gsc_news/en/20260507-google-shuts-down-project-mariner/); [TechSpot](https://www.techspot.com/news/112334-project-mariner-dead-but-google-browser-controlling-ai.html)
- [Vendor] The Gemini 2.5 Computer Use model (Oct 7, 2025) is optimized for browsers and not yet for desktop OS control. — [Model card](https://storage.googleapis.com/deepmind-media/Model-Cards/Gemini-2-5-Computer-Use-Model-Card.pdf)
- [User] HN thread (Oct 7, 2025; 636 points, 325 comments):
  - Step-by-step browser control is too slow.
  - It reported tasks complete after one or two steps, and overwrote spreadsheet columns.
  - A claimed reCAPTCHA solve was actually done by the host, Browserbase.
  - Google's own bot defenses block agents.
  - Commenters want desktop control, and want the agent to explore once and then generate a reusable Playwright script instead of paying the model every run.
  - A commenter reported about 18 attempts to click one link, each a few pixels off.
  — [HN 45507936](https://news.ycombinator.com/item?id=45507936); [Cybernews review](https://cybernews.com/ai-tools/gemini-2-5-computer-use-review/)
- [Press] Chrome auto browse asks for confirmation before purchases and social posts. The Register framed the rollout as Google foisting a Gemini pane on Chrome users (Jan 29, 2026). — [The Register, 2026-01-29](https://www.theregister.com/2026/01/29/chrome_gemini_pane/); [Google blog](https://blog.google/products-and-platforms/products/chrome/gemini-3-auto-browse/)
- [Press] Hands-on, May 20, 2026 (paid AI Pro/Ultra, US only):
  - The author rated 3 of 5 runs genuinely useful.
  - It paused at MFA and needed a manual handoff.
  - It stalled on cancellation modals and cancelled the wrong subscription tier despite a stop rule, which took customer service to reverse.
  - It picked two wrong grocery brands.
  - Long tasks time out or get interrupted by tab activity, and it coordinates poorly with tabs the person is using.
  - The author's verdict: agents that cannot survive a 2FA wall are toys.
  The dates conflict: Google announced auto browse in Jan 2026, but this piece says the preview landed May 19, 2026. — [Sean Kim](https://blog.imseankim.com/chrome-auto-browse-gemini-agentic-hotel-form-fill-google-io-2026/)
- [Press] Gemini Agent: desktop-first for AI Ultra subscribers in the US, English only. It is not part of a browser, so it lacks saved logins, and it is not immune to prompt injection. — [Android Authority](https://www.androidauthority.com/google-gemini-agent-3616670/); [Techloy](https://www.techloy.com/google-has-shut-down-project-mariner-here-are-the-5-best-alternatives/)

#### Microsoft: Copilot Vision, Copilot Actions / agent workspace, Copilot Studio computer use
- [Press] The Verge tested Copilot Vision for a week with prompts from Microsoft's own ads (Nov 2025). It failed to reproduce the ads, misidentified a microphone, could not name a rocket labelled on a slide, and could not toggle dark mode. — [Slashdot, 2025-11-18](https://it.slashdot.org/story/25/11/18/1932202/talking-to-windows-copilot-ai-makes-a-computer-feel-incompetent)
- [User] Backlash to the "agentic OS" framing: Windows chief Pavan Davuluri's Nov 10, 2025 post drew overwhelmingly negative replies asking for reliability and performance instead of AI. He acknowledged the feedback on Nov 15. — [The Register, 2025-11-17](https://www.theregister.com/2025/11/17/windows_agentic_os_feedback/); [TechRadar](https://www.techradar.com/computing/windows/windows-11-users-rebel-as-top-microsoft-exec-says-operating-system-is-evolving-into-an-agentic-os)
- [Vendor] The agent workspace (support page updated Dec 5, 2025):
  - A separate Windows session and account; it can work in the background.
  - Read/write access to six known folders by default.
  - Only an admin can enable it, and the setting applies device-wide.
  - Microsoft warns of cross-prompt injection leading to data exfiltration or malware installation.
  - Known issues: Windows will not sleep while Copilot has active conversations, and shutdown warns that someone is still using the PC.
  — [Microsoft Support](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features)
- [Press] It is still explicitly experimental in 2026. Microsoft warns it may struggle with complex or dynamic interfaces, and testers are told to use a non-critical machine. Early reports say Copilot sometimes refuses to act on the UI. — [Medium hands-on (Jul 2026, per search)](https://medium.com/@Ella456/i-gave-windows-11s-new-ai-agent-the-keys-to-my-pc-4cb55596366b); [WindowsForum](https://windowsforum.com/threads/copilot-actions-windows-11-desktop-automation-for-multi-step-tasks.385024/)
- [Vendor] Copilot Studio computer use: the hosted browser is a preview. It is not Entra-joined or Intune-managed, has no enterprise resource access or custom desktop apps, is not for production, and may be throttled. The tool is sensitive to layout changes, loading delays and unexpected dialogs, and multi-screen desktops are unsupported. — [Learn: where it runs](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-where-computer-use-runs); [Learn FAQ](https://learn.microsoft.com/en-us/microsoft-copilot-studio/faqs-computer-use); [Learn troubleshooting](https://learn.microsoft.com/en-us/microsoft-copilot-studio/troubleshooting-computer-use)
- [Third-party blog] Copilot Studio does not support Electron, Java, Unity, Citrix or virtualized apps. Its allowlist blocks actions but not navigation to unlisted sites. — [digitalapplied](https://www.digitalapplied.com/blog/copilot-studio-computer-use-agents-ga-deep-dive)

#### Perplexity Comet
- [Press] Prompt injection: Brave (Aug 2025) showed hidden page text being executed as commands, up to account takeover via a Reddit post. Perplexity said it was fixed, but Brave's later testing found it persisted and called it systemic. Guardio's "Scamlexity" test had Comet buy from a fake Walmart site, autofilling payment, often without confirmation, and treat phishing emails as to-dos. — [GIGAZINE, 2025-08-26](https://gigazine.net/gsc_news/en/20250826-perplexity-comet-ai-prompt-injection); [HackMag](https://hackmag.com/news/scamlexity)
- [Press] Reliability in 2026 reviews:
  - Perplexity claims complex-task success rose from about 70% to about 80%; a reviewer still saw 20-25% failures on multi-step tasks.
  - Checkout got confused in 2 of 3 purchases.
  - Another review measured 84% success on text-heavy sites against 42% on dynamic single-page apps.
  - Loops of wrong clicks; got stuck creating a project in Photopea.
  — [AI Tool Analysis (updated 2026-02-14)](https://aitoolanalysis.com/comet-browser-review/); [eesel roundup](https://www.eesel.ai/blog/perplexity-comet-reviews); [MakeUseOf](https://www.makeuseof.com/perplexity-comet-review-experience-after-one-month/)
- [Press] Resource use: PCMag (via eesel) measured CPU spikes to 20% and memory above 4GB with a few tabs. Memory recall did not work well for a Cybernews reviewer. — [eesel](https://www.eesel.ai/blog/perplexity-comet-reviews); [Cybernews](https://cybernews.com/ai-tools/perplexity-comet-review/)
- [User] Reddit complaints relayed by a review: a low phishing-block rate, and one user disconnected all their accounts after the Dec 2025 MCP exploit. Also: no iOS app as of Feb 2026, weaker memory than Dia, limited extensions. The 7% phishing figure is not primary-sourced. — [AI Tool Analysis](https://aitoolanalysis.com/comet-browser-review/)
- [Press] Permission friction: a writer cancelled setup at the permissions screen, which asked for Gmail, contacts and calendar access. — [Sovereign Magazine](https://www.sovereignmagazine.com/article/i-wanted-to-love-perplexity-s-ai-browser-but-the-permissions-screen-made-me-hit-cancel)
- [Press] Site blocking, through litigation: Amazon won a preliminary injunction in March 2026 stopping Comet from shopping on Amazon. The Ninth Circuit vacated it around Aug 5, 2026, finding the agent acts as the user's tool. The case is back in district court. — [Bloomberg Law](https://news.bloomberglaw.com/ip-law/amazon-wins-court-order-blocking-perplexitys-ai-shopping-bots); [Retail Insight Network](https://www.retail-insight-network.com/news/us-court-overturns-amazon-injunction-perplexity/)

#### Opera Neon, Dia, Manus, Genspark, Amazon Nova Act, Simular
- [User/Press] Opera Neon's "Do" agent: a Slashdot user calls it sluggish and dumb, and two reviewers found tasks slower than doing them by hand. Opera calls Neon early access. All undated (2025-26). — [Slashdot reviews](https://slashdot.org/software/p/Opera-Neon/); [aichief](https://aichief.com/news/opera-neon-review-three-ai-agents-one-confusing-browser/); [Remio](https://www.remio.ai/post/opera-neon-review-the-confusing-future-of-ai-browsers)
- [Press] Dia (owned by Atlassian since late 2025) runs only on macOS 14+ with Apple silicon. A Mar 2026 review says it summarizes and generates but cannot take actions or automate across tools. A Jun 2026 Atlassian Community user got errors querying Assets and had to fall back to letting Dia read the open page. — [Composite, Mar 2026](https://composite.com/blog/dia-browser-reviews-pricing-alternatives); [Atlassian Community](https://community.atlassian.com/forums/Atlassian-AI-Rovo-articles/Rovo-vs-Dia-Browser-HOW-IS-THIS-EVEN-POSSIBLE/ba-p/3248905)
- [User] Manus: Trustpilot about 1.2-1.3/5 (about 150-209 reviews across snapshots, about 94% one-star). Complaints: credits charged for tasks that fail or stall, billing surprises, bot-only support, hard cancellation. Trustpilot notes Manus does not invite reviews, and the App Store shows 4.7 from about 39K ratings. — [Trustpilot](https://www.trustpilot.com/review/manus.im); [news-tech.co.uk](https://news-tech.co.uk/is-manus-ai-legit-what-the-reviews-actually-show/)
- [User/Third-party blog] Genspark: Trustpilot about 1.5-1.9/5 (about 112 reviews). Complaints: credits deducted for failed tasks and retries, no pre-task cost estimate (10-500 credits per task), unrequested monthly-to-annual switches, bot-only support. — [Trustpilot](https://www.trustpilot.com/review/genspark.ai?page=7); [Lindy](https://lindy.ai/blog/genspark-review); [eesel](https://www.eesel.ai/blog/genspark-ai-review)
- [Vendor] Amazon Nova Act is GA and claims over 90% task reliability. It runs only in us-east-1 and is browser-only. I found no independent post-GA reliability reports. — [AWS GA blog](https://aws.amazon.com/cn/blogs/china/build-reliable-ai-agents-for-ui-workflow-automation-with-amazon-nova-act-now-generally-available); [AWS docs](https://docs.aws.amazon.com/nova-act/latest/userguide/what-is-nova-act.md)
- [Vendor/User] Simular Pro is macOS 15+ only and in private beta. It turns successful runs into deterministic code. Product Hunt commenters asked about privacy, access control and Linux support. No independent hands-on found. — [Simular docs](https://docs.simular.ai); [Simular Pro launch](https://www.simular.ai/articles/introducing-simular-pro-our-first-production-ready-computer-use-agent)

#### Self-hosted contrast with major 2026 traction: OpenClaw (not hosted, included for the demand signal)
- [Press] OpenClaw's appeal is that it runs on the user's own hardware (the Mac-mini-server trend), and it became GitHub's most-starred project within about three months. Concerns: prompt injection leaking keys, China's CNCERT warnings (second warning on Mar 11, 2026), a website-to-agent hijack fixed in 2026.2.25, and hundreds of malicious ClawHub skills. — [eesel](https://www.eesel.ai/blog/openclaw); [SCMP, 2026-03-11](https://scmp.com/tech/tech-trends/article/3346138/china-issues-second-warning-openclaw-risks-amid-adoption-frenzy); [Dark Reading](https://www.darkreading.com/application-security/critical-openclaw-vulnerability-ai-agent-risks); [CrowdStrike](https://crowdstrike.com/en-us/blog/what-security-teams-need-to-know-about-openclaw-ai-super-agent/)

### Inferences
- The complaint set divides by architecture. **Cloud-VM agents** (Operator, ChatGPT agent, Manus, Genspark, Copilot Studio's hosted browser) draw complaints about logins, CAPTCHAs, the virtual cart not being the real cart, and no access to the person's own apps. **On-device agents** (Cowork computer use, Codex Computer Use, Copilot Actions, Comet, Claude in Chrome) draw complaints about OS permission plumbing, needing the machine awake, no sandbox, screen contention and prompt injection with real credentials in reach. Vendors moved from the first group toward the second during 2026 (ChatGPT Work's desktop computer use, Cowork computer use), which shifts the complaints toward the on-device set.
- Desktop-level problems in the evidence that a local MCP server can address directly:
  - Screen and mouse contention (Cowork moved to background windows on macOS 15+; Windows runs agents in a separate session).
  - The machine must stay awake (Cowork; Windows will not sleep while an agent conversation is active).
  - Self-drawn and non-standard UIs (Copilot Studio excludes Electron, Java, Unity, Citrix).
  - Unexpected dialogs and multi-monitor setups (Copilot Studio).
  - Native-app discovery and TCC approval failures (Codex).
- Billing anger concentrates where users pay for failed attempts (Manus, Genspark), or where screenshots eat a shared quota (Cowork, Claude in Chrome). The Reflex benchmark gives the mechanism: screenshot-per-step costs about 45x the tokens of a structured call.

### Gaps
- Reddit threads (r/ClaudeAI, r/OpenAI, r/ChatGPTPro, r/perplexity_ai, r/Windows11) could not be fetched: the crawler is blocked. No Reddit upvote counts are included, and Reddit sentiment appears only where reviews quote it.
- No independent 2026 hands-on of Copilot Actions / agent workspace, Gemini Agent, Nova Act after GA, Simular Pro, or Microsoft UFO2/UFO3 was found. For UFO2/UFO3 I found no user-complaint evidence at all.
- Several Tom's Guide articles (ChatGPT agent, Comet 7-task test, Cowork from phone) were truncated on fetch, so their specific results are not used.
- The exact Operator sunset date and the Gemini Agent launch date were not verified.
- A TechPowerUp report that Microsoft scaled back Copilot in Windows 11 (removing eight File Explorer actions) could not be fetched (HTTP 403), so its date and details are unconfirmed: [TechPowerUp](https://www.techpowerup.com/353963/microsoft-scales-back-copilot-integration-in-windows-11-removes-eight-file-explorer-actions).

## What do users explicitly ask for?

### Takeaway
Explicit requests cluster around six things:
- Desktop control, not browser-only.
- More browsers (Arc, Brave, Firefox) and platforms (Windows for Atlas, iOS for Comet, Linux for Simular).
- Surviving 2FA, logins and CAPTCHAs by handing off cleanly and resuming.
- Cheaper, deterministic repeat runs (record once, replay as a script).
- Isolation: separate agent profiles, cookie isolation, sandboxes.
- Not losing workflows when vendors retire products.

### Cited Findings
- [User] Desktop control: HN commenters on Gemini 2.5 Computer Use asked for a desktop version (for example for QA work), since the model is browser-only. — [HN 45507936](https://news.ycombinator.com/item?id=45507936)
- [User] Record once, replay deterministically: the same thread suggested having the model explore once and then generate a Playwright script, because running the LLM on every action is costly and inconsistent. — [HN 45507936](https://news.ycombinator.com/item?id=45507936). Simular sells this approach, turning successful runs into editable deterministic code. — [Simular](https://www.simular.ai/articles/introducing-simular-pro-our-first-production-ready-computer-use-agent)
- [User] Isolation: Claude for Chrome HN commenters asked for sandboxed agent profiles, cookie isolation so the agent cannot use logged-in sessions by default, per-request permissions, dual-LLM or CaMeL-style designs, and a standard for sites to expose functions to agents (WebMCP). — [HN 45030760](https://news.ycombinator.com/item?id=45030760). After the Cowork exfiltration, commenters asked that skills be treated as executable code, with statically registered tools and human approval. — [HN 46622328](https://news.ycombinator.com/item?id=46622328)
- [User] Browser support: Arc support requested on the Chrome Web Store on Oct 22, 2026. Older reviews say it does not work in Arc or Opera. — [Chrome Web Store](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn/reviews). Brave, Arc, Firefox and mobile remain unsupported. — [AI Tool Analysis](https://aitoolanalysis.com/claude-in-chrome-review/)
- [User] Better models on lower tiers: users asked why Sonnet was not available to Pro users in the Chrome extension (Haiku 4.5 only at the time). — [AI Tool Analysis](https://aitoolanalysis.com/claude-in-chrome-review/)
- [User] Restore what was taken away: the Aug 8, 2026 forum post asks OpenAI to restore agent mode or a true equivalent (real rendered browser, interactive sites, sign-in handoff). — [OpenAI community 1389601](https://community.openai.com/t/agent-mode-was-removed-with-no-real-replacement/1389601)
- [Press] Surviving 2FA mid-task is a reviewer's bar for a real agent, as opposed to a toy. — [Sean Kim, 2026-05-20](https://blog.imseankim.com/chrome-auto-browse-gemini-agentic-hotel-form-fill-google-io-2026/)
- [User] Reliability before features: replies to the Windows "agentic OS" post asked for a performant, reliable, stable OS rather than agent features. — [The Register, 2025-11-17](https://www.theregister.com/2025/11/17/windows_agentic_os_feedback/)
- [User] CAPTCHA help when browsing normally, not just for agents. — [HN 45507936](https://news.ycombinator.com/item?id=45507936)
- [User] Linux support and clarity on data privacy and access control (Simular Product Hunt thread). — [Simular search summary / Product Hunt](https://webmail.hunted.space/product/simular/launches/simular-pro)
- [User] Fair billing: Manus and Genspark reviewers want no charge for failed tasks, a cost estimate before a task, and human support. — [Trustpilot Manus](https://www.trustpilot.com/review/manus.im); [eesel Genspark](https://www.eesel.ai/blog/genspark-ai-review)
- [User] Enterprise governance: HN commenters said agents will not enter production systems without deterministic hooks or callbacks for oversight. — [HN 45507936](https://news.ycombinator.com/item?id=45507936)

### Inferences
- The asks for deterministic replay, isolation and oversight hooks are developer and enterprise asks. Consumer asks are more about browser and platform coverage, lower prices or limits, and not getting stuck at 2FA. A local desktop MCP server is positioned to answer the developer and enterprise set (scriptable, inspectable, auditable) more than the consumer set.
- No source explicitly asked for undo. Instead, users and reviewers describe irreversible mistakes: a wrong-tier subscription cancellation that took customer service to reverse, and 1,000 emails deleted. The absence of undo is visible in the harm reports rather than in feature requests.

### Gaps
- I found no explicit, well-evidenced user requests for learning from demonstration or memory in hosted agents, beyond the HN "explore once, script it" idea and one reviewer's note that Comet's memory recall was weak. — [Cybernews](https://cybernews.com/ai-tools/perplexity-comet-review/)
- No upvote-ranked feature-request lists (for example a vendor feedback portal) were found for any product.

## Which complaints are fixed by now (2026) and which persist?

### Takeaway
Fixes have mostly come from widening access (more plans and platforms, lower prices) and from moving agents onto the person's own machine, with background or separate-session operation. Reliability on multi-step tasks, prompt injection, and quota/credit cost persist in every product. Several 2025 complaints were never fixed: the product was retired instead (Operator, then ChatGPT agent, Atlas, Mariner).

### Cited Findings
- **Fixed / improved:**
  - [Vendor] Claude in Chrome access went from 1,000 Max testers (Aug 2025) to all Max (Nov 2025) to all paid plans (Dec 18, 2025). — [Claude help](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome); [AI Tool Analysis](https://aitoolanalysis.com/claude-in-chrome-review/)
  - [Vendor] Claude computer use went from a macOS-only research preview (Mar 23, 2026) to beta on macOS and Windows (by Oct 2026), and from screen takeover to background windows by default on macOS 15+, asking before full-screen control. — [Engadget](https://www.engadget.com/ai/claude-code-and-cowork-can-now-use-your-computer-210000126.html); [Claude help](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
  - [Press] Comet went from $200/month Max-only (Jul 2025) to free for everyone (Oct 2, 2025), with Android and Enterprise added (Jan 2026). — [AI Tool Analysis](https://aitoolanalysis.com/comet-browser-review/)
  - [Vendor] The "cloud VM, not my machine" complaint about Operator and ChatGPT agent was addressed in July 2026: ChatGPT Work can operate the user's own Mac/Windows desktop and run scheduled or event-triggered tasks. — [TNW, 2026-07-10](https://thenextweb.com/news/openai-chatgpt-work-agent-launch)
  - [Third-party changelog] Atlas agent mode was made more persistent on repetitive tasks (Feb 2026 build). The browser was then shut down. — [search summary of Releasebot](https://releasebot.io/updates/openai/chatgpt-atlas)
  - [Vendor] Windows added per-agent file access controls (Allow always / Ask every time / Never) in preview builds 26100.7344+ (Dec 2025). — [Microsoft Support](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features)
  - [Press] Google's price barrier dropped: Mariner was $249.99 Ultra-only, while Chrome auto browse is available on AI Pro ($19.99) in the US. — [Sean Kim](https://blog.imseankim.com/chrome-auto-browse-gemini-agentic-hotel-form-fill-google-io-2026/)
  - [Press] Amazon's March 2026 injunction against Comet's shopping agent was vacated by the Ninth Circuit around Aug 5, 2026 (not final). — [Retail Insight Network](https://www.retail-insight-network.com/news/us-court-overturns-amazon-injunction-perplexity/)
- **Persisting as of the latest evidence:**
  - [Press/User] Prompt injection: Brave says Comet's issue is systemic and persists despite Perplexity's fix. Anthropic, Microsoft and Google all still warn about it in current docs. Cowork exfiltration (about Jan 2026). — [GIGAZINE](https://gigazine.net/gsc_news/en/20250826-perplexity-comet-ai-prompt-injection); [Claude help](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork); [Microsoft Support](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features); [HN 46622328](https://news.ycombinator.com/item?id=46622328)
  - [User] Codex Computer Use approval failures on macOS (open Apr 21 to Oct 5, 2026) and Windows native-app discovery (Sep to Oct 2026) were unresolved at last activity. — [openai/codex #18896](https://github.com/openai/codex/issues/18896); [OpenAI community 1397316](https://community.openai.com/t/computer-use-plugin-stopped-working/1397316)
  - [User] Claude in Chrome: browser coverage (Arc request Oct 22, 2026) and "not working" reports (Oct 23, 2026). No documented fixes for speed, multi-tab context loss or quota use. — [Chrome Web Store](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn/reviews); [AI Tool Analysis](https://aitoolanalysis.com/claude-in-chrome-review/)
  - [Vendor] Claude computer use: still Pro/Max only (no Team/Enterprise), the machine must stay awake, no sandbox, slower than connectors. — [Claude help](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork)
  - [Vendor/Press] Copilot Actions: still preview/Labs in 2026, with no GA found. Copilot Studio's hosted browser is still a preview and not for production. — [Microsoft Support](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features); [Microsoft Learn](https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-where-computer-use-runs)
  - [Press] Comet reliability: 20-25% multi-step failures and checkout confusion in Feb 2026 testing. — [AI Tool Analysis](https://aitoolanalysis.com/comet-browser-review/)
  - [Press] Gemini auto browse: MFA handoffs, stalls on modals, a wrong destructive action despite a stop rule (May 2026). — [Sean Kim](https://blog.imseankim.com/chrome-auto-browse-gemini-agentic-hotel-form-fill-google-io-2026/)
  - [User] Manus and Genspark credit-on-failure complaints (2026 snapshots). — [Trustpilot Manus](https://www.trustpilot.com/review/manus.im); [Trustpilot Genspark](https://www.trustpilot.com/review/genspark.ai?page=7)
- **Retired rather than fixed:**
  - Operator, merged into ChatGPT agent in Jul 2025. — [TechCrunch](https://www.techcrunch.com/2025/07/17/openai-launches-a-general-purpose-agent-in-chatgpt)
  - ChatGPT agent, removed early Aug 2026. — [OpenAI community 1389601](https://community.openai.com/t/agent-mode-was-removed-with-no-real-replacement/1389601)
  - Atlas, shut down Aug 9, 2026 with no Windows release. — [Wikipedia](https://en.wikipedia.org/wiki/ChatGPT_Atlas)
  - Mariner, shut down May 4, 2026. — [GIGAZINE](https://gigazine.net/gsc_news/en/20260507-google-shuts-down-project-mariner/)
- **Regression introduced by a fix:** ChatGPT Work fixed "not on my machine" but lost the logged-in browser handoff. OpenAI says a cloud browser with sign-in and takeover now exists "on supported accounts" (Sep 7, 2026). — [OpenAI community 1389601](https://community.openai.com/t/agent-mode-was-removed-with-no-real-replacement/1389601); [Carly](https://www.usecarly.com/blog/chatgpt-agent-mode/)

### Inferences
- Most 2025 speed complaints about Atlas and ChatGPT agent were never measured again after a fix. The products were replaced. Whether ChatGPT Work is faster rests only on a competitor's benchmark (Composio: about 6% faster than Cowork).
- Vendor churn is itself a persistent complaint category. Users who built scheduled workflows on Operator, agent or Atlas had to migrate twice in about 13 months.

### Gaps
- No independent speed benchmarks for 2026 versions of Claude in Chrome, ChatGPT Work or Comet were found.
- It is unclear whether Copilot Actions' "Windows won't sleep" known issue (Dec 2025) has been fixed.

## How frequent or severe is each complaint?

### Takeaway
The strongest frequency signals are:
- HN engagement on security threads: Cowork exfiltration 870 points / 399 comments; Claude for Chrome 799 / 406; Gemini Computer Use 636 / 325.
- Store and Trustpilot ratings: Claude in Chrome 3.6/5 from 1.9K; Manus about 1.2/5 with about 94% one-star; Genspark about 1.5-1.9/5.
- Press pile-ons: the Windows agentic-OS backlash; Comet injection coverage across Brave, Guardio and LayerX; the Amazon v. Perplexity case.
- Speed and unreliability appear in nearly every hands-on review of every product.

### Cited Findings
- [User] HN engagement: Cowork file exfiltration (870 points, 399 comments, about Jan 2026); Claude for Chrome launch (799, 406, Aug 2025); Gemini 2.5 Computer Use (636, 325, Oct 2025). — [HN 46622328](https://news.ycombinator.com/item?id=46622328); [HN 45030760](https://news.ycombinator.com/item?id=45030760); [HN 45507936](https://news.ycombinator.com/item?id=45507936)
- [User] Ratings: Claude in Chrome 3.6/5 from about 1.9K (2026-10-25); an older snapshot showed 2.8 from 1.7K. — [Chrome Web Store](https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn/reviews). Manus 1.2-1.3/5 with about 94% one-star, against App Store 4.7 from about 39K. — [news-tech.co.uk](https://news-tech.co.uk/is-manus-ai-legit-what-the-reviews-actually-show/). Genspark about 1.5-1.9/5 (about 112 reviews), 82% one-star per one source. — [eesel](https://www.eesel.ai/blog/genspark-ai-review)
- [User] Severity, irreversible actions: a wrong subscription tier cancelled (Gemini auto browse, May 2026); 1,000 emails deleted (Cowork, Jan 2026); a fake-store purchase with autofilled payment (Comet, Aug 2025). — [Sean Kim](https://blog.imseankim.com/chrome-auto-browse-gemini-agentic-hotel-form-fill-google-io-2026/); [aireiter](https://aireiter.com/blog/claude-cowork-computer-use-review); [HackMag](https://hackmag.com/news/scamlexity)
- [Press] Severity, speed: Atlas about 10 minutes for 3 cart items; ChatGPT agent about 50 minutes for an Etsy search; Claude in Chrome 30 minutes to 2 hours for complex workflows; screenshot agent 17 minutes against 20 seconds by API. — [Futurism](https://futurism.com/artificial-intelligence/openai-atlas-web-browser-messy); [ninetwothree](https://www.ninetwothree.co/blog/chatgpt-agent-mode); [AI Tool Analysis](https://aitoolanalysis.com/claude-in-chrome-review/); [The Register](https://www.theregister.com/ai-and-ml/2026/05/07/ai-vision-agents-use-45x-more-tokens-than-apis-in-benchmark/5231346)
- [Press] Backlash volume: Davuluri's "agentic OS" post drew overwhelmingly negative replies and wide coverage (The Register, TechRadar, Neowin, TechSpot), and he restricted replies. — [TechRadar](https://www.techradar.com/pro/security/no-one-wants-this-microsoft-exec-hit-with-barrage-of-abuse-after-celebrating-windows-evolution-to-become-an-agentic-os); [Neowin](https://www.neowin.net/news/microsoft-confirms-windows-11-is-about-to-change-massively-gets-enormous-backlash/)
- [User] Limits: a third-party troubleshooting guide calls Cowork's usage limits the number-one complaint. — [parix.ai](https://parix.ai/blog/claude-cowork-not-working/)

### Inferences
Cross-cutting ranking. Order is by breadth across products first, then by severity and engagement. This is my judgment from the findings above:
1. **Unreliable multi-step execution** (loops, wrong clicks, premature "done", stalls on modals, wrong destructive actions). Seen in every product with an agent: ChatGPT agent, Atlas, Comet, Claude in Chrome, Cowork, Gemini CU, auto browse, Copilot Vision/Actions, Copilot Studio, Neon, Manus, Genspark.
2. **Slow, often slower than doing it yourself.** ChatGPT agent, Atlas, Claude in Chrome, Neon, Gemini CU, Reflex benchmark.
3. **Prompt injection and security fear.** The highest-engagement threads: Comet (Brave, Guardio, LayerX, MCP exploit), Claude for Chrome, Cowork exfiltration, Atlas memory injection, the Windows XPIA warning, Gemini Agent, OpenClaw.
4. **Usage limits, cost, credits.** Cowork (about 10 minutes to cap), Claude in Chrome, ChatGPT agent (40 a month), Codex on Plus, Work's metering, Manus and Genspark charging for failures, Mariner at $249.99, and the screenshot token cost behind all of it.
5. **Logins, 2FA, CAPTCHAs, site blocking.** ChatGPT agent, Gemini CU, auto browse MFA, Gemini Agent without saved logins, Work without a logged-in browser, Amazon v. Perplexity, Google bot defenses blocking Google's own agent.
6. **Narrow platform or surface coverage.** Browser-only (Gemini CU, Mariner, auto browse, Nova Act). Single OS or browser (Atlas macOS-only, Dia Apple silicon only, Simular macOS 15+, Claude in Chrome on Chrome/Edge only). Plan-gated (Cowork computer use excludes Team/Enterprise). App-gated (Copilot Studio without custom desktop apps or Electron/Java/Unity/Citrix; Codex Windows not seeing native apps).
7. **Product churn and retirement without migration.** Operator, ChatGPT agent, Atlas, Mariner.
8. **Desktop plumbing: OS permissions and setup.** Codex macOS TCC/approval failures, Chrome extension re-approvals, Windows admin-only device-wide toggle.
9. **Background operation and machine state.** It must stay awake with the app open (Cowork; Claude in Chrome schedules). Windows will not sleep while an agent is active. Tasks are interrupted by the person's own tab activity (auto browse). Screen contention, addressed by Cowork's background windows on macOS 15+ and Windows' separate session.
10. **Confirmation friction vs. autonomy.** "Ask before acting" friction (Claude in Chrome), against too little confirmation (Comet's fake-store purchase) and confirmations that fail to hold (the auto browse cancellation).
11. **Privacy.** Screenshots see everything and there is no sandbox (Cowork). Atlas and Comet data concerns. Comet's permission scope drove a reviewer away. Windows known-folder access.
12. **Over-refusal.** A Chrome Web Store review (Oct 2026); Copilot refusing UI actions in early trials.

### Gaps
- No vendor publishes complaint volumes. Reddit thread counts and upvotes are unavailable (crawler blocked). Ratings for Manus and Genspark come from blog snapshots with inconsistent counts.

## What made people stop using a product (churn reasons)?

### Takeaway
Documented churn comes from four causes:
- Forced retirement (Atlas, ChatGPT agent, Mariner).
- Billing and credit anger (Manus, Genspark).
- Security scares that made users disconnect accounts (Comet).
- Agents too slow or flaky to beat doing the task by hand.
Quota ceilings push Cowork users to pay more rather than leave, at least in the available evidence.

### Cited Findings
- [User] Forced churn: ChatGPT agent's removal left a forum user without a working replacement. The thread title says agent mode was removed with no real replacement. — [OpenAI community 1389601](https://community.openai.com/t/agent-mode-was-removed-with-no-real-replacement/1389601). Atlas users had to save data before the Aug 9, 2026 shutdown. — [Wikipedia, citing TechRepublic 2026-08-06](https://en.wikipedia.org/wiki/ChatGPT_Atlas). Mariner subscribers lost the product on May 4, 2026. — [GIGAZINE](https://gigazine.net/gsc_news/en/20260507-google-shuts-down-project-mariner/)
- [User] Billing churn: Manus and Genspark reviewers cite credits burned on failed tasks, unexpected charges, hard cancellations and bot support. Some filed complaints with regulators (single-user claims). — [Trustpilot Manus](https://www.trustpilot.com/review/manus.im); [eesel Genspark](https://www.eesel.ai/blog/genspark-ai-review)
- [User] Security churn: after the Dec 2025 MCP exploit, a Comet user said they disconnected all their accounts. — [AI Tool Analysis](https://aitoolanalysis.com/comet-browser-review/). A writer abandoned Comet at its permissions screen. — [Sovereign Magazine](https://www.sovereignmagazine.com/article/i-wanted-to-love-perplexity-s-ai-browser-but-the-permissions-screen-made-me-hit-cancel)
- [Press] "Faster to do it myself": a ChatGPT agent reviewer gave up mid-task and did it in another tab. Neon reviewers found Do slower than manual. Claude in Chrome was found slower than manual. — [Medium, khaoskook](https://medium.com/@khaoskook/frankly-chatgpts-agent-mode-is-a-little-disappointing-087ebf77fdbb); [Remio](https://www.remio.ai/post/opera-neon-review-the-confusing-future-of-ai-browsers); [AI Tool Analysis](https://aitoolanalysis.com/claude-in-chrome-review/)
- [User] Quota: a Cowork user pays about EUR 15 a month extra to keep working, and another waits about 6 hours after hitting the cap. — [ruben.substack comments](https://ruben.substack.com/p/claude-computer/comments)
- [Press] Vendor-side abandonment: coverage of Mariner's shutdown ties it to a compute-heavy, browser-only approach and a pivot to workflow integration. Google gave no official reason. — [Startup Fortune](https://startupfortune.com/googles-mariner-shutdown-shows-the-agent-market-is-pivoting-from-browser-chaos-to-workflow-integration/); [TechSpot](https://www.techspot.com/news/112334-project-mariner-dead-but-google-browser-controlling-ai.html)
- [Press] Platform churn pressure: PCMag's Jan 2026 headline on Atlas stressed the missing Windows and mobile versions. It never shipped on Windows. — [Wikipedia](https://en.wikipedia.org/wiki/ChatGPT_Atlas)

### Inferences
- Retirements without migration, together with OpenClaw's growth on self-owned hardware, suggest some users value control and continuity (their own machine, their own config) over hosted convenience. That favors open-source, locally run servers, provided they address the security complaints that dominate OpenClaw coverage.
- Churn evidence for Claude in Chrome and Cowork is thin. Complaints are frequent, but the visible response is paying more or waiting for a quota reset rather than quitting.

### Gaps
- No retention or usage numbers are public for any product except Comet's claimed 10M users (Feb 2026) and the Claude in Chrome rating count. No survey-based churn study of hosted computer-use agents was found.
