process.env.COMPUTER_USE_PROFILE ??= 'full'
process.env.COMPUTER_USE_STATUS_CARD = 'false'
const { createSession } = await import('/Users/jameskaranja/Developer/projects/mcp-servers/computer-use-mcp/dist/session.js')
const { createComputerUseServer } = await import('/Users/jameskaranja/Developer/projects/mcp-servers/computer-use-mcp/dist/server.js')
const { connectInProcess } = await import('/Users/jameskaranja/Developer/projects/mcp-servers/computer-use-mcp/dist/client.js')
function createMockNative(overrides = {}) {
  let frontmost = { bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 }
  let runningApps = [
    { bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1, isHidden: false },
  ]
  const windows = [
    {
      windowId: 1001, bundleId: 'com.apple.Safari', displayName: 'Safari', pid: 2,
      title: 'GitHub', bounds: { x: 0, y: 0, width: 800, height: 600 },
      isOnScreen: true, isFocused: false, displayId: 1,
    },
    {
      windowId: 1002, bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1,
      title: 'bash', bounds: { x: 100, y: 100, width: 600, height: 400 },
      isOnScreen: true, isFocused: true, displayId: 1,
    },
  ]
  const calls = []

  const mock = {
    calls,
    setFrontmost(app) { frontmost = app },
    setRunningApps(apps) { runningApps = apps },
    setWindows(w) { windows.splice(0, windows.length, ...w) },
    getWindows() { return windows },
    mouseMove() { calls.push({ method: 'mouseMove', args: [...arguments] }) },
    mouseClick() { calls.push({ method: 'mouseClick', args: [...arguments] }) },
    mouseButton() { calls.push({ method: 'mouseButton', args: [...arguments] }) },
    mouseScroll() { calls.push({ method: 'mouseScroll', args: [...arguments] }) },
    mouseDrag() { calls.push({ method: 'mouseDrag', args: [...arguments] }) },
    cursorPosition() { calls.push({ method: 'cursorPosition' }); return { x: 100, y: 100 } },
    keyPress() { calls.push({ method: 'keyPress', args: [...arguments] }) },
    typeText() { calls.push({ method: 'typeText', args: [...arguments] }) },
    holdKey() { calls.push({ method: 'holdKey', args: [...arguments] }) },
    activateApp(bundleId, timeoutMs) {
      calls.push({ method: 'activateApp', args: [bundleId, timeoutMs] })
      frontmost = { bundleId, displayName: bundleId, pid: 1 }
      return { bundleId, activated: true, displayName: bundleId }
    },
    getFrontmostApp() { calls.push({ method: 'getFrontmostApp' }); return frontmost },
    listRunningApps() { calls.push({ method: 'listRunningApps' }); return runningApps },
    hideApp(bundleId) { calls.push({ method: 'hideApp', args: [bundleId] }); return true },
    unhideApp(bundleId) { calls.push({ method: 'unhideApp', args: [bundleId] }); return true },
    getWindow(windowId) {
      calls.push({ method: 'getWindow', args: [windowId] })
      return windows.find(w => w.windowId === windowId) ?? null
    },
    getCursorWindow() {
      calls.push({ method: 'getCursorWindow' })
      return windows[0] ?? null
    },
    activateWindow(windowId, timeoutMs) {
      calls.push({ method: 'activateWindow', args: [windowId, timeoutMs] })
      return { windowId, activated: true, reason: null }
    },
    listWindows(bundleId) {
      calls.push({ method: 'listWindows', args: [bundleId] })
      return bundleId ? windows.filter(w => w.bundleId === bundleId) : windows
    },
    getDisplaySize() {
      return { width: 1440, height: 900, pixelWidth: 2880, pixelHeight: 1800, scaleFactor: 2, displayId: 1 }
    },
    listDisplays() { return [] },
    takeScreenshot(width, targetApp, quality, previousHash, windowId) {
      calls.push({ method: 'takeScreenshot', args: [width, targetApp, quality, previousHash, windowId] })
      return {
        base64: 'aGVsbG8=',
        width: 640,
        height: 400,
        mimeType: 'image/jpeg',
        hash: 'hash-1',
        unchanged: false,
      }
    },
    ...overrides,
  }

  return mock
}
let captures = 0
const native = createMockNative({
  takeScreenshot(_w, _app, _q, previousHash) {
    captures += 1
    if (previousHash === 'same') return { width: 800, height: 500, mimeType: 'image/jpeg', hash: 'same', unchanged: true }
    return { base64: 'ZnJhbWU=', width: 800, height: 500, mimeType: 'image/jpeg', hash: 'same', unchanged: false }
  },
})
const session = createSession({ native })
const client = await connectInProcess(createComputerUseServer({ runConsole: true, session }))
const parse = r => JSON.parse(r.content.find(b => b.type === 'text').text)
const { runId } = parse(await client.callTool('run_start', { prompt: 'watch' }))
for (let i = 1; i <= 5; i++) {
  const r = await client.callTool('run_progress', { runId, capture: true, narration: `frame ${i}` })
  const body = parse(r)
  console.log(`run_progress #${i}: image block returned=${r.content.some(b => b.type === 'image')}, console screenshot.at=${body.screenshot?.at ?? null}`)
}
console.log('native captures:', captures)
await client.close()
process.exit(0)
