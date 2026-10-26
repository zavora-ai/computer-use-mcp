# v7.7.0 Windows fixes: tasks

From [requirements.md](requirements.md) and [design.md](design.md), both approved 2026-10-25. James then asked for the
work to be implemented end to end at once (2026-10-25), which stands in for a separate approval of this list. Each task
is `done` when its change is in the tree **and** its test passes. Nothing is committed until James says so.

Status: `todo` → `in progress` → `done` (change + test green) → `blocked`.

| # | Task | Design | Req | Status | Tested by |
|---|---|---|---|---|---|
| T1 | `statusCardEnabled`: Windows on by default, off under `node --test` unless explicitly `true` | D1 | R1 | done | v7.7-windows-fixes, v7.6.1-status-card, v7.7-person-control |
| T2 | Windows card reports readiness: script writes `windows-card.json`; `WindowsCardPresenter.start()` resolves on it, rejects on early exit / spawn error / 20 s | D1 | R1 | done | v7.7-windows-fixes; live |
| T3 | `doctor`: Windows "card off" summary names `COMPUTER_USE_STATUS_CARD=false` | D1 | R1 | done | v7.7-windows-fixes |
| T4 | Native Windows `mouse_button` moves to the coordinate before the button event | D2 | R2 | done | live (harness): press lands at the coordinate with the cursor parked elsewhere; down/move/up drags A→B |
| T5 | `notification` runs `powershell.exe`; result notes Focus Assist | D3 | R3 | done | v7.7-windows-fixes; live (toast history) |
| T6 | `windowsPowerShell` wrapper + `plainPowerShellError`; `registry set` creates a missing key; errors name mode and path | D4 | R4 | done | v7.7-windows-fixes; live |
| T7 | `outputSchemaFor(name, platform)`; Windows `get_active_space` schema accepts the GUID string; registry uses it | D5 | R5 | done | v7.7-windows-fixes; live |
| T8 | Native Windows `ROLES` table; `build_condition` OR / `AXUnknown` NOT; unknown role matches nothing; `uiaRoles()` export; Rust tests | D6 | R6 | done | cargo test; live |
| T9 | Windows `unknown_role` refusal in `find_element`, `click_element`, `set_value`, `fill_form` | D6 | R6 | done | v7.7-windows-fixes |
| T10 | Skip three non-Windows tests on `win32`; `scripts/live-windows.mjs` uses `profile: 'full'` | D7 | R7 | done | npm test on Windows |
| T11 | Docs: README, AGENTS.md, TESTING-IN-UTM.md, CHANGELOG v7.7.0 | D1–D7 | R1–R7 | done | v7.7-doc-counts (unchanged counts) |
| T12 | Rebuild native + TS; `npm test`, `cargo test`; live harness run (new checks + the 83 from the first live check) | all | all | done | npm test on Windows: 700 tests, 671 pass, 0 fail, 29 skipped (screen unlocked; an earlier run while it was locked failed only the two fs-jail dispatch tests); cargo test 42 + 1 skipped; lint clean; live checks for these fixes 14/14; full live run 89 pass, 0 fail, 2 known gaps (select_menu_item, open_application launch: out of scope) |
