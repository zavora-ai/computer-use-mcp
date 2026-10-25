import type { NativeModule } from '../native.js'
import { offThread } from './native-async.js'
import { errJson, ok, okJson, okJsonWrappedArray, platformUnsupported, type ToolResult } from '../result.js'
import { PROVIDER_WIDTH } from './constants.js'
import type { SpawnResult } from './spawn.js'
import type { TargetStateController } from './target-state.js'
import { listClassifiedWindows, resolveAppWindow } from './window-select.js'
import type { UserActivityGuard } from './user-activity.js'

export interface WindowHandlerContext {
  native: NativeModule
  targets: TargetStateController
  platform?: NodeJS.Platform
  defaultProvider: string
  signal?: AbortSignal
  sleep(milliseconds: number): Promise<void>
  sleepAbortable(milliseconds: number, signal?: AbortSignal): Promise<boolean>
  runScript(language: string, script: string, timeoutMs: number): Promise<SpawnResult>
  /** v7.5 (R4): refuse activation while the user is active (unless force). */
  guard?: UserActivityGuard
  /** The clock for waits (tests advance it); `Date.now` by default. */
  now?: () => number
}

function stringArg(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new Error(`Invalid ${key}: expected string`)
  return args[key]
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  return typeof args[key] === 'number' ? args[key] : fallback
}

/** How long `open_application` waits for a launched Linux app to show a window or at least a process. */
export const LAUNCH_WAIT_MS = 15_000
/** Once the process runs, how long to keep looking for a window that this desktop lets us list. */
export const LAUNCH_WINDOW_GRACE_MS = 3_000

/**
 * Start a Linux app from its desktop entry and wait for it (7.7.x). A window that can be listed is activated and the
 * result is verified. On GNOME Wayland only XWayland windows can be listed, so an app that draws natively (Firefox,
 * GNOME's own apps) is reported launched with its process running and the effect unverified: look before acting.
 */
async function launchAndWait(bundleId: string, context: WindowHandlerContext): Promise<ToolResult> {
  const { native, targets } = context
  const launched = native.launchApp!(bundleId)
  if (!launched.launched) {
    return errJson({
      error: 'app_not_installed', bundle_id: bundleId, activated: false, reason: launched.reason ?? 'not_installed',
      searched: launched.searched,
      remediation: ['No desktop entry matches that name. Use discover_applications to find the installed id (for example firefox_firefox for the snap).'],
    })
  }
  const names = [...new Set([bundleId, launched.process, launched.desktopId].filter((name): name is string => !!name))]
  const now = context.now ?? Date.now
  const started = now()
  let processSince: number | undefined
  while (now() - started < LAUNCH_WAIT_MS) {
    if (context.signal?.aborted) throw new Error('open_application was cancelled while the app was starting')
    for (const name of names) {
      const window = await offThread(native, 'activateApp', name, 1_000)
      if (window.activated) {
        targets.update({ bundleId: name }, 'activation')
        return { ...okJson({ launched: true, activated: true, bundle_id: name, desktop_entry: launched.desktopEntry }), contract: { effect: 'verified' } }
      }
    }
    if (processSince === undefined && launched.process && native.linuxProcessRunning?.(launched.process)) processSince = now()
    if (processSince !== undefined && now() - processSince >= LAUNCH_WINDOW_GRACE_MS) {
      return {
        ...okJson({
          launched: true, activated: false, process_running: true, bundle_id: bundleId, desktop_entry: launched.desktopEntry,
          note: `${launched.name ?? bundleId} is running, but this desktop does not let programs list its window (a native Wayland window on GNOME), so focus was not confirmed. Take a screenshot before acting.`,
        }),
        contract: { effect: 'unverified' },
      }
    }
    await context.sleep(500)
  }
  return errJson({
    error: 'launch_timeout', bundle_id: bundleId, launched: true, activated: false, desktop_entry: launched.desktopEntry,
    reason: launched.process ? `no window and no ${launched.process} process within ${LAUNCH_WAIT_MS / 1000} s` : 'no window appeared',
    remediation: ['The launcher ran but the app did not appear. Take a screenshot (it may be asking something), or wait_for_window.'],
  })
}

/**
 * Quote a caller-supplied value as a PowerShell single-quoted literal. Doubling
 * `'` is the only escape PowerShell recognizes there, and no other character is
 * interpreted, so this cannot be escaped out of.
 */
