# Changelog

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
