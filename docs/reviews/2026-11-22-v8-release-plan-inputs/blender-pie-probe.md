# Blender pie-menu probe, 2026-11-22 (macOS 26.2, Blender 5.3.0)

The report this probe tested was withdrawn the same day: the pie never closed, and `click_text` missed its item
because OCR reads the item's icon as a glyph ("• Object Mode"). Exact matching now ignores symbols at either end of a
line. The results below show no part of the mutating path closing the pie reliably.

`scripts/probes/blender-pie-probe.mjs`: the mode pie opened with Ctrl+Tab, one call 700 ms later, then whether the pie is still open.

## Run 1

| Variant | Pie open before | Pie open after the call | Call ms |
|---|---|---|---:|
| read-only call (control) | yes | yes | 372 |
| mutating call, everything on | yes | no | 204 |
| mutating call, no desktop lock or run-loop pump | yes | yes | 330 |
| mutating call, no take-over watch | yes | yes | 342 |
| mutating call, no keep-awake or status card | yes | yes | 2 |

The 2 ms call in the last row returned before any OCR; its result was not recorded in this run.

## Run 2 (variants ordered so the status card's first launch is isolated; call results recorded)

| Variant | Pie open before | Pie open after the call | Call ms | Call result |
|---|---|---|---:|---|
| read-only call (control) | yes | yes | 395 | ok |
| mutating call, status card off | yes | yes | 372 | text_not_found |
| mutating call, everything on (the card launches) | yes | yes | 352 | text_not_found |
| mutating call, everything on (the card already up) | yes | yes | 359 | text_not_found |
| mutating call, no desktop lock or run-loop pump | yes | yes | 351 | text_not_found |
| mutating call, no take-over watch | yes | yes | 367 | text_not_found |
| mutating call, no keep-awake | yes | yes | 349 | text_not_found |
