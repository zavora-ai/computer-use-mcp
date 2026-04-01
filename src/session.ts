/**
 * Session — resilient computer use session with in-process focus management.
 *
 * Every mutating action: (1) ensure target app is focused, (2) act, (3) settle.
 * All runs in-process via NAPI — no child processes, no focus stealing.
 */

import { loadNative, type NativeModule } from './native.js'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface Session {
  /** Set the target app for all subsequent actions */
  setTarget(bundleId: string): void
  /** Get current target app */
  getTarget(): string | undefined
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
    await sleep(150) // let activation settle
  }

  /** After a click, detect what app received it */
  function trackClickTarget(): void {
    const front = n.getFrontmostApp()
    if (front?.bundleId) targetApp = front.bundleId
  }

  async function dispatch(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    // Override target if explicitly passed
    if (args.target_app) targetApp = args.target_app as string

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
        case 'left_click': return doClick(n, args, 'left', 1)
        case 'right_click': return doClick(n, args, 'right', 1)
        case 'middle_click': return doClick(n, args, 'middle', 1)
        case 'double_click': return doClick(n, args, 'left', 2)
        case 'triple_click': return doClick(n, args, 'left', 3)

        // ── Mouse movement ──────────────────────────────────────────
        case 'mouse_move': {
          const [x, y] = args.coordinate as [number, number]
          n.mouseMove(x, y)
          return ok(`Moved to (${x}, ${y})`)
        }
        case 'left_click_drag': {
          const to = args.coordinate as [number, number]
          const from = args.start_coordinate as [number, number] | undefined
          if (from) { n.mouseMove(from[0], from[1]); await sleep(50) }
          n.mouseButton('press', from?.[0] ?? to[0], from?.[1] ?? to[1])
          await sleep(50)
          const steps = 10
          for (let i = 1; i <= steps; i++) {
            const t = i / steps
            const sx = from?.[0] ?? to[0], sy = from?.[1] ?? to[1]
            n.mouseDrag(Math.round(sx + (to[0] - sx) * t), Math.round(sy + (to[1] - sy) * t))
            if (i < steps) await sleep(20)
          }
          await sleep(50)
          n.mouseButton('release', to[0], to[1])
          return ok(`Dragged to (${to[0]}, ${to[1]})`)
        }
        case 'left_mouse_down': {
          const [x, y] = args.coordinate as [number, number]
          n.mouseButton('press', x, y)
          return ok('Mouse down')
        }
        case 'left_mouse_up': {
          const [x, y] = args.coordinate as [number, number]
          n.mouseButton('release', x, y)
          return ok('Mouse up')
        }
        case 'cursor_position': {
          const p = n.cursorPosition()
          return ok(`(${p.x}, ${p.y})`)
        }

        // ── Scroll — needs focus ────────────────────────────────────
        case 'scroll': {
          await ensureFocus()
          const [x, y] = args.coordinate as [number, number]
          const dir = args.direction as string
          const amt = (args.amount as number) ?? 3
          n.mouseMove(x, y)
          await sleep(30)
          const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0
          const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0
          n.mouseScroll(dy, dx)
          return ok(`Scrolled ${dir} ${amt}`)
        }

        // ── Keyboard — MUST have focus ──────────────────────────────
        case 'type': {
          await ensureFocus()
          n.typeText(args.text as string)
          return ok('Typed')
        }
        case 'key': {
          await ensureFocus()
          n.keyPress(args.text as string, (args.repeat as number) ?? undefined)
          return ok(`Pressed ${args.text}`)
        }
        case 'hold_key': {
          await ensureFocus()
          n.holdKey(args.keys as string[], ((args.duration as number) ?? 1) * 1000)
          return ok('Held')
        }

        // ── Clipboard (no focus needed) ─────────────────────────────
        case 'read_clipboard': {
          const { execFileSync } = await import('child_process')
          const text = execFileSync('pbpaste', []).toString()
          return ok(text)
        }
        case 'write_clipboard': {
          const { execFileSync } = await import('child_process')
          const text = args.text as string
          execFileSync('pbcopy', [], { input: text })
          return ok('Written')
        }

        // ── App management ──────────────────────────────────────────
        case 'open_application': {
          const bid = args.bundle_id as string
          const r = n.activateApp(bid, 3000)
          targetApp = bid
          await sleep(500) // let app fully launch
          return ok(`Opened ${bid} (activated: ${r.activated})`)
        }

        // ── Wait ────────────────────────────────────────────────────
        case 'wait': {
          await sleep(((args.duration as number) ?? 1) * 1000)
          return ok(`Waited ${args.duration}s`)
        }

        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${tool}` }], isError: true }
      }
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
    }
  }

  function doClick(n: NativeModule, args: Record<string, unknown>, button: string, count: number): ToolResult {
    const [x, y] = args.coordinate as [number, number]
    n.mouseClick(x, y, button, count)
    trackClickTarget()
    return ok(`Clicked (${x}, ${y})`)
  }

  return {
    setTarget(bid) { targetApp = bid },
    getTarget() { return targetApp },
    dispatch,
  }
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}
