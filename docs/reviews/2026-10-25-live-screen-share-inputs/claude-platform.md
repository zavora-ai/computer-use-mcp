# Claude platform for a live "share your screen" loop (as of 2026-10-25)

Scope: what Anthropic's API and Claude apps offer for feeding a stream of desktop screenshots (or deltas) to Claude: realtime/streaming-input APIs, models and prices, latency, vision cost and limits, prompt caching, streaming, computer use, rate limits.

Labels used below: **[Doc]** = Anthropic documentation or announcement, fetched 2026-10-25. **[3P]** = measured or reported by a third party. **[Snippet]** = seen only in a search-result summary, page not fetched, treat as unverified. Calculations from documented formulas are in the Inferences sections and say so.

## 1. Does Anthropic offer any realtime, bidirectional, voice or streaming-input API (a Gemini Live / OpenAI Realtime equivalent)? What do the apps do?

### Takeaway
No. As of 2026-10-25 the Claude API has no realtime, bidirectional, WebSocket, audio or video endpoint. Current models take text and images in and return text, and the only streaming is server-sent events (SSE) for output. A live screen loop on Claude has to be built as repeated, complete Messages API requests. Voice exists only in the consumer apps: a beta voice mode with hands-free or push-to-talk turn-taking. No official page describes screen or camera input in voice mode. Screen access in the apps works through screenshot-per-action computer use (Claude Desktop / Claude Code desktop) and Claude in Chrome. Neither is a continuous screen feed.

