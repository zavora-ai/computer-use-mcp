import { execFileSync as defaultExecFileSync } from 'node:child_process'
import type { NativeModule } from '../native.js'
import { ok, type ToolResult } from '../result.js'
import type { FocusController } from './focus.js'
import type { TargetStateController } from './target-state.js'

type ExecFile = typeof defaultExecFileSync

const INPUT_TOOLS = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up',
  'cursor_position', 'scroll', 'type', 'key', 'hold_key',
  'read_clipboard', 'write_clipboard', 'multi_select', 'multi_edit',
])

/** Physical pointer, keyboard, clipboard, and batch-input execution. */
export class InputHandler {
  readonly #native: NativeModule
  readonly #targets: TargetStateController
  readonly #focus: FocusController
  readonly #platform: NodeJS.Platform
  readonly #sleep: (milliseconds: number) => Promise<void>
  readonly #execFile: ExecFile

  constructor(options: {
    native: NativeModule
    targets: TargetStateController
    focus: FocusController
    platform?: NodeJS.Platform
    sleep(milliseconds: number): Promise<void>
    execFile?: ExecFile
  }) {
    this.#native = options.native
    this.#targets = options.targets
    this.#focus = options.focus
    this.#platform = options.platform ?? process.platform
    this.#sleep = options.sleep
    this.#execFile = options.execFile ?? defaultExecFileSync
  }

