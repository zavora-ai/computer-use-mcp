# MCP streaming primitives between a local server and its host, and which hosts support them (as of 2026-10-25)

Scope: how a local MCP server (stdio, or loopback Streamable HTTP) can push live screen state and events to the host and the model, and receive input back from the model and the person. Revisions are marked: **[2025-11-25]** is the previous protocol revision, **[2026-07-28]** is the current one (stateless). Hosts are checked against their own docs and changelogs. "Undocumented" means I found no primary statement either way.

---

## 1. Server-to-client notifications: progress, logging, resource subscriptions, list-changed, `subscriptions/listen`. Can they carry images? Do hosts put them in the model's context?

### Takeaway
In 2026-07-28, server-to-client pushes come in two kinds. Request-scoped `notifications/progress` and `notifications/message` ride the response stream of an in-flight request. Change notifications (list-changed, `notifications/resources/updated`, and task status in the tasks extension) ride a long-lived `subscriptions/listen` stream. No core notification carries image content: progress carries a text `message`, a resource update carries only a URI, and logging carries arbitrary JSON. Images reach the model only through tool results, resource reads and sampling messages, or through an MCP App. Almost every host shows notifications in the UI only. Two exceptions put server pushes into the model's context: Claude Code "channels" (research preview, legacy protocol only) and the MCP Apps `ui/update-model-context` / `ui/message` requests.

