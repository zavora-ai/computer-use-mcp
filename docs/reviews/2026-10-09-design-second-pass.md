# desktop-control: second pass, the design (2026-10-09)

Follow-up to [`2026-10-09-desktop-control-review.md`](2026-10-09-desktop-control-review.md). James: "do a second pass,
tool discovery and categorise was optimised, have we optimised our design". Measured on the live server (7.5.0 plus the
7.5.1 fixes, `desktop-control` reconnected), read-only: `tools/list` per profile over stdio, `doctor`, `get_tool_guide`,
`get_app_capabilities`, `list_windows` and `read_window_text` against the running Unreal editor, and a simulation of each
proposed change applied to the real tool list. Numbers are JSON bytes; token figures are bytes ÷ 3.8, an estimate.

## 1. Answer

**Discovery was optimised at the edges; the design the model sees was not.** The v7.2 efficiency pass added an opt-in
host-side library (`efficiency` export: lexical tool search, compact accessibility trees, image reuse), static profiles
(`core`, `ax`, `scripting`, `windows-admin`, `full`), `get_tool_guide` and `get_tool_metadata`. Those are good and the
guide in particular is current and right (§3). But:

- the default profile is still `full`: 73 tools, 112,727 bytes, about 30k tokens in every host that loads the list
  (Claude Desktop, Cursor, VS Code; Claude Code defers schemas and pays per search instead);
- half of all schema bytes are the same seven parameters repeated on every input tool;
- five of the twelve largest tools are click variants that differ by one enum value;
- `approval_token` is appended to 40 tools at registration, Windows-only and Spaces tools are listed on a Mac, every tool
  carries seven `_meta` fields, and the server instructions describe v7.0: "prefer the accessibility tree", which is
  empty on the app we automate most;
- the host-side library is used by nobody we know of: Claude Code has its own deferred-tool search, and the other hosts
  load the list verbatim.

The repository's own measurement script says the same in its qualification: "payload measurements, not claimed token
savings", and its "after" column measures the opt-in library, not the server. So the honest state is: discovery tooling
exists, categorisation exists as permission tiers, and the surface itself was left as v7.0 designed it. §4 is the design
pass that was missing; it is additive and keeps every existing name working.

## 2. Measurements

### 2.1 The list the model loads

| Profile | Tools | Bytes | ~Tokens | Description bytes | Schema bytes |
|---|---:|---:|---:|---:|---:|
| core | 31 | 52,110 | 13.7k | 3,978 | 27,328 |
| scripting | 34 | 56,471 | 14.9k | 4,389 | 29,858 |
| windows-admin | 43 | 66,516 | 17.5k | 5,429 | 34,309 |
| ax | 51 | 82,432 | 21.7k | 6,064 | 46,279 |
| **full (default)** | **73** | **112,727** | **29.7k** | 9,541 | 62,497 |

Schemas are 55% of the payload; descriptions are 8%. Annotations add 7,078 bytes and the ten output schemas 6,633.

### 2.2 Where the schema bytes go (full profile)

| Shared parameter | On how many tools | Bytes |
|---|---:|---:|
| `focus_strategy` | 23 | 7,107 |
| `force` | 26 | 5,914 |
| `approval_token` (appended at registration) | 40 | 5,480 |
| `target_window_id` | 22 | 4,180 |
| `delivery` | 9 | 3,924 |
| `target_app` | 23 | 2,519 |
| `target_title` | 13 | 1,898 |
| **Total** | | **31,022 (50% of schema bytes)** |

Largest tools: `click_text` 3,525, `openai_computer` 3,226, `type` 3,120, `key` 2,688, `mouse_drag` 2,684, `scroll`
2,591, then `left_click`, `right_click`, `double_click`, `triple_click`, `middle_click` at about 2,500 each (12,455 bytes
for one verb).

### 2.3 What each design change saves (simulated on the live list)

| Step | Tools | Bytes | Saving |
|---|---:|---:|---:|
| Today, `full` | 73 | 112,727 | |
| 1. `approval_token` out of the schemas (accepted in `_meta` and still as an undeclared argument) | 73 | 106,449 | 5% |
| 2. One-sentence descriptions on the six shared targeting parameters; the guidance moves to the instructions | 73 | 93,089 | 17% |
| 3. Don't list Windows-only tools and Spaces on this Mac | 65 | 85,695 | 23% |
| 4. One `click {button, count}` instead of five (the five names stay as unlisted aliases) | 61 | 79,753 | 29% |
| 5. Default profile `desktop` = core + OCR + agent pointer; `full` on request | 39 | 51,736 | 54% |

