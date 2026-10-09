---
name: computer-use-windows-admin
description: Windows admin tasks via filesystem, registry, process_kill, and PowerShell — not GUI clicks.
---

# Windows admin tools

Prefer:

| Task | Tool |
|---|---|
| Files | `filesystem` (read/write/list/search/copy/move/delete) |
| Registry | `registry` (PowerShell-style `HKCU:\…` paths; Windows only) |
| Processes | `process_kill` (list or kill by name/PID) |
| Complex automation | `run_script` language `powershell` |
| Notify user | `notification` (Windows only) |

Relative filesystem paths resolve from Desktop. Absolute paths are unrestricted by default — treat delete/write carefully (`COMPUTER_USE_FS_ROOTS` confines `filesystem`).

`process_kill` refuses a `pid` below 2 and matches `name` exactly; an ambiguous name returns `ambiguous_name` unless you pass `all: true`.

Set `COMPUTER_USE_PROFILE=windows-admin` for a focused tool surface if desired. These tools are not in the default `desktop` profile (`registry` and `notification` are listed only on Windows). If `COMPUTER_USE_REQUIRE_APPROVAL_FOR` or `COMPUTER_USE_DESTRUCTIVE_REQUIRES_APPROVAL` is set, the operator's token goes in the call's `_meta["computer-use/approval_token"]`, not in the arguments you see.
