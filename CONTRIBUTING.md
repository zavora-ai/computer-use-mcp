# Contributing to computer-use-mcp

Thank you for your interest in contributing!

## Getting started

### macOS
```bash
git clone https://github.com/zavora-ai/computer-use-mcp
cd computer-use-mcp
npm install
npm run build
npm run demo  # verify everything works
```

### Windows
```bash
git clone https://github.com/zavora-ai/computer-use-mcp
cd computer-use-mcp
npm install
npm run build:native:win   # builds Rust native module
npm run build:ts            # compiles TypeScript
node test/smoke-windows.mjs # verify everything works
```

**Windows prerequisites:**
- [Rust](https://rustup.rs) (stable, 1.70+) with MSVC toolchain
- [Node.js](https://nodejs.org) 18+
- Visual Studio Build Tools (C++ workload) or Visual Studio with C++ support
- Windows SDK (included with VS Build Tools)

## Project structure

```
src/              Core library (server, session, client, native loader)
native/src/       Rust NAPI module — each file has #[cfg(target_os)] for macOS + Windows
  mouse.rs        CGEvent (macOS) / SendInput (Windows)
  keyboard.rs     CGEvent (macOS) / SendInput+KEYEVENTF_UNICODE (Windows)
  screenshot.rs   screencapture (macOS) / DXGI Desktop Duplication (Windows)
  clipboard.rs    Windows-only native clipboard (macOS uses pbcopy/pbpaste in session)
  windows.rs      CGWindowList (macOS) / EnumWindows (Windows)
  apps.rs         NSWorkspace (macOS) / EnumWindows+Process (Windows)
  accessibility.rs AXUIElement (macOS) / IUIAutomation COM (Windows)
  display.rs      CGDisplay (macOS) / EnumDisplayMonitors (Windows)
  spaces.rs       CGS private (macOS) / Registry VirtualDesktopIDs (Windows)
test/             Automated test suite (node:test + fast-check property tests)
examples/         Runnable demos
scripts/          Ad-hoc development scripts
docs/specs/       Historical design specs
dist/             Compiled TypeScript output (generated, not committed)
```

## Cross-platform conventions

- Rust files use `#[cfg(target_os = "macos")]` and `#[cfg(target_os = "windows")]` modules
- Some files use `#[path = "filename_macos.rs"]` to keep macOS code in separate files
- NAPI function signatures are identical on both platforms
- TypeScript uses `IS_WINDOWS` / `IS_MACOS` constants for platform branching
- `bundle_id` means macOS bundle ID or Windows process name — the session layer normalizes transparently

## Making changes

### TypeScript changes
Edit files in `src/`, then:
```bash
npm run build:ts
npm test
```

### Rust changes
Edit files in `native/src/`, then:
```bash
npm run build:native
npm test
```

### Full rebuild
```bash
npm run build
```

## Code standards

- **Rust**: run `cargo fmt` and `cargo clippy` before committing — both must be clean
- **TypeScript**: `strict: true` is enforced — no `any` except where unavoidable
- All tool inputs must be validated in `session.ts` before reaching native code
- New tools must be registered in `server.ts`, dispatched in `session.ts`, and typed in `client.ts`

## Testing

Run the automated test suite:

```bash
npm test
```

This builds TypeScript and runs all tests in `test/`. The suite includes property-based tests (via fast-check) covering session semantics, focus strategies, target resolution, and tool schemas.

For a quick post-build smoke test against live macOS:

```bash
npm run smoke
```

For interactive verification with real apps:

```bash
npm run demo                          # Calculator demo
npx tsx examples/browser-test.ts      # Safari navigation
npx tsx examples/demo-v4.ts           # Window targeting
```

## Pull requests

- Keep PRs focused — one feature or fix per PR
- Update the README if you add or change a tool
- Run `npm test` and confirm all tests pass
- Bump the version in `package.json` following semver if you change public API

## Reporting bugs

Open a GitHub issue with:
1. macOS version (`sw_vers`)
2. Node.js version (`node --version`)
3. The exact error message
4. Steps to reproduce

## License

By contributing, you agree your contributions will be licensed under the MIT License.
