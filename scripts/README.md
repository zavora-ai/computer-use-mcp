# Development scripts

Run from the repository root after installing dependencies. Live desktop scripts
need a native build and OS permissions. They are not unattended unit tests.

| Command | Purpose |
|---|---|
| `npm test` | Build TypeScript and run the automated regression suite. |
| `npm run smoke` | Check native display/window access and application discovery without injecting input. |
| `npm run test:browser` | Exercise the isolated browser on a disposable local fixture. |
| `node scripts/test-office.mjs` | Create and verify scratch Word, Excel and PowerPoint files on macOS. |
| `npm run test:input-attribution` | Measure physical-input detection on a supported desktop. |
| `npm run measure:efficiency` | Compare catalog and observation payload sizes. |
| `npm run evaluate:strategy -- baseline.json candidate.json` | Compare matched, independently verified task traces. |
| `npm run prepare:packages` | Synchronize native versions and optional pins, and copy available native binaries. |
| `npm run pack:platforms` | Require all six build artifacts and pack verified native tarballs. |
| `node test/platform-install.mjs` | Install packed native dependencies using a disposable local registry and load the addon. |
| `node scripts/verify-local-native.mjs` | Verify that source execution resolves and loads the current host build artifact; use a process-scoped `COMPUTER_USE_NATIVE_PATH`. |
| `node scripts/utm-vms.mjs up\|status\|down` | On a Mac, tunnel to the server running in UTM Windows and Linux VMs and register it with Claude Code; see [Testing in UTM virtual machines](../docs/TESTING-IN-UTM.md). |
| `ANTHROPIC_API_KEY=… node scripts/bench-live-latency.mjs <shot.jpg> [runs] [out.json]` | Live share: time to first token, speed and cost of the triage and act models on one screenshot behind a cached prompt (spends a few cents). |
| `node scripts/linux-check.mjs [--takeover] [--skip-input]` | The live Linux check: windows, capture, activation, input and read-back on the desktop it runs on; see [Testing on Linux](../docs/TESTING-LINUX.md). |
| `bash scripts/ci-linux-desktop.sh xfwm4\|openbox\|sway` | Run that check on an invisible desktop (Xvfb with xfwm4 or Openbox, or headless sway) with its own display, runtime directory and D-Bus bus, as the `linux-desktops` CI job does for Openbox and sway (xfwm4 is out of CI until its hang on Xvfb is understood). |

`build-ts.mjs` compiles TypeScript into `dist.next` and swaps it into `dist`, so a server starting mid-build still finds its files (`clean-dist.mjs` only removes generated output). `live-windows.mjs` is
an attended Windows development probe. Legacy Mission Control/Spaces experiments
and obsolete v3–v5 scripts were removed in v7.2; their history remains in Git.
Only `verify-input-attribution.mjs` is included as a script in the npm package.

See [Native package releases](../docs/NATIVE-PACKAGES.md) for version synchronization,
CI artifacts, first-publication setup and maintainer approval order.

## `npm run integration:macos`

`scripts/integration-status-card.mjs`: a live integration test on a macOS desktop (7.6.1). It starts the real server
in-process with `COMPUTER_USE_STATUS_CARD=true`, opens Calculator, computes 1 + 2 by accessibility, verifies the result
(accessibility and OCR), presses the status card's Pause, Resume and Stop as a person would (raw native clicks, not tool
calls), checks that the card never appears in the agent's screenshots, that Stop trips the native emergency-stop latch,
and that nothing is left on screen after the session closes. It waits for you to stop typing (the user-active guard
refuses to take focus within 4 s of physical input), so keep your hands off for a minute. Nothing is written outside a
temp directory; Calculator is quit at the end.
