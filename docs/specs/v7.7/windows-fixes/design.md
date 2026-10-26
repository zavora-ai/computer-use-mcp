# v7.7.0 Windows fixes: design

Status: **draft, awaiting approval**. Requirements: [requirements.md](requirements.md) (approved 2026-10-25).
Last updated 2026-10-25.

**Rule for every section:** Windows only. Each change is either in Windows-only code (`#[cfg(target_os = "windows")]`
native code, `libexec/windows-status-card.ps1`, code already inside `isWindows` branches) or guarded by
`platform === 'win32'`. Shared functions keep their macOS and Linux results byte-identical, and each section names the
test that pins that.

## D1 Status card on by default on Windows (R1)

**`statusCardEnabled`** (`src/session/operator-control.ts`): the unset default becomes
`platform === 'darwin' || (platform === 'win32' && !env.NODE_TEST_CONTEXT)`. `true`/`1` and `false`/`0` keep their
meaning on every platform. The `NODE_TEST_CONTEXT` exception (set by `node --test` in every test file's process) stops
`npm test` on a Windows machine or CI runner from opening a PowerShell card for each test that builds a real session;
an explicit `COMPUTER_USE_STATUS_CARD=true` still wins. macOS keeps its default, including under `node --test`. As on
macOS, the card opens with the session's first desktop action, not at process start (unchanged behaviour).

**Did the card actually appear?** Today `WindowsCardPresenter.start()` returns at once, so `launched` is `true` even
when PowerShell exits at once (no interactive desktop, a service, session 0). With the card on by default that has to
be reported (R1 edge):
- `windows-status-card.ps1`, in its existing `SourceInitialized` handler, writes `windows-card.json`
  (`{ "hwnd": n, "rect": [x, y, w, h] }`) to the card directory once the window exists. A new file name, so nothing that
  reads the Linux card's `card.json` (capture masking) is involved.
- `start()` returns a promise that resolves when `windows-card.json` appears, and rejects when the child exits first
  (`powershell.exe exited with code N before the card appeared`) or fails to spawn, or after 20 s
  (`the card did not appear within 20 s`). `OperatorControl` already records a rejection as `card.error`, and `doctor`
  already turns that into a `warn`.
- Nothing waits on this promise except the presenter bookkeeping: tool calls are never delayed (the existing
  `#ensurePresenter` chain is asynchronous).

**`doctor`** (`src/session/doctor.ts`): when the card is off on Windows, the summary says it was turned off with
`COMPUTER_USE_STATUS_CARD=false` and that unsetting it brings it back. The macOS and Linux summaries are untouched.

**Docs:** README (the "Stay in control" row), AGENTS.md (the card paragraph and the environment table), and
`docs/TESTING-IN-UTM.md` (the Windows VM no longer needs `$env:COMPUTER_USE_STATUS_CARD='true'`) say "on by default on
macOS and Windows, opt-in on Linux". CHANGELOG records D1–D7 in the v7.7.0 section.

## D2 `left_mouse_down` / `left_mouse_up` at their coordinate (R2)

`mouse_button` in the Windows module of `native/src/mouse.rs` sends `MOUSEEVENTF_MOVE | ABSOLUTE` to the coordinate
first, then the button event, as the Windows `click` path already does. `SendInput` ignores `dx`/`dy` without
`MOUSEEVENTF_MOVE`; that is the bug. The button bookkeeping (`AGENT_BUTTONS_HELD`, the emergency release) is unchanged.
No TypeScript change: the handler already passes the coordinate.

## D3 `notification` under Windows PowerShell 5.1 (R3)

The toast script uses `[Type, Assembly, ContentType = WindowsRuntime]`, which only Windows PowerShell 5.1 (.NET
Framework) understands; PowerShell 7 has no WinRT projection. `notification` therefore runs `powershell.exe` (5.1,
present on every Windows install) instead of `getPowerShellExe()`. `run_script` keeps preferring `pwsh`. Verified on
this machine: the unchanged script, run with `powershell.exe`, delivered two toasts, both visible in
`ToastNotificationManager.History`. The result text adds that Focus Assist can hide a delivered toast.

## D4 `registry set` creates the key; readable PowerShell errors (R4)

**Missing key:** the `set` script becomes
`if (-not (Test-Path -LiteralPath $p)) { New-Item -Path $p -Force | Out-Null }; New-ItemProperty -LiteralPath $p ...`,
which creates the key and its missing parents.

**Readable errors:** a helper in `admin-handlers.ts`, `windowsPowerShell(executable, script)`, used by `registry` and
`notification`:
- It wraps the script in `$ErrorActionPreference = 'Stop'; try { … } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
  so failures reach stderr as one plain line, not CLIXML.
- `plainPowerShellError(stderr)`, a fallback for anything that still arrives as `#< CLIXML`, keeps the `<S S="Error">`
  text, decodes `_xHHHH_` escapes and XML entities, and strips ANSI colour codes.
- Errors read `registry <mode> <path> failed: <message>` (for example `Requested registry access is not allowed.` for
  `HKLM:` without elevation).

## D5 `get_active_space` on Windows (R5)

`src/output-schemas.ts` adds `GetActiveSpaceOutputWindows` (`active_space_id: string | null`) and
`outputSchemaFor(name, platform)`. That returns the Windows schema for `get_active_space` on `win32`, and otherwise
exactly the `PRIORITY_OUTPUT_SCHEMAS` entry it returns today. `ToolRegistry.registerAll`, which already knows the
platform, calls it. Audit: `get_active_space` is the only Spaces tool with an output schema. The others return
unschema'd JSON, so nothing else changes.

## D6 Every reported role can be searched for (R6)

In the Windows module of `native/src/accessibility.rs`:
- **One table.** `ROLES: &[(&str, &[UIA_CONTROLTYPE_ID])]` replaces `role_to_control_type`'s match. Its entries are
  `AXGroup → [Group, Pane]`, `AXRadioButton → [RadioButton, TabItem]`, `AXWebArea → [Document]`, and the existing
  one-to-one entries (`AXTextField` and `AXTextArea` both → `[Edit]`, as today). `control_type_to_role` is unchanged,
  so `get_ui_tree` output does not change.
- **Conditions.** `build_condition` makes an `OR` of the role's control types. `AXUnknown` (what `get_ui_tree` reports
  for unmapped types) becomes `NOT(OR(every mapped type))`. A role not in the table now matches nothing; until now it
  matched everything.
