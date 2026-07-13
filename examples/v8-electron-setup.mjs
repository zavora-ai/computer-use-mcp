/** Register one sandbox-safe Electron IPC endpoint around DesktopSetupController. */
export function registerElectronSetupIpc(ipcMain, controller, channel = 'computer-use:setup') {
  if (!ipcMain?.handle || !controller?.dispatch) throw new TypeError('ipcMain and setup controller are required')
  ipcMain.handle(channel, async (_event, command) => controller.dispatch(command))
  return () => ipcMain.removeHandler(channel)
}

/** Preload bridge: expose only dispatch, never the controller or host configuration. */
export function electronSetupPreload(api, channel = 'computer-use:setup') {
  if (!api?.invoke) throw new TypeError('Electron ipcRenderer-compatible API is required')
  return Object.freeze({ dispatch: command => api.invoke(channel, command) })
}
