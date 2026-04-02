# Changelog

## v3.0.0 (2026-04-02)

### Features
- **Multi-provider screenshot sizing** — `provider` param on `screenshot` tool sets optimal width/quality per AI provider. Supported: `anthropic` (1024px), `openai` (1024px), `openai-low` (512px), `gemini` (768px), `llama` (1120px), `grok` (1024px), `mistral` (1024px), `qwen` (896px), `nova` (1024px), `deepseek-vl` (896px), `phi` (896px)
- **JPEG quality control** — `quality` param (1–100) on `screenshot` tool, passed through to `sips --setProperty formatOptions`. Default: 80
- **Non-vision model guard** — `COMPUTER_USE_VISION=false` env var (or `createComputerUseServer({ vision: false })`) makes `screenshot` return text metadata instead of image data, enabling text-only models (DeepSeek-V3, R1, etc.)
- **Server-wide provider default** — `COMPUTER_USE_PROVIDER` env var or `createComputerUseServer({ provider: 'gemini' })` sets the default for all screenshot calls
- **Screenshot deduplication** — consecutive identical screenshots return cached result without re-capturing
- **Animated drag** — ease-out-cubic at 60fps, distance-proportional duration (max 500ms). Fixes drag in canvas, scrollbar, and window-resize scenarios

### Reliability fixes
- **Move-and-settle before clicks** — all click operations now move the cursor first, wait 50ms for HID round-trip, then click. Fixes missed clicks on fast-rendering UIs
- **Clipboard-based typing** — text longer than 100 characters is typed via clipboard paste (save → write → verify → paste → restore) instead of CGEvent injection. Fixes long text in Electron apps, web inputs, and terminals

### Breaking changes
- `createComputerUseServer()` now accepts optional `ServerOptions` — backward compatible (no required params)
- Version bumped to 3.0.0

All notable changes to this project will be documented in this file.

## [2.0.4] - 2026-04-02

### Fixed
- `client.screenshot()` now accepts `width` and `target_app` parameters — previously they were silently dropped, causing full-screen captures even when a specific app window was requested.

## [2.0.3] - 2026-04-02

### Fixed
- Server entrypoint guard now matches the bin symlink path (`computer-use-mcp`), fixing MCP handshake timeout when running via global install.

## [2.0.2] - 2026-04-02

### Fixed
- Added `--prefer-offline` to npx invocation in README and mcp.json config to skip registry check on startup, preventing MCP handshake timeout on cached installs.

## [2.0.1] - 2026-04-02

### Added
- `screenshot` tool: `width` parameter — resizes output to specified pixel width using `sips`. Default: 1024px (reduces context size ~5× vs full resolution).
- `screenshot` tool: `target_app` parameter — captures only the target app's window using `screencapture -l <windowID>` instead of the full screen.
- TypeScript client `screenshot()` method updated to accept `{ width?, target_app? }`.

## [2.0.0] - 2026-04-01

### Added
- Initial public release with 24 tools: screenshot, mouse, keyboard, clipboard, app management, display info, and wait.
- Rust NAPI native module for in-process macOS API calls (no subprocess round-trips, no focus stealing).
- Full MCP server over stdio.
- Typed TypeScript client with in-process and stdio transport modes.
- Security hardening: two-layer input validation, no shell injection, temp file O_EXCL, bounded waits.
