# Examples

Runnable demos for `@zavora-ai/computer-use-mcp`. All use the in-process client — no separate server needed.

```
examples/
├── windows/
│   ├── notepad.mjs              Open Notepad, type, save, screenshot, clipboard, zoom, snapshot
│   ├── zoom.mjs                 Capture full screen then zoom into regions at native resolution
│   ├── browser.mjs              Open browser, navigate, copy text, scrape, multi-tab
│   ├── virtual-desktops.mjs     Create desktop, open app, work, switch back, cleanup
│   ├── system-info.mjs          Display, windows, processes, registry, filesystem, tool guide
│   ├── ui-automation.mjs        UI tree inspection, find elements, zoom into text, annotations
│   ├── cross-app-workflow.mjs   Scrape web → save file → open in Notepad → verify
│   ├── data-entry.mjs           Create CSV report with structured employee data
│   └── sysadmin.mjs             System health report: OS, CPU, memory, disk, network, processes
├── macos/
│   ├── calculator.mjs           Open Calculator, compute 42+58, screenshot, clipboard
│   ├── window-targeting.mjs     TextEdit + Safari, window-level targeting, focus recovery
│   ├── browser.mjs              Safari navigation, copy text, multi-tab screenshots
│   ├── crypto-spreadsheet.mjs   Fetch crypto prices, create blank workbook, paste into Numbers
│   ├── budget-template.mjs     Open budget template, personalise with data, add formulas, save
│   ├── send-email.mjs           Compose and send email via Mail.app AppleScript
│   ├── calendar-event.mjs       Create a calendar event for tomorrow via AppleScript
│   ├── create-contact.mjs       Create (and clean up) a contact in Contacts.app
│   ├── open-vscode.mjs          Open VS Code, create file, type TypeScript code, screenshot
│   ├── terminal-disk-space.mjs  Check disk space via shell and Terminal UI
│   └── zoom.mjs                 Capture full screen then zoom into macOS-specific regions
└── README.md
```

## Windows

```bash
# Core demos
node examples/windows/notepad.mjs              # Full demo: type, save, zoom, snapshot
node examples/windows/zoom.mjs                 # Region inspection at native resolution
node examples/windows/browser.mjs              # Browser navigation + scraping

# Advanced workflows
node examples/windows/cross-app-workflow.mjs   # Web scrape → file → Notepad → verify
node examples/windows/data-entry.mjs           # Structured data entry + CSV report
node examples/windows/sysadmin.mjs             # System health report (no GUI needed)

# Platform features
node examples/windows/virtual-desktops.mjs     # Virtual desktop lifecycle
node examples/windows/ui-automation.mjs        # UI tree + element interaction
node examples/windows/system-info.mjs          # System introspection
```

## macOS

```bash
node examples/macos/calculator.mjs
node examples/macos/window-targeting.mjs
node examples/macos/browser.mjs
node examples/macos/crypto-spreadsheet.mjs     # Blank workbook + crypto data
node examples/macos/budget-template.mjs        # Budget template + personalised data
node examples/macos/send-email.mjs             # Send email via Mail.app
node examples/macos/calendar-event.mjs         # Create calendar event
node examples/macos/create-contact.mjs         # Create + cleanup contact
node examples/macos/open-vscode.mjs            # VS Code + TypeScript code
node examples/macos/terminal-disk-space.mjs    # Disk space via Terminal
node examples/macos/zoom.mjs                  # Region inspection at native resolution
```