- **The role list.** A new export, `uiaRoles()`, returns the table's role names plus `AXUnknown`.

In `src/session/accessibility-handlers.ts`, inside the existing `isWindows` context:
- `find_element`, `click_element` and `set_value` check `role` against `native.uiaRoles()`. So does `fill_form`, for
  each field, as a per-field failure.
- An unknown role returns `errJson({ error: 'unknown_role', role, valid_roles, similar_roles })`. `similar_roles` holds
  the closest three by the handler's existing label-similarity function.
- On macOS, roles are open-ended AX strings; nothing is checked there.

`src/native.ts` declares `uiaRoles?(): string[]`. It is optional, so the macOS and Linux modules need nothing new.

## D7 Windows test hygiene (Q4 → R7)

Each change is a skip that applies only on Windows. No assertion changes for macOS or Linux.
- `test/v7.7-helper-identity.test.mjs`, "a copy of the helper is signed…": skip on `win32` (file mode bits are not
  POSIX there; the helper is macOS only).
- `test/v7.7-linux-card.test.mjs`, "the card script is valid Python": skip on `win32` (`python3` there is the
  Microsoft Store alias, which exits 9009 rather than failing to spawn).
- `test/v7.7-linux-launch.test.mjs`, "discovery reads the XDG directories…": skip on `win32` (`path.join` gives
  backslashes; the function runs on Linux only).
- `scripts/live-windows.mjs`: `createComputerUseServer({ profile: 'full' })`, so the admin and scripting tools it
  exercises exist.

## Error handling summary

| Case | Result |
|---|---|
| Card cannot start (no desktop, PowerShell missing or exits) | Server unaffected; `control_status.card.error` set; `doctor` warns with the reason |
| `left_mouse_down` coordinate off-screen | Existing `#validateCoordinates` refusal, unchanged |
| Toast suppressed by Focus Assist | Success: Windows accepted it; the result notes Focus Assist can hide it |
| `powershell.exe` missing (stripped images) | `notification` error naming `powershell.exe` |
| Registry access denied / bad path | `registry set <path> failed: <message>`, plain text |
| Unknown UIA role on Windows | `unknown_role` with `valid_roles` and `similar_roles` |

## Testing approach

**Unit tests (`node --test`, fake native; new file `test/v7.7-windows-fixes.test.mjs`):**
- D1:
  - `statusCardEnabled({}, 'win32')` is `true`.
  - `{ NODE_TEST_CONTEXT: 'child-v8' }` on `win32` gives `false` unless `COMPUTER_USE_STATUS_CARD=true` is set.
  - The `darwin` and `linux` results are unchanged; their existing assertions stay as they are.
  - `WindowsCardPresenter` with a fake script: it resolves once `windows-card.json` is written, rejects on an early
    exit, and rejects on the timeout.
  - The `doctor` Windows "off" summary.
- D3: the notification call spawns `powershell.exe` even when `getPowerShellExe()` returns `pwsh`.
- D4:
  - The decoded `set` script creates a missing key.
  - `plainPowerShellError` decodes a captured CLIXML sample and passes plain text through.
  - The error text includes mode and path.
- D5:
  - A `win32` server returns a GUID `active_space_id` through `connectInProcess` with no output-schema error.
  - `outputSchemaFor` returns the very same schema object as before for `darwin` and `linux`.
- D6:
  - On `win32`, an unknown role gives `unknown_role` with `valid_roles` and `similar_roles`.
  - The same call on `darwin` reaches the native module unchecked.
- In `test/v7.6.1-status-card.test.mjs`, the one assertion that encodes the old Windows default
  (`statusCardEnabled({}, 'win32') === false`) is updated to `true`.

**Rust unit tests (`cargo test`, which runs on Windows here):**
- D6: every control type `control_type_to_role` maps is in `ROLES[control_type_to_role(ct)]`.
- `AXGroup` includes Pane, and `AXRadioButton` includes TabItem.
- Unknown names are absent from the table.

**Live check on this machine (the disposable WinForms harness from the 7.7.0 check, kept out of the repo):**
- D1: with `COMPUTER_USE_STATUS_CARD` unset, the card window appears top-right, topmost, with display affinity `0x11`,
  and `doctor` passes.
- D2: a press at A with the cursor parked at B lands at A, and down/move/up makes a drag.
- D3: a toast appears in `ToastNotificationManager.History`.
- D4: `set` on a new `HKCU` key, then `get` and `delete`. `HKLM` gives a plain-text error.
- D5: `get_active_space` returns the GUID.
- D6: `find_element` with `AXGroup` finds the harness panel, and `AXRadioButton` finds a tab item (the harness gains a
  `TabControl`).
- Then the full 7.7.0 live run again (83 checks), to confirm there are no regressions.

**Whole suite:** `npm test` on Windows is green apart from tests that skip for platform reasons, and `cargo test`
passes.
