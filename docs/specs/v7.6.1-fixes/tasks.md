# v7.6.1: tasks

From [`docs/reviews/2026-10-11-end-to-end-review.md`](../../reviews/2026-10-11-end-to-end-review.md) §7 (the 7.6.1 list) plus
James's 2026-10-11 ask: "fix 7.6.1 items now, starting with full_screen and unhide … also adopt a better status card that is
cross platform". Each task is marked when its change is in the tree **and** its test passes (`npm test`); "tested" names
the test. Nothing here is committed until James says so.

Status: `todo` → `in progress` → `done` (change + test green) → `blocked`/`needs James`.

## A. Correctness (review §3.1, §3.2)

| # | Task | Status | Change | Tested by |
|---|---|---|---|---|
| A1 | F1 `screenshot {full_screen: true}` captures the whole screen even with a session target | done | `screenshot-handlers.ts` reads `full_screen` on both capture paths | v7.6.1-fixes F1 |
| A2 | F3 `unhide_app` callable in the default profile; apps hidden by `prepare_display` restored on session close; recovery skill made true | done | `tool-catalog.ts` (`unhide_app` → core); `focus.ts` tracks and restores; `session.ts` restores on close; recovery skill; doc counts | v7.6.1-fixes F3 |
| A3 | F4 `click_element` coordinate fallback goes through the input handler (guard, validation, target update) | done | `accessibility-handlers.ts` fallback → `InputHandler.clickAt`; `session.ts` passes the handler | session-accessibility-handlers (3 tests) |
| A4 | F5 sensitive-label redaction anchored on words (no more "Shipping address", "Compass", "Pinned tabs"); audit redactor likewise | done | `accessibility-handlers.ts` `SENSITIVE_LABEL` word-bounded; `legacy-policy.ts` token match | v7.6.1-fixes F5 |
| A5 | F2 unknown arguments refused with `invalid_arguments` naming the key and the nearest valid name; compat keys (`approval_token`, alias targeting, `scroll.delta_*`, `left_click_drag.path`, `filesystem.include_digest`) still accepted | done | `registry.ts` unknown-key refusal with `nearestArgumentName`; `definitions.ts` `undeclaredArgs` | v7.6.1-fixes F2 |
| A6 | F8 Windows `get_app_capabilities` reports `accessibility: { nodes, hasControls }` like macOS | done | `accessibility-handlers.ts` Windows branch runs the probe | v7.6.1-fixes F8 |
| A7 | F9 desktop-state resource updates derived from the catalog (`click_text` included) | done | `server.ts` derives `DESKTOP_STATE_MUTATIONS` from the catalog | suite (`click_text` now in the set) |
| A8 | F10 `createSession` defaults to `desktop`; instructions use the registry's platform; stale comment | done | `session.ts` `DEFAULT_PROFILE`; `server.ts` `opts.platform`; comment | v7.6.1-fixes F10 |
| A9 | F11 `screenshot.target_app` description; `scrape` user agent | done | `definitions.ts` description; `admin-handlers.ts` user agent | suite |
| A10 | C1 coordinate validation on `scroll` (HID), `left_mouse_down/up`, `multi_select`, `multi_edit` | done | `input-handlers.ts` `#validateCoordinates` on the four paths | v7.6.1-fixes C1 |
| A11 | C3 Swift helper compiled without the first caller's abort signal | done | `macos-helper.ts` `compileSwiftHelper` (shared with the card), no per-call signal | v7.5-agent-desktop, v7.6-helper-serial (unchanged behaviour) |
| A12 | C4 `open_application` (not activated), `hide_app`/`unhide_app` (no app), `activate_window` (no window) are errors, not prose | done | `window-handlers.ts` `errJson` for the four no-op outcomes | v7.6.1-fixes C4 |
| A13 | Instructions and skill say what results verify today (pid deliveries only) | done | `instructions.ts`; `skills/computer-use/SKILL.md` | v7.6.1-fixes A13, v7.6-tool-surface |

## B. Console host (review §3.5)

| # | Task | Status | Change | Tested by |
|---|---|---|---|---|
| B1 | HS1 Host and Origin validation on every console route; JSON `Content-Type` required on POST; body capped | done | `run-console-host.ts`: validators on every route; `readBody` requires JSON, caps 20 MiB | run-console-host (2 new tests) |
| B2 | HS2 console page accepts `postMessage` only from its own iframe; `frame-ancestors 'none'`; `nosniff` on attachments | done | `run-console-host.ts`: `frame-ancestors`, `nosniff`, `event.source` check | run-console-host |
| B3 | HS6 `run_say` no longer accepts `role: "user"` from the model; the page path records user turns directly | done | `agent-run.ts` drops `role`; the host page path writes user turns through the store | run-console-host, agent-run-console |

## C. Native (review §3.4)