export function powerShellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Quote a caller-supplied value as an AppleScript string literal. Backslash is
 * escaped first so the escapes added afterwards are not re-escaped. Newlines
 * become `\n` escapes so the literal always stays on one line and cannot be
 * terminated early by the payload.
 */
export function appleScriptQuoted(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  return `"${escaped}"`
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
  const platform = context.platform ?? process.platform

  if (tool === 'get_window') {
    const windowId = numberArg(args, 'window_id', -1)
    if (windowId < 0) throw new Error('Invalid window_id: expected number')
    const window = native.getWindow(windowId)
    return window
      ? okJson(window as unknown as Record<string, unknown>)
      : { content: [{ type: 'text', text: `Window not found: ${windowId}` }], isError: true }
  }
  if (tool === 'get_cursor_window') return ok(JSON.stringify(native.getCursorWindow()))

  // v7.5 (R4): taking focus from the user while they type is refused unless forced.
  const guardActivation = (bundleId: string | null | undefined, wouldDo: string) => {
    if (!context.guard || args.force === true) return
    if (bundleId && native.getFrontmostApp()?.bundleId === bundleId) return
    context.guard.check({ tool, wouldDo, pidPossible: false })
  }

  if (tool === 'activate_app') {
    const bundleId = stringArg(args, 'bundle_id')
    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined
    guardActivation(bundleId, `activate ${bundleId}`)
    const frontmostBefore = native.getFrontmostApp()
    const result = await offThread(native, 'activateApp', bundleId, timeoutMs ?? 2_000)
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
    const payload = {
      requestedBundleId: bundleId,
      frontmostBefore: frontmostBefore?.bundleId ?? null,
      frontmostAfter: frontmostAfter?.bundleId ?? null,
      activated,
      reason,
      ...(suggestedRecovery ? { suggestedRecovery } : {}),
    }
    // 7.7.0 (K1): an activation confirmed by the frontmost app is verified; one that did not happen says so.
    return { ...okJson(payload), contract: activated ? { effect: 'verified' } : {
      effect: 'no_visible_change',
      hint: suggestedRecovery === 'unhide_app' ? 'The app is hidden: unhide_app, then activate it again.'
        : reason === 'not_running' ? 'The app is not running: open_application starts it.' : 'The app did not come to the front; check what is in front, then retry.',
    } }
  }

  if (tool === 'activate_window') {
    const windowId = numberArg(args, 'window_id', -1)
    if (windowId < 0) throw new Error('Invalid window_id: expected number')
    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined
    const window = native.getWindow(windowId)
    // 7.6.1: an action that did nothing is an error, not prose.
    if (!window) return errJson({
      error: 'window_not_found', windowId, activated: false,
      frontmostAfter: native.getFrontmostApp()?.bundleId ?? null,
      reason: 'window_not_found',
      remediation: ['list_windows to find a current window id; the window may have closed.'],
    })
    const bundleId = window.bundleId
    guardActivation(bundleId, `raise window ${windowId}${bundleId ? ` of ${bundleId}` : ''}`)
    if (bundleId) {
      if (native.listRunningApps().find(app => app.bundleId === bundleId)?.isHidden) {
        native.unhideApp(bundleId)
        await context.sleep(100)
      }
      await offThread(native, 'activateApp', bundleId, timeoutMs ?? 2_000)
      await context.sleep(80)
    }
    const result = await offThread(native, 'activateWindow', windowId, timeoutMs)
    await context.sleep(80)
    if (result.activated && bundleId) targets.update({ bundleId, windowId }, 'activation')
    const payload = {
      windowId,
      activated: result.activated,
      frontmostAfter: native.getFrontmostApp()?.bundleId ?? null,
      reason: result.reason,
    }
    return result.activated ? { ...okJson(payload), contract: { effect: 'verified' } } : errJson({ error: 'activation_failed', ...payload })
  }

  if (tool === 'open_application') {
    const bundleId = stringArg(args, 'bundle_id')
    guardActivation(bundleId, `open and focus ${bundleId}`)
    const result = await offThread(native, 'activateApp', bundleId, 3_000)
    // 7.7.x (Linux): an app with no window is started from its desktop entry, then waited for.
    if (!result.activated && (result as { reason?: string }).reason === 'not_running' && typeof native.launchApp === 'function') {
      return await launchAndWait(bundleId, context)
    }
    if (result.activated) targets.update({ bundleId }, 'activation')
    await context.sleep(300)
    if (!result.activated) {
      // 7.6.1: "Opened X (activated: false)" was a success result for an action that did nothing.
      const running = native.listRunningApps().find(app => app.bundleId === bundleId)
      return errJson({
        error: 'activation_failed', bundle_id: bundleId, activated: false,
        reason: (result as { reason?: string }).reason ?? (!running ? 'not_running' : running.isHidden ? 'hidden' : 'timeout'),
        frontmostAfter: native.getFrontmostApp()?.bundleId ?? null,
        remediation: [!running
          ? 'The app is not running and could not be launched; check the bundle id with discover_applications.'
          : 'Use activate_app for diagnostics, unhide_app if it is hidden, or wait_for_window for its window.'],
      })
    }
    return { ...ok(`Opened ${bundleId} (activated: true)`), contract: { effect: 'verified' } }
  }
  if (tool === 'get_frontmost_app') return okJson({ app: native.getFrontmostApp() ?? null })
  if (tool === 'list_windows') {
    // v7.5: each window carries `kind` (main/document/dialog/panel/toast/other),
    // `area` and `kindSource`, so a toast is never mistaken for a blocking modal.
    return okJsonWrappedArray(
      'windows', listClassifiedWindows(native, typeof args.bundle_id === 'string' ? args.bundle_id : undefined),
    )
  }
  if (tool === 'list_running_apps') return ok(JSON.stringify(native.listRunningApps()))
  if (tool === 'hide_app' || tool === 'unhide_app') {
    const bundleId = stringArg(args, 'bundle_id')
    const done = tool === 'hide_app' ? native.hideApp(bundleId) : native.unhideApp(bundleId)
    // 7.6.1: "App not found" used to be a success result.
    return done ? ok(tool === 'hide_app' ? 'Hidden' : 'Unhidden')
      : errJson({ error: 'app_not_found', bundle_id: bundleId, remediation: ['list_running_apps or discover_applications to find the running app\'s id.'] })
  }
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
    // The non-Windows path is AppleScript, which Linux has no interpreter for.
    // Say so instead of emitting a script the scripting service will reject.
    if (platform === 'linux') {
      return platformUnsupported('resize_window', 'macOS and Windows',
        'On Linux, move or resize windows with run_script (bash) using wmctrl or xdotool.')
    }
    let language: string
    let script: string
    if (isWindows) {
      const windowId = typeof args.window_id === 'number' ? args.window_id : undefined
      const quotedName = windowName !== undefined ? powerShellSingleQuoted(windowName) : undefined
      const target = windowId
        ? `$hwnd = [IntPtr]${windowId}`
        : quotedName
          ? `$hwnd = (Get-Process -Name ${powerShellSingleQuoted(windowName!.replace(/\.exe$/i, ''))} -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowHandle; if (-not $hwnd -or $hwnd -eq 0) { $hwnd = (Get-Process | Where-Object { $_.MainWindowTitle -like ${powerShellSingleQuoted(`*${windowName}*`)} } | Select-Object -First 1).MainWindowHandle }`
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
        ? `tell application ${appleScriptQuoted(windowName)}`
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
    // v7.5 (R1): an explicit target means its window (the app's main window, or the
    // one titled target_title) for the UI tree and the capture.
    const targetWindowId = typeof args.target_window_id === 'number' ? args.target_window_id
      : typeof args.target_app === 'string' && args.target_app
        ? resolveAppWindow(native, args.target_app, typeof args.target_title === 'string' && args.target_title ? args.target_title : undefined)?.windowId
        : undefined
    if (args.use_vision === true && Array.isArray(windows)) {
      const focused = targetWindowId !== undefined
        ? windows.find(window => window.windowId === targetWindowId)
        : windows.find(window => window.isFocused)
      if (focused) {
        try { desktop += `\n\nUI Tree (${focused.bundleId}):\n${JSON.stringify(await offThread(native, 'getUiTree', focused.windowId, 5)).slice(0, 4000)}` }
        catch { /* semantic capture is best effort */ }
      }
    }
    content.push({ type: 'text', text: desktop })
    if (args.use_vision) {
      const width = typeof args.width === 'number' ? args.width : PROVIDER_WIDTH[context.defaultProvider] ?? 1024
      const screenshot = await offThread(native, 'takeScreenshot', width, undefined, 80, undefined, targetWindowId)
      if (screenshot.base64) {
        // Window annotations are drawn in screen space, so only on a screen capture.
        const annotate = args.use_annotation && Array.isArray(windows) && targetWindowId === undefined
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
