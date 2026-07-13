const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('computerUseSupervisor', Object.freeze({
  onMessage(listener) {
    const wrapped = (_event, message) => listener(message)
    ipcRenderer.on('supervisor:event', wrapped)
    // Installing the only renderer event listener and acknowledging readiness
    // are one atomic preload operation; no replay can be flushed first.
    void ipcRenderer.invoke('supervisor:renderer-ready')
    return () => ipcRenderer.removeListener('supervisor:event', wrapped)
  },
  command: (command, payload) => ipcRenderer.invoke('supervisor:command', command, payload),
  approve: (actionId, scope = 'exact_action') => ipcRenderer.invoke('supervisor:approve', actionId, scope),
  requestEvidenceFrame: frameId => ipcRenderer.invoke('supervisor:get-frame', frameId),
  emergencyStop: () => ipcRenderer.invoke('supervisor:emergency-stop'),
  emergencyReset: () => ipcRenderer.invoke('supervisor:emergency-reset'),
}))
