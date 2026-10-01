/**
 * Key names (v7.5, requirement R6).
 *
 * The native key maps know physical keys by their character ("`", "-", "[") plus a
 * few names. Agents reach for names — "grave", "backtick", "tilde", "minus" — and got
 * "Unknown key in combo: grave", with no list of what would have worked. Aliases are
 * resolved here, once, for every platform; unknown names are refused with the list.
 */

/** Modifier names the native layers accept. */
export const MODIFIER_NAMES = [
  'command', 'cmd', 'shift', 'option', 'alt', 'control', 'ctrl', 'fn', 'super', 'win', 'meta',
] as const

/** Physical keys the native layers accept (the union across platforms). */
export const BASE_KEY_NAMES = [
  'return', 'enter', 'tab', 'space', 'delete', 'backspace', 'forwarddelete', 'escape', 'esc', 'capslock',
  'home', 'end', 'pageup', 'pagedown', 'left', 'right', 'up', 'down',
  ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`),
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`',
] as const

/** Name → native combo fragment. A fragment may carry shift ("shift+`"). */
export const KEY_ALIASES: Readonly<Record<string, string>> = {
  grave: '`', backtick: '`', backquote: '`', tilde: 'shift+`', '~': 'shift+`',
  minus: '-', hyphen: '-', dash: '-', underscore: 'shift+-', _: 'shift+-',
  equal: '=', equals: '=', plus: 'shift+=', '+': 'shift+=',
  leftbracket: '[', bracketleft: '[', lbracket: '[', openbracket: '[',
  rightbracket: ']', bracketright: ']', rbracket: ']', closebracket: ']',
  leftbrace: 'shift+[', braceleft: 'shift+[', '{': 'shift+[',
  rightbrace: 'shift+]', braceright: 'shift+]', '}': 'shift+]',
  backslash: '\\', pipe: 'shift+\\', '|': 'shift+\\',
  semicolon: ';', colon: 'shift+;', ':': 'shift+;',
  quote: "'", apostrophe: "'", singlequote: "'", doublequote: "shift+'", '"': "shift+'",
  comma: ',', lessthan: 'shift+,', less: 'shift+,', '<': 'shift+,',
  period: '.', dot: '.', fullstop: '.', greaterthan: 'shift+.', greater: 'shift+.', '>': 'shift+.',
  slash: '/', forwardslash: '/', question: 'shift+/', questionmark: 'shift+/', '?': 'shift+/',
  exclamation: 'shift+1', '!': 'shift+1', at: 'shift+2', '@': 'shift+2', hash: 'shift+3', '#': 'shift+3',
  dollar: 'shift+4', '$': 'shift+4', percent: 'shift+5', '%': 'shift+5', caret: 'shift+6', '^': 'shift+6',
  ampersand: 'shift+7', '&': 'shift+7', asterisk: 'shift+8', '*': 'shift+8',
  leftparen: 'shift+9', '(': 'shift+9', rightparen: 'shift+0', ')': 'shift+0',
  page_up: 'pageup', page_down: 'pagedown', pgup: 'pageup', pgdn: 'pagedown',
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  del: 'forwarddelete', forward_delete: 'forwarddelete', bksp: 'backspace', spacebar: 'space',
  caps_lock: 'capslock', ' ': 'space',
}

const MODIFIERS = new Set<string>(MODIFIER_NAMES)
const BASE_KEYS = new Set<string>(BASE_KEY_NAMES)

/** Every name `key` and `hold_key` accept, for error messages and docs. */
export function validKeyNames(): string[] {
  return [...MODIFIER_NAMES, ...BASE_KEY_NAMES, ...Object.keys(KEY_ALIASES).filter(k => k.trim())]
}

export class UnknownKeyError extends Error {
  constructor(readonly key: string, readonly combo: string) {
    super(
      `Unknown key ${JSON.stringify(key)} in ${JSON.stringify(combo)}. `
      + `Valid keys: ${validKeyNames().join(' ')}`,
    )
    this.name = 'UnknownKeyError'
  }
}

