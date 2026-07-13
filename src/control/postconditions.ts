import { createHash } from 'node:crypto'
import type { ToolResult } from '../result.js'
import type { Session } from '../session.js'
import type { ActionEnvelope, ActionPostcondition } from '../runtime/types.js'
import type { VerificationResult } from './transaction.js'

const SHA256 = /^sha256:[a-f0-9]{64}$/

export function valueDigest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

export function validatePostcondition(value: ActionPostcondition): void {
  if (!value || typeof value !== 'object') throw new TypeError('postcondition must be an object')
  if ('valueDigest' in value && value.valueDigest !== undefined && !SHA256.test(value.valueDigest)) {
    throw new TypeError('postcondition valueDigest must be sha256:<64 lowercase hex>')
  }
  if ('contentDigest' in value && value.contentDigest !== undefined && !SHA256.test(value.contentDigest)) {
    throw new TypeError('postcondition contentDigest must be sha256:<64 lowercase hex>')
  }
  if (value.kind === 'ui_element' && !value.role && !value.label) {
    throw new TypeError('ui_element postcondition requires role or label')
  }
  if (value.kind === 'ui_element' && !value.exists && value.valueDigest) {
    throw new TypeError('absent ui_element postcondition cannot include valueDigest')
  }
  if (value.kind === 'filesystem' && !value.exists && value.contentDigest) {
    throw new TypeError('absent filesystem postcondition cannot include contentDigest')
  }
  if (value.kind === 'registry' && !value.exists && value.valueDigest) {
    throw new TypeError('absent registry postcondition cannot include valueDigest')
  }
  if (value.kind === 'process' && (!Number.isSafeInteger(value.pid) || value.pid < 1)) {
    throw new TypeError('process postcondition requires a positive pid')
  }
  if (value.kind === 'process' && value.running !== false) {
    throw new TypeError('process postcondition can only prove a non-running process')
  }
  if (value.kind === 'window' && (!Number.isSafeInteger(value.windowId) || value.windowId < 0)) {
    throw new TypeError('window postcondition requires a non-negative windowId')
  }
}

function text(result: ToolResult): string {
  const item = result.content.find(entry => entry.type === 'text')
  return item?.type === 'text' ? item.text : ''
}

function json(result: ToolResult): unknown {
  if (result.structuredContent) return result.structuredContent
  try { return JSON.parse(text(result)) } catch { return undefined }
}

function detail(method: string, verified: boolean, checks: number): VerificationResult {
  return { verified, method, details: { checks } }
}

async function uiValue(
  session: Session,
  windowId: number,
  role: string | undefined,
  label: string | undefined,
  expectedDigest: string | undefined,
  exists = true,
): Promise<boolean> {
  const result = await session.dispatch('find_element', {
    window_id: windowId,
    ...(role ? { role } : {}),
    ...(label ? { label } : {}),
    max_results: 10,
  })
  if (result.isError) return !exists
  const found = json(result)
  const elements = Array.isArray(found) ? found : []
  if (!exists) return elements.length === 0
  if (!elements.length) return false
  if (!expectedDigest) return true
  return elements.some(element => element && typeof element === 'object'
    && valueDigest(String((element as Record<string, unknown>).value ?? '')) === expectedDigest)
}

async function filesystemState(
  session: Session,
  path: string,
  exists: boolean,
  digest?: string,
): Promise<boolean> {
  const info = await session.dispatch('filesystem', { mode: 'info', path })
  if (!exists) return info.isError === true
  if (info.isError) return false
  if (!digest) return true
  const read = await session.dispatch('filesystem', { mode: 'read', path })
  return !read.isError && valueDigest(text(read)) === digest
}

async function registryState(
  session: Session,
  path: string,
  name: string,
  exists: boolean,
  digest?: string,
): Promise<boolean> {
  const result = await session.dispatch('registry', { mode: 'get', path, name })
  if (!exists) return result.isError === true
  return !result.isError && (!digest || valueDigest(text(result).trim()) === digest)
}

function processRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function processState(pid: number, running: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt++) {
    if (processRunning(pid) === running) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return processRunning(pid) === running
}

