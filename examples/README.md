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
│   └── crypto-spreadsheet.mjs   Fetch crypto prices, paste into Numbers
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
node examples/macos/crypto-spreadsheet.mjs
```
