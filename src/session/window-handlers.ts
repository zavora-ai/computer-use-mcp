import type { NativeModule } from '../native.js'
import { ok, okJson, okJsonWrappedArray, type ToolResult } from '../result.js'
import { PROVIDER_WIDTH } from './constants.js'
import type { SpawnResult } from './spawn.js'
import type { TargetStateController } from './target-state.js'

export interface WindowHandlerContext {
  native: NativeModule
  targets: TargetStateController
  platform?: NodeJS.Platform
  defaultProvider: string
  signal?: AbortSignal
  sleep(milliseconds: number): Promise<void>
  sleepAbortable(milliseconds: number, signal?: AbortSignal): Promise<boolean>
  runScript(language: string, script: string, timeoutMs: number): Promise<SpawnResult>
}

function stringArg(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new Error(`Invalid ${key}: expected string`)
  return args[key]
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  return typeof args[key] === 'number' ? args[key] : fallback
}

/** App/window/display handlers with target provenance supplied explicitly. */
export async function handleWindowTool(
  tool: string,
  args: Record<string, unknown>,
  context: WindowHandlerContext,
): Promise<ToolResult | undefined> {
  const native = context.native
  const targets = context.targets
  const isWindows = (context.platform ?? process.platform) === 'win32'

  if (tool === 'get_window') {
    const windowId = numberArg(args, 'window_id', -1)
    if (windowId < 0) throw new Error('Invalid window_id: expected number')
    const window = native.getWindow(windowId)
    return window
      ? okJson(window as unknown as Record<string, unknown>)
      : { content: [{ type: 'text', text: `Window not found: ${windowId}` }], isError: true }
  }
  if (tool === 'get_cursor_window') return ok(JSON.stringify(native.getCursorWindow()))

  if (tool === 'activate_app') {
    const bundleId = stringArg(args, 'bundle_id')
    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined
    const frontmostBefore = native.getFrontmostApp()
    const result = native.activateApp(bundleId, timeoutMs ?? 2_000)
    await context.sleep(80)
    const frontmostAfter = native.getFrontmostApp()
    const activated = result.activated || frontmostAfter?.bundleId === bundleId
    if (activated) targets.update({ bundleId }, 'activation')
    let reason: string | null = null
    let suggestedRecovery: string | undefined
    if (!activated) {
      const running = native.listRunningApps().find(app => app.bundleId === bundleId)
      if (!running) reason = 'not_running'
      else if (running.isHidden) { reason = 'hidden'; suggestedRecovery = 'unhide_app' }
      else reason = 'timeout'
    }
    return ok(JSON.stringify({
      requestedBundleId: bundleId,
      frontmostBefore: frontmostBefore?.bundleId ?? null,
      frontmostAfter: frontmostAfter?.bundleId ?? null,
      activated,
      reason,
      ...(suggestedRecovery ? { suggestedRecovery } : {}),
    }))
  }

  if (tool === 'activate_window') {
    const windowId = numberArg(args, 'window_id', -1)
    if (windowId < 0) throw new Error('Invalid window_id: expected number')
    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined
    const window = native.getWindow(windowId)
    if (!window) return ok(JSON.stringify({
      windowId, activated: false,
      frontmostAfter: native.getFrontmostApp()?.bundleId ?? null,
      reason: 'window_not_found',
    }))
    const bundleId = window.bundleId
    if (bundleId) {
      if (native.listRunningApps().find(app => app.bundleId === bundleId)?.isHidden) {
        native.unhideApp(bundleId)
        await context.sleep(100)
      }
      native.activateApp(bundleId, timeoutMs ?? 2_000)
      await context.sleep(80)
    }
    const result = native.activateWindow(windowId, timeoutMs)
    await context.sleep(80)
    if (result.activated && bundleId) targets.update({ bundleId, windowId }, 'activation')
    return ok(JSON.stringify({
      windowId,
      activated: result.activated,
      frontmostAfter: native.getFrontmostApp()?.bundleId ?? null,
      reason: result.reason,
    }))
  }

  if (tool === 'open_application') {
    const bundleId = stringArg(args, 'bundle_id')
    const result = native.activateApp(bundleId, 3_000)
    if (result.activated) targets.update({ bundleId }, 'activation')
    await context.sleep(300)
    return ok(`Opened ${bundleId} (activated: ${result.activated})`)
  }
  if (tool === 'get_frontmost_app') return okJson({ app: native.getFrontmostApp() ?? null })
  if (tool === 'list_windows') {
    return okJsonWrappedArray(
      'windows', native.listWindows(typeof args.bundle_id === 'string' ? args.bundle_id : undefined),
    )
  }
  if (tool === 'list_running_apps') return ok(JSON.stringify(native.listRunningApps()))
  if (tool === 'hide_app') return ok(native.hideApp(stringArg(args, 'bundle_id')) ? 'Hidden' : 'App not found')
  if (tool === 'unhide_app') return ok(native.unhideApp(stringArg(args, 'bundle_id')) ? 'Unhidden' : 'App not found')
  if (tool === 'get_display_size') {
    return okJson(native.getDisplaySize(
      typeof args.display_id === 'number' ? args.display_id : undefined,
    ) as unknown as Record<string, unknown>)
  }
  if (tool === 'list_displays') return ok(JSON.stringify(native.listDisplays()))
  if (tool === 'wait') {
    const duration = numberArg(args, 'duration', 1)
    const cancelled = await context.sleepAbortable(duration * 1_000, context.signal)
    return cancelled ? ok(`Wait cancelled after ${args.duration}s request (aborted)`) : ok(`Waited ${args.duration}s`)
  }

  if (tool === 'resize_window') {
    const windowName = typeof args.window_name === 'string' ? args.window_name : undefined
    const windowSize = Array.isArray(args.window_size) ? args.window_size as [number, number] : undefined
    const windowLocation = Array.isArray(args.window_loc) ? args.window_loc as [number, number] : undefined
    if (!windowSize && !windowLocation) {
      return { content: [{ type: 'text', text: 'window_size or window_loc required' }], isError: true }
    }
    let language: string
    let script: string
    if (isWindows) {
      const windowId = typeof args.window_id === 'number' ? args.window_id : undefined
      const target = windowId
        ? `$hwnd = [IntPtr]${windowId}`
        : windowName
          ? `$hwnd = (Get-Process -Name '${windowName.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowHandle; if (-not $hwnd -or $hwnd -eq 0) { $hwnd = (Get-Process | Where-Object { $_.MainWindowTitle -like '*${windowName}*' } | Select-Object -First 1).MainWindowHandle }`
          : `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}'; $hwnd = [W]::GetForegroundWindow()`
      let move: string
      if (windowSize && windowLocation) {
        move = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class MW{[DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);}'; [MW]::MoveWindow($hwnd, ${windowLocation[0]}, ${windowLocation[1]}, ${windowSize[0]}, ${windowSize[1]}, $true)`
      } else if (windowSize) {
        move = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class GR{[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);[StructLayout(LayoutKind.Sequential)]public struct RECT{public int l,t,r,b;} [DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool rp);}'; $r = New-Object GR+RECT; [GR]::GetWindowRect($hwnd, [ref]$r); [GR]::MoveWindow($hwnd, $r.l, $r.t, ${windowSize[0]}, ${windowSize[1]}, $true)`
      } else {
        move = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class GR2{[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);[StructLayout(LayoutKind.Sequential)]public struct RECT{public int l,t,r,b;} [DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool rp);}'; $r = New-Object GR2+RECT; [GR2]::GetWindowRect($hwnd, [ref]$r); [GR2]::MoveWindow($hwnd, ${windowLocation![0]}, ${windowLocation![1]}, $r.r-$r.l, $r.b-$r.t, $true)`
      }
      language = 'powershell'
      script = `${target}; if ($hwnd -and $hwnd -ne 0) { ${move}; 'Resized' } else { 'Window not found' }`
    } else {
      const target = windowName
        ? `tell application "${windowName}"`
        : 'tell application (path to frontmost application as text)'
      const parts = [
        ...(windowLocation ? [`set position of front window to {${windowLocation[0]}, ${windowLocation[1]}}`] : []),
        ...(windowSize ? [`set size of front window to {${windowSize[0]}, ${windowSize[1]}}`] : []),
      ]
      language = 'applescript'
      script = `${target}\n${parts.join('\n')}\nend tell`
    }
    const result = await context.runScript(language, script, 10_000)
    return result.code === 0 ? ok(isWindows ? result.stdout.trim() : 'Resized')
      : { content: [{ type: 'text', text: result.stderr || result.stdout || 'resize failed' }], isError: true }
  }

  if (tool === 'snapshot') {
    const content: ToolResult['content'] = []
    const frontmost = native.getFrontmostApp()
    const windows = native.listWindows()
    const display = native.getDisplaySize()
    const apps = native.listRunningApps()
    let desktop = `Display: ${display.width}x${display.height} (scale: ${display.scaleFactor})\n`
      + `Frontmost: ${frontmost?.bundleId ?? 'unknown'} — ${frontmost?.displayName ?? ''}\n`
      + `Windows: ${Array.isArray(windows) ? windows.length : 0}\n`
      + `Running apps: ${Array.isArray(apps) ? apps.length : 0}`
    if (Array.isArray(windows)) {
      desktop += `\n\nWindows:\n${windows.map(window =>
        `  ${window.windowId} | ${window.bundleId} | ${window.title ?? '(no title)'}`).join('\n')}`
    }
    if (args.use_vision !== false && Array.isArray(windows)) {
      const focused = windows.find(window => window.isFocused)
      if (focused) {
        try { desktop += `\n\nUI Tree (${focused.bundleId}):\n${JSON.stringify(native.getUiTree(focused.windowId, 5)).slice(0, 4000)}` }
        catch { /* semantic capture is best effort */ }
      }
    }
    content.push({ type: 'text', text: desktop })
    if (args.use_vision) {
      const width = typeof args.width === 'number' ? args.width : PROVIDER_WIDTH[context.defaultProvider] ?? 1024
      const screenshot = native.takeScreenshot(width, undefined, 80, undefined, undefined)
      if (screenshot.base64) {
        const annotate = args.use_annotation && Array.isArray(windows)
        const grid = Array.isArray(args.grid_lines) ? args.grid_lines as [number, number] : undefined
        if (annotate || grid) {
          const annotations = annotate ? windows.filter(window => window.bounds).map(window => ({
            x: Math.round(window.bounds.x * screenshot.width / display.width),
            y: Math.round(window.bounds.y * screenshot.height / display.height),
            width: Math.round(window.bounds.width * screenshot.width / display.width),
            height: Math.round(window.bounds.height * screenshot.height / display.height),
          })) : null
          const image = native.annotateImage(
            screenshot.base64, annotations ? JSON.stringify(annotations) : null,
            grid?.[0] ?? null, grid?.[1] ?? null, 80,
          )
          content.push({ type: 'image', data: image.base64, mimeType: image.mimeType })
          content.push({ type: 'text', text: `${image.width}x${image.height}` })
        } else {
          content.push({ type: 'image', data: screenshot.base64, mimeType: screenshot.mimeType })
          content.push({ type: 'text', text: `${screenshot.width}x${screenshot.height}` })
        }
        if (annotate) {
          content.push({ type: 'text', text: `\nAnnotations:\n${windows.filter(window => window.bounds)
            .map(window => `[${window.bundleId}] (${window.bounds.x},${window.bounds.y}) ${window.bounds.width}x${window.bounds.height}`)
            .join('\n')}` })
        }
      }
    }
    return { content }
  }

  return undefined
}