Not simulated, additional: `_meta` trimmed from seven fields to two (`legacy_minimal` already exists as an option),
output schemas only where a host asked for `structuredContent`, and shorter descriptions on the remaining long tools.
Realistic targets: **default about 12k tokens, `full` about 22k.** Built and measured on the wire the same day: `desktop` 39 tools, 45,942 bytes; `full` 76 tools, 84,037 bytes (25% less than the 112,727 before; the default list is 59% smaller than the old default). Budgets under test: 48,000 and 88,000.

### 2.4 The agent's experience on Unreal, live

| Call | Result | Reading |
|---|---|---|
| `get_tool_guide("read and press Skip on an Unreal modal while the user works")` | `coordinate` approach, sequence `list_windows → read_window_text → click_text`, explanation names OCR, pid delivery, `grave` and `type mode:"keys"`, confidence 0.85 | **Right and current.** The guide was updated for v7.5 |
| Server instructions (what every host injects at initialize) | "Prefer accessibility tools (get_ui_tree, find_element…) over pixel clicks"; "macOS and Windows"; no OCR, `delivery`, `user_active` or `wait_for_window` | **Wrong for our main app and three releases stale.** The guide and the instructions contradict each other |
| `get_app_capabilities(com.epicgames.UnrealEditor)` | `accessible: true, topLevelCount: 1`; pid delivery: keyboard `changed`, pointer `unverified` | "accessible: true" is misleading: the tree is the window and three buttons. The pid record is the useful part |
| `list_windows` | one `main` window 2560×957, kind from AX | Good: compact, typed |
| `read_window_text` on a 900×60 region | 11 lines in 276 ms: File, Edit, Window, Tools, Build, Platforms, Select, Actor, Help, the map name at 0.5 confidence | Good. Each line carries both `box` and `screen` rectangles, which doubles the geometry bytes |
| `doctor` | 12 pass, 1 skip; `profile: full`; guard clock available | Good. It doesn't yet report the install check the launcher does |

## 3. Design alternatives, with the evidence

| Shape | Who | Pros | Cons | Verdict for us |
|---|---|---|---|---|
| **Flat tools, one per verb** (today: 73) | this server, Peekaboo, most MCP servers | Per-tool host permissions; names searchable by deferred-tool hosts; the model already knows `left_click`, `type`, `key` from Anthropic's tool | Payload grows with every verb; shared parameters repeat; variants multiply | Keep the shape, shrink it (§4) |
| **One composite tool with `action`** | Anthropic `computer` (17 actions in one tool, batching), OpenAI `computer`, our `openai_computer` | One schema; batches; models trained on it | Hosts can't gate one action and allow another; a schema union is as big as the sum; a bad action name fails at call time | Keep `openai_computer` for OpenAI hosts; don't make it the default |
| **Meta-tools: list, describe, call** | Epic's Unreal MCP (3 tools over about 50 toolsets) | Tiny initial list | Two extra round trips per new tool; `call_tool` hides inner tools from host permission rules (the dev.to review of Epic's MCP notes exactly this); deferred-tool hosts can't search inner names | No |
| **Host-side deferred discovery** | Claude Code (deferred tools + ToolSearch), OpenAI tool search | Pays per search, not per request | Only some hosts; needs good names and first sentences | Design for it: distinct names, one-sentence descriptions that say what and when |
| **Every action returns the new state** | macos-use (5 tools, each returns the AX tree) | Few tools, few turns | Huge results; useless where the tree is empty | No; `verify` on actions (7.6 R3) gives the benefit without the payload |

Decision: stay flat, cut the repetition, filter by platform, make the default profile the desktop job, consolidate only
the click family, and rewrite the instructions. Names stay stable so existing agents, the skills in `skills/`, and our
own `desktop-control` skill keep working.

## 4. The design pass (v7.6 R7)

1. **Default profile `desktop`:** core + `read_window_text`, `click_text`, `wait_for_window`, `agent_pointer`. `full`
   and the other profiles stay selectable with `COMPUTER_USE_PROFILE`; the release note says how.
2. **Platform filtering at registration:** a `platforms` field in the catalog; a tool not for this platform is neither
   listed nor callable (today it is listed and fails with `platform_unsupported`). Spaces only where supported.
3. **Shared parameters on a diet:** one sentence each for `target_app`, `target_window_id`, `target_title`,
   `focus_strategy`, `force`, `delivery`; the paragraphs move to the instructions and `get_tool_guide`.
