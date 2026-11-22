/**
 * 8.0: sign-in and verification walls. Typing a password or a one-time code is the person's to do, so before the agent
 * types, the server looks for a wall: the focused field is a password field (the accessibility tree marks it
 * sensitive), or a code field, or the window says it is a sign-in or verification page. On a wall the call is refused
 * and the desktop is handed to the person (`handed_off`) until they press Resume.
 *
 * `COMPUTER_USE_AUTH_HANDOFF=off` lifts it, for an operator who wants the agent to sign in (a test account in a
 * recorded tutorial). The check is the operator's to lift: no tool argument does.
 */
import type { AXElement } from '../native.js'

export type WallKind = 'sign_in' | 'verification'
export interface Wall { kind: WallKind; seen: string }

/** One-time codes and second factors. */
const CODE = /\b(verification code|security code|confirmation code|one[- ]time (?:pass(?:word|code)|code)|two[- ]factor|2-step|2fa|mfa|authenticator|passcode|otp|enter the code|\d[- ]digit code)\b/i
const PASSWORD = /\b(password|passwort|contraseña|mot de passe)\b/i
const SIGN_IN = /\b(sign[ -]?in|log[ -]?in|login|anmelden|iniciar sesión|se connecter)\b/i
/** Roles of a field the accessibility tree knows: when the focus is one of these and is not sensitive, trust it. */
const TEXT_ROLES = /^(AXTextField|AXTextArea|AXComboBox|AXSearchField|Edit|ComboBox|Document|text|entry|password text)$/i

/** Browsers, whose page fields are often not in the accessibility tree: their windows are read by OCR instead. */
export const BROWSERS = new Set([
  'com.apple.Safari', 'com.apple.SafariTechnologyPreview', 'com.google.Chrome', 'com.google.Chrome.canary',
  'org.chromium.Chromium', 'org.mozilla.firefox', 'org.mozilla.firefoxdeveloperedition', 'com.microsoft.edgemac',
  'company.thebrowser.Browser', 'com.brave.Browser', 'com.operasoftware.Opera', 'com.vivaldi.Vivaldi',
])

/** The typing that could enter a secret: text, a field's value, a paste, or a single printable key. */
export function typesText(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'type' || tool === 'set_value' || tool === 'fill_form' || tool === 'multi_edit') return true
  if (tool !== 'key' || typeof args.text !== 'string') return false
  const key = args.text.trim().toLowerCase()
  return key.length === 1 || /^(cmd|command|ctrl|control)\+v$|^shift\+insert$/.test(key)
}

/** What the focused element says: a wall, definitely none (a plain text field), or unknown. */
export function focusWall(focused: AXElement | null | undefined): Wall | 'none' | undefined {
  if (!focused) return undefined
  const label = [focused.label, focused.role].filter(Boolean).join(' ')
  if (focused.sensitive) {
    return { kind: CODE.test(label) ? 'verification' : 'sign_in', seen: `the focused field is a protected field${focused.label ? ` ("${focused.label.slice(0, 40)}")` : ''}` }
  }
  if (focused.label && CODE.test(focused.label)) return { kind: 'verification', seen: `the focused field is labelled "${focused.label.slice(0, 40)}"` }
  if (focused.label && PASSWORD.test(focused.label)) return { kind: 'sign_in', seen: `the focused field is labelled "${focused.label.slice(0, 40)}"` }
  return TEXT_ROLES.test(focused.role) ? 'none' : undefined
}

/** What the window's title says. */
export function titleWall(title: string | undefined): Wall | undefined {
  if (!title) return undefined
  if (CODE.test(title)) return { kind: 'verification', seen: `the window is titled "${title.slice(0, 60)}"` }
  if (SIGN_IN.test(title)) return { kind: 'sign_in', seen: `the window is titled "${title.slice(0, 60)}"` }
  return undefined
}

/** What the window shows: a code prompt, or a password field beside a sign-in heading. */
export function textWall(lines: readonly string[]): Wall | undefined {
  const code = lines.find(line => CODE.test(line))
  if (code) return { kind: 'verification', seen: `the window shows "${code.slice(0, 60)}"` }
  const password = lines.find(line => PASSWORD.test(line))
  const signIn = lines.find(line => SIGN_IN.test(line))
  if (password && signIn) return { kind: 'sign_in', seen: `the window shows "${signIn.slice(0, 40)}" and "${password.slice(0, 40)}"` }
  return undefined
}

/** Whether the operator left the check on (the default). */
export function authHandoffEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.COMPUTER_USE_AUTH_HANDOFF?.trim().toLowerCase()
  return value !== 'off' && value !== 'false' && value !== '0'
}

export function wallMessage(wall: Wall, app?: string): string {
  const where = app ? ` in ${app}` : ''
  return wall.kind === 'verification'
    ? `Enter the verification code${where} yourself.`
    : `Sign in${where} yourself.`
}
