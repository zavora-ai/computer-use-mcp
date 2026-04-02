/**
 * Session — resilient computer use session with in-process focus management.
 *
 * Every mutating action: (1) ensure target app is focused, (2) act, (3) settle.
 * All runs in-process via NAPI — no child processes, no focus stealing.
 */

import { loadNative, type NativeModule } from './native.js'
import { execFileSync } from 'child_process'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ── Provider-aware screenshot defaults ────────────────────────────────────────

const PROVIDER_WIDTH: Record<string, number> = {
  anthropic:     1024,
  openai:        1024,
  'openai-low':   512,
  gemini:         768,
  llama:         1120,
  grok:          1024,
  mistral:       1024,
  qwen:           896,
  nova:          1024,
  'deepseek-vl':  896,
  phi:            896,
  auto:          1024,
}

const PROVIDER_QUALITY: Record<string, number> = {
  anthropic: 80,
  openai:    80,
  gemini:    75,
  default:   80,
}

export interface Session {
  dispatch(tool: string, args: Record<string, unknown>): Promise<ToolResult>
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

export interface SessionOptions {
  /** Disable image output for text-only models (DeepSeek-V3, R1, etc.) */
  vision?: boolean
  /** Default provider — sets optimal width/quality when not specified per-call */
  provider?: string
}

export function createSession(opts: SessionOptions = {}): Session {
  const n = loadNative()
  let targetApp: string | undefined
  const visionEnabled = opts.vision !== false
  const defaultProvider = opts.provider ?? process.env.COMPUTER_USE_PROVIDER ?? 'auto'

  // Screenshot dedup cache — keyed on (params + content hash)
  let _lastKey: string | undefined
  let _lastResult: ToolResult | undefined

  async function ensureFocus(): Promise<void> {
    if (!targetApp) return
    const front = n.getFrontmostApp()
    if (front?.bundleId === targetApp) return
    n.activateApp(targetApp, 2000)
    await sleep(80)
  }

  function trackClickTarget(): void {
    const front = n.getFrontmostApp()
    if (front?.bundleId) targetApp = front.bundleId
  }

  async function doClick(coord: [number, number], button: string, count: number): Promise<ToolResult> {
    const [x, y] = coord
    n.mouseMove(x, y)
    await sleep(50)  // HID round-trip settle before click
    n.mouseClick(x, y, button, count)
    trackClickTarget()
    return ok(`Clicked (${x}, ${y})`)
  }

  async function dispatch(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.target_app === 'string' && args.target_app.length > 0) {
      targetApp = args.target_app
    }

    const coord = (key = 'coordinate'): [number, number] => {
      const v = args[key]
      if (!Array.isArray(v) || v.length < 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number')
        throw new Error(`Invalid ${key}: expected [number, number]`)
      return [v[0], v[1]]
    }
    const str = (key: string): string => {
      if (typeof args[key] !== 'string') throw new Error(`Invalid ${key}: expected string`)
      return args[key] as string
    }
    const num = (key: string, fallback: number): number => {
      const v = args[key]
      return typeof v === 'number' ? v : fallback
    }

    try {
      switch (tool) {

        // ── Screenshot ───────────────────────────────────────────────────────
        case 'screenshot': {
          const provider = (typeof args.provider === 'string' ? args.provider : defaultProvider)
          const defaultWidth = PROVIDER_WIDTH[provider] ?? 1024
          const defaultQuality = PROVIDER_QUALITY[provider] ?? PROVIDER_QUALITY.default
          const w = typeof args.width === 'number' ? args.width
                  : typeof process.env.COMPUTER_USE_WIDTH !== 'undefined' ? parseInt(process.env.COMPUTER_USE_WIDTH)
                  : defaultWidth
          const q = typeof args.quality === 'number' ? args.quality
                  : typeof process.env.COMPUTER_USE_QUALITY !== 'undefined' ? parseInt(process.env.COMPUTER_USE_QUALITY)
                  : defaultQuality
          const app = args.target_app !== undefined ? str('target_app') : undefined

          if (!visionEnabled) {
            const front = n.getFrontmostApp()
            const display = n.getDisplaySize()
            return ok(`Screen: ${display.width}×${display.height} | Frontmost: ${front?.bundleId ?? 'unknown'} (${front?.displayName ?? ''})`)
          }

          const r = n.takeScreenshot(w, app, q)

          // Dedup: key = params + content sample (middle 64 chars avoids identical JPEG headers)
          const mid = Math.floor(r.base64.length / 2)
          const key = `${w}:${q}:${app ?? ''}:${r.base64.slice(mid, mid + 64)}`
          if (key === _lastKey && _lastResult) return _lastResult
          _lastKey = key
          _lastResult = {
            content: [
              { type: 'image', data: r.base64, mimeType: r.mimeType },
              { type: 'text', text: `${r.width}x${r.height}` },
            ]
          }
          return _lastResult
        }

        // ── Clicks ───────────────────────────────────────────────────────────
        case 'left_click':   return doClick(coord(), 'left', 1)
        case 'right_click':  return doClick(coord(), 'right', 1)
        case 'middle_click': return doClick(coord(), 'middle', 1)
        case 'double_click': return doClick(coord(), 'left', 2)
        case 'triple_click': return doClick(coord(), 'left', 3)

        case 'mouse_move': {
          const [x, y] = coord()
          n.mouseMove(x, y)
          return ok(`Moved to (${x}, ${y})`)
        }

        case 'left_click_drag': {
          const to = coord()
          const from = args.start_coordinate ? coord('start_coordinate') : undefined
          if (from) { n.mouseMove(from[0], from[1]); await sleep(50) }
          n.mouseButton('press', from?.[0] ?? to[0], from?.[1] ?? to[1])
          await sleep(50)

          // Ease-out-cubic at 60fps, distance-proportional duration, max 500ms
          const sx = from?.[0] ?? to[0], sy = from?.[1] ?? to[1]
          const dist = Math.hypot(to[0] - sx, to[1] - sy)
          const durationMs = Math.min(dist / 2, 500)
          const frames = Math.max(Math.floor(durationMs / 16), 1)
          for (let i = 1; i <= frames; i++) {
            const t = i / frames
            const eased = 1 - Math.pow(1 - t, 3)
            n.mouseDrag(Math.round(sx + (to[0] - sx) * eased), Math.round(sy + (to[1] - sy) * eased))
            if (i < frames) await sleep(16)
          }

          await sleep(50)
          n.mouseButton('release', to[0], to[1])
          return ok(`Dragged to (${to[0]}, ${to[1]})`)
        }

        case 'left_mouse_down': {
          const [x, y] = coord()
          n.mouseButton('press', x, y)
          return ok('Mouse down')
        }
        case 'left_mouse_up': {
          const [x, y] = coord()
          n.mouseButton('release', x, y)
          return ok('Mouse up')
        }
        case 'cursor_position': {
          const p = n.cursorPosition()
          return ok(`(${p.x}, ${p.y})`)
        }

        case 'scroll': {
          await ensureFocus()
          const [x, y] = coord()
          const dir = str('direction')
          const amt = num('amount', 3)
          n.mouseMove(x, y)
          await sleep(15)
          const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0
          const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0
          n.mouseScroll(dy, dx)
          return ok(`Scrolled ${dir} ${amt}`)
        }

        // ── Keyboard ─────────────────────────────────────────────────────────
        case 'type': {
          await ensureFocus()
          const text = str('text')
          if (text.length > 100) {
            // Clipboard-based typing: faster and more reliable for long text
            let saved: string | undefined
            try { saved = execFileSync('pbpaste', []).toString() } catch { /* ignore */ }
            try {
              execFileSync('pbcopy', [], { input: text })
              const verify = execFileSync('pbpaste', []).toString()
              if (verify === text) {
                n.keyPress('command+v')
                await sleep(100)  // paste-effect vs clipboard-restore race
              } else {
                n.typeText(text)  // fallback to injection
              }
            } finally {
              if (typeof saved === 'string') {
                try { execFileSync('pbcopy', [], { input: saved }) } catch { /* ignore */ }
              }
            }
          } else {
            n.typeText(text)
          }
          return ok('Typed')
        }

        case 'key': {
          await ensureFocus()
          n.keyPress(str('text'), args.repeat !== undefined ? num('repeat', 1) : undefined)
          return ok(`Pressed ${args.text}`)
        }
        case 'hold_key': {
          await ensureFocus()
          if (!Array.isArray(args.keys) || !args.keys.every(k => typeof k === 'string'))
            throw new Error('Invalid keys: expected string[]')
          n.holdKey(args.keys as string[], num('duration', 1) * 1000)
          return ok('Held')
        }

        // ── Clipboard ────────────────────────────────────────────────────────
        case 'read_clipboard': {
          const text = execFileSync('pbpaste', []).toString()
          return ok(text)
        }
        case 'write_clipboard': {
          execFileSync('pbcopy', [], { input: str('text') })
          return ok('Written')
        }

        // ── Apps ─────────────────────────────────────────────────────────────
        case 'open_application': {
          const bid = str('bundle_id')
          const r = n.activateApp(bid, 3000)
          if (r.activated) targetApp = bid
          await sleep(300)
          return ok(`Opened ${bid} (activated: ${r.activated})`)
        }
        case 'list_running_apps':
          return ok(JSON.stringify(n.listRunningApps()))
        case 'hide_app':
          return ok(n.hideApp(str('bundle_id')) ? 'Hidden' : 'App not found')
        case 'unhide_app':
          return ok(n.unhideApp(str('bundle_id')) ? 'Unhidden' : 'App not found')
        case 'get_display_size':
          return ok(JSON.stringify(n.getDisplaySize(typeof args.display_id === 'number' ? args.display_id : undefined)))
        case 'list_displays':
          return ok(JSON.stringify(n.listDisplays()))
        case 'wait': {
          await sleep(num('duration', 1) * 1000)
          return ok(`Waited ${args.duration}s`)
        }

        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${tool}` }], isError: true }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
    }
  }

  return { dispatch }
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}
