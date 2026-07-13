/**
 * Tauri v2 frontend transport for the same DesktopSetupCommand/SetupViewModel
 * contract. The Rust command must invoke DesktopSetupController in the trusted
 * host process and return only its disclosure-safe view.
 */
export function createTauriSetupTransport(invoke, commandName = 'computer_use_setup') {
  if (typeof invoke !== 'function') throw new TypeError('Tauri invoke function is required')
  return Object.freeze({ dispatch: command => invoke(commandName, { command }) })
}
