# Astra desktop showcases

These examples connect **GPT-6 Astra through the OpenAI Responses API** to the
local `computer-use-mcp` server. Astra chooses tools, receives actual screenshots,
acts in applications, and checks the result. The host executes MCP calls locally;
there is no public HTTP tunnel or remote MCP URL to configure.

## Run

From the repository root:

```sh
npm run build:ts
npm install --prefix agents/openai-agent
export OPENAI_API_KEY=your-key
export OPENAI_MODEL=gpt-6-astra
```

Use your platform's native build and grant the host the desktop permissions it
needs. The live Office example needs installed, activated Office apps. API model
access is determined by your account; the runner never silently substitutes a
model. These commands make paid API calls using your configured key.

### Paint a Van Gogh-inspired landscape

For an installed paint app:

```sh
node agents/openai-agent/showcase.mjs paint --app "Paintbrush"
# Windows example: --app "Paint"
# Linux example: --app "Krita"
```

Astra discovers the app, creates a new canvas, chooses its palette, paints curved
strokes, inspects the composition, and saves `painting.png`. The task asks for an
original nocturnal landscape with expressive swirls, stars, hills and a cypress.
It uses GUI tools; the recipe excludes `run_script` and image-generation tools.
Installed-app support depends on that app's controls and save/export workflow.

For a reproducible paint program included with this example:

```sh
npx playwright install chromium
node agents/openai-agent/showcase.mjs paint --studio --turns 60 --minutes 15
```

The studio is a local browser paint app with a canvas, eight colors, brush width,
undo and PNG export. The model operates it through **native MCP mouse and keyboard
actions**. A bounded `paint_strokes` helper sets the controls and executes the
model's paths through MCP. Playwright starts/closes the browser and captures the
initial geometry; the studio's loopback telemetry reports control state after
native input. Playwright never draws or changes brush controls.
The host records pointer strokes on explicit export and saves the PNG. A stopped
run also captures `recovered-canvas.png` before closing; this is recovery evidence,
not a successful model export. To use an
installed Chrome instead of downloaded Chromium, set `PLAYWRIGHT_EXECUTABLE_PATH`
to its executable path. On macOS, for example:

