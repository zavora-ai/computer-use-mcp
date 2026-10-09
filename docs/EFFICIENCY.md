# Token and interaction efficiency

## Current surface (7.6.0)

The list a host loads is the largest fixed cost, so 7.6 shrank it at the source rather than only offering a host-side
library. On macOS, measured over stdio on the live server on 2026-10-09:

| Profile | Tools | `tools/list` bytes | About tokens |
|---|---:|---:|---:|
| Before 7.6 (default `full`) | 73 | 112,727 | 30k |
| 7.6 `desktop` (the new default) | 39 | 45,942 | 12k |
| 7.6 `full` | 76 | 84,037 | 22k |

What changed: the default profile is `desktop` (core plus OCR, waits and `agent_pointer`; `COMPUTER_USE_PROFILE=full` lists
everything); tools that do not exist on a platform are not listed; the six shared targeting parameters are one sentence
each (they were about half of all schema bytes); `approval_token` left every schema (it goes in the call's `_meta`);
one `click {button, count}` replaced five schemas (the old names stay as tiny aliases); each tool carries two `_meta`
fields instead of seven. `COMPUTER_USE_ADVERTISE_APPROVAL_TOKEN=true` and `COMPUTER_USE_FULL_WIRE_META=true` restore the
old shapes. Byte budgets (`desktop` 48,000, `full` 88,000) are tests, so a new tool that pushes past them fails the build.

Other 7.6 savings are in turns, not bytes: `wait_for_window`, `wait_for_text` and `wait_for_stable` replace
sleep-and-screenshot loops, `read_window_text` with a `region` returns a few dozen tokens where a screenshot is an image,
and its lines carry one `box` each with the window's `screen_origin` once (the per-line `screen` rectangle is gone).
These are described, not measured as token counts: compare real usage on the same tasks before claiming a saving.

The host-side helpers below are unchanged and still opt-in. Claude Code defers tool schemas and pays per search; hosts
that load the whole list (Claude Desktop, Cursor, VS Code) are the ones the smaller default list helps.

The optional `@zavora-ai/computer-use-mcp/efficiency` export provides host-side
helpers without changing MCP tool names, schemas, or default results. The host
still executes tools through the server's normal authorization checks.

```js
import {
  createToolDiscovery, compactAccessibilityTree, toModelContent, waitForElement,
} from '@zavora-ai/computer-use-mcp/efficiency'

const discovery = createToolDiscovery(client)
const tools = await discovery.search('fill_form', 6)
// Send only these tools' actual inputSchema values to the model.
// On tools/list_changed or a host profile change:
discovery.invalidate()

const result = await client.callTool('get_ui_tree', { window_id: windowId })
if (!result.isError) {
  const tree = JSON.parse(result.content.find(c => c.type === 'text').text)
  const observation = compactAccessibilityTree(tree, {
    maxNodes: 80, maxChars: 8000, query: 'button',
  })
  // observation.truncated explicitly reports omitted nodes.
}

const ready = await waitForElement(client, {
  windowId, label: 'Ready', timeoutMs: 10000, signal,
})
// Pass errors through; a denied observation never means the element is absent.
const content = toModelContent(ready)
```

Discovery caches the catalog for 30 seconds by default and returns at most eight
schemas. It is lexical search, not an intent classifier. Exact tool names work
best; refine a query if no relevant tool appears. Invalidation prevents a pending
old request from repopulating the cache. Execution remains subject to current
server policy even when a schema was cached.

Compact trees keep labels, roles, values, bounds, actions, and sensitive-field
redaction. Paths identify positions in that observation; they are not stable
element handles. A query filters role/label terms, and does not prove missing
controls are absent when the source or projection was truncated. Narrow the
query or request a larger budget when necessary.

`toModelContent` avoids adding structured data already represented by a JSON text
block. It preserves extra diagnostics, errors, links, and images. Pass its blocks
as native multimodal inputs to the model; JSON-stringifying image blocks does
not provide vision. This does not change the server's dual-format results for
clients that depend on them.

Image reuse is disabled by default. To enable it, supply `imageScope` and only
`knownImageIds` whose images remain in the current model conversation. The helper
emits a SHA-256 image ID scoped by capture context and MIME type; an identical
retained image becomes a text reference. Clear retained IDs after compaction,
truncation, branching without image history, or switching conversations. Pixel
equality does not establish unchanged coordinates, application state, or access.
Image compression size is not a reliable proxy for model image token cost.

`waitForElement` polls locally (250 ms by default), returns once the condition
matches, and supports cancellation and a maximum two-minute deadline. It saves
model turns, not necessarily native calls. `client.callTool` now accepts an
optional third argument `{ signal, timeoutMs }` for request cancellation/timeouts.
Use existing `fill_form` for multi-field entry and semantic controls before
coordinate actions. Verify final state after mutations.

Clipboard-backed typing restores the saved text only if the current clipboard
still equals the injected text. This preserves a different value copied during
the paste delay. It is a best-effort text comparison, not an atomic clipboard
transaction or preservation of every rich clipboard format.

## Example and measurements

The [OpenAI example](../agents/openai-agent/agent.mjs) uses Responses with three
bootstrap tools, loads up to six real schemas on demand, returns real image
inputs, waits locally, emits progress, and reports API usage. Set `OPENAI_MODEL`
to select a compatible model. Image reuse requires explicit
`COMPUTER_USE_REUSE_IMAGES=true`; the example uses a continuous Responses chain
without compaction. No API calls are made by its offline tests.

Run `npm run measure:efficiency` from a source checkout for catalog character
counts and synthetic observation measurements. It measures an in-process shape:
`client.listTools()` through `connectInProcess`, as JSON characters, for the `core`,
`scripting`, `ax` and `full` profiles (it does not list `desktop`). That is not the
wire size of `tools/list` over stdio, which adds framing and per-tool fields. For 7.6.0
on macOS it prints 36 / 42 / 57 / 76 tools and 37,391 / 45,518 / 58,494 / 77,319
characters, against 45,942 and 84,037 bytes measured on the wire for `desktop` and `full`. These are payload measurements,
not claimed token savings. Compare actual input/cached/output token usage,
completion time, successful outcomes, retries, and user interventions on the same
tasks before claiming improvements. Smaller truncated observations can lose
information; lazy discovery adds a turn and may be slower for short tasks.

Reference output from this implementation (JSON characters). The first row was measured on 7.1; the
second re-runs the same script on 7.6.0. Neither is the wire size of a profile's `tools/list` (see above):

| Measurement | Before | After | Qualification |
|---|---:|---:|---|
| Full catalog vs `screenshot` discovery (7.1) | 78,256 | 9,499 | 64 tools vs 5 matches; bootstrap definitions are additional |
| Full catalog vs `screenshot` discovery (7.6, in-process) | 77,319 | 9,385 | 76 tools vs 6 matches; same script, same shape |
| Synthetic accessibility tree | 15,440 | 5,902 | 80 nodes retained; explicitly truncated |
| Text plus duplicate structured result | 33,550 | 18,077 | Equivalent data represented once |

These figures describe the deterministic fixtures in the measurement script,
not an end-to-end benchmark against OpenAI computer use.
