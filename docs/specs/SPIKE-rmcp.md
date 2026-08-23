# SPIKE: rmcp (official Rust MCP SDK) parity evaluation & go/no-go

| Field | Value |
|-------|-------|
| **PR** | PR-16 (v7.0 evaluation track) |
| **Author** | Zavora / maintainers |
| **Date** | 2026-07-10 |
| **Status** | Decision record — **NO-GO for a production rewrite** (evaluate-only, per plan A1 / K2) |
| **Scope** | Should `@zavora-ai/computer-use-mcp` migrate its MCP server layer from the TypeScript `@modelcontextprotocol/sdk` to the official Rust SDK (`rmcp`)? |

---

## 1. What rmcp is (as evaluated)

- **Crate:** `rmcp` — the **official** Rust MCP SDK (`github.com/modelcontextprotocol/rust-sdk`), tokio async runtime.
- **Companion:** `rmcp-macros` (proc-macros for tool definitions).
- **Surface:** builds MCP **servers and clients**; exposes tools, resources, and prompts; ships the wire-protocol types (`CallToolResult`, `ReadResourceResult`, `GetPromptResult`, `Content`, `ToolAnnotations`, `Prompt`, …).
- **Ecosystem context:** several third-party stacks (`pmcp`, `mcpkit`, `rust-mcp-core`, `agentkit-mcp`) build on or parallel `rmcp` and re-export its types — indicating `rmcp` is the de-facto protocol-type source for Rust.

> Evaluation method: this is a **bounded desk evaluation** grounded in the current published crate landscape and our own architecture, not a full runnable rewrite. That is deliberate (§4): building a parallel Rust server binary would duplicate ~3.5k lines of TS session logic before yielding a decision.

## 2. Parity assessment (rmcp vs. our current TS server)

| Capability we ship today | rmcp equivalent | Parity |
|---|---|---|
| `tools/list` + `tools/call` with annotations | `ToolAnnotations` + tool registration (macros or manual) | ✅ full |
| `structuredContent` + `outputSchema` | serde-typed `CallToolResult` + JSON Schema | ✅ full (manual schema) |
| `resources` (`computer://…`) | resource handlers | ✅ full |
| `prompts` | prompt handlers | ✅ full |
| server `instructions` at initialize | initialize result fields | ✅ full |
| **stdio** transport | stdio transport | ✅ full |
| **in-process / in-memory** transport (our `connectInProcess`) | not a first-class story for a *foreign-language* host | ⚠️ lost for JS callers |
| cancellation (`AbortSignal`) | tokio `CancellationToken` / dropped futures | ✅ (different idiom) |
| progress notifications | supported | ✅ |
| elicitation (approval UX) | supported in protocol; wiring is manual | ⚠️ re-implement |
| **typed TS client** (`ComputerUseClient`, 64 wrappers) | N/A — Rust client only | ❌ lost |
| policy/audit, focus model, lock/pump, doctor, guide (all TS) | must be **ported to Rust** | ❌ large rewrite |

**Conclusion:** protocol-level parity is achievable. **Product-level parity is not free** — the differentiators that live in TypeScript (typed client, in-process transport, and ~3.5k lines of `session.ts` orchestration) would have to be rewritten or dropped.

## 3. Cost / risk of a rewrite

- **Duplicated language boundary.** The performance-critical layer (mouse/keyboard/windows/AX/screenshot) is **already Rust** via NAPI. rmcp would move the *protocol* layer to Rust too, but the orchestration (policy, focus strategies, lock/pump, tool-guide, doctor, spaces, filesystem, snapshot, OpenAI adapter) is TS and would need a full port — high effort, high regression risk against a suite that is currently **135 green tests**.
- **Loss of the in-process path.** `connectInProcess` lets JS/TS agents embed the server with zero IPC. A Rust binary cannot offer that to JS callers; they would be forced to stdio subprocess.
- **Loss of the typed TS client.** The 64-method `ComputerUseClient` and its discovery helpers are a shipped product surface.
- **Packaging churn.** We already ship prebuilt `.node` binaries per platform; a Rust server binary adds a second native artifact matrix and distribution path.
- **Velocity.** The TypeScript SDK was `1.29.0` when this spike was written; v7.1 now pins the split SDK packages at `2.0.0` and continues to track the official TypeScript implementation directly.

## 4. Benchmarks (expectation, not measured here)

Protocol dispatch is **not** our bottleneck — input synthesis and screenshotting dominate, and those are already native. A Rust protocol layer would shave sub-millisecond JSON-RPC overhead that is invisible next to a `screencapture` or `CGEvent` round-trip. **No material end-user latency win is expected.**

## 5. Decision

**NO-GO** for migrating the server to rmcp in the v7.0 line. Rationale:

1. Protocol parity is available but delivers **no meaningful performance or capability win** (the hot path is already Rust/NAPI).
2. A rewrite would **sacrifice the in-process transport and typed TS client** — real product value — and re-port ~3.5k lines of tested orchestration at high regression risk.
3. This matches the plan's own framing (A1 "evaluate only"; K2 "npm + stdio + Node/TS primary; rmcp research only").

**Keep** the TypeScript/NAPI architecture. Revisit rmcp **only if** a hard requirement emerges for a single self-contained Rust binary with **no Node runtime** (e.g., a constrained embedding target). If that day comes, the bounded next step is:

- A throwaway `spikes/rmcp-parity/` crate exposing **3 tools** (one read, one mutate, one long-running) over stdio.
- Compare wire transcripts (`initialize`, `tools/list`, `tools/call`, `notifications/cancelled`, progress) against this server at a pinned rmcp version.
- Record the exact version, API stability, and packaging implications, then re-decide.

Until then, no production Rust-server work is scheduled.