| # | Task | Status | Change | Tested by |
|---|---|---|---|---|
| C1 | N3 macOS `activate_window` polls the frontmost app until the timeout and reports what it saw | done | `windows_macos.rs` polls `frontmost_pid` until the timeout; AXMain result honoured | cargo check; release build; not driven live |
| C2 | N7 Windows `write_clipboard` checks `SetClipboardData`, frees the handle on failure, returns an error | done (untested on Windows) | `clipboard.rs` checks `SetClipboardData`, frees on failure | cargo check --target x86_64-pc-windows-msvc |
| C3 | N8 Windows UIA `perform_action` propagates `Invoke`/`Toggle` failures | done (untested on Windows) | `accessibility.rs` reports `invoke_failed` / `toggle_failed` | cargo check --target x86_64-pc-windows-msvc |

## D. Delivery (review §3.6)

| # | Task | Status | Change | Tested by |
|---|---|---|---|---|
| D1 | T1 `package.json` `files` ships `dist/` as a directory; a test pins it; `docs/releases/v7.3.0.md` added | done | `package.json` `files` → `dist/`; `docs/releases/v7.3.0.md` added | v7.6.1-packaging (2 tests); `npm pack --dry-run` |
| D2 | T2 the stage job skips with a warning when the version is already staged (E409) | done (not runnable locally) | `ci.yml` stage step tolerates E409 "already staged" | reviewed by reading |

## E. The status card (review §6; cross-platform)

| # | Task | Status | Change | Tested by |
|---|---|---|---|---|
| E1 | Operator control state machine in the session: `running` / `paused` / `stopped`; mutations refused with `paused_by_user` / `stopped_by_user`; in-flight calls aborted on pause and stop; Stop latches the native emergency stop when the native module has it | done | `session/operator-control.ts` `OperatorControl`; `session.ts` gate, merged signal, approval and user_active waits, close | v7.6.1-status-card (session test) |
| E2 | `control_status` read-only tool (core) and `doctor` check | done | `control_status` in catalog, definitions, core handler, manifest; `doctor` `status_card` | v7.6.1-status-card; v7.6-tool-surface |
| E3 | Honest card content: state, elapsed, the action with its app and window (never a bucketed verb), approval pending, user-active waiting | done | `describeAction` (tool + key argument + app + window; never typed text) | v7.6.1-status-card |
| E4 | macOS presenter: Swift `NSPanel`, non-activating, excluded from screen capture (`sharingType = .none`), Pause/Resume/Stop, exits when the server dies | done | `libexec/macos-status-card.swift` (NSPanel, `sharingType = .none`, pid watch); `MacosCardPresenter` | compiled with swiftc; shown live through a real session on this Mac (launched in 4 s, paused and resumed through the control file, exited with the session); exits within 2 s of its watched pid dying |
| E5 | Windows presenter: PowerShell WPF from PR #40, with parent-pid watching, `WDA_EXCLUDEFROMCAPTURE`, honest labels, Pause/Resume/Stop | done (untested on Windows) | `libexec/windows-status-card.ps1` (pid watch, `WDA_EXCLUDEFROMCAPTURE`, honest labels); `WindowsCardPresenter` | a direct derivation of PR #40's script, which its author ran; not run here |
| E6 | Wiring: `COMPUTER_USE_STATUS_CARD` (opt-in in 7.6.1; headless under an injected native), presenter spawned on the first desktop action, closed on session close; docs in AGENTS.md and README; CHANGELOG | done | `COMPUTER_USE_STATUS_CARD`; AGENTS.md section and env row; README row; CHANGELOG 7.6.1 | v7.6.1-status-card (opt-in test) |

## G. Added on 2026-10-11 afternoon (James: "lets do an integration test here", "create an agent example using adk-anthropic")

| # | Task | Status | Change | Tested by |
|---|---|---|---|---|
| G1 | Live integration test on this Mac: real native, the card, Calculator by accessibility, Pause/Resume/Stop as a person's clicks, screenshot exclusion, the latch, no orphans | done (25/25 on this Mac) | `scripts/integration-status-card.mjs` (`npm run integration:macos`); the card now publishes `card.json` with its geometry so the test can find its buttons | run on this Mac; see the record below |
| G2 | ADK-Rust + Claude agent example with the status card on | done (`cargo check` clean; run once) | `agents/adk-anthropic-agent/` (Cargo project on the local adk-rust checkout, `adk-model` `anthropic` feature) | `cargo check` (52 s); one live run against this build (`COMPUTER_USE_MCP_BIN`) with the read-only default task: server started, 5 tool calls, honest report; found that adk-model's Anthropic converter stringifies tool results so screenshot images never reach Claude (noted in the example README; an adk-rust fix) |

## H. The GitHub issues, re-checked against this tree (2026-10-11)