### Cited Findings
- [Doc] "All current models support text and image input, text output, multilingual capabilities, vision, and tool use." No audio or video modality is listed for any current model. — [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview.md)
- [Doc] The Claude Haiku 5.5 spec table gives "Input → output: Text and images → text". — [Claude Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview.md)
- [Doc] Streaming means setting `"stream": true` to "incrementally stream the response using server-sent events (SSE)". The page describes output events only (message_start, content_block_delta, ping, and so on). It documents no WebSocket, bidirectional or input-streaming mechanism. — [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming.md)
- [Doc] Image sources on the API are base64, URL, or a Files API `file_id`. There is no stream or video source type. Bedrock and Google-managed Google Cloud accept base64 only. — [Vision](https://platform.claude.com/docs/en/build-with-claude/vision.md)
- [Doc] Consumer voice mode (help center):
  - It offers "complete spoken conversations with Claude". It is labelled beta and is on all plans, on iOS, Android, Claude Desktop and the web, "built to work best from your phone".
  - Modes: hands-free (the default) listens continuously, "responds after natural pauses", and stops when you talk over it. Push-to-talk is the alternative.
  - It uses the same models as text chat, and Claude Fable is not available in voice mode. Voices are a preset, limited selection.
  - Voice use counts toward plan usage limits. Connected tools (Gmail, Calendar, Docs, Slack) work in voice.
  - In Claude Cowork and Claude Code, "dictation is available but voice mode isn't."
  - The page does not mention camera, screen sharing or video, and it does not mention the API. — [Using voice mode](https://support.claude.com/en/articles/11101966-using-voice-mode)
- [3P] TechCrunch, 2026-03-03, "Claude Code rolls out a voice mode capability". The search summary said it was live for about 5% of users. This likely names the dictation feature that the help center calls dictation. — [TechCrunch](https://techcrunch.com/2026/03/03/claude-code-rolls-out-a-voice-mode-capability/) [Snippet]
- [3P] AlphaSignal (July 2026) reports that voice mode now runs on Opus and Sonnet instead of Haiku, and that speech output appears to go through ElevenLabs. That would make it an STT/TTS pipeline rather than a speech-native model. Single hedged secondary source. — [AlphaSignal](https://alphasignal.ai/news/anthropic-s-claude-opus-finally-powers-voice-mode-with-real-tool-access) [Snippet]
- [3P] TestingCatalog says Anthropic has not released its own TTS models through its API, nor a native end-to-end real-time audio model, and that it "might be developing its own voice models". — [TestingCatalog](https://www.testingcatalog.com/anthropic-might-be-developing-its-own-voice-models/) [Snippet]
- [3P] Early October 2026: Anthropic began asking users to opt in to sharing voice recordings for training (off by default). — [gHacks](https://www.ghacks.net/2026/10/05/anthropic-asks-claude-users-to-share-voice-recordings-for-ai-training-with-a-new-opt-in-setting/), [BleepingComputer](https://www.bleepingcomputer.com/news/artificial-intelligence/anthropic-asks-claude-users-to-share-voice-data-for-ai-model-training/) [Snippet]
- [3P] FindSkill reports that Anthropic announced no voice product at Code with Claude San Francisco (May 2026), the same period in which OpenAI shipped GPT-Realtime-2. — [FindSkill](https://findskill.ai/blog/gpt-realtime-2-vs-claude-voice-routing/) [Snippet]
- [3P] MindStudio (2026-08-01) says Claude's new interactive voice chat "is currently confined to chat in the web app". Its statements about live camera input and screen screenshots during voice refer to ChatGPT, not Claude. A search-engine summary had misattributed the camera claim to Claude; I verified the article. — [MindStudio](https://www.mindstudio.ai/blog/claude-voice-mode-launch)
- [Doc] Computer use in the Claude Code desktop app:
  - "Computer use is a research preview on macOS and Windows that requires a Pro or Max plan. It is not available on Team or Enterprise plans." It needs macOS 14+, Accessibility and Screen Recording permissions, and is off by default.
  - Claude sees apps "in screenshots" under per-app tiers: view only, click only, or full control.
  - It "is the broadest and slowest" route. Claude prefers connectors, then Bash, then Claude in Chrome, then the iOS Simulator pane, and uses screen control last.
  - On macOS it can run in the background.
  - The page describes no continuous screen streaming. — [Claude Code desktop docs](https://code.claude.com/docs/en/desktop)
- [Doc] Claude in Chrome:
  - A browser extension that lets Claude "read, click, and navigate websites". It controls the browser through the debugger permission, "including taking screenshots".
  - It can read console output, network requests and DOM state.
  - A user can share "screenshots of specific screen regions". This is manual, not a live feed.
  - Available on paid plans. — [Get started with Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)
- [3P] Claude Duet (launched 2026-10-21) is a proactive agent built around Opus 5.5. It monitors connected apps (email, calendar), works in its own virtual-machine browser and asks before acting. Coverage describes no watching of the user's own screen. It is a waitlist research preview for US Pro and Max users. — [MacRumors](https://macrumors.com/2026/10/21/anthropic-claude-duet/) [Snippet]
- [3P] A vendor blog recommends building Claude voice agents as an STT → Claude → TTS pipeline, with a claimed 600–800 ms round trip in production (unverified). — [claudexia](https://claudexia.tech/blog/claude-voice-realtime-stack-2026) [Snippet]

### Inferences
- What does not exist, explicitly:
  - no Realtime/Live API and no WebSocket or bidirectional session on the Messages API;
  - no audio input or output, and no video input;
  - no incremental input streaming (each request carries its whole prompt);
  - no server-side screen capture or frame ingestion;
  - no API access to the apps' voice mode;
  - no server-side frame deduplication or delta encoding.

  All of these follow from the modality and transport documentation above, which lists none of them.
- A "share your screen" product on Claude is therefore a client loop: capture a frame (or a crop of what changed), send a Messages request with the image, and stream the text reply over SSE. Voice, if wanted, is your own STT/TTS around it.
- The apps' screen features (computer use, Claude in Chrome) are agentic, screenshot-per-action designs, the same pattern as this repository's server. None is a passive, continuous "watch my screen" assistant like Gemini Live screen sharing.

### Gaps
- I found no Anthropic statement about plans for a realtime or audio API. Only secondary speculation exists (TestingCatalog, plus the voice-data opt-in).
- The voice mode's architecture is not documented by Anthropic: the speech models, whether TTS goes through ElevenLabs, and end-to-end latency.
- I could not confirm whether the mobile app's voice mode accepts the camera. The official help page is silent, and the one claim found was about ChatGPT.
- The Claude Code desktop docs do not say how often screenshots are taken.

## 2. Current models and prices (checked against the live docs)

### Takeaway
The reported figures are mostly right. Claude Haiku 5.5 is $0.10 input / $0.50 output per MTok for prompts up to 100,000 tokens and $0.50 / $2.50 above that. Sonnet 5.5 is $2 / $10 and Opus 5.5 is $4 / $20. Fast mode is $8 / $40 on Opus 5.5, up to 2.5x output tokens per second. Two corrections:
- **Opus 5.5 fast mode is GA and not Claude-API-only.** It needs no beta header or access request, and it is also offered on Claude Models on Google Cloud (Anthropic managed) and on Microsoft Foundry deployments hosted on Azure. Opus 5 and Opus 4.8 fast mode stays a waitlisted research preview at $10 / $50.
- **Haiku 5.5's 100K threshold counts every input token in the request, including cache reads.** A growing screenshot history can cross it.

### Cited Findings
- [Doc] Model IDs, context and output limits, defaults and release dates:

  | Model | ID | Comparative latency | Context | Max output | Default effort | Released | Retirement not before |
  |---|---|---|---|---|---|---|---|
  | Haiku 5.5 | `claude-haiku-5-5` | Fastest | 1M | 128K | `medium` | 2026-10-07 | 2027-10-07 |
  | Sonnet 5.5 | `claude-sonnet-5-5` | Fast | 1M | 128K | `high` | — | 2027-09-28 |
  | Opus 5.5 | `claude-opus-5-5` | Moderate | 1M | 128K | `medium` | 2026-09-22 | 2027-09-22 |
  | Fable 5.1 | `claude-fable-5-1` | Slower | 1M | 128K | `high` | — | — |

  The knowledge cutoff is June 2026 for all four. Artificial Analysis gives Sonnet 5.5's release as 2026-09-28 ([AA Sonnet 5.5 low](https://artificialanalysis.ai/models/claude-sonnet-5-5-low)); the Anthropic pages I fetched don't state it. — [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview.md), [Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview.md), [Opus 5.5 announcement](https://www.anthropic.com/claude-opus-5-5)
- [Doc] Price table, per MTok:

  | Model | Base input | 5m cache write | 1h cache write | Cache hit/refresh | Output |
  |---|---|---|---|---|---|
  | Haiku 5.5 (prompt ≤100K) | $0.10 | $0.125 | $0.20 | $0.01 | $0.50 |
  | Haiku 5.5 (prompt >100K) | $0.50 | $0.625 | $1 | $0.05 | $2.50 |
  | Sonnet 5.5 | $2 | $2.50 | $4 | $0.10 (0.05x) | $10 |
  | Opus 5.5 | $4 | $5 | $8 | $0.20 (0.05x) | $20 |
  | Opus 5 / 4.8 | $5 | $6.25 | $10 | $0.50 | $25 |
  | Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |
  | Fable 5.1 | $10 | $12.50 | $20 | $0.25 (0.025x) | $50 |

  — [Pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)
- [Doc] Haiku 5.5 long-context rule: "a request whose prompt is over 100,000 tokens pays higher prices. A request's prompt length counts all of its input tokens, including cache reads and cache writes. Each request is priced on its own." Other Claude 4.6+ models charge the standard price across the full 1M window. — [Pricing, Long context pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)
- [Doc] Fast mode, pricing and availability:
  - Pricing: $8 / $40 on Opus 5.5 and $10 / $50 on Opus 5 and Opus 4.8. It applies "across the full context window", and prompt caching and data residency multipliers stack on top.
  - Not available with the Batch API or a Priority Tier commitment.
  - Opus 5.5 "doesn't need a beta header or an access request". Opus 5 and 4.8 need `fast-mode-2026-02-01` and access through the waitlist or an account manager.
  - Opus 5.5 fast mode is also on Foundry (Azure-hosted deployments) and on Claude Models on Google Cloud (Anthropic managed). — [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode.md), [Pricing, Fast mode pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)
- [Doc] Fast mode is not available on Claude Platform on AWS. — [Rate limits](https://platform.claude.com/docs/en/api/rate-limits.md)
- [Doc] The Opus 5.5 announcement says standard output "generates output more than 30% faster than Opus 5". Fast mode is "up to 2.5x speed" at $8 / $40, and Opus 5.5 will "cost 40% less than Opus 5 on typical workloads". — [Introducing Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5)
- [Doc] Claude 4.7 and later models (Haiku 5.5 included) use a newer tokenizer that "produces approximately 30% more tokens for the same text" than Sonnet 4.6 and earlier. — [Pricing](https://platform.claude.com/docs/en/about-claude/pricing.md), [Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview.md)
- [Doc] Data residency: `inference_geo: "us"` applies a 1.1x multiplier to all token categories on Claude 4.6+ models, including Haiku 5.5's >100K prices. — [Pricing, Data residency pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)
- [Doc] Tool-use system prompt overhead with `tool_choice` auto/none: 286 tokens on Opus 5.5, Sonnet 5.5 and Haiku 5.5. — [Pricing, Tool use pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)
- [Doc] Thinking tokens "are billed as output tokens, even when the thinking text isn't returned". — [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking.md)

### Inferences
- For screenshot-heavy input, the input price matters most. Per million input tokens, Haiku 5.5 (≤100K) is 20x cheaper than Sonnet 5.5 and 40x cheaper than Opus 5.5. Cache reads are 10x, 20x and 40x apart respectively ($0.01, $0.10, $0.20).
- Image tokens are patch-based (section 4), so the tokenizer's 30% text inflation does not apply to screenshots. It applies only to the text around them.

### Gaps
- The pricing page does not give per-model Priority Tier eligibility for Haiku 5.5. Anthropic's bundled SDK reference says Priority Tier is unsupported on Opus 5.5 and Sonnet 5.5, but I did not verify that on a live page.

## 3. Latency: time to first token and output tokens/second

### Takeaway
Anthropic publishes only relative latency labels (Haiku 5.5 "Fastest", Sonnet 5.5 "Fast", Opus 5.5 "Moderate"), plus three claims: Opus 5.5 output is 30% faster than Opus 5, fast mode gives up to 2.5x output tokens per second, and fast mode does not help time to first token. Artificial Analysis measures, on Anthropic's API:
- Haiku 5.5: about 176–184 tok/s, but 6.7–7.6 s TTFT at low/medium effort;
- Sonnet 5.5 low: 104 tok/s, 1.40 s TTFT;
- Opus 5.5 low: 82 tok/s, 4.90 s TTFT.

TTFT on these models is dominated by up-front thinking, so the main latency levers are effort and turning thinking off. Haiku 5.5 allows `thinking: {type: "disabled"}` at effort `high` or below. Sonnet 5.5 allows `between_tools`. Opus 5.5 cannot turn thinking off. No figures exist for image prompts or for thinking-off runs.

### Cited Findings
- [Doc] Relative labels ("Comparative latency: Relative to the current lineup. Actual latency depends on prompt length, output length, and thinking effort."): Fable 5.1 Slower, Opus 5.5 Moderate, Sonnet 5.5 Fast, Haiku 5.5 Fastest. — [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview.md)
- [Doc] Fast mode gives "up to 2.5x higher output tokens per second", and "Speed benefits are focused on output tokens per second (OTPS), not time to first token (TTFT)". The same model runs "with a faster inference configuration", with no change in intelligence. — [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode.md)
- [Doc] Opus 5.5 "generates output more than 30% faster than Opus 5". — [Introducing Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5)
- [Doc] Latency guidance: for speed-critical applications Haiku 5.5 "offers the fastest response times". "Effort is its main control for speed and cost". The doc's example runs it at `low`, "the cheapest and fastest level". Other levers are fewer input and output tokens and streaming. — [Reducing latency](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency.md)
- [Doc] Turning thinking off:
  - Haiku 5.5 "accepts `thinking: {type: "disabled"}` at effort `high` or below". At `xhigh` or `max` that combination returns a 400. With thinking off, "the model can skip a tool call it needs when you also request JSON output."
  - Sonnet 5.5 rejects `disabled`. Its lowest setting is `thinking: {type: "between_tools"}` (turns off up-front thinking), accepted at effort `high` or below.
  - Opus 5.5 (and Fable 5.1) reject `disabled`: "Thinking can't be turned off on these models."
  - `display: "omitted"` (the default on these models) "reduces latency, not cost". — [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking.md)
- [Doc] Changing thinking configuration or the top-level effort "start[s] a new cache prefix" (it invalidates cache breakpoints). — [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking.md)
- [Doc] Caching and latency: "You generally see improved time-to-first-token for long documents". The 5-minute and 1-hour caches "behave the same with respect to latency". No percentage is given. — [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md)
- [Doc] Images and latency: compressing images "can reduce latency by reducing the size of requests". "To minimize latency ... prefer resizing images before uploading them." Base64 images resent on every turn "can significantly increase request size and latency as the conversation grows", so use the Files API `file_id`. — [Vision](https://platform.claude.com/docs/en/build-with-claude/vision.md)
- [3P] Artificial Analysis measurements on Anthropic's first-party API, snapshot fetched 2026-10-25. AA's own benchmark prompts, not image prompts. The pages do not state the prompt length.

  | Model and effort | Output speed (tok/s) | Median of peers | TTFT (s) | Median of peers |
  |---|---|---|---|---|
  | Haiku 5.5 low | 176.3 | 111.3 | 6.68 | 1.72 |
  | Haiku 5.5 medium | 184.3 | 114.9 | 7.62 | 1.70 |
  | Sonnet 5.5 low | 104.0 | 82.3 | 1.40 | 3.68 |
  | Opus 5.5 low | 82.1 | 83.5 | 4.90 | 3.68 |
  | Opus 5.5 max | 96.3 | — | 562.48 | 3.68 |

  — [AA Haiku 5.5 low](https://artificialanalysis.ai/models/claude-haiku-5-5-low), [AA Haiku 5.5 medium](https://artificialanalysis.ai/models/claude-haiku-5-5-medium), [AA Sonnet 5.5 low](https://artificialanalysis.ai/models/claude-sonnet-5-5-low), [AA Opus 5.5 low](https://artificialanalysis.ai/models/claude-opus-5-5-low), [AA Opus 5.5 max](https://artificialanalysis.ai/models/claude-opus-5-5)
- [3P] Sonnet 5.5 (xhigh): 111.8 tok/s on Anthropic's API. — [AA Sonnet 5.5 xhigh (Korean page)](https://artificialanalysis.ai/ko/models/claude-sonnet-5-5-xhigh) [Snippet]
- [3P] Conflicting older snapshots: a review cites Haiku 5.5 medium TTFT 14.2 s and high 26.2 s. Kingy.ai reports medium at 137.1 tok/s and 13.40 s from an earlier snapshot. — [eesel review](https://www.eesel.ai/blog/claude-haiku-5-5-review), [Kingy.ai](https://kingy.ai/blog/claude-haiku-5-5-benchmarks-specs-sol-luna/) [Snippet]
- [3P] OrcaRouter lists Opus 5.5 at 96 tok/s with 4,465 ms median latency, and Sonnet 5.5 at 140 tok/s with 3,000 ms. Its September page gives different numbers, so treat these as unreliable. — [OrcaRouter](https://www.orcarouter.ai/compare/claude-opus-5.5-vs-claude-sonnet-5.5) [Snippet]

### Inferences
- Haiku 5.5's high AA TTFT (6.7–7.6 s, against 1.40 s for Sonnet 5.5 low) most likely reflects up-front adaptive thinking that AA's measurement includes, not slow prefill. Haiku's output speed is the highest in the lineup.
  - For a live loop, the lowest-latency configurations that are actually documented are Haiku 5.5 with `thinking: {type: "disabled"}` (at effort ≤ high), or Sonnet 5.5 with `between_tools` at `low` effort.
  - Opus 5.5 always thinks.
  - No measurement of the thinking-off configurations was found.
- Fast mode helps long outputs, not a short caption per frame. At AA's measured 82–96 tok/s for Opus 5.5, "up to 2.5x" implies at most roughly 205–240 tok/s (inferred upper bound, not measured), and TTFT is unchanged.
- Keep the system prompt and tools as a cached prefix and the frame small. That trims prefill and request size: a 1280×800 frame is about 1.3K tokens (section 4), so a request is dominated by the cached prefix plus one image.

### Gaps
- No published or credible measured TTFT for requests that contain images, and no per-image prefill cost in milliseconds.
- No measured TTFT or tok/s for Haiku 5.5 with thinking disabled, Sonnet 5.5 with `between_tools`, or Opus 5.5 fast mode.
- AA's TTFT definition for reasoning models (first token vs first answer token) and its prompt lengths were not stated on the fetched pages.

## 4. Vision: token formula, limits, recommended size, screenshot costs

### Takeaway
The old `w × h / 750` estimate is replaced by an exact rule: an image costs `⌈width/28⌉ × ⌈height/28⌉` visual tokens, one per 28×28 patch.
- Claude 4.7 and later models (Haiku 5.5, Sonnet 5.5, Opus 5.5) are on a high-resolution tier: 2,576 px long edge and 4,784 visual tokens. Older models are on the standard tier: 1,568 px and 1,568 tokens.
- A 1024×640 screenshot costs 851 tokens and a 1280×800 screenshot costs 1,334, unresized on every tier.
- Per frame, a 1280×800 image costs about $0.000133 on Haiku 5.5, $0.0027 on Sonnet 5.5 and $0.0053 on Opus 5.5 at base input price.
- Up to 600 images per API request (1M-context models). The hard maximum is 8000×8000 px. A stricter 2000 px per side limit applies once a request holds more than 20 images.
- Screenshots returned to the computer-use toolset are rejected if oversized, not downscaled.

### Cited Findings
- [Doc] "Each patch is a 28×28-pixel block of the image, referred to as a visual token. An image, therefore, costs `⌈width / 28⌉ × ⌈height / 28⌉` visual tokens." — [Vision](https://platform.claude.com/docs/en/build-with-claude/vision.md)
- [Doc] Resolution tiers: "High-resolution | Claude 4.7 and later models | 2,576 px | 4,784" and "Standard | All other models | 1,568 px | 1,568". High resolution "is automatic … and requires no beta header". High-resolution images "can use up to roughly three times more visual tokens". "If you don't need the additional fidelity … downsample images before sending to control token costs." — [Vision](https://platform.claude.com/docs/en/build-with-claude/vision.md)
- [Doc] Example costs:

  | Image | Standard tier | High-resolution tier |
  |---|---|---|
  | 1000×1000 | 1,296 tokens | 1,296 tokens |
  | 1920×1080 | downsized to 1456×819, 1,560 tokens | not resized, 2,691 tokens |
  | 3840×2160 | — | downsized to 2576×1449, 4,784 tokens |

  "At Claude Opus 5.5's $4 USD per million (high-resolution tier), the same [1000×1000] image costs about $5.18 USD per thousand." — [Vision](https://platform.claude.com/docs/en/build-with-claude/vision.md)
- [Doc] Resizing rule: the model finds the largest aspect-preserving size within both the edge limit and the token limit. "For nearly all photos and screenshots, the visual token limit is what determines the final size." Every image is then padded on the bottom and right edges to the next multiple of 28 px. "Always normalize or rescale by the resized dimensions, not the padded dimensions." The `transformations: {oversized_image: "error"}` field turns silent resizing into a 400. — [Coordinates and bounding boxes](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates.md)
- [Doc] Limits:
  - Images per request: 20 per message on claude.ai; 100 per API request for 200K-context models; 600 for all other models.
  - Maximum dimensions are 8000×8000 px.
  - Above 20 images in one request (counting resent earlier images and images nested in `tool_result`, "for example, screenshots returned to the computer use tool"), a stricter per-image limit applies. To stay safe, "resize each image so that neither dimension exceeds 2000 px".
  - Per-image size: 10 MB base64 on the Claude API, 5 MB on Bedrock.
  - Request size limit: 32 MB on standard endpoints.
  - Formats: JPEG, PNG, GIF, WebP; animation is not supported and only the first frame is used. — [Vision](https://platform.claude.com/docs/en/build-with-claude/vision.md)
- [Doc] Screenshots and zoom images returned to the computer use and browser use toolsets are an exception to automatic resizing: "the API rejects a `tool_result` image that exceeds the model's limits with a validation error instead of downscaling it". — [Vision](https://platform.claude.com/docs/en/build-with-claude/vision.md), [Coordinates](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates.md)
- [Doc] Computer-use resolution guidance:
  - "For general desktop tasks, use 1024x768 or 1280x720; for web applications, use 1280x800 or 1366x768." "Avoid resolutions above 1920x1080."
  - Screenshots cost "roughly 1,000–1,800 input tokens each".
  - macOS Retina (2x) screenshots must be downscaled by 2x, or the coordinates halved. — [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool.md)
- [Doc] Heavy JPEG compression "can make text difficult to read". Claude "does not parse or receive any metadata from images". — [Vision](https://platform.claude.com/docs/en/build-with-claude/vision.md)

### Inferences
- Computed with the documented formula and Anthropic's reference resize implementation (high-resolution tier, which applies to Haiku 5.5, Sonnet 5.5 and Opus 5.5):

  | Frame | Visual tokens (high-res tier) | Standard tier (Haiku 4.5) |
  |---|---|---|
  | 280×280 crop | 100 | 100 |
  | 512×320 | 228 | 228 |
  | 1024×640 | 851 | 851 |
  | 1024×768 | 1,036 | 1,036 |
  | 1280×720 | 1,196 | 1,196 |
  | 1280×800 | 1,334 | 1,334 |
  | 1366×768 | 1,372 | 1,372 |
  | 1440×900 | 1,716 | 1,550 (resized to 1389×868) |
  | 1512×982 (14" MacBook, logical) | 1,944 | 1,568 |
  | 1920×1080 | 2,691 | 1,560 |
  | 2560×1600 | 4,698 (resized to 2420×1512; would be rejected as a computer-use `tool_result`) | 1,550 |

- Base-input cost per frame, not counting the prompt, output or thinking:

  | Model | 1024×640 (851 tokens) | 1280×800 (1,334 tokens) | 1280×800, per 1,000 frames |
  |---|---|---|---|
  | Haiku 5.5 (≤100K) | $0.000085 | $0.000133 | $0.133 |
  | Sonnet 5.5 | $0.0017 | $0.0027 | $2.67 |
  | Opus 5.5 | $0.0034 | $0.0053 | $5.34 |
  | Opus 5.5 fast | $0.0068 | $0.0107 | $10.67 |

- Deltas: there is no API-side delta encoding. Cost is linear in patches sent, so sending only a changed region (a crop) costs proportionally less. A 280×280 crop is 100 tokens against 1,334 for a full 1280×800 frame. Crops lose surrounding context, and coordinates must be offset by the crop origin, which the coordinates doc describes.
- A live loop that keeps more than 20 frames in one request must keep each frame at or under 2000 px per side. 1280×800 frames satisfy that.
- There is no "low detail" switch (unlike OpenAI's `detail: low`). The only cost control is the pixel size you send. The vision page documents no other control.

### Gaps
- No documentation on whether the high-resolution tier improves screenshot understanding enough to justify sending more than about 1,400 tokens per frame. This would need measurement.
- No guidance on image encoding latency (JPEG vs PNG) beyond the general advice to compress.

## 5. Prompt caching with images, growing screenshot conversations, context editing and compaction

### Takeaway
Images and tool results are cacheable, but caching is an exact prefix match, not content deduplication.
- An identical screenshot is served from cache only when it sits in an identical prefix (for example, the next turn of the same conversation). A new frame appended at the end is always new input.
- The minimum cacheable prefix is 512 tokens on Haiku 5.5, Sonnet 5.5 and Opus 5.5.
- Writes cost 1.25x base (5-minute TTL) or 2x (1-hour TTL).
- Reads cost 0.1x on Haiku 5.5 ($0.01/MTok) and 0.05x on Sonnet 5.5 and Opus 5.5 ($0.10 and $0.20).
- The TTL is refreshed free on every hit, and cached reads do not count toward input-tokens-per-minute (ITPM) limits.
- Adding or removing images anywhere invalidates the messages cache from that point.
- Context editing (tool-result clearing) and compaction keep long screenshot histories bounded, but each clear or compaction costs a new cache write.
- On Haiku 5.5, Sonnet 5.5 and Opus 5.5, client-side pruning of old screenshots also invalidates later thinking blocks. Anthropic recommends server-side clearing instead.

### Cited Findings
- [Doc] Minimum cacheable length is 512 tokens for Opus 5.5, Sonnet 5.5, Haiku 5.5 (and Fable 5.1, Opus 5, Sonnet 5). A shorter prompt is processed without caching and returns no error. — [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md), [Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview.md)
- [Doc] Write multipliers: 5-minute TTL is "1.25 times the base input tokens price", 1-hour is "2 times". Reads are "0.1 times", except 0.05x on Opus 5.5 and Sonnet 5.5 and 0.025x on Fable 5.1 and Mythos 5.1. Haiku 5.5 rates per MTok:

  | Haiku 5.5 rate | Prompt ≤100K | Prompt >100K |
  |---|---|---|
  | 5m write | $0.125 | $0.625 |
  | 1h write | $0.20 | $1 |
  | Cache read | $0.01 | $0.05 |

  — [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)
- [Doc] Cacheable content includes "Images and documents" ("Content blocks in the messages.content array, in user turns") and tool use and tool results (both turns). Thinking blocks cannot be cached directly, but can be cached alongside other content in previous assistant turns. — [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md)
- [Doc] Invalidation: for "Images", the tools cache and system cache survive but the messages cache does not; "Adding/removing images anywhere in the prompt affects message blocks". The FAQ adds: "changing whether there are images in a prompt or modifying tool use settings breaks the cache". "Cache hits require 100 percent identical prompt segments." — [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md)
- [Doc] Mechanics:
  - Up to 4 breakpoints. The lookback window is 20 blocks per breakpoint; consecutive `tool_result` blocks count as one position.
  - Automatic caching is a top-level `cache_control` that moves the breakpoint forward as the conversation grows.
  - Default lifetime is 5 minutes. "The cache is refreshed for no additional cost each time the cached content is used." Lifetime is "measured from the start of the request".
  - Pre-warming with `max_tokens: 0` bills only the cache write and zero output tokens. It is rejected with `stream: true`, with extended thinking enabled, with structured outputs, with forced `tool_choice`, and in Batches. — [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md)
- [Doc] Growing conversation billing: each request reads the earlier prefix and writes only the new segment, so `total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens`. — [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md)
- [Doc] Rate limits: `cache_read_input_tokens` do not count toward ITPM on current models. Uncached input and cache writes do. — [Rate limits](https://platform.claude.com/docs/en/api/rate-limits.md)
- [Doc] Switching between fast and standard speed is a cache miss: "Requests at different speeds do not share cached prefixes." — [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode.md)
- [Doc] Context editing (beta `context-management-2025-06-27`):
  - `clear_tool_uses_20250919` replaces the oldest tool results with a placeholder. Defaults: trigger at 100,000 input tokens, keep 3 tool uses. Options are `clear_at_least`, `exclude_tools` and `clear_tool_inputs`.
  - It "Invalidates cached prompt prefixes when content is cleared", so use `clear_at_least` to make each clear worth the write.
  - Available "on all supported Claude models". The page does not mention images specifically. — [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing.md)
- [Doc] Computer-use caching advice:
  - Put one `cache_control` breakpoint after the system prompt and tools. Prune old screenshots in batches ("keep the last three and prune every 25 turns") so the cached prefix stays stable.
  - But on Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5, "avoid client-side pruning because it invalidates later thinking blocks". Resize to 2000 px or less per side and use server-side tool result clearing (context editing) instead. — [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool.md)
- [Doc] Compaction:
  - Threshold compaction (beta `compact-2026-01-12`, edit `compact_20260112`): default trigger 150,000 input tokens, minimum 50,000. Supported models include Haiku 5.5, Sonnet 5.5 and Opus 5.5.
  - It "requires an additional sampling step, which contributes to rate limits and billing". That usage is reported in `usage.iterations`, not in top-level `input_tokens` / `output_tokens`. It runs inside the request that crosses the threshold. — [Compaction at a token threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold.md)
  - On-demand compaction (beta `compact-2026-09-04`) can run in the background and keep recent turns word for word. — [Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction.md)
- [Doc] Files API: upload once and reference by `file_id`, which "keeps request payloads small regardless of how many images accumulate". — [Vision](https://platform.claude.com/docs/en/build-with-claude/vision.md)

### Inferences
- Two loop shapes, costed from documented prices. Assumptions:
  - a 5,000-token cached prefix (system plus tools; the computer-use toolset alone is about 4,520 tokens);
  - one 1280×800 frame (1,334 tokens) and about 50 text tokens per turn;
  - 150 output tokens per turn;
  - thinking tokens excluded, so add them if thinking is on.

  **Stateless per frame** (cached prefix plus the current frame only):

  | Model | $ per frame | 1 frame/s for 1 h | 1 frame per 5 s for 1 h |
  |---|---|---|---|
  | Haiku 5.5 | $0.00026 | $0.93 | $0.19 |
  | Sonnet 5.5 | $0.0047 | $16.80 | $3.36 |
  | Opus 5.5 | $0.0093 | $33.61 | $6.72 |
  | Opus 5.5 fast | $0.0187 | $67.22 | $13.44 |

  **Growing conversation with automatic caching** (all frames kept):

  | Turns | Haiku 5.5 cached (uncached) | Sonnet 5.5 cached (uncached) | Opus 5.5 cached (uncached) | Final prompt |
  |---|---|---|---|---|
  | 10 | $0.004 ($0.014) | $0.07 ($0.28) | $0.15 ($0.56) | about 20K tokens |
  | 60 | $0.046 ($0.31) | $0.61 ($6.29) | $1.22 ($12.57) | about 97K tokens |

  Caching cuts the growing-history cost by roughly 7–10x. The history still grows quadratically, and on Haiku 5.5 the next frame after about 60 turns pushes the prompt over 100K tokens, where every token (cache reads included) costs 5x.
- Repeated identical screenshots save nothing unless the client detects them. This repository already does that: an unchanged capture returns a short text instead of the image.
- Deduplicate or skip frames on the client, crop to changed regions, and bound history with a sliding window. On 5.5 models, use server-side clearing rather than editing history, accepting a cache write at each clear.
- Changing effort or thinking settings between frames invalidates the cache. Pick one configuration per session.

### Gaps
- The context-editing page does not say whether `clear_tool_uses` drops image blocks nested in tool results the same way it drops text. The computer-use page implies it does: it recommends that feature for screenshots.
- The threshold-compaction page I fetched does not say how images in the compacted history are treated.
- No published cache-hit TTFT reduction percentage.
- Mid-conversation system messages and per-message effort (which avoid cache resets) appear in Anthropic's bundled SDK reference for Haiku 5.5 and the 5.5 models. I did not verify them on a live docs page.

## 6. Streaming responses, fine-grained tool streaming, and streaming input

### Takeaway
Output streams over SSE. Tool-call arguments can stream unbuffered from the model to the client with the per-tool `eager_input_streaming: true` flag, on all models with no beta header. Input cannot be streamed incrementally. Every request is a complete prompt, so a new frame means a new request. User input typed while the model works is delivered in the next request.

### Cited Findings
- [Doc] `"stream": true` streams the response over SSE. Event types include message_start, content_block_start/delta/stop, message_delta and message_stop, and streams "might also include any number of `ping` events". Clients should tolerate new event types. Tool inputs stream as `input_json_delta` partial JSON. — [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming.md)
- [Doc] Fine-grained tool streaming:
  - It "delivers a tool's input to your client as Claude generates it, without server-side buffering or JSON validation", reducing "the time to the first fragment of a large parameter".
  - It works on all models on the Claude API, Bedrock, Claude Platform on AWS, Google Cloud and Foundry. Set `eager_input_streaming: true` per tool; no beta header.
  - Partial or invalid JSON is possible, so guard the parse and return `{"INVALID_JSON": …}` with `is_error`.
  - The legacy `fine-grained-tool-streaming-2025-05-14` header "cannot be combined with a computer use or browser use toolset entry". — [Fine-grained tool streaming](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming.md)
- [Doc] Fast mode is "Compatible with streaming, where the OTPS gain is most visible". — [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode.md)
- [Doc] Streaming recovery: for Claude 4.5 models and earlier, an interrupted stream can be resumed from where it stopped. The statement is scoped to 4.5 and earlier. — [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming.md)

### Inferences
- Confirmed by absence: the streaming docs describe only response streaming. No input-streaming, append-to-running-request or WebSocket mechanism is documented, so frames cannot be pushed into an in-flight generation.
- To interrupt a reply when the screen changes, the client cancels the HTTP stream and sends a new request. Output generated before the cancel is presumably still billed, but I did not verify this.

### Gaps
- No documentation found on billing for client-cancelled streams.
- Managed Agents sessions (a separate SSE event stream accepting user events while running) might offer steering mid-session. I did not fetch those docs. They are listed in the [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview.md). Note that the computer-use toolset is not available in Managed Agents (section 7).

## 7. The computer use tool on current models

### Takeaway
Current models use `computer_toolset_20260801`, which is GA on the Claude API with no beta header, for Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1, Opus 5, Sonnet 5 and Opus 4.8.
- On the Claude API and Google Cloud, the 5.5 models reject the older `computer_20251124` and `computer_20250124`. On Amazon Bedrock, Haiku 5.5, Sonnet 5.5 and Opus 5.5 still accept `computer_20251124`.
- The toolset is a client toolset of 17 member tools. Only `screenshot` and `zoom` return images; other actions return "OK", and no screenshot is taken automatically after each action.
- Batches of actions per turn are supported. Declaring the toolset costs about 4,520 input tokens.
- It is not available in Managed Agents.

### Cited Findings
- [Doc] Compatibility:
  - `computer_toolset_20260801` supports Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5.5, Opus 5, Sonnet 5.5, Sonnet 5, Opus 4.8 and Haiku 5.5. It is GA on the Claude API and Google Cloud (Google managed), and beta on Claude Platform on AWS, Bedrock and Foundry. "The toolset needs no beta header."
  - On the Claude API and Google Cloud, Claude 5.5+ models return an error for `computer_20251124` and `computer_20250124`.
  - "On Amazon Bedrock, Claude Opus 5.5, Claude Sonnet 5.5, and Claude Haiku 5.5 accept the earlier `computer_20251124` tool version as Claude Opus 5 and Claude Sonnet 5 do."
  - Older models (Opus 4.7, 4.6, Sonnet 4.6, Opus 4.5) use `computer_20251124` with a beta header. — [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool.md)
- [Doc] Member tools: `screenshot`, `zoom` (region; returns a full-resolution crop), `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `left_click_drag`, `mouse_move`, `left_mouse_down`, `left_mouse_up`, `cursor_position`, `scroll`, `type`, `key` (repeat 1–100), `hold_key` (up to 300 s) and `wait` (up to 300 s).
  - Only `screenshot` and `zoom` return images. Others return a short "OK"-style text.
  - The client does not auto-screenshot after each action. When a batch doesn't end with a screenshot, "your application can attach a screenshot as an extra `image` block on the last result in the batch".
  - Batches are multiple `tool_use` blocks in one turn, run in order, stopping at the first failure. Unexecuted actions get `is_error` "Not executed…" results tagged with `"toolset_name": "computer"`.
  - `configs` can disable members (for example `zoom`). `disable_parallel_tool_use` forces one action per round trip.
  - It "isn't available in Claude Managed Agents". It is a client toolset whose reference implementation is a Docker container with Xvfb. — [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool.md)
- [Doc] Overhead: declaring `computer_toolset_20260801` with default members "adds about 4,500 input tokens" (about 4,520 on most supported models, about 4,590 on Sonnet 5). Disabling `zoom` removes about 410. Older versions cost 466–499 system-prompt tokens plus about 735 tokens per tool definition. Screenshots and zoom images are billed as image input. — [Pricing, Computer use tool](https://platform.claude.com/docs/en/about-claude/pricing.md)
- [Doc] Image limits for toolset models: 2,576 px long edge and 4,784 visual tokens. Oversized `tool_result` images are rejected rather than downscaled.
  - Recommended sizes: 1024×768 or 1280×720 for desktop work, 1280×800 or 1366×768 for web; avoid more than 1920×1080.
  - Screenshots cost about 1,000–1,800 tokens each.
  - The page's sample scaling helper still uses the standard-tier constants (1,568 px, 1.15 MP). — [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool.md)
- [Doc] OSWorld 2.1 (computer use): Opus 5.5 81.8%, Fable 5.1 80.7%, Opus 5 74.0%. — [Introducing Claude Opus 5.5](https://www.anthropic.com/claude-opus-5-5)
- [Doc] A browser-use toolset (`browser_toolset_20260801`) also exists, at about 6,600 input tokens with default members. — [Pricing](https://platform.claude.com/docs/en/about-claude/pricing.md)

### Inferences
- The toolset is agentic: the model asks for a screenshot when it wants one. It is not a passive "watch" channel. A live-observation product can skip the toolset (saving about 4.5K prefix tokens) and send frames as ordinary user-turn images, which the API auto-resizes. It needs the toolset only when Claude must act.
- If you do use it, the 2,576 px / 4,784-token cap and the rejection of oversized images mean the client must resize. A raw 2880×1800 Retina capture would be rejected.

### Gaps
- No documented latency figures for computer-use turns.
- The truncated part of the computer-use page (beyond 100K characters) was not read. It may contain more on Haiku 4.5 and the beta header values for older versions.

## 8. Batch, priority and rate limits (relevant to many small requests)

### Takeaway
The Batch API (50% off) and fast-mode exclusions don't matter for a realtime loop. Rate limits are generous for a frame loop:
- Haiku 5.5, Sonnet 5.5 and Opus 5.5 each get 1,000 RPM, 2M ITPM and 400K OTPM on the Start tier, up to 10,000 RPM and 10M ITPM on the Scale tier.
- Cached reads don't count toward ITPM, and limits replenish continuously as a token bucket.
- Short bursts can still trip per-second enforcement or "acceleration limits".
- The Start tier has a $500 monthly spend cap.

### Cited Findings
- [Doc] Messages API limits per model row (Haiku 5.5, Sonnet 5.5 and Opus 5.5 each have their own row):

  | Tier | RPM | ITPM | OTPM | Monthly spend cap |
  |---|---|---|---|---|
  | Start | 1,000 | 2,000,000 | 400,000 | $500 |
  | Build | 5,000 | 5,000,000 | 1,000,000 | $1,000 |
  | Scale | 10,000 | 10,000,000 | 2,000,000 | $200,000 |

  New organizations may start in a lower Evaluation tier. — [Rate limits](https://platform.claude.com/docs/en/api/rate-limits.md)
- [Doc] "The API uses the token bucket algorithm … capacity is continuously replenished". "A rate of 60 requests per minute (RPM) might be enforced as 1 request per second. Short bursts of requests can exceed the limit." 429s can also come from "acceleration limits" on sharp usage increases. OTPM counts actual tokens generated; `max_tokens` does not factor in. — [Rate limits](https://platform.claude.com/docs/en/api/rate-limits.md)
- [Doc] Fast mode has its own rate limit with `anthropic-fast-*` headers. Opus 5.5 has a default fast limit on Start, Build and Scale tiers. — [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode.md)
- [Doc] Batch API is 50% off input and output (Haiku 5.5 batch: $0.05 / $0.25 at ≤100K). Fast mode is unavailable in Batch and with Priority Tier. — [Pricing](https://platform.claude.com/docs/en/about-claude/pricing.md), [Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode.md)
- [Doc] Files API requests have a separate per-organization limit. — [Rate limits](https://platform.claude.com/docs/en/api/rate-limits.md)

### Inferences
- At one 1280×800 frame per second with a cached prefix, a loop uses about 60 RPM and about 80K uncached ITPM (frames only). That is 6% of Start-tier RPM and 4% of ITPM, so one Start-tier organization could carry roughly a dozen concurrent 1 frame/s streams before the RPM limit, subject to per-second smoothing.
- On Haiku 5.5 the spend cap is not a concern, at about $0.93 per stream-hour. On Opus 5.5, at about $34 per stream-hour, a Start-tier organization would hit the $500 cap after about 15 stream-hours.

### Gaps
- Per-model Priority Tier eligibility for Haiku 5.5 is not confirmed on a live page.
- No documented per-second burst allowance beyond the 60 RPM ≈ 1 request/s example.
