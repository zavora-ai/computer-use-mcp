# v7.6 honest actions: requirements

Status: **approved by James 2026-10-09 ("approved, build and test"); R0 and R7 built the same day, R1 to R6 next.** From the review
[`docs/reviews/2026-10-09-desktop-control-review.md`](../../reviews/2026-10-09-desktop-control-review.md) §3, §5 and §8.
Design and tasks follow approval. The 7.5.1 fixes (R0) can ship first on their own.

## Context

- The server returns `ok` for actions whose effect it cannot know, and sometimes for actions that did nothing
  (`open_application ... activated: false`, `hide_app` "App not found"). Every computer-use tracker in the ecosystem is
  full of "green check, nothing happened"; cua's `effect`/`route`/`delivery` contract is the model users praise.
- Pixel clicks are not tied to the screenshot they were chosen from, and element refs can go stale between snapshots.
- The only synchronisation primitive is `wait_for_window`. Agents poll with `wait` and screenshots.
- `tools/list` costs about 27k tokens for 73 tools; a screenshot costs 1,000 to 1,800 tokens and an unchanged frame is
  re-sent in full.
- Four defects found in the review need fixing before any of this (R0).
- Users: Claude Code sessions in the games workspace (macOS, Node 25), and the server's npm users on all three platforms.

## User stories and acceptance criteria

### R0 Fix what is broken (7.5.1)
- **When** the server starts with `node_modules/` or the native addon missing, **then** it exits with one stderr line that
  names the file and the command that fixes it (`npm ci`, `npm run build:native`), and `doctor` (when it can run) reports
  the same under `install`.
- **When** the first guarded input call of a server process happens within `COMPUTER_USE_USER_IDLE_MS` of process start
  with no physical input, **then** it is allowed. The physical-input clock is seeded at install from the system's HID
  idle counter, not from "now". Unit test with a fake native; the macOS smoke test in CI passes.
- `process_kill` refuses `pid < 2`, resolves `name` to pids and refuses when more than one process matches unless
  `all: true`; `pkill` is called with `-x`.
- `hold_key.duration` is capped (default max 10 s) and the hold no longer blocks the event loop (chunked or off-thread,
  cancellable by the host's abort signal).
- Start-up tolerates empty or non-numeric environment values (defaults apply and `doctor` warns), uses the realpath
  entrypoint check, and logs unhandled rejections to stderr instead of dying silently. `build:ts` builds to a temporary
  directory and renames, so a server starting mid-build still finds `dist/`.
- `prepare_display` state is per dispatch and runs only for mutating tools; `hide_app`, `unhide_app` and the
  `click_element` coordinate fallback go through the user-active guard.
- The Swift helper compiles without the first caller's abort signal.
- PR #34 is landed (named permission refusals, `.output()` for capture children, overlay anchor) and extended to the
  pid-delivery and `typeKeys` paths.
- Tagged and published; CI runs the unit suite on Node 22 and 25 as well as 20; the `package` job asserts the v7.5 files;
  the publish job skips cleanly when the version is already on npm.

### R1 Every action says what it did
As the agent, I want each action result to state how the input was delivered and what changed, so I never read a success
that was a no-op.
- Every mutating tool result carries `delivery` (`hid` | `pid` | `ax` | `script` | `app-bridge`), `route` (the window or
  element it went to), and `effect` (`changed` | `unchanged` | `unverifiable`), plus `verification` (`capture-diff` |
  `ax-readback` | `none`).
- **When** a tool can observe that nothing changed (window list, capture diff, AX read-back), **then** `effect` is
  `unchanged` and `isError` is true with a typed `reason` (`no_effect`, `not_delivered`, `permission_denied`,
  `user_active`, `target_gone`, `stale_ref`, `stale_capture`).
- `open_application` with `activated: false`, `hide_app` with no app, `click_element` whose element vanished, and
  `select_menu_item` whose menu didn't open are errors, not prose.
- Refusals are structured, consistent (`status`, `error`, `hint` naming the fix) and listed in `get_tool_metadata`.

### R2 Clicks are bound to the frame they came from
- `screenshot`, `zoom` and `read_window_text` return a one-use `capture_id` with the image geometry.
- Pixel tools accept `capture_id`; **when** given and the window moved, resized or a newer capture exists, **then** the
  click is refused with `stale_capture` and the current geometry, instead of landing elsewhere.
- Element tools return opaque tokens that encode the producer (snapshot id, pid, window); a token from another snapshot
  or session is refused with `stale_ref`.

### R3 Wait for what you need
- `wait_for_text {target, text, region?, gone?, timeout_ms}` polls OCR (and AX where available) and returns when the text
  appears or disappears, with the match box.
- `wait_for_stable {target, timeout_ms, quiet_ms}` returns when consecutive captures stop changing (a frame diff), with
  the final `capture_id`. It is the sync primitive after a click that triggers loading.
- `left_click` and `click_text` accept `verify: "capture" | "text:<expected>"` and set `effect` from the result.
- There is no blanket post-action sleep.

### R4 Cost
- An unchanged frame returns text (`unchanged`, `capture_id`) and no image when `previous_capture_id` is given.
- `screenshot` and `zoom` accept `display_id` and `full_screen`; the mapping line names the display. `snapshot.display` is
  honoured or removed.
- `format: "path"` writes the PNG to the server's cache directory and returns the path; hosts that can read files (Claude
  Code) use it instead of base64.
