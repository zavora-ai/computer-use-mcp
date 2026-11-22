# Enterprise, security, reliability and platform expectations for computer-use agents (as of 2026-10-25)

Scope note: notes for a comparison against computer-use-mcp. Sources were gathered on 2026-10-25. Where only search
summaries or secondary coverage were available, that is marked. Vendor-reported numbers are labelled as such. Items
before 2025 are labelled "older".

## 1. Enterprise requirements: what buyers and analysts demand before deploying computer-use agents, and what blocks adoption

### Takeaway
Analysts frame the category as "block or tightly contain until proven otherwise". Gartner told CISOs in December 2025
to block AI browsers. Forrester's AEGIS (39 controls in 6 domains) and the 2026 CISO surveys keep asking for the same
things: an inventory of agents, a separate identity per agent, least agency, per-tool-call authorization, revocation
within minutes, and audit. Fewer than half of CISOs say they have any of these today (Okta, 306 CISOs, June 2026).
Two controls are named most often and are usually missing: per-agent identity with revocation, and a contained
execution environment (a hosted browser, a Cloud PC, or a separate agent account).

### Cited Findings
**Gartner**
- Gartner's advisory "Cybersecurity Must Block AI Browsers for Now" (analysts Dennis Xu, Evgeny Mirolyubov, John Watts;
  reported 2025-12-08):
  - It defines AI browsers by two features: an AI sidebar, and "agentic transaction" capability in authenticated
    sessions.
  - It names these risks: sidebar data going to cloud back ends; indirect prompt injection leading to rogue actions;
    erroneous actions from inaccurate reasoning; credential loss to phishing; employees automating mandatory training;
    wrong purchases.
  - It recommends: block installs if the back-end AI is judged too risky; assess the back-end AI service; disable
    agentic transactions, including use of email; harden data retention; centrally govern and monitor the AI-browser
    fleet; educate users that anything on screen may be sent to the AI. — [The Register, 2025-12-08](https://www.theregister.com/2025/12/08/gartner_recommends_ai_browser_ban/)
  - Gartner's wording: "CISOs must block all AI browsers in the foreseeable future" — [CSO Online, Dec 2025](https://www.csoonline.com/article/4102571/keep-ai-browsers-out-of-your-enterprise-warns-gartner-2.html)
  - Criticism: Security Boulevard calls a blanket ban unrealistic because AI browsers had already spread — [Security Boulevard, Dec 2025](https://securityboulevard.com/2025/12/gartners-ai-browser-ban-rearranging-deck-chairs-on-the-titanic/)
- Gartner predicts over 40% of agentic AI projects will be cancelled by end of 2027, citing rising costs, unclear
  business value and inadequate risk controls. It warns of "agent washing" and estimates only about 130 of the thousands
  of "agentic" vendors are real — [Gartner press release, 2025-06-25](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)
- Gartner forecasts that 40% of enterprise apps will feature task-specific agents by 2026, up from under 5% in 2025.
  The coverage also mentions CISO concerns about governance, data sovereignty and liability — [IT Brief (secondary), 2025](https://itbrief.com.au/story/ai-agents-to-power-40-of-enterprise-apps-by-2026-says-gartner)
- Gartner published a Magic Quadrant for Enterprise AI Coding Agents (2026-05-20). Secondary commentary says its
  criteria include "approval checkpoints" and "sandbox scope enforcement". Unverified against Gartner's own text — [Creeta (secondary)](https://news.creeta.com/en/gartner-enterprise-ai-coding-agents-2026/)
- A Gartner press release dated 2026-09-29 predicts 70% of enterprises will abandon agentic AI built by vendor
  forward-deployed engineering by 2028. Only the title was seen — [Gartner, 2026-09-29](https://www.gartner.com/en/newsroom/press-releases/2026-09-29-gartner-predicts-70-percent-of-enterprises-will-abandon-agentic-ai-built-by-vendor-forward-deployed-engineering-by-2028)

**Forrester**
- AEGIS is built on "least agency": give an agent as few tools, permissions and decisions as possible. It has 39
  controls across six domains: governance, identity, data, application security, threat operations and Zero Trust. Its
  identity domain treats agents as first-class entities with ownership, credentials, lifecycle and auditability, plus
  just-in-time, least-privilege authorization — [Forrester AEGIS page](https://forrester.com/technology/aegis-framework); [TechTarget](https://www.techtarget.com/cybersecurity/tip/How-the-AEGIS-framework-mitigates-agentic-AI-risks?amp=1)
- A CSA note (2026-08-25) says every AEGIS control maps to the NIST AI RMF and ISO/IEC 42001. It adds that AEGIS is a
  proprietary Forrester product, not an open standard — [CSA research note, Aug 2026](https://labs.cloudsecurityalliance.org/research-rb/csa-research-note-forrester-aegis-agentic-ai-controls-202608/)

**Surveys: what blocks adoption**
- Okta Global CISO Insights 2026: 306 security executives in the UK, Japan, US, France, Canada and Germany; data
  finalized June 2026; published 2026-07-29 — [Okta, 2026-07-29](https://www.okta.com/newsroom/articles/global-ciso-insights-2026/)
  - Visibility and control: 47% can identify all AI agents in their environment; 46% can centrally control what agents
    access; 45% can authorize individual agent actions or tool calls.
  - Concern and credentials: 81% worry about excessive AI access; 21% use shared credentials or broad service accounts.
  - Revocation: 26% on average can revoke agent access within minutes (50% of "advanced" organizations); 18% of
    "reactive" organizations cannot identify or stop a rogue agent.
  - Barriers: 48% cite lack of visibility into AI identities (US: 74%).
  - Most crucial feature: 29% name full control of agent access; 20% name discovery; 20% name credential management.
- Other surveys (all vendor-sponsored, so directional):
  - 73% of 160+ CISOs are very or critically concerned about agent risk, and 25% of enterprises have no AI-specific
    controls — [NeuralTrust, 2026](https://neuraltrust.ai/blog/the-state-of-ai-agent-security-2026)
  - 76% of CISOs say limited visibility into AI traffic is a major barrier — [Gigamon via NatLawReview, 2026](https://natlawreview.com/press-releases/gigamon-2026-survey-shift-hybrid-ai-drives-governance-top-ciso-agenda)
  - 52% of 100 security leaders distrust agent outputs, and 36% have agents in production — [Strike48, 2026](https://www.strike48.com/resources/agentic-security-report)
  - 92% of 235 CISOs and CIOs lack full visibility into agent identities — [CSA research note, 2026-04-03](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-agent-governance-framework-gap-20260403/)

**Concrete enterprise controls shipped by vendors (the de facto checklist)**
- Copilot Studio computer use:
  - Microsoft's preview announcement lists a hosted browser on Windows 365 (no machine setup) or a registered machine of
    your own; stored credentials for websites and desktop apps; and an allow-list of websites and apps, with the run
    stopping automatically if it goes outside the list — [Microsoft Copilot blog, 2025](https://www.microsoft.com/en-us/microsoft-copilot/blog/copilot-studio/computer-use-is-now-in-public-preview-in-microsoft-copilot-studio/)
  - Computer-using agents reached general availability in May 2026 — [Copilot Studio May 2026 updates](https://www.microsoft.com/en-us/copilot/blog/copilot-studio/new-and-improved-computer-using-agents-a-new-workflows-experience-and-real-time-voice-experiences/)
  - Session replay (instruction, screenshots, coordinates, timestamps, sites, credentials used) is described only by a
    third-party article. Unverified — [DEV Community (secondary)](https://dev.to/aakash_rahsi/copilot-studio-computer-use-assurance-session-replay-and-oversight-rahsi-framework-40e9)
- Microsoft Build 2026 (2026-06-02) — [Microsoft Security blog, 2026-06-02](https://www.microsoft.com/en-us/security/blog/2026/06/02/microsoft-build-2026-securing-code-agents-and-models-across-the-development-lifecycle/)
  - Generally available: Windows 365 for Agents ("fully isolated, policy-governed Cloud PC") and the Agent 365 SDK
    (observability, access controls, compliance).
  - Preview:
    - Purview audit of all agent activity.
    - Purview runtime DLP for agent prompts.
    - Purview exfiltration protections for Claude Code, GitHub Copilot, OpenAI Codex and OpenClaw.
    - Intune agent runtime policies.
  - Preview "coming soon":
    - An Agent 365 registry that discovers unmanaged local agents, local and remote MCP servers among them, through
      Defender, Entra and Intune.
    - Defender hunting over agent activity.
  - Early preview: the MXC execution-container SDK (process and session isolation).
  - A third party notes that public Microsoft Learn docs still listed Windows 365 for Agents as preview and US-only — [Redmondmag, 2026-06-02](https://redmondmag.com/articles/2026/06/02/microsoft-uses-build-2026-to-put-ai-agents-at-the-center-of-windows.aspx)
- Claude in Chrome admin controls: site allowlists and blocklists, an org-wide on/off switch, and off by default for
  HIPAA-enabled organizations (not covered by the BAA) — [Anthropic Help Center, accessed 2026-10-25](https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely)
- Anthropic's desktop computer use is still not offered to Team or Enterprise plans (Pro and Max only, research
  preview) — [Claude Code docs, accessed 2026-10-25](https://code.claude.com/docs/en/computer-use.md); [Anthropic safety guide, accessed 2026-10-25](https://support.claude.com/en/articles/14128542)

### Inferences
- In order of how often they appear, the demanded controls are:
  1. An inventory or registry of agents, and an identity per agent.
  2. Least agency: per-app and per-site allowlists, and capability tiers.
  3. Per-action authorization for consequential steps.
  4. Revocation and a kill switch measured in minutes.
  5. Audit that ties actions to an agent identity, increasingly with a screenshot trail (session replay).
  6. Execution in a contained desktop (Cloud PC, hosted browser, separate account).
  7. DLP over what is sent to the model.

  SOC 2 and data residency come up mainly for cloud-hosted agents. A local MCP server sidesteps residency but then has
  to show where its screenshots go.
- How computer-use-mcp maps to that list:
  - It already covers app allowlists and denylists, an approval flow (host elicitation or token), a sensitive-app gate,
    filesystem roots, a JSONL audit log, and a person-facing Pause and Stop.
  - The controls buyers name that it does not obviously provide:
    - A per-agent identity that can be revoked centrally, rather than per-process environment variables.
    - Fleet or MDM-managed policy.
    - A screenshot-linked session replay.
    - DLP or redaction of captured frames before they reach the model.
    - Credential vaulting and hand-off.
    - A contained or isolated desktop mode.
    - Category tiers in the style of Claude's view-only and click-only.
- Anthropic keeping desktop computer use off Team and Enterprise plans (as of 2026-10-25) suggests even first-party
  vendors do not yet consider their own local computer use enterprise-ready.

### Gaps
- No Gartner, IDC or consultancy document specific to desktop computer-use agents (as opposed to AI browsers or agentic
  AI in general) was found. IDC figures were not found at all.
- Forrester's full AEGIS control list is paywalled, so individual control wording (for example, whether it names
  session replay or a kill switch) is unverified.
- No survey isolates computer-use or GUI agents from agents in general.
- Microsoft's official documentation of Copilot Studio session replay was not located.

## 2. Security: incidents in 2025–2026, researcher recommendations, and what vendors shipped

### Takeaway
From August 2025 to August 2026 a steady run of disclosures showed indirect prompt injection steering agents in Comet,
Atlas, Claude Cowork, M365 Copilot, Atlassian Rovo and MCP servers into exfiltration, credential theft and purchases.
Several were zero-click. Hidden text in screenshots and calendar invites were among the vectors. Researchers converge on
Willison's "lethal trifecta": private data, untrusted content and an exfiltration channel should never be combined.
Vendors answered with layered, probabilistic defences:
- **Classifiers and critics:** Anthropic's two classifiers, Google's User Alignment Critic, OpenAI's adversarially
  trained model with an RL attacker.
- **Scope limits:** Google's origin sets, Anthropic's per-app and per-site permissions and category tiers.
- **Confirmation tiers** before sensitive actions.
- **Logged-out and watch modes** (OpenAI).
- **Hiding the operator's own UI** from the model (Anthropic excludes the terminal; Esc is consumed).

None of them claims a deterministic guarantee.

### Cited Findings
**Incidents and disclosures**
- Brave, Perplexity Comet (Aug 2025): hidden text on a page (for example light-on-light text or HTML comments) was
  executed as user instructions. On re-testing, Brave found the issue still not fully mitigated — [Brave, Aug 2025](https://brave.com/blog/comet-prompt-injection/)
- Brave, "unseeable prompt injections in screenshots" (2025-10-21): instructions embedded in images, invisible to
  humans, were read from Comet's screenshot feature and followed. Fellou treated visible page text as trusted input.
  This is directly relevant to screenshot-driven desktop agents — [Brave](https://brave.com/blog/unseeable-prompt-injections/); [Simon Willison, 2025-10-21](https://simonwillison.net/2025/Oct/21/unseeable-prompt-injections/)
- Guardio "Scamlexity" (Aug 2025):
  - Comet bought an Apple Watch on a fake Walmart site, auto-filling payment details in some runs.
  - It sent a user to a live phishing page from a spoofed bank email.
  - It obeyed "PromptFix", an injection hidden in a fake CAPTCHA. — [Guardio Labs](https://guard.io/labs/scamlexity-we-put-agentic-ai-browsers-to-the-test-they-clicked-they-paid-they-failed); [The Hacker News, Aug 2025](https://thehackernews.com/2025/08/experts-find-ai-browsers-can-be-tricked.html)
- LayerX (Oct 2025) reported "ChatGPT Tainted Memories" in Atlas and "CometJacking", an injection delivered through
  crafted URL parameters — [Wikipedia: ChatGPT Atlas (secondary)](https://en.wikipedia.org/wiki/ChatGPT_Atlas); [CyberScoop](https://cyberscoop.com/agentic-ai-browsers-allow-hijacking-zenity-labs-comet/)
- A secondary source says Atlas stopped only 5.8% and Comet 7% of malicious web pages in testing. The figures come from
  one source and are unverified — [Decryption Digest (secondary)](https://www.decryptiondigest.com/blog/agentic-browser-prompt-injection-comet-atlas-security)
- An academic index found no agent-specific safety evaluations or third-party testing disclosed for Comet — [2025 AI Agent Index, arXiv 2602.17753, Feb 2026](https://arxiv.org/pdf/2602.17753)
- PromptArmor, Claude Cowork (Jan 2026):
  - A document posing as a Claude Skill, with hidden 1-pt white text, made Cowork upload user files to an attacker's
    Anthropic account through the Files API, with no further approval once folder access had been granted.
  - The technique had first been reported by Johann Rehberger and was not remediated. — [PromptArmor](https://www.promptarmor.com/resources/claude-cowork-exfiltrates-files); [The Register, 2026-01-15](https://www.theregister.com/security/2026/01/15/anthropics-files-api-exfiltration-risk-resurfaces-in-cowork/5202464)
- Zenity Labs "PleaseFix" and "PerplexedBrowser" (published 2026-03-03):
  - Zero-click hijack of Comet through a legitimate calendar invite.
  - The agent read local files and sent them to an attacker while showing the user a normal reply.
  - It was steered into the 1Password web vault to pull secrets.
  - Timeline: disclosed 2025-11-03; a first patch on 2026-01-23 was bypassed; a second patch on 2026-02-13 blocked file
    system access by default. — [Zenity Business Wire, 2026-03-03](https://www.businesswire.com/news/home/20260303909038/en/Zenity-Labs-Discloses-PleaseFix-Vulnerability-Family-in-Perplexity-Comet-and-Other-Agentic-Browsers); [Zenity Labs](https://labs.zenity.io/p/perplexedbrowser-how-attackers-can-weaponize-comet-to-takeover-your-1password-vault); [Korben](https://korben.info/en/perplexity-comet-calendar-invite-1password-vulnerability.html)
- EchoLeak (M365 Copilot, 2025): a hidden payload in an email made Copilot exfiltrate mail and chat with no click.
  OWASP's agentic list uses it as the example for ASI01 — [Giskard summary of OWASP (secondary)](https://www.giskard.ai/knowledge/owasp-top-10-for-agentic-application-2026)
- MCP servers (secondary aggregators; counts not checked against NVD):
  - Three Anthropic Git MCP server CVEs (CVE-2025-68143, -68144, -68145; path traversal and argument injection),
    disclosed Jan 2026.
  - "MCPwn" CVE-2026-33032 in the nginx-ui MCP server: CVSS 9.8, exploited in the wild, patched 2026-03-15.
  - 30+ MCP CVEs in one 60-day window in early 2026, about 43% of them command injection.
  - A PromptArmor zero-click exfiltration in Atlassian Rovo, published 2026-08-05 while still unpatched.
  - A Cowork VM escape, "SharedRoot" CVE-2026-46331. — [Practical DevSecOps, 2026](https://www.practical-devsecops.com/mcp-security-statistics-2026-report/); [CyberDesserts](https://blog.cyberdesserts.com/ai-agent-security-risks/)
- An arXiv paper shows Unicode TAG-block characters hiding payloads in MCP tool metadata, so the host's approval view
  does not show what the model reads, across three server implementations — [arXiv 2607.05744, Jul 2026](https://arxiv.org/pdf/2607.05744)
- A CSA research note reports prompt injection defeating Claude Code's auto-mode safety classifier. Only the title and
  abstract were seen — [CSA Labs, 2026](https://labs.cloudsecurityalliance.org/research/csa-research-note-claude-code-automode-prompt-injection-2026/)

**Researcher recommendations**
- Simon Willison, "lethal trifecta" (2025-06-16): access to private data, plus exposure to untrusted content, plus the
  ability to communicate externally. He calls 95% detection "very much a failing grade" and says the only safe course
  is to avoid combining all three — [Simon Willison, 2025-06-16](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)
- Brave calls indirect prompt injection "a systemic challenge" for the whole AI-browser category, not a single bug — [Brave, Oct 2025](https://brave.com/blog/unseeable-prompt-injections/)
- OWASP Top 10 for Agentic Applications (2025-12-09):
  - ASI01 Agent Goal Hijack; ASI02 Tool Misuse and Exploitation; ASI03 Identity and Privilege Abuse; ASI04 Agentic
    Supply Chain; ASI05 Unexpected Code Execution; ASI06 Memory and Context Poisoning; ASI07 Insecure Inter-Agent
    Communication; ASI08 Cascading Failures; ASI09 Human-Agent Trust Exploitation; ASI10 Rogue Agents.
  - Sources: [OWASP GenAI, 2025-12-09](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/); names verified via [Giskard](https://www.giskard.ai/knowledge/owasp-top-10-for-agentic-application-2026)
  - Mitigation guidance (treat retrieved content as untrusted input) — [SecureW2 (secondary)](https://securew2.com/?p=72008)

**What vendors shipped in response**
- Anthropic, Claude in Chrome:
  - At pilot launch, attack success was 23.6% without mitigations and 11.2% with safeguards, across 123 tests covering 29
    attack scenarios — [Anthropic, Aug 2025 (older baseline)](https://www.claude.com/blog/claude-for-chrome)
  - The current page lists:
    - Two classifiers: one on incoming content, one checking each action before it runs.
    - RL training to refuse injected instructions.
    - Blocked categories (adult and pirated content).
    - Permission prompts before financial sites.
    - Confirmation for downloads and for entering sensitive data.
    - A "Manually approve" mode.
    - Prohibited activities: trading, CAPTCHA bypass, entering sensitive data.
  - It claims attack success "less than 0.08%" with Claude Opus 4.8 on internal tests. Undated page — [Anthropic Help Center, accessed 2026-10-25](https://support.claude.com/en/articles/12902428-use-claude-in-chrome-safely)
- Anthropic, desktop computer use (Claude Code CLI and Desktop):
  - Per-app approval for each session.
  - Category tiers: browsers and trading platforms view-only; terminals and IDEs click-only; everything else full
    control.
  - "Sentinel" warnings for terminals ("equivalent to shell access"), Finder and System Settings.
  - Other apps hidden while it works.
  - The terminal excluded from screenshots so on-screen text cannot feed back into the model.
  - A global Esc that is consumed so an injection cannot use it to dismiss dialogs.
  - A one-session lock file.
  - A notification at the start and end of each turn.
  - Desktop supports macOS and Windows with a configurable denied-apps list; the CLI is macOS only.
  - Sources: [Claude Code docs, accessed 2026-10-25](https://code.claude.com/docs/en/computer-use.md)
  - The safety guide adds that investment, trading and crypto apps are blocked by default, that the agent scans for
    injection and asks before opening new apps, and advises keeping sensitive apps out of reach — [Anthropic safety guide](https://support.claude.com/en/articles/14128542)
- OpenAI, Atlas and agent mode:
  - An RL-trained automated attacker finds injections, and its traces feed an adversarially trained agent model.
  - OpenAI claims no deterministic guarantee. — [OpenAI, "Continuously hardening ChatGPT Atlas", Dec 2025 (page returned 403; via search summary and coverage)](https://openai.com/index/hardening-atlas-against-prompt-injection); [eSecurity Planet](https://www.esecurityplanet.com/artificial-intelligence/openai-hardens-chatgpt-atlas-against-prompt-injection-attacks/)
  - Logged-out mode (the agent is not signed in to sites).
  - "Watch Mode" on sensitive sites: the tab must stay active, and the agent pauses if the user switches away.
  - Confirmation before purchases. — [OpenAI, "Understanding prompt injections" (via search summary)](https://openai.com/index/prompt-injections/)
- Google, Gemini in Chrome (Dec 2025):
  - A separate "User Alignment Critic" model checks each planned action and sees only action metadata, not raw web
    content.
  - "Origin sets" separate read-only from read-write origins and withhold unrelated sites and iframes; a gating function
    approves new domains.
  - A real-time injection classifier.
  - Pauses before purchases and messages. — [9to5Google, 2025-12-08](https://9to5google.com/2025/12/08/gemini-chrome-agentic-security/); [BleepingComputer](https://bleepingcomputer.com/news/security/google-chrome-adds-new-security-layer-for-gemini-ai-agentic-browsing)
- Microsoft:
  - Agent accounts, agent workspace, signed agents that can be revoked ("operational trust"), and user transparency to
    authorize, monitor and take over. Copilot Actions is off by default — [Windows security book, 2025-11-13](https://learn.microsoft.com/en-us/windows/security/book/operating-system-agentic-security)
  - Microsoft names cross-prompt injection (XPIA) through UI elements and documents as the core risk (same source).

### Inferences
- What the vendor responses have in common:
  1. Restrict scope (sites, apps, origins, tiers).
  2. Add a second model or classifier that checks actions without reading raw untrusted content.
  3. Confirm before consequential actions.
  4. Keep the operator's own UI and stop key out of the model's reach.
  5. Prefer logged-out or contained contexts.
- Anthropic's view-only and click-only tiers by app category, and "sentinel" warnings for shell-equivalent apps, are a
  concrete bar for any desktop MCP server. computer-use-mcp's sensitive-app gate and allowlist are coarser: allow or
  deny, rather than capability per category.
- Screenshot-borne injection (Brave, Oct 2025) means OCR and vision output must be treated as untrusted. computer-use-mcp
  already states this for live share and web content. The open question is whether the whole action loop has an
  action-checking layer or a capture-redaction layer.
- Hiding the agent's controls from capture (Anthropic excludes the terminal; computer-use-mcp excludes the status card
  and pointer) is now expected practice.
- A consumed emergency key (Anthropic's Esc) parallels computer-use-mcp's ctrl+alt+escape chord.
- MCP-server CVEs are mostly classic injection and path-traversal bugs. Buyers will expect input validation, filesystem
  confinement and supply-chain hygiene (signed packages, provenance) from any MCP server.

### Gaps
- OpenAI's primary pages returned 403, so the exact dates and wording of the Atlas hardening post and the
  prompt-injection page are from search summaries.
- No independent measurement of Google's User Alignment Critic was found.
- The MCP CVE counts and the SharedRoot CVE come from secondary aggregators and were not checked against NVD.
- No 2026 incident was found that targeted a third-party desktop (non-browser) computer-use MCP server specifically.
- The LayerX 5.8% (Atlas) and 7% (Comet) figures were not traced to LayerX's primary report.

## 3. Reliability: benchmark results in 2026 against human baselines, and where agents still fail

### Takeaway
On short desktop tasks, the leaders now beat the OSWorld-Verified human baseline of 72.36%:
- Intelligence-Indeed Agent 90.19%.
- Claude Fable 5 85.96%.
- Claude Opus 5 83.39%.

Long workflows remain far from solved. On OSWorld 2.0 (108 tasks, median 1.6 hours for a human, about 318 tool calls
each), binary completion is 44–49% at best and was 20.6% when the benchmark was released. Recent failure analyses agree
that most failures are now decisions rather than clicks: lost constraints, stale state, skipped verification, guessing
instead of asking. Grounding errors remain a minority.

### Cited Findings
- OSWorld-Verified (369 tasks, 100-step limit), as of 2026-10-01 — [Presenc AI compilation of the official board, Oct 2026](https://presenc.ai/research/osworld-computer-use-leaderboard-2026)
  - Human baseline: 72.36%.
  - Leaders: Intelligence-Indeed Agent 90.19% (2026-07-25); Claude Fable 5 85.96% (2026-08-01); Pointer Agent with
    Opus 4.7 83.64%; Claude Opus 5 83.39%; Coasty CUA v1 82.81%.
- Sources disagree on which agent first crossed the human baseline: Simular Agent S2 at 72.6% (Dec 2025) or GPT-5.4 at
  75.0%, self-reported (2026-03-05) — [BuildMVPFast](https://www.buildmvpfast.com/blog/osworld-benchmark-ai-agents-passed-human-baseline-2026); [AgentMarketCap](https://agentmarketcap-1.onbex.co/blog/2026/07/13/gpt-54-osworld-human-baseline-computer-use-agent-saturation)
- OSWorld 2.0 paper (submitted 2026-06-28, v2 2026-07-13): 108 long-horizon workflows; median human time about 1.6
  hours; about 318 tool calls per task against about 30 in OSWorld 1.0; a 500-step limit — [arXiv 2606.29537](https://arxiv.org/abs/2606.29537)
  - Best at release: Claude Opus 4.8 at 20.6% completion and 54.8% partial.
  - GPT-5.5 "plateaus near 13%" but uses fewer tokens.
  - Failure behaviours it lists: losing track of constraints; missing information that arrives mid-task; guessing rather
    than asking; skipping verification; failing to recover hidden state.
- OSWorld 2.0 v2.1 — [Presenc AI, Oct 2026](https://presenc.ai/research/osworld-computer-use-leaderboard-2026)
  - Scores:
    - Claude Opus 5.5: 81.8% partial, 48.7% binary (vendor-reported, 2026-09-22).
    - Claude Opus 5 at max effort on the official board: 77.67% partial, 44.33% binary.
  - Effort and versioning matter:
    - Opus 5 binary completion runs from 18.81% at low effort to 44.33% at max.
    - It rose from 31.43% to 44.33% between benchmark releases with no change to the model.
- Benchmark scoring itself is noisy: an audit of 150 failed trajectories found about 15% of FAIL verdicts were wrong.
  Grounding, state-propagation and tool errors made up only 13.9% of failures — [arXiv 2607.28367, Jul 2026](https://arxiv.org/html/2607.28367v1)
- CUA-Recovery annotated 619 failures: most were wrong decisions, not wrong clicks. Planning and perception accounted for
  57.3% of root causes in its test set — [arXiv 2610.27645, Oct 2026](https://arxiv.org/html/2610.27645v1)
- A long-horizon codebook (6,967 mistakes, 88 categories, software-engineering and computer-use trajectories combined)
  attributes about 69% to action and planning faults — [arXiv 2609.17930, Sep 2026](https://arxiv.org/pdf/2609.17930)
- WindowsAgentArena: the only figures found are from the original paper. Best agent (Navi) 19.5%, humans 74.5% — [Windows Agent Arena paper (older, 2024; ICML 2025)](https://arxiv.org/html/2409.08264v1)
- AndroidWorld: an aggregator lists a top agent at 97.4% pass@1 against a human entry of 80%. The source of the human
  figure is unclear — [benchmarklist.com, sampled 2026-06-01](https://benchmarklist.com/benchmarks/androidworld/)
- ScreenSpot-Pro (professional high-resolution grounding): no authoritative 2026 leaderboard was found.
  - Chain-of-Ground self-reports 68.4%, against 63.6% for GTA-32B — [arXiv 2512.01979, Dec 2025](https://arxiv.org/pdf/2512.01979)
  - Older baseline: Qwen2.5-VL-72B at 43.6 — [arXiv 2603.12823](https://arxiv.org/pdf/2603.12823)
  - Per-category results from GUI-Eyes-3B show CAD as the weakest category (48.2%), against 70.8% for development tools — [arXiv 2601.09770](https://arxiv.org/pdf/2601.09770)
- Blind users with real desktop apps: 8 users submitted 1,258 commands across 12 applications over three weeks. The best
  agent (GPT-5) succeeded on 52.5%. Failures clustered in grounding, planning, constraint-tracking and termination — [arXiv 2609.00524, Sep 2026](https://arxiv.org/pdf/2609.00524)

### Inferences
- "Beats humans on OSWorld-Verified" is now table stakes in marketing. The live question is long-horizon reliability,
  verification and recovery, which favours servers that make verification cheap: before-and-after captures, `effect`
  fields, waits, deterministic semantic routes (accessibility, scripting).
- Grounding on professional high-resolution apps (CAD, creative tools) is still weak: about 50–68% on ScreenSpot-Pro for
  research systems. Self-drawn apps still need OCR, zoom and coordinate fallbacks.
- Real-user success (52.5% for blind users on desktop apps) is far below benchmark headlines, which matters for
  accessibility claims.

### Gaps
- No 2026 WindowsAgentArena or WebArena results were found, and no current ScreenSpot-Pro scores for frontier models.
- No specific 2026 quantitative failure breakdown was found for drag, scrolling, dialogs or spreadsheets. The OSWorld 2.0
  abstract names "visual-spatial precision" and "streaming interaction" as challenge areas without percentages.
- Several OSWorld numbers are vendor-reported or compiled by a third party. The official os-world.github.io board was
  not fetched directly.

## 4. Cost and latency expectations

### Takeaway
The evidence is thin but consistent:
- Model calls (planning, reflection, judging) dominate latency.
- Agents take several times more steps than humans.
- Screenshots dominate token cost.

The result is tasks that run for tens of minutes and cost dollars, against seconds and cents for a scripted or API
route. Hence the field-wide rule of "API first, scripting second, pixels last", and attention to step count, screenshot
size and keeping old frames out of context.

### Cited Findings
- OSWorld-Human (MLSys 2026) — [arXiv 2506.16042 (v1 Jun 2025)](https://arxiv.org/pdf/2506.16042); [MLSys 2026 oral](https://mlsys.org/virtual/2026/oral/3865)
  - Large-model calls for planning, reflection and judging make up most end-to-end latency.
  - Later steps run up to about 3x slower than early ones.
  - Tasks can take tens of minutes where humans need a few.
  - The best agents take 1.4–2.7x more steps than necessary (v1), or 2.7–4.3x (MLSys version). The versions disagree.
- Claude Code downscales screenshots automatically, for example from 3456×2234 to about 1372×887 on a 16-inch MacBook
  Pro, and offers no setting to change the target size — [Claude Code docs, accessed 2026-10-25](https://code.claude.com/docs/en/computer-use.md)
- Anthropic describes computer use as "the broadest and slowest" route. Claude prefers MCP, then Bash, then the browser,
  then the screen — [Claude Code docs](https://code.claude.com/docs/en/computer-use.md)
- Practitioner figures (anecdotal, attribution between the two sources unclear):
  - A 1080p screenshot adds about 1,000–4,000 tokens.
  - Keeping old screenshots in context multiplied token use about 10x.
  - A median of $3.20 per task against $0.02 for a scripted Playwright run.
  - $1–4 per complex workflow.
  - Sources: [tianpan.co, 2026-04-10](https://tianpan.co/blog/2026-04-10-computer-use-agents-when-pixels-replace-apis); [Enterprise DNA](https://enterprisedna.co/resources/blog/practitioner-anthropic-computer-use)
- OSWorld 2.0 notes GPT-5.5 is "far more token-efficient" than Claude Opus 4.8 but completes fewer tasks, a cost and
  capability trade-off — [arXiv 2606.29537](https://arxiv.org/abs/2606.29537)
- Gartner names "escalating costs" as a top reason agentic projects will be cancelled — [Gartner, 2025-06-25](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)

### Inferences
- These designs answer the cost and latency criticism:
  - Batched steps (`run_steps`).
  - Suppressing duplicate captures.
  - Region OCR instead of full frames.
  - Waits instead of polling screenshots.
  - Routing to scripting or accessibility first.

  The step-count multiple (2.7–4.3x over human trajectories) is the metric analysts cite. Reporting tokens and steps per
  task would let a server compete on it.

### Gaps
- No analyst (Gartner, Forrester or IDC) gives an acceptable latency or cost-per-task threshold for computer-use agents.
- No controlled study of per-task dollar cost across vendors in 2026 was found.

## 5. Platform and host expectations: Windows, Linux and Wayland, multi-monitor, MCP host features, accessibility

### Takeaway
First-party computer use is still uneven across platforms:
- Anthropic: Claude Desktop computer use runs on macOS and Windows; the CLI is macOS only; no Linux.
- Microsoft: building around Windows-native containment.
- Google: Android.

The 2026-07-28 MCP spec changes what a host can offer a computer-use server: stateless requests, MRTR-based elicitation
for confirmations, a Tasks extension for long work, MCP Apps for server-rendered UI, and Mcp-Method/Mcp-Name headers so
gateways can authorize. Evidence on demand for Wayland and multi-monitor support in agents is anecdotal. Accessibility for
disabled users is emerging as a research use case, with modest success rates.

### Cited Findings
- MCP 2026-07-28 (final, released 2026-07-28) — [MCP blog, 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
  - The `initialize` handshake and session header are retired; each request carries version, identity and capabilities
    in `_meta`.
  - `server/discover` is added.
  - Multi Round-Trip Requests (`resultType: "input_required"`) replace server-initiated elicitation and sampling; the
    post's example is a tool asking for confirmation mid-call.
  - Change notifications move to a single `subscriptions/listen` stream.
  - Tasks become the `io.modelcontextprotocol/tasks` extension, with `tasks/get` and `tasks/update`.
  - The first official extensions are MCP Apps, Tasks and Enterprise Managed Authorization.
  - Streamable HTTP must carry `Mcp-Method` and `Mcp-Name` headers for gateways and WAFs.
  - Roots, Sampling, Logging and HTTP+SSE are deprecated, with at least 12 months' notice.
  - Dynamic client registration gives way to CIMD.
  - Tier-1 SDKs are TypeScript, Python, Go and C#; Rust is in beta.
  - Supporters named include Bedrock AgentCore, Cloudflare, Microsoft Foundry and Supabase, which cites elicitation for
    confirming actions.
- The Microsoft C# SDK v2 moves elicitation to `InputRequiredException`; the legacy method throws in stateless mode — [.NET Blog](https://devblogs.microsoft.com/dotnet/announcing-v20-of-the-official-mcp-csharp-sdk/)
- Anthropic computer use platform coverage: Desktop on macOS and Windows; CLI macOS only; not on Linux; not through
  Bedrock, Vertex or Foundry; only one session at a time — [Claude Code docs, accessed 2026-10-25](https://code.claude.com/docs/en/computer-use.md)
- Claude's Mac computer use launched as a research preview in March 2026; a September 2026 report says it extended to
  Windows — [Reworked, Mar 2026](https://www.reworked.co/digital-workplace/anthropics-claude-can-now-control-your-mac/); [Let's Data Science, Sep 2026](https://letsdatascience.com/news/claude-extends-desktop-control-across-macos-and-windows-0e32c092)
- Accessibility:
  - 8 blind users and 1,258 commands: the best agent succeeded on 52.5%, and users needed more than automation (trace
    explanations, control) — [arXiv 2609.00524, Sep 2026](https://arxiv.org/pdf/2609.00524)
  - CHI 2026 AskEase: step-by-step guidance for 12 screen-reader users raised task success and lowered workload — [Microsoft Research / Stanford SCALE](https://scale.stanford.edu/ai/repository/struggle-success-context-aware-guidance-screen-reader-users-computer-use)
- Multi-monitor and Wayland: only general Linux pain points were found, such as Remmina and Citrix failing to use
  multiple monitors under Wayland and Fedora users citing that as a blocker to adopting Wayland. Nothing specific to
  agents — [Fedora Discussion](https://discussion.fedoraproject.org/t/wayland-whats-blocking-you-from-using-it/114012); [Remmina issue 2618](https://gitlab.com/Remmina/Remmina/-/issues/2618)

### Inferences
- A computer-use server that serves both legacy initialization and 2026-07-28 MRTR elicitation, and offers Tasks and an
  MCP App (computer-use-mcp does all of these per its AGENTS.md), is ahead of most hosts. The gap is on the host side:
  which hosts actually render MCP Apps and answer `input_required` for confirmations.
- First-party tools do not support Linux at all, which is a differentiator for any server that does (X11, plus Wayland
  through libei or the portal).

### Gaps
- No survey or analyst source quantifies demand for Windows, Linux, Wayland or multi-monitor support in computer-use
  agents.
- No list of which MCP hosts implement MCP Apps, Tasks or MRTR elicitation as of 2026-10-25 was found.
- No vendor accessibility commitments for computer-use agents were found.

## 6. Operating-system vendors: how Microsoft, Apple and Google are reshaping the baseline

### Takeaway
Microsoft is turning agent isolation into an OS primitive:
- A separate agent account and agent workspace (its own desktop, scoped known-folder access, the user can monitor and
  take over).
- Signed, revocable agents.
- An on-device MCP registry whose servers run contained by default, but only if they are packaged .exe binaries with
  MSIX identity.
- Cloud PCs for agents (Windows 365 for Agents, GA at Build on 2026-06-02).

Google exposes apps as on-device MCP servers through AppFunctions, with UI automation in a "secure virtual window" as the
fallback. Apple's confirmed route is App Intents (expanded at WWDC26). MCP has appeared only as beta code since macOS and
iOS 26.1, and no shipped OS-level MCP was confirmed. The baseline these set for third-party tools:
1. Act through structured app APIs first.
2. Run the agent under its own identity, in a contained session.
3. Let the user watch, take over and revoke.
4. Ship as signed, packaged code.

### Cited Findings
**Microsoft**
- Windows agentic security principles: distinct agent accounts; limited agent privileges that can be revoked; signed
  agents ("operational trust", revocable through certificate validation and antivirus); privacy-preserving design —
  [Windows 11 security book: agentic security, 2025-11-13 (updated 2025-11-18)](https://learn.microsoft.com/en-us/windows/security/book/operating-system-agentic-security)
- Building blocks, from the same source:
  - Copilot Actions is off by default; it is turned on under Settings > System > AI components > Agent tools >
    Experimental agentic features.
  - Agent accounts are separate standard accounts.
  - The agent workspace has its own desktop, with limited visibility of the user's desktop, built on "recognized
    security boundaries".
  - User transparency means the user can authorize, monitor and take over.
  - During preview, agents get access to Documents, Downloads, Desktop and Pictures only.
  - Entra and MSA identity are "coming soon".
- MCP on Windows (public preview, announced at Ignite 2025-11-18):
  - The on-device agent registry (ODR) runs registered MCP servers in a separate agent session under a separate agent
    account.
  - Containment requires: an .exe binary; package identity through an MSIX extension; a manifest.json carrying
    `_meta.com.microsoft.windows` static responses for `tools/list`.
  - MCP bundles (.mcpb) and unpackaged apps cannot run contained.
  - File access is consented per host, not per server.
  - A "Reduce protections for agent connectors" setting exists for testing.
  - Sources: [Microsoft Learn, 2025-11-11 (updated 2025-12-04)](https://learn.microsoft.com/en-us/windows/ai/mcp/servers/mcp-containment); [SiliconANGLE, 2025-11-18](https://siliconangle.com/2025/11/18/microsoft-accelerates-automation-windows-mcp-agent-connectors/)
- Build 2026 (2026-06-02):
  - Generally available: Windows 365 for Agents; the Agent 365 SDK.
  - Preview: Intune agent runtime policies (including blocking OpenClaw execution methods); Purview audit and DLP for
    local coding agents.
  - Preview "coming soon": an Agent 365 registry of local agents and MCP servers.
  - Early preview: the MXC containment SDK.
  - No kill switch or quarantine feature is named.
  - Sources: [Microsoft Security blog, 2026-06-02](https://www.microsoft.com/en-us/security/blog/2026/06/02/microsoft-build-2026-securing-code-agents-and-models-across-the-development-lifecycle/); [Windows IT Pro blog](https://techcommunity.microsoft.com/blog/windows-itpro-blog/made-for-developers-and-agents-windows-365-at-build-2026/4519041)
- No source confirmed general availability of the agent workspace or of Copilot Actions on Windows by 2026-10-25 — [Petri (2025)](https://petri.com/windows-11-agentic-computing-workspaces/); [Microsoft support: experimental agentic features](https://support.microsoft.com/windows/experimental-agentic-features-a25ede8a-e4c2-4841-85a8-44839191dfb3)

**Apple**
- WWDC26 (2026-06-08): App Intents updates let developers connect apps to Siri's personal context, app actions and
  onscreen awareness — [Apple Newsroom, 2026-06](https://www.apple.com/newsroom/2026/06/apple-aids-app-development-with-new-intelligence-frameworks-and-advanced-tools/)
- The macOS 27 guide adds a View Annotations API for acting on on-screen content — [Apple WWDC26 macOS guide](https://developer.apple.com/wwdc26/guides/macos/)
- Xcode 27 adds plugins for bringing your own tools and agents — [Apple WWDC26 video 382](https://developer.apple.com/videos/play/wwdc2026/382/)
- MCP:
  - Code in the iOS, iPadOS and macOS Tahoe 26.1 betas (Sept 2025) suggested MCP support built on App Intents. It was
    not usable, and Apple has not commented — [Computerworld, Sep 2025](https://www.computerworld.com/article/4061614/apple-to-deploy-mcp-support-for-powerful-ai-experiences.html); [AlternativeTo, Sep 2025](https://alternativeto.net/news/2025/9/apple-begins-testing-early-model-context-protocol-mcp-support-in-ios-ipados-and-macos)
  - A claim that Xcode ships an `mcpbridge` binary carrying MCP over XPC is from TechTimes only, not an Apple source — [TechTimes, 2026-06-10](https://www.techtimes.com/articles/318110/20260610/wwdc-2026-day-3-xcode-27-neural-engine-completes-code-without-sending-source-any-server.htm)

**Google**
- AppFunctions:
  - It lets an app act as an on-device MCP server (experimental preview); Gemini already uses it for Calendar, Notes and
    Tasks.
  - The UI-automation framework for apps without integrations is in development.
  - Android 17 is to broaden these features. — [Android Developers blog, I/O 2026](https://developer.android.com/blog/posts/top-ai-on-android-updates-for-building-intelligent-experiences-from-google-i-o-26); [Android Developers: the intelligent OS](https://developer.android.com/blog/posts/the-intelligent-os-making-ai-agents-more-helpful-for-android-apps?authuser=2)
- Gemini agentic tasks on Android:
  - Apps run in a secure virtual window in the background, and Gemini reaches only specific apps.
  - The user follows progress through notifications or a live view, can take over manual control at any point, and is
    alerted before purchases.
  - Launched on the Galaxy S26 series. — [heise (German), 2026](https://heise.de/-11191564)
- Chrome's agent architecture (Dec 2025) is covered in section 2: the User Alignment Critic and origin sets.

### Inferences
- Microsoft's model sets a Windows bar a Node/npx MCP server cannot meet today: ODR containment requires a packaged .exe
  with MSIX identity and excludes .mcpb bundles. A server distributed as an npm package runs uncontained in the user
  session, or the user has to turn on "Reduce protections".
- Expect Windows enterprise buyers to ask whether the server can run inside an agent workspace, a Windows 365 for Agents
  Cloud PC, or under Intune agent runtime policy.
- The OS vendors converge on these user-facing expectations:
  1. The agent works in a separate session or window, not on the user's live desktop.
  2. The user can watch live and take over.
  3. Sensitive actions pause for consent.
  4. Structured app actions come before pixels.

  computer-use-mcp's status card, takeover pause and route order match items 2–4. Item 1, an isolated desktop or agent
  account, is the notable gap.
- On Apple platforms, App Intents and Shortcuts, rather than OS-level MCP, are the structured route a macOS server can
  use today.

### Gaps
- Not verified: whether Microsoft's agent workspace, ODR or MCP on Windows reached GA by 2026-10-25, and whether agent
  accounts are created per agent or shared.
- Not confirmed: any OS-level MCP in macOS 26.x or macOS 27.
- Not found: any Google ChromeOS desktop-agent announcement.

## 7. Regulation and standards touching transparency, logging and human oversight

### Takeaway
No regulation specific to agents is in force yet, but the frameworks point the same way:
- **OWASP's Agentic Top 10** (Dec 2025) names the threat model: goal hijack, tool misuse, identity abuse, rogue agents.
- **NIST CAISI's AI Agent Standards Initiative** (Feb 2026) and an NCCoE concept paper are working on agent hijacking,
  identity, scoped permissions, audit and revocation. Nothing has been finalized.
- **The EU AI Act** requires automatic logging (Art. 12) and configurable human oversight (Art. 14) for high-risk
  systems, and deployers must keep logs for at least six months (Art. 26). The Digital Omnibus pushes Annex III high-risk
  deadlines to 2027-12-02. Its final legal status was reported inconsistently.

### Cited Findings
- OWASP Top 10 for Agentic Applications 2026, published 2025-12-09 by the OWASP GenAI Security Project; ASI01–ASI10 as
  listed in section 2 — [OWASP GenAI](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/); [Modulos](https://docs.modulos.ai/frameworks/owasp-top-10-agentic)
- ASI03 (Identity and Privilege Abuse) describes an "attribution gap" when agents lack governed identity. ASI02 cites
  over-privileged access — [Giskard (secondary)](https://www.giskard.ai/knowledge/owasp-top-10-for-agentic-application-2026)
- NIST CAISI launched the AI Agent Standards Initiative on 2026-02-17, with three pillars: standards, open protocols,
  and agent security and identity — [CASRAI guide](https://casrai.org/guides/nist-ai-agent-standards-initiative); [CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-nist-ai-agent-standards-initiative-complia/)
  - A January 2026 RFI (docket NIST-2025-0035) covers indirect prompt injection, backdoors and misaligned objectives.
  - An NCCoE concept paper (comments due 2026-04-02) explores extending OAuth 2.0 and SPIFFE to agents: how permissions
    are scoped, how actions are audited, how access is revoked.
  - As of May 2026 no standard had been finalized (secondary, CSA).
- EU AI Act — [Help Net Security, 2026-04-16](https://www.helpnetsecurity.com/2026/04/16/eu-ai-act-logging-requirements/); [Lumenova](https://www.lumenova.ai/solutions/eu-ai-act/)
  - Article 12: automatic event logging over the system's lifetime. The Act does not say "tamper-proof", and no
    harmonized logging standard is final; prEN 18229-1 and ISO/IEC DIS 24970 are the drafts to watch.
  - Article 14: human oversight built into the design and configurable by the deployer.
  - Article 26: deployers keep logs for at least six months.
- Digital Omnibus on AI:
  - Parliament adopted it on 2026-06-16 (423 to 57, 174 abstentions). Annex III high-risk obligations move to
    2027-12-02, and embedded products to 2028-08-02 — [iubenda, Jun 2026](https://www.iubenda.com/en/blog/ai-omnibus-parliament-adoption-june-2026); [SecurePrivacy](https://secureprivacy.ai/blog/eu-ai-act-digital-omnibus-the-new-high-risk-ai-deadlines-after-council-approval)
  - Council approval was reported for 2026-06-29 (secure privacy, noze).
  - One opinion piece says it took effect as Regulation 2026/1744 on 2026-07-27 — [Forkast (opinion)](https://forkast.news/?p=132188)
  - Official Journal publication was not verified.
- The EU AI Act has no "agent" category. Agents fall under general-purpose AI obligations, or under high-risk rules when
  the use case is Annex III (inferred from the sources above; no primary EU guidance on agents was found).

### Inferences
- Taken together, the logging and oversight expectations call for:
  1. Automatic, per-action logs attributable to an agent identity, ideally tamper-evident (Art. 12 language and
     Microsoft's non-repudiation principle).
  2. Human oversight the deployer can configure: approvals, pause and stop (Art. 14).
  3. At least six months of log retention on the deployer side (Art. 26).
  4. A way to revoke access quickly (NCCoE, Okta).
- computer-use-mcp's default JSONL audit log, configurable approvals and status card cover the shape of items 1 and 2.
  Tamper evidence, per-agent identity and retention or export settings are what an auditor would ask about next.

### Gaps
- Not found: primary EU, NIST or NCCoE documents; most citations here are secondary.
- Not found: EU guidance that addresses agents explicitly.
- Not verified: the Digital Omnibus's final Official Journal publication, and whether Article 50 transparency
  obligations changed.
- Not checked: the full OWASP mitigation text, including whether it names kill switches or session recording.
