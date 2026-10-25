# v7.8.0: live share tasks

From [`docs/reviews/2026-10-25-live-screen-share.md`](../../reviews/2026-10-25-live-screen-share.md): watch the screen
locally, wake a model only when something changed, Claude Haiku 5.5 triages and Claude Opus 5.5 acts. James's choices
on 2026-10-25: watcher, console and tiers end to end; macOS first (Windows and Linux get the gate on their existing
capture); up to $5 of API spend for the benchmark and a live test; typed turns now, voice later.

Status: `todo` → `in progress` → `done` (change + test green) → `blocked` / `needs hardware`.

| # | Task | Status | Change | Tested by |
|---|---|---|---|---|
| S1 | Spike: a persistent ScreenCaptureKit stream in the helper | done: dropped | While a stream ran, the first capture from another process of the helper worked and every later one hung (`sck_timeout`), the stream stopped delivering frames, and captures stayed broken until the streaming process exited. The watcher samples instead | `scratchpad` spike, 2026-10-25: 1/4 and 0/4 captures from another process with a stream up, 8/8 without |
| S2 | Found by S1: a warm helper blocks every other session's captures (7.7.0 regression) | done | The block is per code identity: a capture in a process with the same identity as a warm helper hangs until it exits; a copy signed with another identifier, and `screencapture`, are unaffected. `ownHelperCopy` gives each helper instance its own signed copy (`macos-helper.ts`); copies are removed at exit and stale ones by the next process | v7.7-helper-identity (4); live: a second process captured in 663 ms then ~100 ms while the first helper was warm (before: 10 s and `sck_timeout`) |
| W1 | The helper compares a capture with the previous one of the same source | done | `capture --diff [--diff-key] [--skip-unchanged]` keeps a 160-px grey thumbnail per source and returns `{changed, area, dirty}`; an unchanged sample is not encoded | v7.8-change-gate (helper client); live probe: one line rewritten 1.7%, five lines 6.3%, one digit 0.02% of the window |
| W2 | The change gate | done | `change-gate.ts`: settle 600 ms, report every 3 s while changing, minimum area with a growing-box rule, ignored regions (the menu bar) | v7.8-change-gate (4) |
| W3 | The session watcher | done | `live-watcher.ts`: samples at 2/s (helper on macOS, native hash elsewhere), window list deltas, gate, `cause: agent` while the session acts, Pause / Stop / locked screen, credential-manager pause, event ring, `waitForEvents`, `latestFrame` | v7.8-live-watcher (10); live trace: each change became an event 0.7-1.1 s later |
| W4 | Watching on the status card | done | `OperatorControl.watching()` launches the card and publishes `watching`; macOS, Windows and Linux cards say "Agent is watching", and Pause says the watch sees nothing | v7.8-live-share (card frame); Swift card compiles; Linux card parses; Windows card not run here |
| T1 | `live_watch`, `live_events` | done | `live-tools.ts`, registered when `live: true` / `COMPUTER_USE_LIVE=true` (outside the profile budgets, like the run console) | v7.8-live-share (2) |
| D1 | The tiered driver | done | `live-driver.ts`: Haiku 5.5 triage (thinking off, low effort, JSON schema, no tools), Opus 5.5 act (adaptive thinking, server-side fallbacks, tools only for the person or with `act`), rate limits, back-off, captions / replies / spend into the run store | v7.8-live-share (6) |
| H1 | Console host: Watch button, live view, driver | done | `run-console-host.ts --live [--live-act] [--live-fast]`; page bridge allows `live_watch`; frames into the run at most 1/s; `run-console.ts` Watch button | v7.8-live-share (host); run-console-host and agent-run-console suites unchanged |
| B1 | Latency benchmark (Phase 0a) | done | `scripts/bench-live-latency.mjs`; results in `docs/reviews/2026-10-25-live-screen-share-inputs/latency-bench.json` | 6 runs per configuration, $0.34 |
| V1 | Live run on macOS with real models | done | A throwaway window showing a build status; a person's goal, two changes, a follow-up question | 2026-10-25: failure → person told in 4.9 s; question answered in 3.1 s; ~$0.01 per run |
| L1 | A persistent stream, now that each server has its own helper identity | todo | Re-run S1 with distinct identities; if streams coexist, use `SCFrameStatus` and dirty rects instead of sampling | |
| L2 | Voice: on-device speech recognition into turns, spoken replies | todo | | |
| L3 | Host reach: a Claude Code channel companion, an MCP App live panel | todo | | |
| L4 | Windows: a kept-open capture session with dirty rects | todo | | |

## Measurements (macOS 26.2, 2026-10-25)

Benchmark: a synthetic 1280×800 screenshot (a failing build and an editor, so no real screen was sent) behind a
~5,000-token cached system prompt, one question, `max_tokens` 300.

| Configuration | First text p50 | p95 | Total p50 | Output | Cost per call |
|---|---|---|---|---|---|
| Haiku 5.5, thinking off, low | 1,072 ms | 1,309 ms | 1,288 ms | 57 tokens, ~270 tok/s | $0.00023 |
| Haiku 5.5, adaptive, low | 1,070 ms | 1,747 ms | 1,253 ms | 57 (no thinking at low) | $0.00023 |
| Sonnet 5.5, `between_tools`, low | 8,169 ms | 8,634 ms | 8,717 ms | 82 | $0.0049 |
| Opus 5.5, low | 2,892 ms | 3,169 ms | 2,893 ms | 143 (67 thinking; text in one burst) | $0.0097 |
| Opus 5.5, low, fast | 1,530 ms | 1,665 ms | 1,712 ms | 111 (36 thinking), ~570 tok/s | $0.018 |

Two findings against the review's assumptions: Haiku with thinking off is about 1.1 s, not the 6.7-7.6 s measured
with thinking on; and fast mode does shorten Opus's wait for the first text, because Opus thinks before it writes
and fast mode speeds the thinking tokens too. Sonnet 5.5 with `between_tools` was much slower here than the 1.4 s
third-party figure.

Live (V1): watched window → `screen` event 0.7 s → Haiku caption with escalation 1.5 s → Opus message 2.7 s. The first
change ("compiling") was captioned and not escalated, as intended.
