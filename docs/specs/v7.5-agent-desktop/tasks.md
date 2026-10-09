# v7.5 "agent desktop": tasks

Status: **pre-approved by James 2026-10-01; implemented on `feat/v7.5-agent-desktop` (`b97de7e`, PR #35)**. Implements [design.md](design.md) and [requirements.md](requirements.md).
Work on branch `feat/v7.5-agent-desktop`. Commits as the user (existing git identity, no AI co-author trailer), only after
the user confirms; then a PR with `gh`.

- [x] **1. Window choice and kinds.** Rust selection fix + `target_title`; kinds in `list_windows`; unit tests. (§1; R1)
  Done: `main_window_for_pid` in `native/src/screenshot.rs`; the shared scoring/kinds live in TypeScript
  (`src/session/window-select.ts`) so they are testable and cross-platform; `get_window_ax_info` (napi) feeds AX
  subroles; `screenshot` resolves `target_app`/`target_title` in TS and hands native a window id.
  `test/v7.5-window-select.test.mjs` (9 tests). Deviation: `target_title` is a TS argument, not a native one.
- [x] **2. Keys.** Key map additions, `type mode:"keys"`; tests. (§5; R6)
  Done: aliases and the valid-name error in `src/session/keys.ts` (all platforms); macOS native map + `typeKeys`
  (UCKeyTranslate table, US-ANSI fallback); TS fallback through `keyPress` elsewhere. `test/v7.5-keys.test.mjs` (10).
  Deviation: aliases resolve in TypeScript rather than in each native map; one existing test now expects `page_down` →
  `pagedown` and `period` → `.` (names the native maps never knew).
- [x] **3. Swift helper.** Compile-on-first-use, `capture`, `ocr`; TS wrapper. (§2; R2, R3)
  Done: `libexec/macos-agent-helper.swift` (capture/ocr/version), `src/session/macos-helper.ts` (sha-named cache,
  ad hoc signing, atomic install, 10-minute failure back-off). Compiles in ~3–5 s on the M4. Additions: `scalesToFit`
  (found live), 2x OCR capture, `--min-scale`.
- [x] **4. Tools.** `read_window_text`, `click_text`, SCK capture path for `screenshot`/`zoom`; catalog, schemas, profiles,
  tool guide. (§2; R2, R3)
  Done: `src/session/agent-desktop-handlers.ts`; `ScreenshotHandler.handleAsync` (SCK window screenshots with an exact
  mapping, window-relative `zoom`), `snapshot` target; catalog (core tier), definitions, `mcp-server.toml`, tool guide
  entries; `doctor` checks `agent_helper`/`user_active_guard`/`pid_delivery`. 73 tools.
- [x] **5. User-active guard.** (§3; R4)
  Done: `src/session/user-activity.ts`, wired into input routing, `focus.ensure` and the activation tools; `force`
  argument; `StructuredToolError` → structured `user_active` result. Verified live (§6).
- [x] **6. Pid delivery + spike.** (§4; R5) Record results in design §6.
  Done: native `*ToPid` functions, `delivery` argument, `auto` routing, capture-verified per-app/per-class records
  (`src/session/pid-delivery.ts`). TextEdit spike recorded in §6 (keys reach a background app; menu shortcuts and clicks
  into its text view don't). Unreal/Blender spike **pending — needs the editor owner** (steps in §6).
- [x] **7. `wait_for_window`.** (§5; R7)
  Done: in `agent-desktop-handlers.ts`, 250 ms polls over `listClassifiedWindows`, cancellation, timeout; verified live.
- [x] **8. Verify and ship.** `npm run build` (native + ts), `npm test`, live checks; CHANGELOG, README tool count, release
  notes `docs/releases/v7.5.0.md`; bump version; record fixed bugs in `games/ROADMAP.md`.
  Done: `npm run build:native` + `npm test` → 490 tests, 489 pass, 1 skipped (baseline 451/450/1); `eslint src` clean;
  `cargo clippy` adds no warnings; `cargo check --target x86_64-pc-windows-msvc` passes. Live checks in design §6.
  Version 7.5.0 in package.json, package-lock.json, packages/*, mcp-server.toml, server.ts, mcp-tasks.ts (and the tests
  that assert it); README 73 tools; AGENTS.md section + `COMPUTER_USE_USER_IDLE_MS`; three bugs ticked in
  `games/ROADMAP.md`. Not committed: waiting for James. Open: the Unreal/Blender pid spike (§6).
