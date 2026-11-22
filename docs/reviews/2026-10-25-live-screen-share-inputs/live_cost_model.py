"""Cost and latency model for a live screen-share loop on Claude, from the figures in
docs/reviews/2026-10-25-live-screen-share-inputs/claude-platform.md and realtime-model-apis.md.
Every assumption is a named constant; change it and rerun."""
import math

# $ per million tokens (claude-platform.md section 2, Pricing page)
PRICE = {
    #            base in, cache read, output
    'haiku':    (0.10, 0.01, 0.50),   # prompt <= 100K tokens
    'haiku>100k': (0.50, 0.05, 2.50),
    'sonnet':   (2.00, 0.10, 10.00),
    'opus':     (4.00, 0.20, 20.00),
    'opus_fast': (8.00, 0.40, 40.00),  # fast mode; caching multiplier stacks (0.05x of $8)
}

def vt(w, h):
    """Visual tokens: ceil(w/28) * ceil(h/28) (Vision docs), below the 4,784 cap."""
    return math.ceil(w / 28) * math.ceil(h / 28)

FRAMES = {'1280x800': vt(1280, 800), '1024x640': vt(1024, 640), '768x768': vt(768, 768),
          '512x320': vt(512, 320), '280x280 crop': vt(280, 280)}

PREFIX = 5000       # cached system + tools (claude-platform.md assumption; toolset alone ~4,520)
TEXT = 50           # uncached text per turn
OUT = 150           # output tokens per turn, thinking excluded

def call_cost(model, frame_tokens, text=TEXT, out=OUT, thinking=0, prefix=PREFIX):
    base, read, outp = PRICE[model]
    return (prefix * read + (frame_tokens + text) * base + (out + thinking) * outp) / 1e6

print('Visual tokens per frame:', FRAMES)
print()
print('D1 raw stream, stateless, 1280x800, no thinking ($/frame, $/h at 1 fps, $/h at 0.2 fps)')
for m in ['haiku', 'sonnet', 'opus', 'opus_fast']:
    c = call_cost(m, FRAMES['1280x800'])
    print(f'  {m:10s} {c:.6f}  {c*3600:7.2f}  {c*720:6.2f}')
print('  (claude-platform.md table omits the 50 text tokens: haiku', round(call_cost('haiku', 1334, text=0)*3600, 2), ')')
print()
print('D1 at 0.5 fps, 768x768 (the Gemini Live recommended frame), $/h')
for m in ['haiku', 'sonnet', 'opus', 'opus_fast']:
    print(f'  {m:10s} {call_cost(m, FRAMES["768x768"])*1800:7.2f}')
print()

# Thinking sensitivity: Opus 5.5 cannot turn thinking off; Haiku can (effort <= high).
print('Thinking sensitivity: $ added per call per 100 thinking tokens')
for m in ['haiku', 'sonnet', 'opus', 'opus_fast']:
    print(f'  {m:10s} {100*PRICE[m][2]/1e6:.5f}')
print()

ACTIVITY = {'quiet (60 calls/h)': 60, 'moderate (240/h)': 240, 'busy (720/h)': 720}
THINK_OPUS = 300    # ASSUMPTION, illustrative only: thinking tokens per Opus call at low effort
CROP_AVG = 400      # ASSUMPTION: mean tokens of a changed-region crop (between 280x280=100 and 1024x640=851)

print('D3 event-gated full frames to one model (1280x800 per gated event), $/h')
for label, n in ACTIVITY.items():
    row = []
    for m, th in [('haiku', 0), ('opus', THINK_OPUS), ('opus_fast', THINK_OPUS)]:
        row.append(f'{m}={call_cost(m, FRAMES["1280x800"], thinking=th)*n:.2f}')
    print(f'  {label:20s}', ' '.join(row))
print()
print('D3b event-gated crops (mean 400 tokens), $/h')
for label, n in ACTIVITY.items():
    row = []
    for m, th in [('haiku', 0), ('opus', THINK_OPUS), ('opus_fast', THINK_OPUS)]:
        row.append(f'{m}={call_cost(m, CROP_AVG, thinking=th)*n:.2f}')
    print(f'  {label:20s}', ' '.join(row))
print()

# D4 tiered: Haiku (thinking off) triages every gated event with a frame and writes a ~60-token
# caption; Opus is called on ESCALATE share of events with the frame + 600 tokens of recent captions,
# 300 output tokens and THINK_OPUS thinking tokens.
ESCALATE = 0.10     # ASSUMPTION
HAIKU_OUT = 60
def tiered(n, opus_model='opus', frame=FRAMES['1280x800']):
    h = call_cost('haiku', frame, text=TEXT, out=HAIKU_OUT) * n
    o = call_cost(opus_model, frame, text=600, out=300, thinking=THINK_OPUS) * n * ESCALATE
    return h, o
print('D4 tiered Haiku triage + Opus on 10% of events, $/h (haiku part + opus part)')
for label, n in ACTIVITY.items():
    for om in ['opus', 'opus_fast']:
        h, o = tiered(n, om)
        print(f'  {label:20s} {om:9s} haiku={h:.3f} opus={o:.3f} total={h+o:.2f}')
print()