4. **`approval_token` leaves the schemas:** accepted in `tools/call` `_meta["computer-use/approval_token"]` and, for
   compatibility, still as an undeclared argument (the registry already parses with `passthrough`). Policy behaviour is
   unchanged; the model stops seeing a credential-shaped field on 40 tools.
5. **One `click`:** `click {coordinate?, button: left|right|middle, count: 1|2|3, …targeting}`. `left_click`,
   `right_click`, `middle_click`, `double_click`, `triple_click` remain callable as aliases and are listed only in `full`.
6. **An explicit session target:** `set_target {app | window_id | title}` and `get_target`, documenting the implicit
   target that already exists, so input tools can omit targeting; `screenshot` gains `full_screen` and `display_id`.
7. **Metadata trimmed:** two `_meta` fields by default (`focusRequired`, `mutates`), the rest behind an option; output
   schemas only when the client declared `structuredContent`; a one-line text summary plus `structuredContent` instead
   of the same JSON twice.
8. **Result payloads:** OCR lines carry `screen` rectangles and the window origin once (not `box` and `screen` per line);
   `get_app_capabilities.accessible` says what the tree actually contains (`nodes`, `hasControls`).
9. **Instructions rewritten per platform and per release** (draft below), and a test that the instructions mention
   every tool in the default profile and no tool that isn't registered.
10. **Categorisation by job, not only by tier:** the catalog gains `job: observe | act | semantic | script | admin |
    browser | spaces | meta`; `get_tool_guide` and the instructions are organised by job; deferred-tool hosts get names
    whose first sentence states the job.

Draft instructions (macOS):

```
computer-use-mcp: desktop control for macOS (Windows and Linux hosts see their own text).

Pick the route in this order, and say which you used:
1. The app's own API or MCP server (Unreal: ue-bridge / Epic's MCP; Blender: its MCP; browsers: browser tools).
2. Scripting for scriptable apps: run_script (AppleScript/JXA). get_app_capabilities says if an app is scriptable.
3. Accessibility for Cocoa apps: get_ui_tree, find_element, click_element, set_value, fill_form.
4. OCR for apps that draw their own UI (Unreal, Blender, games, Electron canvases): list_windows, read_window_text
   (use a region), click_text, wait_for_window. Their accessibility tree is empty; don't call get_ui_tree on them.
5. Coordinates last: screenshot/zoom, then click/type/key/scroll with target_app or target_window_id.

While the user works: calls that would take focus or move the mouse within 4 s of their input return user_active.
Use delivery: "pid" (keys reach background apps; clicks usually don't), wait, or ask. Never pass force unless the user
asked for the action. Every action result says delivery, route and effect; treat effect: unverifiable as unknown and
look (screenshot, read_window_text) before continuing.

Targets: set target_app (bundle id) or target_window_id on input tools, or set_target once. list_windows labels
windows main/document/dialog/panel/toast. Waits: wait_for_window, wait_for_text, wait_for_stable; don't poll with
screenshots.

Safety: run_script, filesystem, process_kill and registry change the machine; destructive calls may need approval.
doctor reports permissions and the install; get_tool_guide(task) picks the route for a task.
```

## 5. What stays as it is, and why

- **Tool names.** Four thousand installs a month and three skills in `skills/` depend on them; Anthropic's model knows
  `left_click`, `type`, `key`, `scroll`, `zoom`, `hold_key`, `wait`. Aliases cost nothing in `desktop` and are listed
  in `full`.
- **The `efficiency` export.** Keep it for hosts that embed the server; it isn't the fix for hosts that load the list.
- **`openai_computer`.** The composite stays for OpenAI-shaped harnesses; it is not the default surface.
- **Profiles as permission tiers.** They still bound what a deployment allows; `job` is a second, orthogonal axis.

## 6. Verification plan for R7

- A unit test asserts the default profile's `tools/list` under 48,000 bytes and `full` under 88,000 on the real transport, and fails the
  build when a new tool pushes past them (a byte budget, like a bundle-size check).
- A test that every listed tool is callable on this platform and every alias resolves.
- The instructions test in §4.9.
- The live checks of §2.4 repeated after the change: the guide's sequence for the Unreal dialog must be unchanged, and
  `read_window_text` on the same region must return the same eleven lines with the smaller payload.

## 7. Decisions for James

James, 2026-10-09: "approved, build and test". R7 is in the v7.6 spec and built; `desktop` is the default profile; the instructions ship with it.


1. Adopt R7 into v7.6 (it is in the spec now, marked for approval).
2. The default profile change: `desktop` as default, `full` on request. This is the one behaviour change users will notice.
3. Whether to ship the instruction rewrite earlier than 7.6 (it corrects advice that is wrong for Unreal today).
