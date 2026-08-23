import type { NativeModule } from '../native.js'
import { ok, okJsonWrappedScalar, type ToolResult } from '../result.js'
import type { SpawnBounded } from './spawn.js'

type Backend = 'auto' | 'yabai' | 'mission_control' | 'cgs'

/** Stateful virtual-desktop handler with explicit platform and subprocess dependencies. */
export class SpacesHandler {
  readonly #native: NativeModule
  readonly #spawn: SpawnBounded
  readonly #sleep: (milliseconds: number) => Promise<void>
  readonly #platform: NodeJS.Platform
  readonly #env: NodeJS.ProcessEnv
  #cachedAgentSpaceId: number | undefined

  constructor(options: {
    native: NativeModule
    spawnBounded: SpawnBounded
    sleep(milliseconds: number): Promise<void>
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
  }) {
    this.#native = options.native
    this.#spawn = options.spawnBounded
    this.#sleep = options.sleep
    this.#platform = options.platform ?? process.platform
    this.#env = options.env ?? process.env
  }

  #backend(): Backend {
    const value = (this.#env.COMPUTER_USE_SPACES_BACKEND ?? 'auto').toLowerCase()
    return value === 'yabai' || value === 'mission_control' || value === 'cgs' ? value : 'auto'
  }

  async #yabaiAvailable(): Promise<boolean> {
    if (this.#platform === 'win32' || this.#platform === 'linux') return false
    return (await this.#spawn('yabai', ['--version'], 3_000)).code === 0
  }

  async #yabaiSpaces(): Promise<Array<Record<string, unknown>>> {
    const result = await this.#spawn('yabai', ['-m', 'query', '--spaces'], 5_000)
    if (result.code !== 0) return []
    try {
      const value: unknown = JSON.parse(result.stdout)
      return Array.isArray(value) ? value as Array<Record<string, unknown>> : []
    } catch { return [] }
  }