# D5 local perception first: the server sends a text delta (OCR/accessibility, ~200 tokens) per gated
# event; a frame is attached on FRAME_SHARE of calls (model asks, or the gate cannot express the change).
DELTA = 200
FRAME_SHARE = 0.20  # ASSUMPTION
def local_first(model, n, thinking=0):
    text_only = call_cost(model, 0, text=DELTA, thinking=thinking)
    with_frame = call_cost(model, FRAMES['1280x800'], text=DELTA, thinking=thinking)
    return n * ((1 - FRAME_SHARE) * text_only + FRAME_SHARE * with_frame)
print('D5 local text deltas, frames on 20% of calls, $/h')
for label, n in ACTIVITY.items():
    print(f'  {label:20s} haiku={local_first("haiku", n):.3f} opus={local_first("opus", n, THINK_OPUS):.2f} '
          f'opus_fast={local_first("opus_fast", n, THINK_OPUS):.2f}')
print()

# Growing history: frames kept, automatic caching. When does Haiku cross 100K?
per_turn = FRAMES['1280x800'] + TEXT + OUT
print('Haiku 100K crossing with a growing 1280x800 history: turn', math.ceil((100_000 - PREFIX) / per_turn))
print()

# Latency floor (seconds) for "frame appears -> first useful words", from measured or documented parts.
CAPTURE = (0.062, 0.128)        # warm helper capture .. screenshot end to end (CHANGELOG, macOS 26.2)
GATE = (0.2, 0.5)               # debounce (screenpipe 200 ms default; balanced 500 ms)
TTFT = {'haiku (thinking on, AA low)': 6.68, 'sonnet low (AA)': 1.40, 'opus low (AA)': 4.90}
TPS = {'haiku (thinking on, AA low)': 176.3, 'sonnet low (AA)': 104.0, 'opus low (AA)': 82.1}
print('Latency floor for a 150-token reply (s): capture + gate + TTFT + output')
for m in TTFT:
    lo = CAPTURE[0] + GATE[0] + TTFT[m] + OUT / TPS[m]
    hi = CAPTURE[1] + GATE[1] + TTFT[m] + OUT / TPS[m]
    print(f'  {m:28s} {lo:.1f}-{hi:.1f}')
fast_tps = 82.1 * 2.5
print(f'  opus fast (TTFT unchanged, <=2.5x tok/s)  {CAPTURE[0]+GATE[0]+4.90+OUT/fast_tps:.1f}-{CAPTURE[1]+GATE[1]+4.90+OUT/fast_tps:.1f}')
print()
print('Where fast mode pays: time to emit an action plan of N output tokens on Opus 5.5 (s)')
for n in [150, 600, 1500]:
    print(f'  {n:5d} tokens: standard {n/82.1:5.1f}  fast(upper bound) {n/fast_tps:5.1f}  saved {n/82.1-n/fast_tps:4.1f}')
print()
print('In-flight requests if frames are sent at 1 fps and each takes TTFT+output to answer:')
for m in TTFT:
    print(f'  {m:28s} ~{TTFT[m] + OUT/TPS[m]:.1f} requests overlapping')
print()

# Gemini 3.8 Live comparator (realtime-model-apis.md): video $1/M, audio in $3/M, audio out $12/M.
v70 = 3600 * 70 / 1e6 * 1.00
v258 = 3600 * 258 / 1e6 * 1.00
a_in = 3600 * 25 / 1e6 * 3.00
a_out = 360 * 25 / 1e6 * 12.00
print(f'Gemini 3.8 Live, 1 fps, mic open 1 h, model speaks 6 min: streaming view ${v70+a_in+a_out:.2f}/h '
      f'(70 tok/frame) or ${v258+a_in+a_out:.2f}/h (258 tok/s)')
print(f'  $0.002/min video price implies {0.002/1.00*1e6/60:.0f} tokens/s')
blend = 0.9 * 1.00 + 0.1 * 3.00
for turns, ctx in [(120, 79_000), (360, 79_000), (120, 12_000)]:
    print(f'  per-turn full-context billing: {turns} turns/h x {ctx/1000:.0f}K avg context = ${turns*ctx*blend/1e6:.1f}/h')
print()
print('D1 with Opus thinking (300 tokens/call, the same assumption as D3-D5), $/h at 1 fps')
for m in ['opus', 'opus_fast']:
    print(f'  {m:10s} {call_cost(m, FRAMES["1280x800"], thinking=THINK_OPUS)*3600:7.2f}')
print()
print('Opus 5.5 call breakdown, 1280x800 frame, 300 thinking tokens:')
base, read, outp = PRICE['opus']
parts = {'cached prefix': PREFIX*read/1e6, 'frame+text input': (FRAMES['1280x800']+TEXT)*base/1e6,
         'output+thinking': (OUT+THINK_OPUS)*outp/1e6}
tot = sum(parts.values())
for k, v in parts.items():
    print(f'  {k:18s} ${v:.5f}  {100*v/tot:4.1f}%')
print(f'  total ${tot:.5f}')
print()
print('Start-tier $500 monthly cap, hours until reached:')
for label, perh in [('opus raw 1 fps', call_cost('opus', 1334)*3600), ('opus tiered busy', tiered(720)[0]+tiered(720)[1])]:
    print(f'  {label:18s} {500/perh:6.0f} h')
