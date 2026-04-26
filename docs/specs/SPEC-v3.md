# computer-use-mcp v3.0 — Multi-Provider Vision Spec

**Author:** James Karanja Maina, Zavora Technologies Ltd  
**Date:** April 2026  
**Status:** Draft

---

## 1. Problem Statement

`@zavora-ai/computer-use-mcp` v2.x was designed with Anthropic as the implicit target. As AI agents increasingly run on OpenAI, Gemini, Grok, Qwen, Mistral, and other providers, three problems emerge:

1. **Token waste** — screenshot dimensions are not tuned per provider. A 1024px screenshot costs ~928 tokens on Anthropic but ~765 tokens on OpenAI. Wrong sizing on Gemini can cost 3× more than necessary.
2. **Reliability gaps** — no move-and-settle before clicks, no clipboard-based typing, no drag animation. These cause failures on fast-rendering apps regardless of provider.
3. **Non-vision model blindness** — DeepSeek-V3, DeepSeek-R1, and text-only variants crash or silently fail when the model receives an image block it cannot process.

---

## 2. Top 10 Vision Model Providers (2026)

### 2.1 Provider Registry

| # | Provider | Models | Vision | Image format |
|---|---|---|---|---|
| 1 | **Anthropic** | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 | ✅ | base64 or URL |
| 2 | **OpenAI** | GPT-4o, GPT-4.1, o3, o4-mini | ✅ | base64 or URL |
| 3 | **Google** | Gemini 2.5 Pro, 2.5 Flash, 2.0 Flash | ✅ | base64 (inline_data) or URL |
| 4 | **Meta** | Llama 4 Scout, Llama 4 Maverick | ✅ | base64 (via API providers) |
| 5 | **xAI** | Grok 4, Grok 4.1 Fast | ✅ | base64 or URL (OpenAI-compat) |
| 6 | **Mistral** | Pixtral Large, Mistral Medium 3.1 | ✅ | base64 or URL |
| 7 | **Alibaba/Qwen** | Qwen2.5-VL-72B, Qwen2.5-VL-7B | ✅ | base64 |
| 8 | **Amazon** | Nova Pro, Nova Lite | ✅ | base64 (Bedrock) |
| 9 | **DeepSeek** | DeepSeek-VL2 | ✅ (VL2 only) | base64 |
| 10 | **Microsoft** | Phi-4-Vision, Phi-4-Multimodal | ✅ | base64 or URL |

> **Note:** DeepSeek-V3 and DeepSeek-R1 are **text-only** — vision must be disabled for these.

---

### 2.2 Vision Token Cost by Provider

This is the core data driving screenshot sizing decisions.

#### Anthropic
- **Formula:** `tokens = (width × height) / 750`
- **API resizes to:** 1568px max (server-side), but pre-sizing avoids server overhead
- **Optimal width:** 1092px → `(1092 × 728) / 750` ≈ **1060 tokens**
- **Default 1024px:** `(1024 × 680) / 750` ≈ **928 tokens**
- **Max image size:** 5 MB base64

#### OpenAI (GPT-4o, GPT-4.1, o3)
- **Low detail:** flat **85 tokens** regardless of size (image resized to 512×512)
- **High detail formula:** image scaled to fit 2048×2048, then tiled into 512×512 blocks
  - `tokens = 85 + (170 × num_tiles)`
  - 1024×1024 → 4 tiles → `85 + 680` = **765 tokens**
  - 512×512 → 1 tile → `85 + 170` = **255 tokens**
  - 1024×768 → 4 tiles → `85 + 680` = **765 tokens**
- **Optimal for computer use (high detail):** 1024px wide → 765 tokens
- **Optimal for cost (low detail):** any size → 85 tokens (loses fine detail)

#### Google Gemini (2.0 Flash, 2.5 Flash, 2.5 Pro)
- **Small images** (both dimensions ≤ 384px): flat **258 tokens**
- **Larger images:** tiled into 768×768 blocks, **258 tokens per tile**
  - 1024×768 → 2 tiles → **516 tokens**
  - 768×768 → 1 tile → **258 tokens**
  - 1536×768 → 2 tiles → **516 tokens**
- **Optimal for computer use:** 768px wide → 258–516 tokens depending on height
- **Max image size:** 20 MB