- The tool-list diet and the instructions rewrite are specified in R7 (the design pass of 2026-10-09).

### R5 Correctness fixes carried from the review
- The sensitive-value redaction matches role and whole-word labels; "Shipping address" and "Compass" keep their values;
  tests cover the false positives found.
- `resize_window` honours `window_id` on macOS; `scroll`, `left_mouse_down/up` and `multi_*` validate coordinates like
  the click tools.
- The cross-process lock waits up to `wait_ms` (default 2 s) and then returns `locked_by_pid` with a retry hint.
- The OpenAI adapter scales model coordinates to the screenshot it sent.
- `UnknownKeyError` returns the five nearest key names, not the whole map.

### R6 Unattended safety
- `COMPUTER_USE_ALLOWED_APPS` (bundle ids or names): when set, mutating tools on other apps are refused with
  `not_allowed`; when an approval channel is absent and `COMPUTER_USE_REQUIRE_APPROVAL_FOR` names a tool, the tool is
  refused with `no_approver` rather than running.
- A hard-blocked list of key combos (default: Cmd+Q, Cmd+Shift+Q, Ctrl+Alt+Del equivalents, screen-lock chords) that
  `key`, `type mode:"keys"` and `hold_key` refuse unless `COMPUTER_USE_ALLOW_DANGEROUS_KEYS=1`.
- The emergency-stop Escape is consumed (not forwarded) so injected text cannot dismiss a dialog.
- `read_clipboard`, `scrape` and full-screen `screenshot` can be gated by `COMPUTER_USE_REQUIRE_APPROVAL_FOR`;
  `scrape` refuses private and link-local addresses unless allowed and caps the body.

### R7 The tool surface (the design pass, [review](../../reviews/2026-10-09-design-second-pass.md))
As the agent, I want the smallest list that does the desktop job on this platform, with stable names and one clear
sentence per tool and parameter, so the list costs little in hosts that load it and searches well in hosts that defer it.
- **Default profile `desktop`** = core plus `read_window_text`, `click_text`, `wait_for_window`, `wait_for_text`,
  `wait_for_stable`, `agent_pointer`. `COMPUTER_USE_PROFILE` keeps selecting `core`, `ax`, `scripting`, `windows-admin`
  or `full`.
- **Platform filtering:** the catalog gains `platforms`; a tool not for the running platform is neither listed nor
  callable. Spaces tools are listed only where supported.
- **Shared parameters:** `target_app`, `target_window_id`, `target_title`, `focus_strategy`, `force` and `delivery`
  are described in one sentence each; the guidance lives in the instructions and `get_tool_guide`.
- **`approval_token` is not in any schema.** It is accepted in `tools/call` `_meta["computer-use/approval_token"]` and,
  for compatibility, as an undeclared argument. Policy behaviour is unchanged.
- **One `click`** `{coordinate?, button: left|right|middle, count: 1|2|3}` with the existing targeting; `left_click`,
  `right_click`, `middle_click`, `double_click` and `triple_click` stay callable as thin aliases (a line each in the list,
  in every profile that lists `click`, so existing agents keep working).
- **Session target:** `set_target {app | window_id | title}` and `get_target`; input tools may omit targeting when one is
  set; `screenshot` gains `full_screen` and `display_id` (R4).
- **Metadata:** two `_meta` fields per tool by default (`focusRequired`, `mutates`). Built in 7.6.0. Deferred to the next
  release: output schemas only when the client declared `structuredContent`, and a one-line text summary plus
  `structuredContent` instead of the same JSON twice (output schemas still follow `COMPUTER_USE_STRUCTURED_CONTENT`).
- **Payloads:** `read_window_text` returns `screen` rectangles and the window origin once; `get_app_capabilities`
  reports what the accessibility tree contains (`nodes`, `hasControls`) instead of `accessible: true`.
- **Instructions** are generated per platform from the catalog and describe the current release (route order with OCR
  for self-drawn apps, `user_active` and `delivery`, waits, `capture_id`, `effect`); a test asserts they name every tool
  in the default profile and no unregistered tool.
- **Categorisation by job:** the catalog gains `job: observe | act | semantic | script | admin | browser | spaces | meta`;
  `get_tool_guide` and the instructions are organised by job.
- **Budgets, tested on the real transport:** `tools/list` for `desktop` under 48,000 bytes (about 12k tokens) and for
  `full` under 88,000 (about 22k); the unit suite fails when a change exceeds them. Measured on the wire 2026-10-09: before,
  `full` 112,727 bytes; after, `desktop` 45,942 and `full` 84,037.

## Compatibility
- All new fields are additive. Existing `ok` text results keep their text; `isError` changes only where the action
  demonstrably did nothing (R1), which is a behaviour change and goes in the CHANGELOG.
- The default-profile change is a behaviour change for users who relied on `full`; the release note says how to keep it.
- Every v7 tool name stays callable (the click variants as aliases); nothing a published skill calls breaks.

## Out of scope
- The Unreal and Blender bridges (v8).
- Windows multi-monitor and DPI, occlusion-safe Windows capture, native Linux enumeration, the per-platform packages:
  tracked in the native input's top 10 and offered to the contributors who asked.
