# v8 cross-runtime contracts

These fixtures freeze the additive v8 developer-preview boundary shared by the TypeScript runtime, MCP facade, supervisor clients, and ADK-Rust adapter.

Rules:

- Wire payloads use camelCase; MCP tool arguments use the snake_case schemas advertised by the server.
- IDs are opaque strings. A retry reuses `sessionId`, `actionId`, and `actionDigest`.
- `indeterminate` is terminal for automatic execution and routes to fresh observation plus review.
- `action-postcondition.schema.json` defines optional digest-only expected state. It is included in `actionDigest`, must bind to the action target/resource, and is independently read back after mutation. Supported UI value/form, filesystem, registry, and PID-kill operations derive strict postconditions automatically even when the caller omits one.
- `target-sensitivity.schema.json` defines value-free native AX/UIA sensitivity evidence. Protected values are nulled before the accessibility tool boundary; semantic mutations require a conclusive assessment, bind it into action identity, and revalidate it immediately before effect.
- Image blocks remain image blocks. Adapters must not replace bytes with text placeholders.
- `principalId` comes from authenticated host context, never model-produced arguments.
- Session deletion is terminal-state-only and principal-bound. Retention rewrites are represented by an opaque marker, never by retained private payload bytes.
- Follow-up instructions are principal/session-bound and monotonic. Their text is memory-only in the TypeScript runtime; supervisor/audit events disclose only digest and length metadata.
- Capability certification is a trusted host/operator workflow, not an agent-callable mutation. A usable certification is bound to the exact adapter, installed app version, low-level tool, canonical action contract, instance-authority `bindingDigest`, live probe, expiry, and trace digest.
- `capability-certification-trace.schema.json` is the public, redacted trace boundary. Arbitrary adapter evidence is discarded; a stored trace alone never grants authority because the runtime must also restore the matching trusted adapter predicate and re-read the live app version.
- `evidence-frame.schema.json` defines the opt-in PiP visual-review boundary. Pixels are target-scoped, process-memory-only, size/count/TTL bounded, and returned only over an authenticated local session subscription; events and journals contain metadata only.
- Conformance reports use `conformance-evidence.schema.json` and `conformance-report.schema.json`. Badge status is derived from explicit assertion IDs. Live platform coverage is derived only from digest-valid certification traces; deterministic or integration tests cannot impersonate live platform proof.
- `browser-page-evidence.schema.json` freezes the host-supplied DOM/CDP evidence boundary. The runtime binds bridge/page identity, URL digest, DOM revision, viewport, observation freshness, domain policy, and postcondition evidence; browser URLs are digest-only in model-visible execution results.
- `setup-command.schema.json` and `setup-view-model.schema.json` define the shared terminal/Electron/Tauri setup boundary. Renderer-visible views intentionally contain counts and capability facts, never principal IDs, window IDs, filesystem paths, app IDs, environment values, screenshots, or accessibility content.
- `reliability-lab-corpus.json` plus its corpus/report schemas define the public cross-platform lab matrix and metric format. Deterministic, integration, and live evidence remain separate; live-only rows cannot pass in a non-interactive environment, and every blocked or unrun cell remains in the report.
- `release-artifact-manifest.schema.json` binds every native target filename, platform package/version, executable format, byte length, and SHA-256 digest to one root release. CI verifies copied and already-published optional-package bytes before the main package can publish.
- `release-evidence.schema.json` and `release-readiness-report.schema.json` define trusted external evidence and the non-waivable v8 stage decision. Hardware, ADK, CI, signing, and review statements are Ed25519-signed against host-configured trusted keys, version-bound, expiring, and artifact-digest-bound. A self-attested conformance JSON cannot independently earn a beta or stable decision.
- `adk-evaluation-receipt.schema.json` is shared with `adk-computer-use`. Its canonical receipt binds the exact graph/auth/eval/MCP multimodal sources and test output, including separate pre-effect and post-commit crash points. Readiness requires a trusted `adk_graph` signature over that receipt digest; the receipt alone remains self-attested.
- Optional fields may be added compatibly. Removing or retyping a field requires a schema-version change.
- `safety-corpus.json` is executable, sanitized test data for the deterministic fake desktop. It must remain image-free and secret-free so every platform and downstream runtime can replay it in CI.