#### Meta Llama 4 (Scout, Maverick)
- **Tile size:** 560×560 (inherited from Llama 3.2 Vision architecture)
- **Formula:** `tokens ≈ num_tiles × ~1600` (varies by serving provider)
- **Optimal width:** 560px or 1120px (1 or 4 tiles)
- Served via Groq, Together AI, Fireworks — token counting varies

#### xAI Grok 4
- OpenAI-compatible API
- Uses same tile formula as GPT-4o: `85 + 170 × num_tiles` (512×512 tiles)
- **Optimal width:** 1024px → 765 tokens

#### Mistral Pixtral (Large, Medium 3.1)
- Native variable-resolution encoder, no fixed tile size
- Processes up to 1024×1024 natively without cropping
- Token cost: approximately **1024 tokens** per 1024×1024 image
- **Optimal width:** 1024px

#### Alibaba Qwen2.5-VL
- Dynamic resolution ViT: `tokens = (H × W) / patch_size²`
- Patch size = 28px → `tokens = (H × W) / 784`
- 1024×768 → `786432 / 784` ≈ **1003 tokens**
- 896×672 → `602112 / 784` ≈ **768 tokens**
- **Optimal width:** 896px → ~768 tokens

#### Amazon Nova (Pro, Lite)
- Snaps to nearest supported resolution grid (e.g. 900×450 for 2:1 ratio)
- Approximate cost: **1000–1500 tokens** per image at 1024px
- Max payload: 25 MB
- **Optimal width:** 1024px

#### DeepSeek-VL2
- Supports vision; DeepSeek-V3 and R1 do **not**
- Dynamic resolution, 448×448 tiles
- `tokens ≈ num_tiles × 256`
- 1024×768 → ~6 tiles → **~1536 tokens**
- **Optimal width:** 896px (2×448) → ~512 tokens

#### Microsoft Phi-4-Vision
- 448×448 tiles (same as DeepSeek-VL2 architecture)
- `tokens ≈ num_tiles × 256`
- **Optimal width:** 896px → ~512 tokens

---

### 2.3 Optimal Screenshot Width Summary

| Provider | Optimal width | Est. tokens at optimal | Notes |
|---|---|---|---|
| `anthropic` | 1024 | ~928 | Pre-sized to API target dims |
| `openai` | 1024 | ~765 | 4 tiles × 170 + 85 |
| `openai-low` | 512 | 85 | Low detail mode, loses fine text |
| `gemini` | 768 | ~258–516 | 1–2 tiles of 768×768 |
| `llama` | 1120 | ~varies | 4 tiles of 560×560 |
| `grok` | 1024 | ~765 | Same tile formula as OpenAI |
| `mistral` | 1024 | ~1024 | Native encoder, no tiling |
| `qwen` | 896 | ~768 | 28px patch grid |
| `nova` | 1024 | ~1200 | Snaps to resolution grid |
| `deepseek-vl` | 896 | ~512 | 448px tiles |
| `phi` | 896 | ~512 | 448px tiles |

---

## 3. Proposed Changes

### 3.1 `screenshot` Tool — Provider-Aware Sizing

Add `provider` parameter. When `width` is omitted, use the provider's optimal default.

**Schema change:**
```typescript
tool('screenshot', 'Capture the screen or a specific app window', {
  width: z.number().int().positive().optional()
    .describe('Override width in pixels. Omit to use provider-optimal default.'),
  quality: z.number().int().min(1).max(100).optional()
    .describe('JPEG quality 1–100. Default: 80. Lower = smaller = fewer tokens.'),
  target_app: z.string().optional()
    .describe('Bundle ID of app to capture (window only). Omit for full screen.'),
  provider: z.enum([
    'anthropic', 'openai', 'openai-low', 'gemini',
    'llama', 'grok', 'mistral', 'qwen', 'nova', 'deepseek-vl', 'phi', 'auto'
  ]).optional().describe('AI provider — determines optimal default width. Default: auto (1024px).'),
})
```

**Provider width map (session.ts):**
```typescript
const PROVIDER_WIDTH: Record<string, number> = {
  anthropic:    1024,
  openai:       1024,
  'openai-low':  512,
  gemini:        768,
  llama:        1120,
  grok:         1024,
  mistral:      1024,
  qwen:          896,
  nova:         1024,
  'deepseek-vl': 896,
  phi:           896,
  auto:         1024,
}
```

