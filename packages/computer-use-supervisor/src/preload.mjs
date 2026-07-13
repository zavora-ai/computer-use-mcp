import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('computerUseSupervisor', Object.freeze({
  onMessage(listener) {
    const wrapped = (_event, message) => listener(message)
    ipcRenderer.on('supervisor:event', wrapped)
    return () => ipcRenderer.removeListener('supervisor:event', wrapped)
  },
  command: (command, payload) => ipcRenderer.invoke('supervisor:command', command, payload),
  approve: actionId => ipcRenderer.invoke('supervisor:approve', actionId),
  emergencyStop: () => ipcRenderer.invoke('supervisor:emergency-stop'),
  emergencyReset: () => ipcRenderer.invoke('supervisor:emergency-reset'),
}))