  #yabaiFailure(error: string, reason: string): Record<string, unknown> {
    const normalized = reason.trim() || error
    const needsAddition = /scripting[- ]addition/i.test(normalized)
    return {
      error, reason: normalized, backend: 'yabai',
      ...(needsAddition ? {
        requires_scripting_addition: true,
        setup_commands: ['sudo yabai --load-sa'],
        sip_note: 'On SIP-enabled Macs, yabai scripting-addition setup can require Recovery-mode SIP configuration before load succeeds. Run the command with --load-sa; running yabai as root without that flag is intentionally rejected.',
      } : {}),
    }
  }

  async #createWithYabai(): Promise<Record<string, unknown> | undefined> {
    if (!(await this.#yabaiAvailable())) return undefined
    const before = await this.#yabaiSpaces()
    const ids = new Set(before.map(space => space.id).filter(id => typeof id === 'number'))
    const result = await this.#spawn('yabai', ['-m', 'space', '--create'], 10_000)
    await this.#sleep(700)
    const after = await this.#yabaiSpaces()
    const created = after.find(space => typeof space.id === 'number' && !ids.has(space.id))
    if (result.code !== 0 || !created) return {
      ...this.#yabaiFailure('yabai_create_failed', result.stderr || result.stdout || 'no_new_space_detected'),
      before_count: before.length, after_count: after.length,
    }
    return {
      supported: true, backend: 'yabai', spaceId: created.id,
      index: created.index, uuid: created.uuid, created: true, attached: true,
      note: 'Created visible Space via yabai.',
    }
  }

  async #createWithMissionControl(): Promise<Record<string, unknown> | undefined> {
    if (this.#platform !== 'darwin' || typeof this.#native.listSpaces !== 'function') return undefined
    const before = this.#native.listSpaces()
    const beforeSpaces = Array.isArray(before.displays)
      ? before.displays.flatMap(display => Array.isArray(display.spaces) ? display.spaces : []) : []
    const ids = new Set(beforeSpaces.map(space => space.id))
    const display = this.#native.getDisplaySize()
    if (!display.width || !display.height) return undefined
    const candidates: Array<[number, number]> = [
      [Math.max(0, display.width - 33), 72], [Math.max(0, display.width - 60), 85],
      [Math.max(0, display.width - 80), 85], [Math.max(0, display.width - 120), 72],
    ]
    let afterSpaces = beforeSpaces
    let created: (typeof beforeSpaces)[number] | undefined
    for (const [x, y] of candidates) {
      await this.#spawn('open', ['-a', 'Mission Control'], 5_000)
      await this.#sleep(1_500)
      this.#native.mouseMove(Math.round(display.width / 2), 200)
      await this.#sleep(700)
      this.#native.mouseMove(x, 200)
      await this.#sleep(300)
      this.#native.mouseMove(x, y)
      await this.#sleep(900)
      this.#native.mouseClick(x, y, 'left', 1)
      await this.#sleep(1_400)
      this.#native.keyPress('control+up')
      await this.#sleep(1_200)
      const after = this.#native.listSpaces()
      afterSpaces = Array.isArray(after.displays)
        ? after.displays.flatMap(item => Array.isArray(item.spaces) ? item.spaces : []) : []
      created = afterSpaces.find(space => !ids.has(space.id))
      if (created) break
    }
    return created ? {
      supported: true, backend: 'mission_control', spaceId: created.id, uuid: created.uuid,
      created: true, attached: true, note: 'Created visible Space via Mission Control gesture.',
    } : {
      error: 'mission_control_create_failed', backend: 'mission_control',
      beforeCount: beforeSpaces.length, afterCount: afterSpaces.length, reason: 'space_count_unchanged',
    }
  }

  async #createMac(): Promise<Record<string, unknown>> {
    const backend = this.#backend()
    if (backend === 'yabai' || backend === 'auto') {
      const result = await this.#createWithYabai()
      if (result && !('error' in result)) return result
      if (backend === 'yabai') return result ?? { error: 'yabai_unavailable', backend: 'yabai' }
    }
    if (backend === 'mission_control' || backend === 'auto') {
      const result = await this.#createWithMissionControl()
      if (result && !('error' in result)) return result
      if (backend === 'mission_control') return result ?? { error: 'mission_control_unavailable', backend: 'mission_control' }
    }
    return { ...this.#native.createAgentSpace(), backend: 'cgs_internal' }
  }

  async #moveMac(windowId: number, spaceId: number): Promise<Record<string, unknown>> {
    const backend = this.#backend()
    if (backend === 'yabai' || backend === 'auto') {
      if (await this.#yabaiAvailable()) {
        const target = (await this.#yabaiSpaces()).find(space => space.id === spaceId)
        const selector = target?.index ?? spaceId
        try { this.#native.activateWindow(windowId) } catch { /* best effort */ }
        await this.#sleep(250)
        const result = await this.#spawn('yabai', ['-m', 'window', '--space', String(selector)], 10_000)
        if (result.code === 0) return {
          moved: true, verified: true, backend: 'yabai', window_id: windowId, space_id: spaceId, selector,
        }
        if (backend === 'yabai') return {
          moved: false, ...this.#yabaiFailure('yabai_move_failed', result.stderr || result.stdout || 'yabai_move_failed'),
        }
      } else if (backend === 'yabai') return { moved: false, reason: 'yabai_unavailable', backend: 'yabai' }
    }
    return { ...this.#native.moveWindowToSpace(windowId, spaceId), backend: 'cgs_internal' }
  }

  async #destroyMac(spaceId: number): Promise<Record<string, unknown>> {
    const backend = this.#backend()
    if (backend === 'yabai' || backend === 'auto') {
      if (await this.#yabaiAvailable()) {
        const target = (await this.#yabaiSpaces()).find(space => space.id === spaceId)
        const selector = target?.index ?? spaceId
        const result = await this.#spawn('yabai', ['-m', 'space', String(selector), '--destroy'], 10_000)
        if (result.code === 0) return { destroyed: true, backend: 'yabai', space_id: spaceId, selector }
        if (backend === 'yabai') return {
          destroyed: false, ...this.#yabaiFailure('yabai_destroy_failed', result.stderr || result.stdout || 'yabai_destroy_failed'),
        }
      } else if (backend === 'yabai') return { destroyed: false, reason: 'yabai_unavailable', backend: 'yabai' }
    }
    return { ...this.#native.destroySpace(spaceId), backend: 'cgs_internal' }
  }

  async handle(tool: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
    if (tool === 'list_spaces') return ok(JSON.stringify(this.#native.listSpaces()))
    if (tool === 'get_active_space') return okJsonWrappedScalar('active_space_id', this.#native.getActiveSpace())
    if (tool === 'create_agent_space') {
      if (this.#platform === 'win32') {
        const before = this.#native.listSpaces().displays?.[0]?.spaces?.length ?? 0
        this.#native.keyPress('ctrl+win+d')
        await this.#sleep(500)
        const spaces = this.#native.listSpaces().displays?.[0]?.spaces ?? []
        return ok(JSON.stringify({
          created: spaces.length > before, space_id: spaces.at(-1)?.uuid ?? null,
          name: `Desktop ${spaces.length}`, total_desktops: spaces.length,
          note: 'Created via Ctrl+Win+D keyboard shortcut. You are now on the new desktop.',
        }))
      }
      if (this.#cachedAgentSpaceId !== undefined) return ok(JSON.stringify({
        space_id: this.#cachedAgentSpaceId, created: false, cached: true,
      }))
      const result = await this.#createMac()
      if ('error' in result || result.supported === false) return {
        content: [{ type: 'text', text: JSON.stringify({
          error: 'spaces_api_unavailable', reason: result.reason ?? result.error ?? 'api_unavailable',
          backend: result.backend, requires_scripting_addition: result.requires_scripting_addition,
          setup_commands: result.setup_commands, sip_note: result.sip_note,
          before_count: result.before_count, after_count: result.after_count,
          workaround: 'Install/start yabai, grant Accessibility, and install/load yabai scripting-addition for visible Space create/destroy. Alternatively allow Mission Control gesture automation. CGS-only Space creation can be orphaned on SIP-enabled Macs.',
        }) }], isError: true,
      }
      if (typeof result.spaceId === 'number') this.#cachedAgentSpaceId = result.spaceId
      return ok(JSON.stringify({
        space_id: result.spaceId, created: result.created ?? true, attached: result.attached ?? false,
        backend: result.backend, index: result.index, uuid: result.uuid, note: result.note,
      }))
    }
    if (tool === 'move_window_to_space') {
      const windowId = typeof args.window_id === 'number' ? args.window_id : -1
      const spaceId = typeof args.space_id === 'number' ? args.space_id : -1
      if (windowId < 0) throw new Error('Invalid window_id: expected number')
      if (spaceId < 0) throw new Error('Invalid space_id: expected number')
      const result = await this.#moveMac(windowId, spaceId)
      if (!result.moved) return {
        content: [{ type: 'text', text: JSON.stringify({
          error: result.reason ?? 'move_failed', window_id: windowId, space_id: spaceId,
          backend: result.backend, requires_scripting_addition: result.requires_scripting_addition,
          setup_commands: result.setup_commands, sip_note: result.sip_note,
        }) }], isError: true,
      }
      return ok(JSON.stringify({
        window_id: windowId, space_id: spaceId, moved: true, verified: result.verified ?? false,
        backend: result.backend, selector: result.selector,
        window_on_screen_before: result.window_on_screen_before,
        window_on_screen_after: result.window_on_screen_after, note: result.note,
      }))
    }
    if (tool === 'remove_window_from_space') {
      const windowId = typeof args.window_id === 'number' ? args.window_id : -1
      const spaceId = typeof args.space_id === 'number' ? args.space_id : -1
      if (windowId < 0) throw new Error('Invalid window_id: expected number')
      if (spaceId < 0) throw new Error('Invalid space_id: expected number')
      const result = this.#native.removeWindowFromSpace(windowId, spaceId)
      return result.removed
        ? ok(JSON.stringify({ window_id: windowId, space_id: spaceId, removed: true }))
        : { content: [{ type: 'text', text: JSON.stringify({ error: result.reason ?? 'remove_failed' }) }], isError: true }
    }
    if (tool === 'destroy_space') {
      if (this.#platform === 'win32') {
        const before = this.#native.listSpaces().displays?.[0]?.spaces?.length ?? 0
        this.#native.keyPress('ctrl+win+f4')
        await this.#sleep(500)
        const after = this.#native.listSpaces().displays?.[0]?.spaces?.length ?? 0
        return ok(JSON.stringify({
          destroyed: after < before, remaining_desktops: after,
          note: 'Closed current desktop via Ctrl+Win+F4. Windows moved to adjacent desktop.',
        }))
      }
      const spaceId = typeof args.space_id === 'number' ? args.space_id : -1
      if (spaceId < 0) throw new Error('Invalid space_id: expected number')
      const result = await this.#destroyMac(spaceId)
      if (!result.destroyed) return {
        content: [{ type: 'text', text: JSON.stringify({
          error: result.reason ?? 'destroy_failed', backend: result.backend,
          requires_scripting_addition: result.requires_scripting_addition,
          setup_commands: result.setup_commands, sip_note: result.sip_note,
        }) }], isError: true,
      }
      if (this.#cachedAgentSpaceId === spaceId) this.#cachedAgentSpaceId = undefined
      return ok(JSON.stringify({
        space_id: spaceId, destroyed: true, backend: result.backend, selector: result.selector,
      }))
    }
    return undefined
  }
}