### Cited Findings
**What 2026-07-28 changed**
- 2026-07-28 removes protocol-level sessions and the `Mcp-Session-Id` header (SEP-2567). It also removes the `initialize`/`notifications/initialized` handshake: every request carries its protocol version and client capabilities in `_meta`, and servers MUST implement `server/discover` (SEP-2575). — [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- 2026-07-28 replaces the HTTP GET endpoint and `resources/subscribe`/`resources/unsubscribe` with `subscriptions/listen`, "a single long-lived POST-response stream for opted-in server-to-client change notifications". Clients opt in per type (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`). The server tags each notification with `io.modelcontextprotocol/subscriptionId`. Request-scoped notifications (`notifications/progress`, `notifications/message`) stay on the response stream of their request (SEP-2575). — [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- It also removes `ping`, `logging/setLevel` and `notifications/roots/list_changed`. The log level is now set per request via `_meta` `io.modelcontextprotocol/logLevel`, and servers MUST NOT emit `notifications/message` for a request that lacks it. — [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

**How `subscriptions/listen` works**
- The server MUST first send `notifications/subscriptions/acknowledged`, carrying the subset of types it agreed to honor, and MUST NOT send types the client did not request.
- Each notification carries the subscription ID, which is the JSON-RPC id of the listen request. A client may hold several concurrent subscriptions.
- On stdio, messages share one channel, so clients MUST demultiplex by `subscriptionId`. After a stdio reconnect the client MUST re-send `subscriptions/listen`; the server holds no subscription state.
- The client cancels by closing the SSE stream (HTTP) or sending `notifications/cancelled` (stdio). A server that ends a subscription on its own SHOULD answer the listen request with a `resultType: "complete"` result. — [Subscriptions, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)
- Resource updates: a server declaring `subscribe` sends `notifications/resources/updated {uri}` for the URIs listed in `notifications.resourceSubscriptions`. The client then calls `resources/read`, which can return `blob` (base64) contents such as `image/png`. — [Resources, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
- The Python SDK says a dropped listen stream raises `SubscriptionLost`, with "no replay and no automatic re-listen". — [Python SDK subscriptions](https://py.sdk.modelcontextprotocol.io/api/mcp/client/subscriptions/)

**Progress and logging**
- Progress needs a client-chosen `progressToken` in the request `_meta`. The notification carries `progress` (must increase), optional `total` and optional `message` ("human readable progress information"). Both sides SHOULD rate-limit, and notifications MUST stop after completion. — [Progress, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress)
- Logging is **Deprecated** in 2026-07-28 (SEP-2577; earliest removal is the first revision on or after 2027-07-28). Its `notifications/message` carries `level`, `logger` and arbitrary JSON `data`. It is request-scoped, and the server MUST NOT deliver it on a `subscriptions/listen` stream. The suggested migration is stderr (stdio) or OpenTelemetry. — [Logging, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/logging); [Deprecated features registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)

**[2025-11-25] behaviour**
- A client could open an HTTP GET SSE stream for server-initiated messages, and could resume broken streams with `Last-Event-ID` (redelivery). 2026-07-28 removes both. — [Transports, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports); [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (item 9)

**What hosts do with these notifications**
- *Claude Code, progress:* progress is UI-only. A long call moves to a background task after two minutes, and "the task's entry shows the latest progress the server has reported". Progress does not extend the wall-clock `timeout`, but it does reset the idle timeout (5 min HTTP, 30 min stdio). — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- *Claude Code, progress fixes:* 2.1.283 stopped discarding MCP progress notifications after a tool call moves to the background. — [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- *Claude Code, list-changed:* on its v2 runtime (MCP TypeScript SDK 2.0), Claude Code receives `list_changed` from 2026-07-28 servers "over a stream it holds open". Reopen limits apply: three reopens if the stream closes within 10 s, and five per hour before a roughly 6 h back-off. Resource-update subscriptions are not mentioned (undocumented). — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- *Claude Code, channels (research preview):* a channel is a local stdio MCP server that declares `capabilities.experimental['claude/channel']` and emits `notifications/claude/channel {content: string, meta: Record<string,string>}`. Claude Code injects each event into the model's context as a `<channel source=...>` tag. Events that arrive while Claude is busy are "delivered together on the next turn". A two-way channel adds a reply tool, and `claude/channel/permission` relays approval prompts. — [Channels reference](https://code.claude.com/docs/en/channels-reference)
- *Claude Code, channel limits:* channels need claude.ai or Console auth, an allowlist, or `--dangerously-load-development-channels`. Team and Enterprise organisations must enable `channelsEnabled`. — [Channels](https://code.claude.com/docs/en/channels)
- *Claude Code, channels on 2026-07-28:* "a channel server that negotiates MCP protocol revision 2026-07-28 can't deliver channel messages, so Claude Code doesn't register it as a channel." Stdio servers are asked for 2026-07-28 by default, and `MCP_PROTOCOL_NEGOTIATION=legacy` keeps every server on the old handshake. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- *Claude Code, WebSocket:* Claude Code accepts a WebSocket transport, described as suiting "remote MCP servers that push events to Claude unprompted". It has no OAuth, and a single message over 16 MiB closes the connection. This transport is not in the MCP spec. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- *VS Code:* "supports resource updates, enabling users to see changes to the contents of a resource in real-time in the editor". This is a UI surface; the docs do not say whether updates reach the model. — [VS Code MCP developer guide](https://code.visualstudio.com/docs/copilot/guides/mcp-developer-guide)
- *claude.ai and Claude Desktop:* "Claude doesn't yet support these MCP features ... Resource subscriptions; Sampling; Advanced or draft capabilities". — [Build an MCP server for Claude](https://claude.com/docs/connectors/building/index.md)
- *Images in tool results:* Claude Code shows PNG/JPEG/GIF/WebP tool-result images to the model inline (possibly scaled) and, since 2.1.283, saves the original to a file. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- *Images in tool results:* Cursor "attaches returned images to the chat. If the model supports images, it analyzes them." — [Cursor MCP docs](https://cursor.com/docs/context/mcp)

### Inferences
- No core MCP notification can carry a frame to the model. On 2026-07-28 a "live screen" for the model must be pulled: a tool call returns an image, or a resource is marked updated and the client re-reads it. No host documents re-reading a subscribed resource into the model's context automatically.
- For a 2026-07-28 stdio server such as this project's, Claude Code (2.1.292 or later negotiates 2026-07-28 for stdio by default) will see progress in `/tasks` and list-changed over `subscriptions/listen`. It will **not** accept channel events on that connection. Pushing events into the model through channels would need the server to stay on the legacy handshake (or a second, legacy-only channel server), and is limited to text `content`.
- Progress `message` strings are the most widely displayed push. They are suitable for "what the agent is doing" status, not for screen data.

### Gaps
- Whether any host other than VS Code renders `notifications/resources/updated` live, and whether any host re-feeds updated resources to the model, is undocumented (Cursor, ChatGPT, Goose, Windsurf, LM Studio).
- How hosts display progress `message` (spinner text, task panel), outside Claude Code, is undocumented for Cursor, Claude Desktop, ChatGPT, Windsurf, Goose and LM Studio.

---

## 2. Server-to-model initiative: sampling (with images) and elicitation (form and URL)

### Takeaway
Sampling can carry images. Since 2026-07-28 it is **Deprecated**, and a server can only use it, along with elicitation and roots, *inside* a client request, via Multi Round-Trip Requests (MRTR). Among the target hosts, VS Code (with per-server model-access controls) and Goose document sampling support. claude.ai and Claude Desktop explicitly don't support it, and Claude Code, Cursor and ChatGPT document none. Elicitation (form, plus URL mode for secrets) is the supported way to ask the person. Claude Code, VS Code, Cursor and Goose (form only) support it. It is undocumented for claude.ai, Claude Desktop and ChatGPT.

### Cited Findings
**MRTR replaces server-initiated requests (2026-07-28)**
- MRTR (SEP-2322) replaces server-initiated `roots/list`, `sampling/createMessage` and `elicitation/create`. The server returns an `InputRequiredResult` (`resultType: "input_required"`) whose `inputRequests` carries the asks. The client retries the original request with `inputResponses`. — [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog); [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
- On Streamable HTTP the server "MUST NOT send independent JSON-RPC requests on this stream ... a change from Streamable HTTP in protocol versions 2025-03-26 through 2025-11-25". On stdio, "the server MUST NOT write JSON-RPC requests to stdout". — [Streamable HTTP, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http); [stdio, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)

**Sampling**
- "Servers can request text, audio, or image-based interactions". Messages carry `ImageContent` (`type: "image"`, base64 `data`, `mimeType`). That applies in [2025-11-25] and still in 2026-07-28. — [Sampling, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling); [Sampling, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)
- Sampling with tools (SEP-1577) lets a server pass a `tools` array and `toolChoice`; the client must declare `sampling.tools`. The spec says there SHOULD be a human in the loop able to deny sampling. — [Sampling, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/client/sampling)
- Roots, Sampling and Logging are deprecated in 2026-07-28 (SEP-2577). The migration for sampling is to "integrate directly with LLM provider APIs". The `includeContext` values `thisServer`/`allServers` are also deprecated. — [Deprecated features registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)

**Elicitation**
- Two modes: form (in-band structured data, flat schemas) and URL (out-of-band). Servers MUST NOT use form mode for passwords, API keys, tokens or payment credentials, and MUST use URL mode for those. An empty `elicitation: {}` capability means form only. — [Elicitation, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)
- 2026-07-28 removes `notifications/elicitation/complete` and `elicitationId` (both added in 2025-11-25). The client learns the outcome by retrying, and the server correlates through `requestState`. — [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

**Host support: sampling**
- *VS Code:* "VS Code provides access to sampling for MCP servers ... the user is prompted to authorize the server to access their models". Users can restrict models and inspect requests (MCP: List Servers > Show Sampling Requests), and the setting is `chat.mcp.serverSampling`. — [VS Code MCP developer guide](https://code.visualstudio.com/docs/copilot/guides/mcp-developer-guide); [VS Code MCP configuration reference](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)
- *Goose:* the community matrix lists Sampling for goose (snapshot 2026-05-26). — [MCP clients page, last version before removal](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/87993a6/docs/clients.mdx)
- *GitHub Copilot CLI:* also listed with Sampling in the same snapshot. — [MCP clients page, last version before removal](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/87993a6/docs/clients.mdx)
- *claude.ai and Claude Desktop:* sampling is not supported. — [Build an MCP server for Claude](https://claude.com/docs/connectors/building/index.md)
- *Claude Code:* its MCP docs and CHANGELOG never mention sampling, and the 2026-05-26 matrix row omits it. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp); [MCP clients page snapshot](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/87993a6/docs/clients.mdx)
- *Cursor:* its protocol table lists Tools, Prompts, Resources, Roots, Elicitation and Apps, with no sampling. — [Cursor MCP docs](https://cursor.com/docs/context/mcp)

**Host support: elicitation**
- *Claude Code, modes:* on 2026-07-28 connections Claude Code declares `elicitation: {form: {}, url: {}}`. URL mode on 2026-07-28 arrived in 2.1.281, and URL prompts on 2025-11-25 in 2.1.287. `Elicitation` hooks can auto-answer. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp); [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- *Claude Code, non-interactive sessions:* in a task, `elicitation/create` is served only in interactive terminal sessions. Since 2.1.310, an unanswered elicitation in a non-interactive session tells Claude that no answer came. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp); [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- *VS Code:* adopted the 2025-11-25 spec, including URL mode elicitation, in 1.107 (2025-12-10). Elicitation forms moved to the Ask Questions UI in 1.112 (2026-03-18). — [VS Code 1.107 release notes](https://code.visualstudio.com/updates/v1_107); [VS Code 1.112 release notes](https://code.visualstudio.com/updates/v1_112)
- *Cursor:* "Elicitation: Supported" (modes unspecified). — [Cursor MCP docs](https://cursor.com/docs/context/mcp)
- *Goose:* "goose supports form mode requests". Requests time out after 5 minutes, in Desktop and CLI. — [goose MCP Elicitation guide](https://github.com/block/goose/blob/main/documentation/docs/guides/mcp-elicitation.md)

**Sampling from an MCP App view (draft)**
- In the MCP Apps *draft*, the view itself may send `sampling/createMessage` to the host when `hostCapabilities.sampling` is set. This is absent from the stable 2026-01-26 Apps spec. — [MCP Apps draft spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx); [MCP Apps 2026-01-26 spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)

### Inferences
- "A server asks the model to look at a frame and decide" is possible only on VS Code and Goose among the target hosts. On 2026-07-28 it must happen inside a tool call (MRTR), not spontaneously. Given the deprecation and Claude's non-support, it is not a durable design basis. Returning the frame as a tool result and letting the host's own agent loop decide is the portable route.
- Elicitation is the portable way to get input *from the person* mid-call, but only in the hosts listed above. Under MRTR it cannot be raised outside a pending request.

### Gaps
- Whether VS Code's sampling accepts image content in messages is undocumented.
- Whether Goose's sampling is per-spec or the experimental app-front-end variant is unclear from primary sources.
- Elicitation support in claude.ai, Claude Desktop and ChatGPT is undocumented. The 2026-05-26 matrix lists neither for them.

---

## 3. The tasks extension (`io.modelcontextprotocol/tasks`)

### Takeaway
The tasks extension turns a long `tools/call` into a durable handle. The client polls `tasks/get` and answers mid-flight questions via `tasks/update`; push status via `notifications/tasks` on `subscriptions/listen` is optional. Results do **not** stream: the full result arrives once, at `completed`, and progress and logging notifications are not supported on tasks. Claude Code (CLI, Agent SDK and GitHub Actions, 2.1.304 or later, on 2026-07-28 connections) is the only target host whose docs specify support. VS Code supported the older core Tasks [2025-11-25].

### Cited Findings
**The extension (2026-07-28)**
- In 2026-07-28, tasks moved out of core into an official extension (SEP-2663). It replaces blocking `tasks/result` with polling via `tasks/get`, adds `tasks/update` for client-to-server input, removes `tasks/list`, and lets servers return task handles unsolicited. — [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- Flow: the client declares the extension in per-request capabilities, and the server returns `CreateTaskResult` (`resultType: "task"`, `taskId`, status, TTL, `pollIntervalMs`). Statuses are `working`, `input_required`, `completed`, `failed` and `cancelled`; the last three are terminal. `tasks/cancel` is cooperative. — [Tasks extension overview](https://modelcontextprotocol.io/extensions/tasks/overview)
- Servers MAY push `notifications/tasks`, carrying full task state, after the client subscribes with `subscriptions/listen` and `notifications.taskIds`. "`notifications/progress` and `notifications/message` notifications MUST NOT be sent on the `subscriptions/listen` stream for a task, and are not supported on tasks in general." — [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension)
- The intermediate signal is the optional `statusMessage` string on the task. — [SEP-2663](https://modelcontextprotocol.io/seps/2663-tasks-extension)
- The core Subscriptions page lists only four filter fields and omits `taskIds`; the field is defined in SEP-2663. — [Subscriptions, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)
- The Tasks extension is not in the official extension support matrix, which covers Apps, the two auth extensions and Skills. — [Extension support matrix](https://modelcontextprotocol.io/extensions/client-matrix)

**Claude Code**
- *Conditions:* a call becomes an MCP task only on HTTP, stdio or claude.ai-connector servers on 2026-07-28, in sessions that fetch feature flags, and in terminal CLI, Agent SDK or GitHub Actions (2.1.304 or later). "Other surfaces, such as the VS Code extension and the desktop app, don't have MCP tasks."
- *What it uses:* it polls `tasks/get` (default every 2000 ms, clamped to 250–30000) and shows `statusMessage` in `/tasks`. It serves `elicitation/create` (interactive only) and `roots/list` in `inputRequests`. It does not use "`tasks/result`, `tasks/list`, `notifications/tasks`". — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

**VS Code and others**
- VS Code 1.107 (2025-12-10) added "Tasks for long-running, resilient tool calls" as part of 2025-11-25. This was the pre-extension core design. — [VS Code 1.107 release notes](https://code.visualstudio.com/updates/v1_107)
- The 2026-05-26 matrix lists Tasks for VS Code and GitHub Copilot CLI only. — [MCP clients page snapshot](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/87993a6/docs/clients.mdx)

**Streaming task output: proposals only**
- SEP-2694 "Resumable Task Event Streams" (open) proposes `tasks/stream` and `notifications/tasks/event`, with sequence numbers and resume cursors. — [PR #2694](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2694)
- SEP-2679 "Task streaming partial results" was closed 2026-06-13 when tasks moved to the extension track. — [PR #2679](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2679)
- The Tasks and Events WG charter scopes stabilising the extension and promoting it into core. — [Tasks and Events WG charter](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/community/working-groups/tasks-events.mdx)

### Inferences
- Tasks suit "watch until done" jobs, with a `statusMessage` per poll. They are not a frame stream: no image or partial content until completion, and progress notifications are disallowed on tasks.
- Hosts that ignore `notifications/tasks` (Claude Code says so explicitly) force polling, so the server's `pollIntervalMs` sets the effective update rate.

### Gaps
- Tasks-extension (SEP-2663) support in VS Code, Cursor, Goose and ChatGPT is undocumented as of October 2026.

---

## 4. MCP Apps (`ui://` resources, extension `io.modelcontextprotocol/ui`)

### Takeaway
An MCP App is a `ui://` HTML resource that the host renders in a sandboxed iframe. The iframe speaks a JSON-RPC dialect over `postMessage` to the host:
- it can call server tools (including app-only tools hidden from the model);
- it can read resources;
- it can send a chat message that starts a turn (`ui/message`);
- it can update the model's context for future turns (`ui/update-model-context`).

The host pushes tool input (including partial input while the model streams arguments) and tool results into it. No server-initiated push into the app is defined beyond tool results and list-changed. A "live" view is done by the app polling an app-only tool; the official system-monitor example polls every 2 s. Alternatively the app can use fetch or WebSocket to origins declared in `csp.connectDomains`. Hosts that render MCP Apps: claude.ai, Claude Desktop, VS Code, Microsoft 365 Copilot, Goose, Postman, MCPJam, ChatGPT, Cursor, Archestra and PostHog Code. Claude Code (terminal) does not render them.

### Cited Findings
**Model and lifecycle**
- A tool declares `_meta.ui.resourceUri` pointing to a `ui://` resource. The host may preload it, "enabling features like streaming tool inputs to the app". The resource can request `permissions` (microphone, camera) and `csp`. — [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)
- The app "can request tool calls, send messages, update the model's context, and receive data from the host". The overview cites real-time monitoring as a use case. — [MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview)
- MCP Apps (SEP-1865) launched as the first official MCP extension on 2026-01-26. — [WorkOS on MCP Apps](https://workos.com/blog/2026-01-27-mcp-apps)
- The stable spec is `specification/2026-01-26`; there is also a `draft`. ext-apps 2.0.0 (2026-09-08) moved to TypeScript SDK 2.0 with the "wire protocol unchanged". — [ext-apps specification](https://github.com/modelcontextprotocol/ext-apps/tree/main/specification); [ext-apps v2.0.0 release](https://github.com/modelcontextprotocol/ext-apps/releases/tag/v2.0.0)

**Bridge methods** — [MCP Apps draft spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)
- *Lifecycle:* `ui/initialize` → `ui/notifications/initialized`.
- *View → host:* `tools/call` and `tools/list` (proxied to the server; needs host `serverTools`), `resources/read`, `ui/open-link`, `ui/message`, `ui/request-display-mode` (`inline`, `fullscreen`, `pip`), `ui/update-model-context`, `notifications/message`. The draft also adds `ui/download-file` and `sampling/createMessage`.
- *Host → view:* `ui/notifications/tool-input`, `ui/notifications/tool-input-partial` (sent "while the agent is streaming tool arguments"), `ui/notifications/tool-result`, `ui/notifications/tool-cancelled`, `ui/notifications/host-context-changed`, size-changed, `ui/resource-teardown`, and `notifications/tools/list_changed`.

**Requests that reach the model**
- `ui/message`: the host "SHOULD add the message to the conversation context, preserving the specified role" and "MAY request user consent".
- `ui/update-model-context`: "This context will be used in future turns. Each request overwrites the previous context". The host MAY defer it until the next user message, and if several arrive first it SHOULD send only the last.
- Content modalities: host capabilities `message` and `updateModelContext` each declare the block types they accept (`text`, `image`, `audio`, `resource`, `resourceLink`, `structuredContent`). — [MCP Apps draft spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)

**Live updates**
- The spec's only update pattern is "Views can request fresh data by calling tools". Tools with `visibility: ["app"]` are "hidden from the agent but remain callable by apps". — [MCP Apps draft spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)
- The official system-monitor example "Polls `poll-system-stats` every 2 seconds", an app-only tool, to show "real-time OS metrics". — [system-monitor-server example](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/system-monitor-server)
- The video example serves video "via MCP resources using the base64 blob pattern" over stdio. — [video-resource-server example](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/video-resource-server)
- *Sandbox permissions:* `connectDomains` are "Origins for network requests (fetch/XHR/WebSocket)"; empty means no external connections, and the example includes `wss://realtime.service.com`. The permissions a host can grant are `camera`, `microphone`, `geolocation` and `clipboardWrite`. — [MCP Apps draft spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)

**Stable vs draft**
- The draft adds "App-Provided Tools": the host or agent calls tools *registered by the app*, a pull complement to push-style `ui/update-model-context`. App tools MAY be task-augmented. Neither app tools, view sampling nor `ui/download-file` is in the stable 2026-01-26 spec. In the stable spec, `ui/update-model-context`, `tool-input-partial`, `pip` and camera/microphone permissions are present. — [MCP Apps draft spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx); [MCP Apps 2026-01-26 spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)

**Hosts that render MCP Apps**
- The official matrix checks MCP Apps for Claude (web), Claude Desktop, VS Code GitHub Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam, ChatGPT, Cursor, Archestra.AI and PostHog Code. — [Extension support matrix (raw)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/extensions/client-matrix.mdx)
- *Claude:* "claude.ai on the web: remote connectors, including MCP Apps". The getting-started guide runs example MCP Apps as local stdio servers through `claude_desktop_config.json` in Claude Desktop. — [Claude connectors overview](https://claude.com/docs/connectors/overview); [Get started with MCP Apps (Claude)](https://claude.com/docs/connectors/building/mcp-apps/getting-started.md)
- *Claude Code:* MCP Apps UI resources (`ui://` or `text/html;profile=mcp-app`) are "pages for a host application to render". They are skipped in `@` suggestions and the resource list (2.1.281); reading by URI works. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- *VS Code:* MCP Apps added in 1.109 (2026-02-04); the setting is marked "experimental and might change or be removed". — [VS Code 1.109 release notes](https://code.visualstudio.com/updates/v1_109); [VS Code MCP configuration reference](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)
- *Cursor:* "Cursor supports the MCP Apps extension"; it shipped in 2.6. A forum report says apps stopped rendering in 3.10.20. — [Cursor MCP docs](https://cursor.com/docs/context/mcp); [Cursor 2.6 forum post](https://forum.cursor.com/t/cursor-2-6-mcp-apps/153482); [regression thread](https://forum.cursor.com/t/mcp-apps-stopped-rendering-in-3-10-20-worked-in-3-9-16/165167)
- *ChatGPT:* "ChatGPT implements the MCP Apps standard". The reference page names `ui/notifications/tool-input` and display modes `inline`/`fullscreen`/`pip`. It also keeps `window.openai` extras: `callTool`, `sendFollowUpMessage`, `setWidgetState`, `uploadFile`, `requestDisplayMode`, `requestModal` and others. `connectDomains` are described as fetch/XHR targets; WebSocket and localhost are not addressed. — [OpenAI Apps SDK reference](https://developers.openai.com/apps-sdk/reference)
- *Goose:* MCP Apps render inline in goose Desktop or in standalone windows, flagged experimental; apps "can call tools and read resources". — [goose: Using MCP Apps](https://github.com/block/goose/blob/main/documentation/docs/guides/interactive-chat/mcp-ui.md)

### Inferences
- A live screen view inside an app is feasible today only as polling: `setInterval` → `tools/call` on an app-only `get_frame` tool returning an image. Every frame passes through the host's postMessage proxy and the MCP connection, so the practical frame rate is low (the official example uses 2 s).
- A real video stream would need the app to connect to a loopback WebSocket or HTTP endpoint the server opens, declared in `connectDomains`. Whether hosts permit `ws://localhost` origins, and under which Origin, is undocumented.
- The sandbox permission list has no screen capture (`display-capture`). An app cannot call `getDisplayMedia` itself, so screen pixels must come from the server.
- Frames an app fetches for itself do not reach the model. To let the model see the "current frame", the app must call `ui/update-model-context` (image modality, if the host declares it) or `ui/message` (which starts a turn). Hosts may defer both until the next user message.
- `ui/message` is the only spec path by which a person's action in a server-rendered UI starts a model turn without typing in the host's composer.

### Gaps
- Which ui/* methods each host actually implements is not published per host: ChatGPT's reference names few, and Claude, Cursor and Goose publish no method list. Image support in `updateModelContext`/`message` per host is undocumented.
- How hosts rate-limit or throttle app-initiated `tools/call` is undocumented.

---

## 5. Transports: Streamable HTTP SSE, server-initiated messages, resumability, stdio, WebSocket

### Takeaway
In 2026-07-28 each POST may answer with an SSE stream: request-related notifications, then the response. Long-lived pushes use the POST-based `subscriptions/listen` stream. There is no GET endpoint, no session ID, no server-initiated requests and no resumability, so a broken stream loses the request. Stdio is one shared bidirectional channel with notifications demultiplexed by `subscriptionId`, and the server MUST NOT write requests to stdout. WebSocket remains non-standard: SEP-1288 was closed as dormant, and pluggable transports (SEP-2598) are open and deferred. Claude Code nevertheless accepts a WebSocket transport.

### Cited Findings
**Streamable HTTP and stdio (2026-07-28)**
- Every client message is its own POST, and the server may answer with JSON or an SSE stream "scoped to that request, carrying request-related notifications followed by the final response". The final response SHOULD terminate the stream.
- Long-lived change notifications come from a `subscriptions/listen` POST whose SSE response stays open. Servers are "encouraged to periodically emit an SSE comment line" as keep-alive. "Resumable SSE streams via `Last-Event-ID` are not supported." — [Streamable HTTP, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- Broken response streams: the client MUST re-issue the request with a new ID. `Mcp-Method`/`Mcp-Name` headers are now required on POSTs (SEP-2243). — [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- *stdio:* newline-delimited JSON-RPC with no per-request streams. The server sends responses, request-related notifications and `subscriptions/listen` notifications, which clients MUST correlate by `subscriptionId`. To cancel, the client sends `notifications/cancelled`. After a reconnect, in-flight requests are lost. — [stdio, 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)

**[2025-11-25] and deprecated transports**
- In 2025-11-25 a GET opened a server-to-client SSE stream, servers could send requests on SSE streams, and resumption used `Last-Event-ID` with redelivery. — [Transports, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- The HTTP+SSE transport (2024-11-05) is reclassified as Deprecated. — [Deprecated features registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)

**WebSocket and pluggable transports**
- SEP-1288 (WebSocket transport) was closed 2026-06-26 as dormant, with no Core Maintainer sponsor. — [Issue #1288](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1288)
- SEP-2598 "Pluggable Transports" (open, labelled `deferred`) would keep stdio and Streamable HTTP "the only Standard transports". Instead it would add an SDK `Transport` interface, with WebSocket, gRPC and SSH distributed as packages. — [PR #2598](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2598)
- Claude Code supports a WebSocket transport (persistent bidirectional, no OAuth, 16 MiB per-message limit). — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

**Roadmap**
- The 2026-08-22 roadmap aims at "local servers speaking Streamable HTTP over stdio", unifying on one transport. — [MCP roadmap post, 2026-08-22](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-08-22-mcp-roadmap.md)
- The Transports WG scope includes multiplexing, reconnection, resumption, and delivery and ordering guarantees. — [Transports WG charter](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/community/working-groups/transports.mdx)

**Claude Code client behaviour**
- Since 2.1.292, Claude Code negotiates 2026-07-28 with local stdio servers by default on every install. claude.ai connectors followed in 2.1.295 and cloud/Remote Control connectors in 2.1.299. `MCP_PROTOCOL_NEGOTIATION=legacy` opts out. — [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

### Inferences
- For a local server, stdio and loopback Streamable HTTP offer the same push semantics in 2026-07-28. Request-scoped notifications go on the call, and change notifications go on `subscriptions/listen`. Neither carries server-initiated requests, and neither resumes.
- A screen stream needing resumability or binary framing has no standard home. Binary resource streaming (SEP-2532) is HTTP-only and unsponsored.

### Gaps
- Behaviour of hosts other than Claude Code toward `subscriptions/listen` streams (reconnect policy, keep-alive tolerance) is undocumented.

---

## 6. Host support matrix (as of 2026-10-25)

### Takeaway
MCP Apps is the most widely supported "rich" channel: eleven clients in the official extension matrix check it, including six of the nine target hosts (Claude Desktop, claude.ai, Cursor, VS Code, ChatGPT, Goose). Elicitation is next. Sampling is supported by a minority (VS Code, Goose, Copilot CLI) and is deprecated. Resource subscriptions are explicitly unsupported by Claude and undocumented almost everywhere. Of the target hosts, only Claude Code documents 2026-07-28 stateless support and tasks-extension support. LM Studio and Windsurf are tools-centric.

### Cited Findings
Legend: Y = documented support; N = documented absence; U = undocumented. The source for each row follows the table.

| Host | Progress display | Resource subscriptions | Sampling | Elicitation | MCP Apps | Tasks | 2026-07-28 stateless |
|---|---|---|---|---|---|---|---|
| Claude Code (CLI) | Y, in `/tasks` (UI only) | U (list-changed via listen stream: Y) | U (not mentioned) | Y, form + URL | N (UI resources skipped) | Y, extension, CLI/SDK/Actions, 2.1.304+ | Y, default for stdio since 2.1.292 |
| Claude Desktop (chat) | U | N | N | U | Y (incl. local stdio servers) | U | U |
| claude.ai remote connectors | U | N | N | U | Y | U | U |
| Cursor | U | U | U (not in table) | Y | Y (2.6+; regression report in 3.10.20) | U | U |
| VS Code (GitHub Copilot) | U | Y, live resource updates in editor | Y | Y, form + URL (1.107) | Y (1.109, experimental) | Y, 2025-11-25 core tasks (1.107) | U (not in release notes 1.104–1.144) |
| ChatGPT (developer mode / apps) | U | U | U | U | Y | U | U |
| Windsurf (now Devin Desktop docs, Cascade agent) | U | U | U | U | U | U | U |
| Goose | U | U | Y | Y, form only | Y (experimental) | U | U |
| LM Studio | U | U | U | U | U | U | U |

**Row sources**
- *Claude Code:* [Claude Code MCP docs](https://code.claude.com/docs/en/mcp); [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md). Elicitation, tasks, MCP Apps skipping, list-changed stream and 2026-07-28 defaults are all quoted in sections 1–5.
- *Claude Desktop and claude.ai:* "Claude doesn't yet support ... Resource subscriptions; Sampling; Advanced or draft capabilities". Hosted limits are a ~150,000-character tool result and a 240 s tool-call timeout. Supported features are tools, prompts, resources, text and image results, and text and binary resources. — [Build an MCP server for Claude](https://claude.com/docs/connectors/building/index.md)
- *Claude Desktop and claude.ai, MCP Apps:* web renders MCP Apps, and Desktop runs local MCP Apps examples. — [Claude connectors overview](https://claude.com/docs/connectors/overview); [Get started with MCP Apps (Claude)](https://claude.com/docs/connectors/building/mcp-apps/getting-started.md)
- *Claude Desktop and claude.ai, 2026-05-26 matrix:* Desktop = Resources, Prompts, Tools, Roots, Apps, DCR; claude.ai = Resources, Prompts, Tools, Apps, CIMD, DCR. — [MCP clients page snapshot](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/87993a6/docs/clients.mdx)
- *claude.ai reachability:* claude.ai reaches remote servers only, so testing a local server needs a tunnel. — [Test your connector](https://claude.com/docs/connectors/building/testing.md)
- *Cursor:* the protocol table lists Tools, Prompts, Resources, Roots, Elicitation and Apps as Supported, and transports stdio, SSE and Streamable HTTP. — [Cursor MCP docs](https://cursor.com/docs/context/mcp); [Cursor 2.6 forum post](https://forum.cursor.com/t/cursor-2-6-mcp-apps/153482); [regression thread](https://forum.cursor.com/t/mcp-apps-stopped-rendering-in-3-10-20-worked-in-3-9-16/165167)
- *VS Code:* the features list is Tools, Prompts, Resources, Elicitation, Sampling, Authentication, Server instructions, Roots and MCP Apps, over stdio, Streamable HTTP and legacy SSE; the guide also says "VS Code supports resource updates". — [VS Code MCP developer guide](https://code.visualstudio.com/docs/copilot/guides/mcp-developer-guide); [VS Code 1.107](https://code.visualstudio.com/updates/v1_107); [VS Code 1.109](https://code.visualstudio.com/updates/v1_109); [VS Code MCP configuration reference](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)
- *VS Code, 2026-07-28:* no release note between 1.104 and 1.144 (2026-10-21) mentions 2026-07-28; I scanned them, and the 1.116 page failed to download. — [VS Code updates index](https://code.visualstudio.com/updates)
- *ChatGPT:* implements the MCP Apps standard. — [OpenAI Apps SDK reference](https://developers.openai.com/apps-sdk/reference)
- *ChatGPT developer mode:* per its guide, available on the web for Pro, Plus, Business, Enterprise and Education, with SSE or streaming HTTP. This is from a search summary; the page returned 404 when fetched on 2026-10-25. — [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- *ChatGPT write actions:* "ChatGPT currently requires manual confirmation in any conversation before write actions can be taken". — [OpenAI MCP docs](https://developers.openai.com/api/docs/mcp/)
- *ChatGPT, 2026-05-26 matrix:* Tools, Apps, DCR, CIMD, Instructions. — [MCP clients page snapshot](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/87993a6/docs/clients.mdx)
- *Windsurf:* "We currently support an MCP server's tools, resources, and prompts". Transports are stdio, Streamable HTTP and SSE. The page now lives under "Devin Docs" and applies "to the legacy Cascade agent only"; the Devin Local agent configures MCP elsewhere. The 2026-05-26 matrix lists Tools, Discovery. — [Windsurf/Devin Cascade MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp); [MCP clients page snapshot](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/87993a6/docs/clients.mdx)
- *Goose:* the 2026-05-26 matrix lists Apps, DCR, Discovery, Elicitation, Instructions, Prompts, Resources, Roots, Sampling, Tools. — [MCP clients page snapshot](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/87993a6/docs/clients.mdx); [goose MCP Elicitation guide](https://github.com/block/goose/blob/main/documentation/docs/guides/mcp-elicitation.md); [goose: Using MCP Apps](https://github.com/block/goose/blob/main/documentation/docs/guides/interactive-chat/mcp-ui.md)
- *LM Studio:* local and remote MCP servers from 0.3.17, using Cursor's `mcp.json` notation; the 2026-05-26 matrix lists Tools only. — [LM Studio MCP docs](https://lmstudio.ai/docs/app/mcp); [MCP clients page snapshot](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/87993a6/docs/clients.mdx)

**Other hosts worth noting**
- GitHub Copilot CLI: Tools, Discovery, Instructions, Sampling, Elicitation, DCR, OAuth Client Credentials, Tasks. Codex: Resources, Tools, Elicitation, Instructions. (2026-05-26 snapshot.) — [MCP clients page snapshot](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/87993a6/docs/clients.mdx)
- Microsoft 365 Copilot, Postman, MCPJam, Archestra.AI and PostHog Code render MCP Apps. — [Extension support matrix (raw)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/extensions/client-matrix.mdx)

**Source caveat**
- The community "Example Clients" feature matrix was removed from modelcontextprotocol.io on 2026-05-27 (commit 2075a21). The last copy (87993a6, 2026-05-26) predates 2026-07-28. Only the extension matrix is still maintained. — [commit history for docs/clients.mdx](https://github.com/modelcontextprotocol/modelcontextprotocol/commits/main/docs/clients.mdx)

### Inferences
- The only feature reaching most rich hosts (Claude web and Desktop, VS Code, Cursor, ChatGPT, Goose) is MCP Apps. A person-facing live view is portable through an app; a model-facing live view is portable only as tool-result images.
- Claude Code is the strongest target for 2026-07-28-native features (tasks, listen streams, URL elicitation) but renders no apps. Its push-to-model channel works only on the legacy handshake.
- "Ignores subscriptions" is the norm. Claude says so explicitly, and others are silent; the one documented exception is VS Code showing live resource updates to the user.

### Gaps
- No primary source states 2026-07-28 support for Claude Desktop, claude.ai, Cursor, VS Code, ChatGPT, Goose, Windsurf or LM Studio.
- Progress-notification display is undocumented for every host except Claude Code.

---

## 7. SEPs and working-group work in 2026 on streaming media, realtime or voice, and "live" sessions

### Takeaway
There is no SEP or working group for realtime audio or video media streams. 2026 work clusters around three areas:
- *Agentic messaging primitives* (roadmap priority): server-initiated events and webhooks, streamed results, mid-flight steering.
- *Events* (SEP-3415, open): poll, push and webhook delivery of upstream events, with resume cursors.
- *Task event streams* (SEP-2694, open), *LLM re-entry from server events* (SEP-2495, open) and *binary resource streaming* (SEP-2532, open, unsponsored).

Partial and streaming tool results were proposed several times. The latest, SEP-2998, was closed 2026-09-22 to go through a working group.

### Cited Findings
**Roadmap and working groups**
- 2026-08-22 roadmap, priority "Agentic messaging primitives": "Loops can run for longer, servers can push streamed results, and there is a clear need to steer work mid-flight". The work "spans server-initiated events (webhooks and channels, so clients aren't left polling for results)", a composition review across the Agents, Transports and Triggers & Events groups, and maturing Tasks into core. — [MCP roadmap post, 2026-08-22](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/blog/content/posts/2026-08-22-mcp-roadmap.md)
- Tasks and Events WG mission: "define how servers proactively notify clients of state changes ... a standardized callback mechanism—webhooks or similar ... with defined ordering guarantees". It is out of scope to modify existing notification primitives except where they relate to proactive delivery. — [Tasks and Events WG charter](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/community/working-groups/tasks-events.mdx)
- MCP Apps WG scope includes "bi-directional messaging, app tools" and interop with A2UI and AG-UI. — [MCP Apps WG charter](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/community/working-groups/apps.mdx)

**Event and streaming SEPs**
- SEP-3415 "Events Extension" (`io.modelcontextprotocol/events`; open, opened 2026-10-05) has `events/list` and three delivery modes: `events/poll`, a long-lived `events/stream` push, and `events/subscribe` webhooks signed per Standard Webhooks. Opaque resume cursors allow optional replay, and `list_changed` rides a `subscriptions/listen` filter field. A reference SDK implementation is outstanding. — [PR #3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415)
- SEP-2495 "Event-Driven Tool Invocation (Server-Push to LLM Re-entry)" (open) proposes letting servers trigger new LLM turns. It notes that today's notifications "only update metadata — they never re-enter the LLM loop", and uses a desktop app (Avalonia) as the motivating case. — [PR #2495](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2495)
- SEP-2694 "Resumable Task Event Streams" (open) proposes `tasks/stream` and `notifications/tasks/event`, with sequence numbers and vendor-prefixed event types. It is positioned as the resumable complement to fire-and-forget `subscriptions/listen`. — [PR #2694](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2694)
- SEP-2532 "Resource Streaming for Binary Content Delivery" (open, "seeking sponsor") proposes `resources/stream` returning raw binary HTTP streams or a `downloadUrl` instead of base64. "stdio transport is explicitly out of scope." — [PR #2532](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2532)

**Closed attempts**
- SEP-2998 "Partial Tool Results" proposed `notifications/tools/partial_result` during `tools/call`, motivated partly by MCP Apps getting partial *input* but no partial *output*. It was closed 2026-09-22, when maintainers required new SEPs to come through a working group. — [PR #2998](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2998)
- SEP-2664/PR #3000 (streaming tool results) was closed for undisclosed AI generation. — [PR #3000](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3000)
- The long-standing open issues are #117 "Streaming tool use results" and #2932 "lacks a mechanism for tools to stream incremental results". — [Issue #117](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/117); [Issue #2932](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2932)
- Also closed in 2026: SEP-2631 "File Objects and Transfer" (closed 2026-10-14) and SEP-2356 "File input support for tools and elicitation" (closed 2026-08-23). — [PR #2631](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631); [PR #2356](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2356)

**Transport proposals**
- WebSocket (SEP-1288) was closed as dormant on 2026-06-26, and Pluggable Transports (SEP-2598) is open and deferred. — [Issue #1288](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1288); [PR #2598](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2598)

### Inferences
- A standard "live session" primitive (a server pushing a continuous media stream that the model consumes) is not on any 2026 track. The nearest are SEP-3415 events (discrete events, not media), SEP-2495 (re-entering the model) and SEP-2532 (binary, HTTP-only). A screen-share feature built now has to compose existing pieces:
  - frames as tool-result images;
  - an MCP App polling app-only tools, or a loopback WebSocket under CSP;
  - `ui/update-model-context` / `ui/message` to involve the model;
  - Claude Code channels (legacy-only, text) for event injection.

### Gaps
- I found no SEP, working group or discussion on realtime voice or audio streaming, or video, over MCP in 2026. The search covered spec-repo PRs and issues for websocket, realtime, audio streaming, video, partial and streamed results, and webhooks.
- The outcome of SEP-3415 and SEP-2694 review, and whether either will target the next revision, is not yet known.