```sh
export PLAYWRIGHT_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

### Produce a coordinated Office briefing

```sh
node agents/openai-agent/showcase.mjs office --reasoning low
```

The agent discovers Excel, Word and PowerPoint and produces a workbook with
formulas and a chart, an executive memo, and a three-slide briefing from a shared
four-region dataset. Outputs are `quarterly-review.xlsx`, `.docx` and `.pptx`.
The Office recipe selects compact AppleScript guidance on macOS and
PowerShell/COM guidance on Windows, avoiding large application dictionaries.
It requires installed desktop Microsoft Office; this recipe does not implement
LibreOffice automation on Linux and exits before calling the API there. With no `--output`, Office runs use a unique
subdirectory of `~/Downloads/computer-use-showcases`; pass `--output` to choose a
different root. The recipe instructs the model to read back totals and visually
review files.
The runner checks file signatures; it does **not** claim those checks prove
correct formulas, good layout, or consistent figures. Review the saved files and
model observations. `scripts/test-office.mjs` separately exercises deterministic
Office scripts and independently checks their OOXML contents on macOS.

### Office setup and folder access

Install and activate desktop Word, Excel and PowerPoint before running this
recipe. On macOS, allow the host Accessibility, Screen Recording and Automation
access as needed. Office may separately request access to the output folder,
including a folder under Downloads. Complete that app-owned dialog for the
intended folder; changing the output root does not guarantee permission.
On Windows, use an interactive signed-in desktop with Office COM available.
These are deployment prerequisites, not permissions the agent grants itself.

The optional macOS `--office-preflight` performs a bounded disposable Excel save.
It cannot prove Word/PowerPoint access. A timeout can leave its workbook or
permission dialog open: inspect and close that scratch document before retrying.
Every run gets a new directory, so a grant for a previous run may not apply to the
next one. Inspect partial artifacts before retrying; never assume a timed-out
application action was rolled back. Native Office automation is not sandboxed.

### Inspect desktop capabilities

```sh
node agents/openai-agent/showcase.mjs inspect --turns 12
```

This agent produces a read-only capability report. Its host allowlist excludes
app launch, screenshots, document reads and mutations.

## Evidence and limits

Each run creates a unique directory under `showcase-output/` (Office uses
`~/Downloads/computer-use-showcases`; override the root with `--output /path`). It contains:

- `report.json`: model, status, actual API usage and artifact checks.
- `events.jsonl`: response IDs, tool names, errors and timestamps; no API keys or
  full tool arguments/results are logged.
- `observation-*.png/jpg`: real image feedback received by the model.
- `summary.md`: the model's own final report, explicitly distinct from checks.
- Paint studio: `painting.png` and `strokes.json` after the agent clicks Export PNG.

A capped GPT-6 Astra studio run was validated on 2026-09-09 with 15 model calls,
191,734 input tokens and 3,274 output tokens. It exported a 103,717-byte PNG from
105 native MCP-painted strokes across 7 colors and 614 points; studio evidence
reported `trustedPointerEvents: true`. The evidence is saved under
`/tmp/computer-use-astra-showcase/paint-xK01Yh/`. The PNG proves export and
pointer provenance. Visual review found a coherent original nocturnal landscape
with swirls, stars, moon, cypress, hills and village; its graphic treatment is
simpler than textured oil paint and the village details remain loose.

The first bounded Office attempt on 2026-09-09 used 24 turns, a 200,000-token
budget, 10 minutes and low reasoning. It stopped after 12 model calls at 222,340
input tokens and 1,432 output tokens while an Excel `Grant File Access` dialog
blocked the disposable output folder; no requested Office artifact was produced.
An optional macOS save preflight (`--office-preflight`) detects a matching
access dialog before model execution and reports the blocked folder. The default
run does not create an extra workbook to probe permissions. It does not grant
folders automatically. The recipe also
specifies explicit USD number formatting to avoid locale-dependent currency and
requires exactly three PowerPoint slides. This run remains an unsuccessful
validation and is not counted as Office artifact evidence.
The model-driven Office workflow therefore remains unvalidated; the earlier
deterministic MCP Office smoke test passed separately for Word, Excel and
PowerPoint.

`model_finished` means the model returned a final answer. Artifact checks validate
presence and signatures only. Studio evidence additionally reports stroke count,
palette diversity and trusted pointer events; **artistic quality needs visual
review**. No successful model run is fabricated by the offline tests.

Controls: `--turns 60`, `--tokens 400000`, `--minutes 15`, and `--reasoning low`.
The token limit sums actual input and output tokens, including cached input; it
is checked between responses and can overshoot by one response. The model receives
remaining-budget feedback and an instruction to save before the budget runs out. Ctrl+C cancels
API/MCP work and closes the studio. A stopped run still writes a report. Inspect
saved work before retrying an operation with an unknown outcome.

The shared loop uses lazy MCP schemas, compact accessibility observations,
multimodal function outputs, `previous_response_id`, serialized desktop writes,
local waits, retained-image references and actual usage reporting. The runner
enforces the MCP allowlist for convenience observation/wait tools as well as
discovered tools. Model-visible tool text is bounded to 24,000 characters per
result (configurable with `runAgent({maxToolTextChars})`); omitted text is marked
explicitly, and image blocks are preserved. Host hooks receive the original
result for verification. This text bound is not a total context or billing cap. These HTTP
examples do not implement Astra's optional WebSocket steering or async tools.
Local desktop access and Office scripting are not sandboxed. Run native-app
showcases in a disposable desktop when isolation is required. Studio calls are
restricted to the host-selected window, and paint/inspect exclude script tools.

## Extend a showcase

Add a recipe in `recipes.mjs` with a task and explicit tool allowlist. The model
gets the task and discovers the required MCP schemas on demand. Add a host-side
verifier for application-specific success; keep model claims and independent
checks separate. Use `runAgent` directly to supply your own MCP client, hooks,
usage limits and instructions.

## Official API references

- [GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model): Responses model ID and supported reasoning options.
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling): function-call loop, matching `call_id` outputs, image feedback.
- [Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use): visual computer interaction concepts. This example wraps local MCP tools as functions rather than using a hosted computer runtime.