  async handle(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult | undefined> {
    if (!INPUT_TOOLS.has(tool)) return undefined
    const coordinate = (key = 'coordinate'): [number, number] => {
      const value = args[key]
      if (!Array.isArray(value) || value.length < 2
        || typeof value[0] !== 'number' || typeof value[1] !== 'number') {
        throw new Error(`Invalid ${key}: expected [number, number]`)
      }
      return [value[0], value[1]]
    }
    const string = (key: string): string => {
      if (typeof args[key] !== 'string') throw new Error(`Invalid ${key}: expected string`)
      return args[key]
    }
    const number = (key: string, fallback: number): number =>
      typeof args[key] === 'number' ? args[key] : fallback
    const target = () => this.#targets.resolve(args)
    const focus = async (resolved: { bundleId?: string; windowId?: number }) => {
      await this.#focus.ensure(resolved, this.#focus.strategyFor(tool, args))
    }

    const click = async (button: string, count: number): Promise<ToolResult> => {
      const resolved = target()
      await focus(resolved)
      const [x, y] = coordinate()
      this.#validateCoordinates(x, y)
      this.#native.mouseMove(x, y)
      await this.#sleep(50)
      this.#native.mouseClick(x, y, button, count)
      this.#targets.trackClick(resolved)
      return ok(`Clicked (${x}, ${y})`)
    }

    if (tool === 'left_click') return click('left', 1)
    if (tool === 'right_click') return click('right', 1)
    if (tool === 'middle_click') return click('middle', 1)
    if (tool === 'double_click') return click('left', 2)
    if (tool === 'triple_click') return click('left', 3)

    if (tool === 'mouse_move') {
      const resolved = target()
      await focus(resolved)
      const [x, y] = coordinate()
      this.#validateCoordinates(x, y)
      this.#native.mouseMove(x, y)
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Moved to (${x}, ${y})`)
    }

    if (tool === 'left_click_drag') {
      const resolved = target()
      await focus(resolved)
      const to = coordinate()
      const from = args.start_coordinate ? coordinate('start_coordinate') : to
      const path = Array.isArray(args.path) ? args.path as [number, number][] : [from, to]
      for (const [x, y] of path) this.#validateCoordinates(x, y)
      this.#native.mouseMove(from[0], from[1])
      await this.#sleep(50)
      signal?.throwIfAborted()
      this.#native.mouseButton('press', from[0], from[1])
      try {
        for (const [x, y] of path.slice(1)) {
          signal?.throwIfAborted()
          this.#native.mouseDrag(x, y)
          await this.#sleep(16)
        }
      } finally { this.#native.mouseButton('release', to[0], to[1]) }
      this.#targets.trackClick(resolved)
      return ok(`Dragged to (${to[0]}, ${to[1]})`)
    }

    if (tool === 'left_mouse_down' || tool === 'left_mouse_up') {
      const resolved = target()
      await focus(resolved)
      const [x, y] = coordinate()
      this.#native.mouseButton(tool === 'left_mouse_down' ? 'press' : 'release', x, y)
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(tool === 'left_mouse_down' ? 'Mouse down' : 'Mouse up')
    }

    if (tool === 'cursor_position') {
      const position = this.#native.cursorPosition()
      return ok(`(${position.x}, ${position.y})`)
    }

    if (tool === 'scroll') {
      const resolved = target()
      await focus(resolved)
      const [x, y] = coordinate()
      const direction = string('direction')
      const amount = number('amount', 3)
      this.#native.mouseMove(x, y)
      await this.#sleep(15)
      const deltaX = typeof args.delta_x === 'number' ? args.delta_x : direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const deltaY = typeof args.delta_y === 'number' ? args.delta_y : direction === 'up' ? -amount : direction === 'down' ? amount : 0
      this.#native.mouseScroll(deltaY, deltaX)
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Scrolled ${direction} ${amount}`)
    }

    if (tool === 'type') {
      const resolved = target()
      await focus(resolved)
      const text = string('text')
      const caretPosition = typeof args.caret_position === 'string' ? args.caret_position : 'idle'
      if (caretPosition === 'start' || caretPosition === 'end') {
        this.#native.keyPress(caretPosition === 'start' ? 'home' : 'end')
        await this.#sleep(30)
      }
      if (args.clear === true || args.clear === 'true') {
        this.#native.keyPress(this.#platform === 'darwin' ? 'command+a' : 'ctrl+a')
        await this.#sleep(30)
        this.#native.keyPress('delete')
        await this.#sleep(30)
      }
      if (text.length > 100 || text.includes('\n')) await this.#pasteText(text)
      else this.#native.typeText(text)
      if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
      if (args.press_enter === true || args.press_enter === 'true') {
        this.#native.keyPress('return')
        await this.#sleep(30)
      }
      return ok('Typed')
    }

    if (tool === 'key') {
      const resolved = target()
      await focus(resolved)
      this.#native.keyPress(string('text'), args.repeat !== undefined ? number('repeat', 1) : undefined)
      if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
      return ok(`Pressed ${args.text}`)
    }

    if (tool === 'hold_key') {
      const resolved = target()
      await focus(resolved)
      if (!Array.isArray(args.keys) || !args.keys.every(key => typeof key === 'string')) {
        throw new Error('Invalid keys: expected string[]')
      }
      this.#native.holdKey(args.keys, number('duration', 1) * 1000)
      if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
      return ok('Held')
    }

    if (tool === 'read_clipboard') {
      if (this.#platform !== 'darwin' && this.#native.readClipboard) return ok(this.#native.readClipboard())
      return ok(this.#execFile('pbpaste', []).toString())
    }

    if (tool === 'write_clipboard') {
      const text = string('text')
      if (this.#platform !== 'darwin' && this.#native.writeClipboard) this.#native.writeClipboard(text)
      else this.#execFile('pbcopy', [], { input: text })
      return ok('Written')
    }

    if (tool === 'multi_select') {
      const resolved = target()
      await focus(resolved)
      const locations = Array.isArray(args.locs) ? [...args.locs] as [number, number][] : []
      if (Array.isArray(args.labels) && args.labels.length > 0 && resolved.windowId) {
        for (const label of args.labels as string[]) {
          const found = this.#resolveLabel(resolved.windowId, label)
          if (found) locations.push(found)
        }
      }
      if (locations.length === 0) return this.#noCoordinates()
      // press_ctrl advertises default true, so additive is the documented behavior.
      // The modifier has to be held across the click, which only the native
      // additive entry point does — tapping it separately selects nothing.
      const additive = args.press_ctrl !== false
      if (additive && !this.#native.mouseClickAdditive) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: 'native_capability_missing',
            capability: 'mouseClickAdditive',
            remediation: [
              'Additive selection needs a native module built from this release; rebuild it (npm run build:native) or reinstall the package.',
              'Pass press_ctrl=false to replace the selection instead of extending it.',
            ],
          }) }],
          isError: true,
        }
      }
      for (const [x, y] of locations) {
        this.#checkAbort(signal, 'multi_select aborted before the next selection')
        this.#native.mouseMove(x, y)
        await this.#sleep(50)
        this.#checkAbort(signal, 'multi_select aborted before click')
        if (additive) this.#native.mouseClickAdditive!(x, y, 'left', 1)
        else this.#native.mouseClick(x, y, 'left', 1)
        await this.#sleep(30)
      }
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Selected ${locations.length} elements`)
    }

    const resolved = target()
    await focus(resolved)
    const edits = Array.isArray(args.locs) ? [...args.locs] as [number, number, string][] : []
    if (Array.isArray(args.labels) && args.labels.length > 0 && resolved.windowId) {
      for (const [label, text] of args.labels as [string, string][]) {
        const found = this.#resolveLabel(resolved.windowId, label)
        if (found) edits.push([found[0], found[1], text])
      }
    }
    if (edits.length === 0) return this.#noCoordinates()
    for (const [x, y, text] of edits) {
      this.#checkAbort(signal, 'multi_edit aborted before the next edit')
      this.#native.mouseMove(x, y)
      await this.#sleep(50)
      this.#checkAbort(signal, 'multi_edit aborted before click')
      this.#native.mouseClick(x, y, 'left', 1)
      await this.#sleep(50)
      this.#checkAbort(signal, 'multi_edit aborted before typing')
      this.#native.typeText(text)
      await this.#sleep(30)
    }
    if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
    return ok(`Edited ${edits.length} fields`)
  }

  #validateCoordinates(x: number, y: number): void {
    const available = this.#native.listDisplays?.()
    const displays = available?.length ? available : [this.#native.getDisplaySize()]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !displays.some(display => {
      const originX = display.x ?? 0, originY = display.y ?? 0
      return x >= originX && y >= originY && x < originX + display.width && y < originY + display.height
    })) throw new Error(`Coordinates (${x}, ${y}) are outside display bounds`)

  }

  async #pasteText(text: string): Promise<void> {
    if (this.#platform !== 'darwin' && this.#native.readClipboard && this.#native.writeClipboard) {
      let saved: string | undefined
      try { saved = this.#native.readClipboard() } catch { /* best effort */ }
      try {
        this.#native.writeClipboard(text)
        this.#native.keyPress('ctrl+v')
        await this.#sleep(100)
      } finally {
        if (typeof saved === 'string') {
          // Preserve a new clipboard value copied by the user while paste settled.
          try { if (this.#native.readClipboard() === text) this.#native.writeClipboard(saved) } catch { /* best effort */ }
        }
      }
      return
    }
    let saved: string | undefined
    try { saved = this.#execFile('pbpaste', []).toString() } catch { /* best effort */ }
    try {
      this.#execFile('pbcopy', [], { input: text })
      const verified = this.#execFile('pbpaste', []).toString()
      if (verified === text) {
        this.#native.keyPress('command+v')
        await this.#sleep(100)
      } else this.#native.typeText(text)
    } finally {
      if (typeof saved === 'string') {
        try {
          if (this.#execFile('pbpaste', []).toString() === text) this.#execFile('pbcopy', [], { input: saved })
        } catch { /* best effort */ }
      }
    }
  }

  #resolveLabel(windowId: number, label: string): [number, number] | undefined {
    try {
      const elements = this.#native.findElement(windowId, undefined, label, undefined, 1)
      const values = Array.isArray(elements) ? elements : JSON.parse(JSON.stringify(elements))
      const bounds = values[0]?.bounds
      return bounds
        ? [Math.round(bounds.x + bounds.width / 2), Math.round(bounds.y + bounds.height / 2)]
        : undefined
    } catch { return undefined }
  }

  #checkAbort(signal: AbortSignal | undefined, message: string): void {
    if (signal?.aborted) throw new Error(message)
  }

  #noCoordinates(): ToolResult {
    return {
      content: [{ type: 'text', text: 'No coordinates resolved. Provide locs or valid labels.' }],
      isError: true,
    }
  }
}
