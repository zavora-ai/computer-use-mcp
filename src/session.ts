/**
 * Session — resilient computer use session with in-process focus management.
 *
 * Every mutating action: (1) ensure target app is focused, (2) act, (3) settle.
 * All runs in-process via NAPI — no child processes, no focus stealing.
 */

import { loadNative, type NativeModule } from './native.js'
import { execFileSync } from 'child_process'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface Session {
  /** Dispatch a tool call */
  dispatch(tool: string, args: Record<string, unknown>): Promise<ToolResult>
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

export function createSession(): Session {
  const n = loadNative()
  let targetApp: string | undefined

  /** Ensure target app is frontmost. In-process — no focus steal. */
  async function ensureFocus(): Promise<void> {
    if (!targetApp) return
    const front = n.getFrontmostApp()
    if (front?.bundleId === targetApp) return
    n.activateApp(targetApp, 2000)
    await sleep(80) // let activation settle
  }

  /** After a click, detect what app received it */
  function trackClickTarget(): void {
    const front = n.getFrontmostApp()
    if (front?.bundleId) targetApp = front.bundleId
  }

  async function dispatch(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    // Override target if explicitly passed
    if (args.target_app) targetApp = args.target_app as string

    // Input guards
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
        // ── Screenshot (read-only, no focus needed) ─────────────────
        case 'screenshot': {
          const r = n.takeScreenshot()
          return { content: [
            { type: 'image', data: r.base64, mimeType: r.mimeType },
            { type: 'text', text: `${r.width}x${r.height}` },
          ]}
        }

        // ── Clicks — focus happens via the click itself ─────────────
        case 'left_click': return doClick(n, coord(), 'left', 1)
        case 'right_click': return doClick(n, coord(), 'right', 1)
        case 'middle_click': return doClick(n, coord(), 'middle', 1)
        case 'double_click': return doClick(n, coord(), 'left', 2)
        case 'triple_click': return doClick(n, coord(), 'left', 3)

        case 'mouse_move': {
          const [x, y] = coord()
          n.mouseMove(x, y)
          return ok(`Moved to (${x}, ${y})`)
        }
        case 'left_click_drag': {
          const to = coord()
          const from = args.start_coordinate ? coord('start_coordinate') : undefined
          if (from) { n.mouseMove(from[0], from[1]); await sleep(30) }
          n.mouseButton('press', from?.[0] ?? to[0], from?.[1] ?? to[1])
          await sleep(30)
          const steps = 10
          for (let i = 1; i <= steps; i++) {
            const t = i / steps
            const sx = from?.[0] ?? to[0], sy = from?.[1] ?? to[1]
            n.mouseDrag(Math.round(sx + (to[0] - sx) * t), Math.round(sy + (to[1] - sy) * t))
            if (i < steps) await sleep(16)
          }
          await sleep(30)
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

        case 'type': {
          await ensureFocus()
          n.typeText(str('text'))
          return ok('Typed')
        }
        case 'key': {
          await ensureFocus()
          n.keyPress(str('text'), args.repeat !== undefined ? num('repeat', 1) : undefined)
          return ok(`Pressed ${args.text}`)
        }
        case 'hold_key': {
          await ensureFocus()
          if (!Array.isArray(args.keys)) throw new Error('Invalid keys: expected string[]')
          n.holdKey(args.keys as string[], num('duration', 1) * 1000)
          return ok('Held')
        }

        // ── Clipboard (no focus needed) ─────────────────────────────
        case 'read_clipboard': {
          const text = execFileSync('pbpaste', []).toString()
          return ok(text)
        }
        case 'write_clipboard': {
          execFileSync('pbcopy', [], { input: args.text as string })
          return ok('Written')
        }

        // ── App management ──────────────────────────────────────────
        case 'open_application': {
          const bid = str('bundle_id')
          const r = n.activateApp(bid, 3000)
          targetApp = bid
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
          return ok(JSON.stringify(n.getDisplaySize(args.display_id !== undefined ? num('display_id', 0) : undefined)))
        case 'list_displays':
          return ok(JSON.stringify(n.listDisplays()))
        case 'wait': {
          await sleep(num('duration', 1) * 1000)
          return ok(`Waited ${args.duration}s`)
        }

        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${tool}` }], isError: true }
      }
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
    }
  }

  function doClick(n: NativeModule, [x, y]: [number, number], button: string, count: number): ToolResult {
    n.mouseClick(x, y, button, count)
    trackClickTarget()
    return ok(`Clicked (${x}, ${y})`)
  }

  return { dispatch }
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}
