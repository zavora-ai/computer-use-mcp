---
name: computer-use-windows-admin
description: Windows admin tasks via filesystem, registry, process_kill, and PowerShell — not GUI clicks.
---

# Windows admin tools

Prefer:

| Task | Tool |
|---|---|
| Files | `filesystem` (read/write/list/search/copy/move/delete) |
| Registry | `registry` (PowerShell-style `HKCU:\…` paths) |
| Processes | `process_kill` (list or kill by name/PID) |
| Complex automation | `run_script` language `powershell` |
| Notify user | `notification` |

Relative filesystem paths resolve from Desktop. Absolute paths are unrestricted by default — treat delete/write carefully.

Set `COMPUTER_USE_PROFILE=windows-admin` for a focused tool surface if desired.
