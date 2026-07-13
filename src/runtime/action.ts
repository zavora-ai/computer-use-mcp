import type { ToolMeta } from '../tool-catalog.js'

export type ActionClass =
  | 'observe'
  | 'navigate'
  | 'edit_reversible'
  | 'communicate_external'
  | 'authentication'
  | 'financial'
  | 'destructive'
  | 'privilege_change'
  | 'secret_access'

export interface ActionClassification {
  actionClass: ActionClass
  reversible: boolean
  externalSideEffect: boolean
  reasons: string[]
}

export type RiskMapper = (args: Readonly<Record<string, unknown>>) => ActionClassification

const classification = (
  actionClass: ActionClass,
  reversible: boolean,
  externalSideEffect: boolean,
  ...reasons: string[]
): ActionClassification => ({ actionClass, reversible, externalSideEffect, reasons })

function stringArg(args: Readonly<Record<string, unknown>>, key: string): string {
  return typeof args[key] === 'string' ? args[key].toLowerCase() : ''
}

function containsSensitiveField(args: Readonly<Record<string, unknown>>): boolean {
  const sensitive = /pass(word|code)?|secret|token|credential|otp|one.?time|api.?key|pin/i
  if (sensitive.test(stringArg(args, 'role')) || sensitive.test(stringArg(args, 'label'))) {
    return true
  }
  const fields = args.fields
  return Array.isArray(fields) && fields.some(field => {
    if (!field || typeof field !== 'object') return false
    const entry = field as Record<string, unknown>
    return sensitive.test(stringArg(entry, 'role')) || sensitive.test(stringArg(entry, 'label'))
  })
}

/**
 * Operation-aware default classification for every v7 tool.
 *
 * This mapper is deterministic and intentionally conservative. App-specific
 * policy and target evidence may raise risk further, but may never lower a
 * class without an explicit certified adapter rule.
 */
export function classifyToolAction(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  meta: ToolMeta,
): ActionClassification {
  if (tool === 'filesystem') {
    const mode = stringArg(args, 'mode')
    if (mode === 'read' || mode === 'list' || mode === 'search' || mode === 'info') {
      return classification('observe', true, false, `filesystem:${mode || 'unknown'}`)
    }
    if (mode === 'delete') return classification('destructive', false, true, 'filesystem:delete')
    return classification('edit_reversible', true, true, `filesystem:${mode || 'unknown'}`)
  }

  if (tool === 'registry') {
    const mode = stringArg(args, 'mode')
    if (mode === 'get' || mode === 'list') {
      return classification('observe', true, false, `registry:${mode}`)
    }
    if (mode === 'delete') return classification('destructive', false, true, 'registry:delete')
    return classification('privilege_change', false, true, `registry:${mode || 'unknown'}`)
  }

  if (tool === 'process_kill') {
    return stringArg(args, 'mode') === 'list'
      ? classification('observe', true, false, 'process:list')
      : classification('destructive', false, true, 'process:kill')
  }

  if (tool === 'openai_computer') {
    const actions = Array.isArray(args.actions)
      ? args.actions
      : args.action && typeof args.action === 'object'
        ? [args.action]
        : []
    const types = actions.map(action => {
      const record = action as Record<string, unknown>
      return stringArg(record, 'type') || stringArg(record, 'action')
    })
    if (types.length > 0 && types.every(type => type === 'screenshot' || type === 'wait')) {
      return classification('observe', true, false, 'openai_computer:observation_batch')
    }
    if (types.some(type => type === 'type' || type === 'keypress' || type === 'key')) {
      return classification('edit_reversible', true, true, 'openai_computer:text_or_key_input')
    }
    return classification('navigate', true, true, 'openai_computer:pointer_or_dynamic_action')
  }

  if (tool === 'browser_action') {
    const operation = stringArg(args, 'operation')
    if (['navigate', 'go_back', 'go_forward', 'open_web_browser'].includes(operation)) {
      return classification('navigate', true, true, `browser:${operation}`)
    }
    return classification('edit_reversible', true, true, `browser:${operation || 'unknown'}`)
  }

  if (tool === 'set_value' || tool === 'fill_form') {
    if (containsSensitiveField(args)) {
      return classification('secret_access', false, true, `${tool}:sensitive_field`)
    }
    return classification('edit_reversible', true, true, `${tool}:ui_edit`)
  }

  if (tool === 'read_clipboard') {
    return classification('secret_access', false, false, 'clipboard contents may contain secrets')
  }
  if (tool === 'run_script') {
    return classification('privilege_change', false, true, 'arbitrary script execution')
  }
  if (tool === 'notification') {
    return classification('communicate_external', false, true, 'operating-system notification')
  }
  if (tool === 'destroy_space') {
    return classification('destructive', false, true, 'virtual desktop destruction')
  }
  if (tool === 'type' || tool === 'key' || tool === 'hold_key' || tool === 'multi_edit') {
    return classification('edit_reversible', true, true, `${tool}:physical_input`)
  }
  if (tool === 'write_clipboard') {
    return classification('edit_reversible', true, false, 'clipboard write')
  }

  if (!meta.mutates) return classification('observe', true, false, `${tool}:read_only`)
  if (meta.destructiveHint) return classification('destructive', false, true, `${tool}:destructive_hint`)
  return classification('navigate', true, true, `${tool}:mutation`)
}

export function createRiskMapper(tool: string, meta: ToolMeta): RiskMapper {
  return args => classifyToolAction(tool, args, meta)
}
