function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

/** Render only the disclosure-safe SetupViewModel. */
export function renderSetupHtml(view) {
  if (!view) return '<button type="button" data-setup-action="start">Start secure setup</button>'
  const steps = view.steps.map(step => `
    <li data-status="${escapeHtml(step.status)}">
      <span>${escapeHtml(step.id)}</span><strong>${escapeHtml(step.status)}</strong>
      ${step.detail ? `<small>${escapeHtml(step.detail)}</small>` : ''}
    </li>`).join('')
  const permissions = (view.permissions ?? []).map(permission => `
    <li data-status="${escapeHtml(permission.status)}">
      <strong>${escapeHtml(permission.label)}</strong> · ${escapeHtml(permission.status)}
      <small>${escapeHtml(permission.remediation)}</small>
      ${permission.canRequestInProcess ? `<button type="button" data-setup-action="request_permission" data-permission-id="${escapeHtml(permission.id)}">Request permission</button>` : ''}
      ${permission.canOpenSettings ? `<button type="button" data-setup-action="open_permission_settings" data-permission-id="${escapeHtml(permission.id)}">Open settings</button>` : ''}
    </li>`).join('')
  const id = escapeHtml(view.onboardingId)
  return `<section aria-labelledby="setup-title">
    <h1 id="setup-title">Computer Use setup</h1>
    <p>${escapeHtml(view.progress)}% · ${escapeHtml(view.stage)}</p>
    <ol>${steps}</ol>
    <h2>Operating-system permissions</h2><ul>${permissions}</ul>
    <div data-setup-controls data-onboarding-id="${id}">
      <button type="button" data-setup-action="diagnose">Run diagnostics</button>
      <button type="button" data-setup-action="test_capture">Test capture</button>
      <button type="button" data-setup-action="show_pointer">Show virtual pointer</button>
      <button type="button" data-setup-action="confirm_pointer" data-confirmed="true">I can see it</button>
      <button type="button" data-setup-action="confirm_pointer" data-confirmed="false">I cannot see it</button>
      <label>Window ID <input name="windowId" inputmode="numeric" autocomplete="off"></label>
      <button type="button" data-setup-action="test_semantic">Test accessibility</button>
      <button type="button" data-setup-action="acknowledge_emergency" data-confirmed="false">Show emergency stop</button>
      <button type="button" data-setup-action="acknowledge_emergency" data-confirmed="true">I understand emergency stop</button>
      <label>Filesystem roots <input name="filesystemRoots" autocomplete="off" placeholder="/safe/root, /another/root"></label>
      <label>Allowed apps <input name="allowedAppIds" autocomplete="off" placeholder="com.example.app"></label>
      <label><input name="allowScrape" type="checkbox"> Allow open-world scrape</label>
      <label><input name="persistAudit" type="checkbox" checked> Enable audit</label>
      <button type="button" data-setup-action="configure">Save least-privilege policy</button>
      <button type="button" data-setup-action="complete">Finish</button>
    </div>
  </section>`
}

const list = value => value.split(',').map(item => item.trim()).filter(Boolean)

/** Mount the same setup UI in an Electron BrowserWindow or Tauri WebView. */
export function mountSetupUi(root, transport) {
  if (!root?.addEventListener || typeof transport?.dispatch !== 'function') {
    throw new TypeError('root element and setup transport are required')
  }
  let view
  const render = () => { root.innerHTML = renderSetupHtml(view) }
  root.addEventListener('click', async event => {
    const button = event.target?.closest?.('[data-setup-action]')
    if (!button) return
    const action = button.dataset.setupAction
    const id = view?.onboardingId
    const command = action === 'start' ? { action }
      : action === 'open_permission_settings' || action === 'request_permission'
        ? { action, onboardingId: id, permissionId: button.dataset.permissionId }
      : action === 'show_pointer' ? { action, onboardingId: id, coordinate: [200, 120] }
        : action === 'confirm_pointer' ? { action, onboardingId: id, confirmed: button.dataset.confirmed === 'true' }
          : action === 'acknowledge_emergency' ? { action, onboardingId: id, confirmed: button.dataset.confirmed === 'true' }
          : action === 'test_semantic' ? {
              action, onboardingId: id, windowId: Number(root.querySelector('[name=windowId]').value),
            }
            : action === 'configure' ? {
                action, onboardingId: id,
                filesystemRoots: list(root.querySelector('[name=filesystemRoots]').value),
                allowedAppIds: list(root.querySelector('[name=allowedAppIds]').value),
                allowScrape: root.querySelector('[name=allowScrape]').checked,
                persistAudit: root.querySelector('[name=persistAudit]').checked,
              }
              : { action, onboardingId: id }
    button.disabled = true
    try { view = await transport.dispatch(command); render() }
    finally { if (button.isConnected) button.disabled = false }
  })
  render()
  return Object.freeze({ view: () => view, render })
}