**Quality map (lower quality = fewer bytes = fewer tokens for size-based providers):**
```typescript
const PROVIDER_QUALITY: Record<string, number> = {
  anthropic: 80,
  openai:    80,
  gemini:    75,  // Gemini tiles — lower quality saves bytes, same token count
  default:   80,
}
```

---

### 3.2 Non-Vision Model Guard

For text-only models (DeepSeek-V3, DeepSeek-R1, etc.), `screenshot` must not return an image block.

**New `vision` server-level config:**
```typescript
// In createComputerUseServer(opts?)
export function createComputerUseServer(opts?: { vision?: boolean }): McpServer {
  const visionEnabled = opts?.vision !== false  // default true
  // ...
  case 'screenshot': {
    if (!visionEnabled) {
      const front = n.getFrontmostApp()
      return ok(`Screen: ${r.width}×${r.height} | Frontmost: ${front?.bundleId ?? 'unknown'}`)
    }
    // ... normal image return
  }
}
```

**MCP config for text-only models:**
```json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"],
      "env": { "COMPUTER_USE_VISION": "false" }
    }
  }
}
```

---

### 3.3 Move-and-Settle Before Clicks

All click operations must move first, wait 50ms for HID round-trip, then click. This prevents missed clicks on fast-rendering UIs.

**Current (broken for fast UIs):**
```typescript
n.mouseClick(x, y, button, count)
```

**Fixed:**
```typescript
async function doClick(n, [x, y], button, count) {
  n.mouseMove(x, y)
  await sleep(50)          // HID settle — same as @ant/computer-use-mcp
  n.mouseClick(x, y, button, count)
  trackClickTarget()
  return ok(`Clicked (${x}, ${y})`)
}
```

---

### 3.4 Clipboard-Based Typing

For text longer than 100 characters, use clipboard paste instead of CGEvent injection. CGEvent injection is unreliable for long strings in many apps (terminals, Electron apps, web inputs).

```typescript
case 'type': {
  await ensureFocus()
  const text = str('text')
  const useClipboard = text.length > 100

  if (useClipboard) {
    const saved = execFileSync('pbpaste', []).toString()
    execFileSync('pbcopy', [], { input: text })
    // Read-back verify — clipboard writes can silently fail
    const verify = execFileSync('pbpaste', []).toString()
    if (verify === text) {
      n.keyPress('command+v')
      await sleep(100)  // paste-effect vs clipboard-restore race
    } else {
      n.typeText(text)  // fallback to injection
    }
    execFileSync('pbcopy', [], { input: saved })  // restore
  } else {
    n.typeText(text)
  }
  return ok('Typed')
}
```

---

### 3.5 Screenshot Deduplication

Cache the last screenshot. If the screen hasn't changed between consecutive calls, return the cached result without a new capture. Saves one native call + base64 encode per redundant screenshot.

```typescript
// Module-level in session.ts
let _lastHash: string | undefined
let _lastResult: ToolResult | undefined

case 'screenshot': {
  const r = n.takeScreenshot(w, app)
  const hash = r.base64.slice(0, 64)  // first 64 chars — fast, sufficient for dedup
  if (hash === _lastHash && _lastResult) return _lastResult
  _lastHash = hash
  _lastResult = { content: [
    { type: 'image', data: r.base64, mimeType: r.mimeType },
    { type: 'text', text: `${r.width}x${r.height}` },
  ]}
  return _lastResult
}
```

---

### 3.6 JPEG Quality Parameter

Pass `quality` through to the Rust native module. Currently `screencapture` uses its own default. Exposing quality gives providers with byte-based limits (Nova: 25 MB) direct control.

**native.ts:**
```typescript
export function takeScreenshot(width?: number, targetApp?: string, quality?: number): ScreenshotResult
```

**screenshot.rs:**
```rust
// Pass quality to sips or use libjpeg directly
// quality: 1–100, default 80
```

---

### 3.7 Animated Drag

Current drag uses linear interpolation at 16ms intervals. Add ease-out-cubic at 60fps for apps that watch `.leftMouseDragged` events (scrollbars, window resizes, canvas tools).