async function explicitPostcondition(
  session: Session,
  postcondition: ActionPostcondition,
  envelope: ActionEnvelope,
): Promise<VerificationResult> {
  validatePostcondition(postcondition)
  if (postcondition.kind === 'ui_element') {
    const windowId = envelope.target?.windowId
    if (typeof windowId !== 'number') return detail('postcondition.ui_element', false, 0)
    return detail('postcondition.ui_element', await uiValue(
      session, windowId, postcondition.role, postcondition.label,
      postcondition.valueDigest, postcondition.exists,
    ), 1)
  }
  if (postcondition.kind === 'filesystem') {
    return detail('postcondition.filesystem', await filesystemState(
      session, postcondition.path, postcondition.exists, postcondition.contentDigest,
    ), 1)
  }
  if (postcondition.kind === 'registry') {
    return detail('postcondition.registry', await registryState(
      session, postcondition.path, postcondition.name, postcondition.exists, postcondition.valueDigest,
    ), 1)
  }
  if (postcondition.kind === 'process') {
    return detail('postcondition.process', await processState(postcondition.pid, postcondition.running), 1)
  }
  const result = await session.dispatch('get_window', { window_id: postcondition.windowId })
  return detail('postcondition.window', postcondition.exists ? !result.isError : result.isError === true, 1)
}

async function automaticPostcondition(
  session: Session,
  envelope: ActionEnvelope,
  args: Readonly<Record<string, unknown>>,
): Promise<VerificationResult | undefined> {
  const windowId = envelope.target?.windowId
  if (envelope.tool === 'set_value' && typeof windowId === 'number'
      && typeof args.role === 'string' && typeof args.label === 'string' && typeof args.value === 'string') {
    return detail('postcondition.auto_ui_value', await uiValue(
      session, windowId, args.role, args.label, valueDigest(args.value), true,
    ), 1)
  }
  if (envelope.tool === 'fill_form' && typeof windowId === 'number' && Array.isArray(args.fields)) {
    let checks = 0
    for (const entry of args.fields) {
      if (!entry || typeof entry !== 'object') return detail('postcondition.auto_fill_form', false, checks)
      const field = entry as Record<string, unknown>
      if (typeof field.role !== 'string' || typeof field.label !== 'string' || typeof field.value !== 'string') {
        return detail('postcondition.auto_fill_form', false, checks)
      }
      checks++
      if (!await uiValue(session, windowId, field.role, field.label, valueDigest(field.value), true)) {
        return detail('postcondition.auto_fill_form', false, checks)
      }
    }
    return detail('postcondition.auto_fill_form', checks > 0, checks)
  }
  if (envelope.tool === 'filesystem' && typeof args.path === 'string') {
    const mode = args.mode
    if (mode === 'write' && typeof args.content === 'string') {
      if (args.append === true) {
        const read = await session.dispatch('filesystem', { mode: 'read', path: args.path })
        return detail('postcondition.auto_filesystem_append', !read.isError && text(read).endsWith(args.content), 1)
      }
      return detail('postcondition.auto_filesystem_write', await filesystemState(
        session, args.path, true, valueDigest(args.content),
      ), 1)
    }
    if (mode === 'delete') {
      return detail('postcondition.auto_filesystem_delete', await filesystemState(session, args.path, false), 1)
    }
    if ((mode === 'copy' || mode === 'move') && typeof args.destination === 'string') {
      const destinationExists = await filesystemState(session, args.destination, true)
      const sourceState = mode === 'move' ? await filesystemState(session, args.path, false) : true
      return detail(`postcondition.auto_filesystem_${mode}`, destinationExists && sourceState, 2)
    }
  }
  if (envelope.tool === 'registry' && typeof args.path === 'string' && typeof args.name === 'string') {
    if (args.mode === 'set') return detail('postcondition.auto_registry_set', await registryState(
      session, args.path, args.name, true, valueDigest(String(args.value ?? '')),
    ), 1)
    if (args.mode === 'delete') return detail('postcondition.auto_registry_delete', await registryState(
      session, args.path, args.name, false,
    ), 1)
  }
  if (envelope.tool === 'process_kill' && args.mode === 'kill' && typeof args.pid === 'number') {
    return detail('postcondition.auto_process_kill', await processState(args.pid, false), 1)
  }
  return undefined
}

/** Independently read back an explicit or safely derivable expected effect. */
export async function verifySessionPostcondition(
  session: Session,
  envelope: ActionEnvelope,
  args: Readonly<Record<string, unknown>>,
): Promise<VerificationResult | undefined> {
  if (envelope.postcondition) return explicitPostcondition(session, envelope.postcondition, envelope)
  return automaticPostcondition(session, envelope, args)
}
