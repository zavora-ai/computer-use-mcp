# Development Scripts

Development and operator scripts for debugging, platform probing, and validating features. Only the explicitly listed v8 operator scripts are published; ad-hoc experiments are not part of the package or automated test suite.

## Categories

### Published v8 operator verification

- `certify-background-adapter.mjs` — run the host-only reversible Finder or PowerShell capability probe and persist a private certification trace (`npm run certify:background -- finder|powershell`).
- `certify-semantic-adapter.mjs` — certify one exact existing AX/UIA text target without using the focus-enforcing legacy handler (`npm run certify:semantic -- --app-id=... --window-id=... --role=AXTextArea --label=...`).
- `verify-input-attribution.mjs` — verify synthetic input exclusion plus native emergency latch/block/reset; `--interactive` additionally measures a physical event (`npm run test:input-attribution`).
- `probes/v8-emergency-chord.mjs` — present-operator live reliability probe for the physical global chord with no MCP transport attached, a blocking native observer, monotonic hook latency, post-latch mutation rejection, and trusted-host reset (`COMPUTER_USE_LIVE_EMERGENCY_PROBE=true npm run reliability:emergency-chord`).
- `generate-v8-conformance.mjs` — run scoped policy, multi-agent, and supervisor suites, validate live traces, and emit a digest-bearing report (`npm run conformance:v8`). Missing platform evidence remains partial or unassessed.
- `run-v8-reliability-lab.mjs` — execute the public platform matrix and emit evidence-separated metrics (`npm run reliability:v8`). Interactive live probes are opt-in modules; headless runs stay deterministic.
- `generate-release-artifacts.mjs` — validate platform-package linkage and native Mach-O/PE/ELF headers, then emit a deterministic size/SHA-256 manifest (`npm run release:manifest -- --allow-missing` locally; release CI requires every target and verifies copied bytes).
- `evaluate-v8-readiness.mjs` — evaluate immutable developer-preview/beta/stable gates from conformance, reliability, artifact, and trusted signed external evidence (`npm run readiness:v8` reports; `npm run readiness:gate` exits non-zero on no-go).

### Smoke / E2E tests (manual)
- `test-v5-smoke.mjs` — quick post-build smoke test (read-only, <1s)
- `test-v5-e2e.mjs` — full v5 feature walkthrough against real TextEdit
- `test-v5-spaces.mjs` — Spaces surface verification

### Mission Control / Spaces experiments
- `test-space-create.mjs` — gesture-based Space creation via MC
- `test-space-gesture.mjs` — refined gesture approach with coordinate probing
- `test-space-diag.mjs` / `test-space-diag2.mjs` — diagnostic screenshots during MC interaction
- `test-space-open.mjs` — verify which Space a new window lands in
- `test-mc-ax.mjs` — inspect MC's accessibility tree via Dock
- `test-mc-reveal.mjs` — probe "+" button reveal by hovering
- `test-mc-screenshot.mjs` — screenshot MC at various hover positions
- `test-mc-strip.mjs` — scan the Space strip at the top of MC
- `test-ax-approach.mjs` — accessibility-first Space creation strategies
- `test-plus-from-below.mjs` — approach "+" button from below to avoid NC hot zone
- `capture-plus-coords.mjs` / `capture-plus-v2.mjs` — interactive cursor capture for "+" button

### Misc
- `test-return.mjs` — tiny JS async behavior test (not project-specific)