| Issue | Still valid? | Evidence | Done here |
|---|---|---|---|
| #36 per-platform packages (open, 10-08, no reply) | **Yes.** All six names still 404; nothing builds or publishes them; the resolver's step 2 honours one when installed (`src/native.ts:72-80`), and `test/platform-packages.test.mjs:37-40` pins the root at no `optionalDependencies` on them | `npm view` on 10-11 | The "binary missing" error no longer tells users to install them (it names the universal tarball, a checkout build, or `COMPUTER_USE_NATIVE_PATH`). The publish workflow is the real fix: accept the reporter's PR offer |
| #32 Windows overlay deadlock (open, awaiting the reporter) | **Unconfirmed, probably fixed.** The cross-thread `SetWindowPos`/`ShowWindow` calls are gone (`overlay.rs:539-578`, posted to the owning thread, `READY` gated); residual: `hwnd()` still polls up to 750 ms on the napi thread (`overlay.rs:485-505`); no Windows hardware here | code | Nothing; the 7.6.1 Windows status card does not use the native overlay, so it cannot hit this path |
| #21 Linux empty `get_ui_tree` (open, filed on 7.1.0) | **Changed since it was filed; likely resolved, unverified.** 7.1 had a native stub that returned bare `AXWindow` nodes; since 7.2 Linux accessibility goes through `libexec/linux-atspi.py` (`src/session/linux-atspi.ts`), which walks the real AT-SPI tree. Two things could still bite the reporter: a missing `wmctrl` is hidden as an empty window list (`windows.rs:66-69`, review N table), and the bridge found the frame by exact title only and answered a miss with prose | code | The bridge now finds the frame by PID, then exact title, then case-insensitive substring, then the only frame; a miss returns `atspi_window_not_found` (toolkit accessibility off) or `atspi_window_ambiguous` with the frames AT-SPI exposes and the remediation. Ask the reporter to retest on 7.6.1 |
| #20 `zoom` `cropImage is not a function` (closed 09-12) | **Fixed.** A missing native export returns `platform_unsupported` with the alternative | `screenshot-handlers.ts:307-314` | |
| #19 `run_script` bash on Linux (closed 09-12) | **Fixed.** Language-first dispatch; `bash` runs on macOS and Linux and is refused on Windows with the alternative | `scripting-service.ts:81-145` | |
| #2 Linux support (closed 05-19) | **Closed correctly, with the caveat the review records:** Linux works on X11 through shell-outs whose absence is hidden; the review's N table and T15 list the next Linux fixes | review §3.4 | |
| PR #40 (open) | See §5 of the review and the draft comment below | | |

## F. Outward-facing (needs James)

| # | Task | Status | Draft |
|---|---|---|---|
| F1 | Reply to issue #36 (per-platform packages) | done | posted 2026-10-11: https://github.com/zavora-ai/computer-use-mcp/issues/36#issuecomment-6113242533 |
| F2 | Reply to issue #21 (Linux AT-SPI) | done | posted 2026-10-11: https://github.com/zavora-ai/computer-use-mcp/issues/21#issuecomment-6113242751 |
| F3 | Review comment on PR #40 | done | posted 2026-10-11 on #40, pointing at #41 and asking for a Windows run; closing #40 is the contributor's and James's call |
| F4 | Commit and PR for 7.6.1 | done | branch `release/v7.6.1`, commit e76d350, https://github.com/zavora-ai/computer-use-mcp/pull/41; version bumped to 7.6.1, release note `docs/releases/v7.6.1.md` |

## Drafts

_Filled in as the work lands._

---

**Final verification (2026-10-11):** `npm run build:ts && node --test test/*.test.mjs`: 560 tests, 559 pass, 0 fail, 1 skipped (the opt-in browser integration); `npm run lint` clean; `cargo check` clean for aarch64-apple-darwin and x86_64-pc-windows-msvc; macOS native module rebuilt. Not run here: anything on Windows or Linux (C2, C3, E5, D2 are reviewed by reading).

**Integration record (2026-10-11, this Mac):** `node scripts/integration-status-card.mjs` → 25/25. Of note: the first run
failed on every desktop step because James was typing his next message and the user-active guard refused to take focus
(correct); the test now waits for the keyboard to go quiet. Calculator's accessibility values carry U+200E marks around
each glyph ("‎3"), which the test strips; OCR read the large result glyph as "9", so the accessibility value is the
check that counts.

**CI on #41 (2026-10-12):** the Windows test jobs failed on the new packaging test (a `file:` URL pathname is not a Windows path; fixed with `fileURLToPath`), and the Linux test jobs failed in the input smoke step: `multi_select` now validates coordinates, which asks the display size, and the runner had no X server (review T6: the smoke used to pass by doing nothing). The Linux job now runs that step under Xvfb with the X11 tools installed.

**Release (2026-10-12):** #41 merged as 06a14bd (squash, co-authored by ShakeCrane). A stray `libexec/__pycache__/*.pyc`
from a local syntax check rode in with the merge; #42 (3860ca4) removed it and ignores `__pycache__/`. The tag `v7.6.1` and
the GitHub release were then re-cut on 3860ca4, so the tag, the release and the tarball share a commit. The `main` run on
3860ca4 passed every job and staged `@zavora-ai/computer-use-mcp@7.6.1` (tag `latest`, 182 files, 5.5 MB, shasum
`25b9e231c9f3b968943790d1247bbcf7edb81315`, stage id `9fcd12b1-a7ed-4464-b623-3a5b7d047de9`) for James's approval on
npmjs.com. Still open after the release: #40 (ShakeCrane's Windows validation, then close), #36 (the publish workflow for
the per-platform packages), and the adk-rust Anthropic converter gap noted in the agent example.
