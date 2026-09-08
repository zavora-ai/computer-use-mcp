# Token and interaction efficiency

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
counts and synthetic observation measurements. These are payload measurements,
not claimed token savings. Compare actual input/cached/output token usage,
completion time, successful outcomes, retries, and user interventions on the same
tasks before claiming improvements. Smaller truncated observations can lose
information; lazy discovery adds a turn and may be slower for short tasks.

Reference output from this implementation (JSON characters):

| Measurement | Before | After | Qualification |
|---|---:|---:|---|
| Full catalog vs `screenshot` discovery | 78,256 | 9,499 | 64 tools vs 5 matches; bootstrap definitions are additional |
| Synthetic accessibility tree | 15,440 | 5,902 | 80 nodes retained; explicitly truncated |
| Text plus duplicate structured result | 33,550 | 18,077 | Equivalent data represented once |

These figures describe the deterministic fixtures in the measurement script,
not an end-to-end benchmark against OpenAI computer use.
