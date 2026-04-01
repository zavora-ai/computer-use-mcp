/**
 * Native NAPI module loader — loads the compiled .node addon.
 * All functions run in-process via CGEvent/NSWorkspace.
 */

import { createRequire } from 'module'
import { join } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const ADDON_PATH = join(fileURLToPath(import.meta.url), '..', '..', 'computer-use-napi.node')

export interface NativeModule {
  // Mouse
  mouseMove(x: number, y: number): void
  mouseClick(x: number, y: number, button: string, count: number): void
  mouseButton(action: string, x: number, y: number): void
  mouseScroll(dy: number, dx: number): void
  mouseDrag(x: number, y: number): void
  cursorPosition(): { x: number; y: number }
  // Keyboard
  keyPress(combo: string, repeat?: number): void
  typeText(text: string): void
  holdKey(keys: string[], durationMs: number): void
  // Apps
  activateApp(bundleId: string, timeoutMs?: number): { bundleId: string; activated: boolean; displayName?: string }
  getFrontmostApp(): { bundleId: string; displayName: string; pid: number } | null
  listRunningApps(): Array<{ bundleId: string; displayName: string; pid: number; isHidden: boolean }>
  hideApp(bundleId: string): boolean
  unhideApp(bundleId: string): boolean
  // Display
  getDisplaySize(displayId?: number): { width: number; height: number; pixelWidth: number; pixelHeight: number; scaleFactor: number; displayId: number }
  listDisplays(): Array<{ width: number; height: number; scaleFactor: number; displayId: number }>
  // Screenshot
  takeScreenshot(): { base64: string; width: number; height: number; mimeType: string }
}

let cached: NativeModule | undefined

export function loadNative(): NativeModule {
  if (cached) return cached
  cached = require(ADDON_PATH) as NativeModule
  return cached
}