```typescript
case 'left_click_drag': {
  const to = coord()
  const from = args.start_coordinate ? coord('start_coordinate') : undefined
  if (from) { n.mouseMove(from[0], from[1]); await sleep(50) }
  n.mouseButton('press', from?.[0] ?? to[0], from?.[1] ?? to[1])
  await sleep(50)

  // Ease-out-cubic, 60fps, max 500ms
  const sx = from?.[0] ?? to[0], sy = from?.[1] ?? to[1]
  const dist = Math.hypot(to[0] - sx, to[1] - sy)
  const durationMs = Math.min(dist / 2, 500)
  const frames = Math.max(Math.floor(durationMs / 16), 1)

  for (let i = 1; i <= frames; i++) {
    const t = i / frames
    const eased = 1 - Math.pow(1 - t, 3)  // ease-out-cubic
    n.mouseDrag(
      Math.round(sx + (to[0] - sx) * eased),
      Math.round(sy + (to[1] - sy) * eased),
    )
    if (i < frames) await sleep(16)
  }

  await sleep(50)
  n.mouseButton('release', to[0], to[1])
  return ok(`Dragged to (${to[0]}, ${to[1]})`)
}
```

---

## 4. Client API Changes

```typescript
// screenshot() — new params
const shot = await client.screenshot({
  provider: 'openai',   // sets width=1024, quality=80
  target_app: 'com.apple.Safari',
})

// screenshot() — explicit override still works
const shot = await client.screenshot({
  width: 768,
  quality: 60,
  provider: 'gemini',
})

// Server-level vision disable (for text-only models)
const server = createComputerUseServer({ vision: false })
```

---

## 5. MCP Config Examples

### Anthropic (Claude)
```json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"]
    }
  }
}
```

### OpenAI (GPT-4o, o3)
```json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"],
      "env": { "COMPUTER_USE_PROVIDER": "openai" }
    }
  }
}
```

### Google Gemini
```json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"],
      "env": { "COMPUTER_USE_PROVIDER": "gemini" }
    }
  }
}
```

### DeepSeek-V3 / R1 (text-only — no vision)
```json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"],
      "env": { "COMPUTER_USE_VISION": "false" }
    }
  }
}
```

### DeepSeek-VL2 (vision enabled)
```json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"],
      "env": { "COMPUTER_USE_PROVIDER": "deepseek-vl" }
    }
  }
}
```

---

## 6. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `COMPUTER_USE_PROVIDER` | `auto` | Sets default screenshot width and quality. Overridden by per-call `provider` param. |
| `COMPUTER_USE_VISION` | `true` | Set `false` for text-only models. `screenshot` returns text metadata instead of image. |
| `COMPUTER_USE_QUALITY` | provider default | JPEG quality 1–100. Overrides provider default. |
| `COMPUTER_USE_WIDTH` | provider default | Screenshot width in pixels. Overrides provider default. |

---

## 7. Implementation Plan

| Priority | Change | Effort | Impact |
|---|---|---|---|
| P0 | Move-and-settle (50ms) before clicks | 5 min | Fixes click reliability on all providers |
| P0 | Clipboard-based typing (>100 chars) | 30 min | Fixes long text in Electron/web apps |
| P1 | Provider width map + `provider` param | 1 hr | Reduces tokens 20–70% depending on provider |
| P1 | `COMPUTER_USE_VISION=false` guard | 30 min | Enables DeepSeek-V3, R1, text-only models |
| P1 | `quality` param through to native | 1 hr | Direct byte/token control |
| P2 | Screenshot deduplication | 30 min | Eliminates redundant captures |
| P2 | Animated drag (ease-out-cubic) | 30 min | Fixes drag in canvas/scrollbar apps |
| P3 | ScreenCaptureKit (Swift) | 2–3 days | Eliminates subprocess overhead entirely |

---

## 8. Version

These changes target **v3.0.0** — breaking change on `createComputerUseServer()` signature (adds optional `opts` param, backward compatible).

`screenshot()` client method gains optional `provider` and `quality` params — backward compatible.

`COMPUTER_USE_PROVIDER` env var sets the server-wide default, so existing configs need no changes unless they want provider-specific sizing.