/** Split a combo on "+", keeping a literal "+" key ("cmd++", "+"). */
function splitCombo(combo: string): string[] {
  if (combo.trim() === '+') return ['+']
  const parts = combo.split('+')
  const out: string[] = []
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    // "a++" splits into [..., '', ''] — the two empties are one "+" key.
    if (part === '' && index === parts.length - 2 && parts[index + 1] === '') {
      out.push('+')
      break
    }
    out.push(part)
  }
  return out.map(part => (part === ' ' ? part : part.trim())).filter(part => part.length > 0)
}

function resolveToken(token: string, combo: string): string[] {
  const lower = token.length === 1 ? token : token.toLowerCase()
  const name = lower.length === 1 ? lower.toLowerCase() : lower
  if (MODIFIERS.has(name) || BASE_KEYS.has(name)) return [name]
  const alias = KEY_ALIASES[lower] ?? KEY_ALIASES[name]
  if (alias) return alias.split('+')
  throw new UnknownKeyError(token, combo)
}

/**
 * Names the target platform's native map knows. "meta" (and, on macOS, "super" and
 * "win") mean the command/Windows/Super key, which every native map knows as "cmd".
 * Only the macOS map distinguishes forward delete; elsewhere "delete" already is it.
 */
function platformToken(token: string, platform: NodeJS.Platform): string {
  if (token === 'meta') return 'cmd'
  if ((token === 'super' || token === 'win') && platform === 'darwin') return 'cmd'
  if (token === 'forwarddelete' && platform !== 'darwin') return 'delete'
  return token
}

/**
 * Canonical native combo: aliases resolved ("tilde" → "shift+`"), modifiers
 * deduplicated and kept in order before the main key. Throws UnknownKeyError.
 */
export function normalizeKeyCombo(combo: string, platform: NodeJS.Platform = process.platform): string {
  const tokens = splitCombo(combo)
    .flatMap(token => resolveToken(token, combo))
    .map(token => platformToken(token, platform))
  if (tokens.length === 0) throw new UnknownKeyError(combo, combo)
  const modifiers: string[] = []
  const keys: string[] = []
  for (const token of tokens) {
    if (MODIFIERS.has(token)) { if (!modifiers.includes(token)) modifiers.push(token) }
    else keys.push(token)
  }
  return [...modifiers, ...keys].join('+')
}

/** hold_key names: each alias expands, so "tilde" holds shift and the grave key. */
export function normalizeHeldKeys(keys: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = []
  for (const key of keys) {
    for (const raw of resolveToken(key, key)) {
      const token = platformToken(raw, platform)
      if (!out.includes(token)) out.push(token)
    }
  }
  return out
}

/** Rewrap a native "Unknown key" failure with the list of valid names. */
export function explainNativeKeyError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error)
  if (/Unknown key/i.test(message)) {
    return new Error(`${message}. This platform's key map lacks it. Valid keys: ${validKeyNames().join(' ')}`)
  }
  return error
}

const US_SHIFTED: Readonly<Record<string, string>> = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'",
  '<': ',', '>': '.', '?': '/',
}

/**
 * US-ANSI combo for one character, or undefined when no key produces it.
 * Used by `type mode:"keys"` where the native layout-aware table is unavailable
 * (Windows, Linux, an older native module).
 */
export function charToUsCombo(char: string): string | undefined {
  if (char === '\n' || char === '\r') return 'return'
  if (char === '\t') return 'tab'
  if (char === ' ') return 'space'
  if (/^[a-z0-9]$/.test(char)) return char
  if (/^[A-Z]$/.test(char)) return `shift+${char.toLowerCase()}`
  if ("-=[]\\;',./`".includes(char) && char.length === 1) return char
  const base = US_SHIFTED[char]
  return base ? `shift+${base}` : undefined
}
