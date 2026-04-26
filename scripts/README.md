# Development Scripts

Ad-hoc scripts used during development for debugging, probing macOS internals, and validating features. These are **not** part of the published package or the automated test suite.

## Categories

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
