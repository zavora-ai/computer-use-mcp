# v7.7.0 Windows fixes: requirements

Status: **approved by James 2026-10-25**, with the proposed answers to Q1–Q6. Last updated 2026-10-25.

**Constraint (James, 2026-10-25):** this work is Windows only. The card is proven on macOS and Linux; nothing changes
for those platforms: no behaviour, defaults, messages or schemas they see. Tests for macOS/Linux features may only gain
a skip on Windows.

## Context

A live check of every Windows tool on 7.7.0 (`d66849e`, Windows 11 Pro 10.0.26200, one 1920×1080 display at 100 %),
driven against a disposable WinForms window that reports its own state, passed 83 checks and found the five defects
below. The desktop status card was also found to work on Windows (top-right, topmost, excluded from captures), but it
is off unless `COMPUTER_USE_STATUS_CARD=true`; James wants it on by default.

## User stories and acceptance criteria

### R1 The status card is on by default on Windows
As a person whose PC an agent is driving, I see what it is doing and can pause or stop it without configuring anything.
- **When** the server starts on Windows with `COMPUTER_USE_STATUS_CARD` unset, **then** the card is shown (as it is
  today with `true`): top-right of the primary work area, topmost, excluded from captures, closed with the server.
- **When** `COMPUTER_USE_STATUS_CARD` is `false` or `0`, **then** no card is shown; `true` or `1` still shows it.
- macOS is unchanged (on by default). Linux is unchanged (opt-in).
- `doctor`'s `status_card` check, the README, AGENTS.md and the CHANGELOG describe the new default and how to turn it
  off.
- **Edge:** where the card cannot start (no `powershell.exe`, a service or session-0 process with no interactive
  desktop, CI), the server starts and serves tools as before, with no added delay; `doctor` reports the card as not
  shown and why.

### R2 `left_mouse_down` / `left_mouse_up` act at their coordinate
As an agent building a drag from separate press, move and release calls, the press lands where I said.
- **When** `left_mouse_down` is called with `coordinate: [x, y]`, **then** the cursor is at (x, y) (±1 px) and the
  press happens there, not where the cursor was. Same for `left_mouse_up`.
- **When** an agent calls `left_mouse_down` at A, `mouse_move` to B, `left_mouse_up` at B, **then** the target app sees
  a press at A and a release at B (a drag from A to B).
- The emergency stop still releases a held button. macOS and Linux behaviour is unchanged.

### R3 `notification` shows a toast whether or not PowerShell 7 is installed
- **When** `pwsh` (PowerShell 7) is installed, which makes it the server's PowerShell, **then** `notification` still
  succeeds and a toast appears. Today it fails because the WinRT type syntax it uses exists only in Windows PowerShell
  5.1.
- **When** `notification` fails, **then** the error is readable text (see R4's last criterion).
- **Known limit, not a defect:** with Focus Assist / Do Not Disturb on, or an unregistered `app_id`, Windows may drop
  the toast silently; the tool cannot detect that and says so in its result.

### R4 `registry set` creates a missing key; PowerShell errors are readable
- **When** `set` targets a key that does not exist (for example `HKCU:\Software\MyApp`, the AGENTS.md example),
  **then** the key and any missing parents are created and the value is set; a following `get` returns it.
- **When** `set` is refused (for example `HKLM:` without elevation), **then** the result is an error naming the path
  and the reason.
- **When** a PowerShell-backed Windows tool (`registry`, `notification`) fails, **then** the error text is plain text,
  not the raw `#< CLIXML` serialization it is today. (`process_kill` uses `tasklist`/`taskkill`, not PowerShell, so it
  is not affected; corrected during design.)

### R5 `get_active_space` works on Windows
- **When** `get_active_space` is called on Windows, **then** it returns the current virtual desktop's id (the GUID
  string `list_spaces` reports as `uuid` / `active_space_id`) without an output-schema error. macOS still returns a
  number; `null` still means unknown.
- The output schemas of the other Spaces tools are checked for the same number-versus-string mismatch and fixed where
  found.

### R6 Every role `get_ui_tree` reports can be searched for
- **When** `get_ui_tree` reports an element with role R, **then** `find_element`, `click_element`, `set_value` and
  `fill_form`, given role R, match that element. Today `AXGroup` misses panes, `AXRadioButton` misses tab items, and `AXWebArea` / `AXUnknown` are not
  filtered at all (they match every role).
- **When** a role is given that `get_ui_tree` never reports, **then** see open question Q3.

## Out of scope
- `select_menu_item` / `list_menu_bar` on Windows (not implemented), `open_application` launching an app that is not
  running, `browser_tabs` on Windows. These are known gaps, not regressions.
- The three unit tests that fail on Windows for platform reasons, and `scripts/live-windows.mjs` using the default
  profile (see Q4).

## Open questions (answers change the scope)
1. **Linux default (R1).** "The repo should default to true": Windows only, or Linux too? The Linux card reserves a
   strip of the desktop and is painted out of captures, so it is more intrusive. *Proposed: Windows only.*
2. **Several servers at once (R1).** You run two MCP clients (Claude Code and Kiro); with the card on by default each
   server shows its own card at the same top-right spot, one on top of the other. macOS behaves the same today.
   *Proposed: accept it for this fix and track stacking separately.*
3. **Unknown roles (R6).** Should `find_element` with a role `get_ui_tree` never reports (a typo like `AXButon`) return
   an error listing the valid roles, like `key` does for unknown key names, or no matches? *Proposed: an error with the
   list.*
4. **Test hygiene.** Include the three Windows-unguarded tests (`v7.7-helper-identity`, `v7.7-linux-card`'s Python
   check, `v7.7-linux-launch`'s path test) and `scripts/live-windows.mjs`'s profile in this change, so `npm test` is
   green on Windows? *Proposed: yes, as a separate small story R7.*
5. **Locked screen and non-UI tools.** While the screen is locked, 7.7.0 also refuses `filesystem`, `registry`,
   `process_kill` and `run_script`, which do not use the screen. Change that here? *Proposed: no, separate change.*
6. **Version.** Ship as 7.7.1? *Proposed: yes.* **Changed 2026-10-26 (James):** 7.7.0 was never published, so these
   fixes ship in 7.7.0; the spec moved from `docs/specs/v7.7.1-windows-fixes` to `docs/specs/v7.7/windows-fixes`.
