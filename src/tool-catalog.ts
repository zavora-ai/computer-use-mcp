/**
 * Tool catalog — single source of truth for ToolMeta, MCP annotations,
 * profile membership, and mutating-tool set (K4, K7, Appendix A/B).
 */

export type FocusRequired = 'scripting' | 'ax' | 'cgevent' | 'none'
export type ProfileName = 'core' | 'ax' | 'scripting' | 'windows-admin' | 'full'

export interface ToolMeta {
  focusRequired: FocusRequired
  mutates: boolean
  requiresFocus: boolean
  movesUserCursor: boolean
  usesVirtualPointer: boolean
  physicalInput: boolean
  /** MCP annotation: destructiveHint */
  destructiveHint: boolean
  /** MCP annotation: idempotentHint */
  idempotentHint: boolean
  /** MCP annotation: openWorldHint */
  openWorldHint: boolean
  /** Base profile tier before nest expansion (Appendix B) */
  tier: ProfileName
}

export interface McpToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export function toMcpAnnotations(meta: ToolMeta): McpToolAnnotations {
  return {
    readOnlyHint: !meta.mutates,
    destructiveHint: meta.destructiveHint,
    idempotentHint: meta.idempotentHint,
    openWorldHint: meta.openWorldHint,
  }
}

export function toToolMetaPublic(meta: ToolMeta) {
  return {
    focusRequired: meta.focusRequired,
    mutates: meta.mutates,
    requiresFocus: meta.requiresFocus,
    movesUserCursor: meta.movesUserCursor,
    usesVirtualPointer: meta.usesVirtualPointer,
    physicalInput: meta.physicalInput,
  }
}

/** Nested inclusion: core ⊆ ax/scripting/windows-admin ⊆ full */
export function profilesForTier(tier: ProfileName): ProfileName[] {
  switch (tier) {
    case 'core':
      return ['core', 'ax', 'scripting', 'windows-admin', 'full']
    case 'ax':
      return ['ax', 'full']
    case 'scripting':
      return ['scripting', 'windows-admin', 'full']
    case 'windows-admin':
      return ['windows-admin', 'full']
    case 'full':
      return ['full']
  }
}

export function toolInProfile(meta: ToolMeta, profile: ProfileName): boolean {
  if (profile === 'full') return true
  return profilesForTier(meta.tier).includes(profile)
}

export function parseProfile(raw: string | undefined | null): ProfileName {
  const v = (raw ?? 'full').toLowerCase()
  if (v === 'core' || v === 'ax' || v === 'scripting' || v === 'windows-admin' || v === 'full') {
    return v
  }
  return 'full'
}

// Shorthand factories
const m = (
  focusRequired: FocusRequired,
  mutates: boolean,
  opts: Partial<Pick<ToolMeta, 'requiresFocus' | 'movesUserCursor' | 'usesVirtualPointer' | 'physicalInput' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>> & { tier: ProfileName },
): ToolMeta => ({
  focusRequired,
  mutates,
  requiresFocus: opts.requiresFocus ?? ((focusRequired === 'cgevent' || focusRequired === 'ax') && mutates),
  movesUserCursor: opts.movesUserCursor ?? false,
  usesVirtualPointer: opts.usesVirtualPointer ?? false,
  physicalInput: opts.physicalInput ?? false,
  destructiveHint: opts.destructiveHint ?? false,
  idempotentHint: opts.idempotentHint ?? !mutates,
  openWorldHint: opts.openWorldHint ?? false,
  tier: opts.tier,
})

const CG_MUT = (tier: ProfileName = 'core'): ToolMeta =>
  m('cgevent', true, { requiresFocus: true, movesUserCursor: true, physicalInput: true, tier })
const AX_MUT = (tier: ProfileName = 'ax'): ToolMeta =>
  m('ax', true, { requiresFocus: true, tier })
const AX_READ = (tier: ProfileName = 'ax'): ToolMeta =>
  m('ax', false, { requiresFocus: false, tier })
const SCRIPTING = (tier: ProfileName = 'scripting'): ToolMeta =>
  m('scripting', true, { requiresFocus: false, destructiveHint: true, openWorldHint: true, tier })
const SCRIPT_READ = (tier: ProfileName = 'scripting'): ToolMeta =>
  m('scripting', false, { requiresFocus: false, tier })
const NONE_READ = (tier: ProfileName = 'core', extra?: Partial<ToolMeta>): ToolMeta =>
  m('none', false, { requiresFocus: false, tier, ...extra })
const NONE_MUT = (tier: ProfileName = 'core', extra?: Partial<ToolMeta>): ToolMeta =>
  m('none', true, { requiresFocus: false, tier, ...extra })

/** Appendix A + B — all 64 tools */
export const TOOL_CATALOG: Record<string, ToolMeta> = {
  doctor: NONE_READ('core'),
  policy_status: NONE_READ('core'),
  agent_pointer: NONE_MUT('full', { usesVirtualPointer: true }),
  openai_computer: m('cgevent', true, {
    requiresFocus: true, movesUserCursor: true, usesVirtualPointer: true, physicalInput: true,
    openWorldHint: true, tier: 'full',
  }),
  screenshot: NONE_READ('core'),
  zoom: NONE_READ('core'),
  left_click: CG_MUT('core'),
  right_click: CG_MUT('core'),
  middle_click: CG_MUT('ax'),
  double_click: CG_MUT('core'),
  triple_click: CG_MUT('ax'),
  mouse_move: CG_MUT('core'),
  left_click_drag: CG_MUT('ax'),
  cursor_position: NONE_READ('core'),
  left_mouse_down: CG_MUT('ax'),
  left_mouse_up: CG_MUT('ax'),
  scroll: CG_MUT('core'),
  type: CG_MUT('core'),
  key: CG_MUT('core'),
  hold_key: CG_MUT('core'),
  read_clipboard: NONE_READ('core'),
  write_clipboard: NONE_MUT('core'),
  open_application: m('ax', true, { requiresFocus: true, openWorldHint: true, tier: 'core' }),
  get_frontmost_app: AX_READ('core'),
  list_windows: AX_READ('core'),
  list_running_apps: AX_READ('ax'),
  discover_applications: NONE_READ('core'),
  hide_app: AX_MUT('ax'),
  unhide_app: AX_MUT('ax'),
  get_display_size: NONE_READ('core'),
  list_displays: NONE_READ('core'),
  get_window: AX_READ('core'),
  get_cursor_window: AX_READ('ax'),
  activate_app: AX_MUT('core'),
  activate_window: AX_MUT('core'),
  resize_window: AX_MUT('ax'),
  wait: NONE_READ('core', { idempotentHint: false }),
  snapshot: NONE_READ('full'),
  get_ui_tree: AX_READ('ax'),
  get_focused_element: AX_READ('ax'),
  find_element: AX_READ('ax'),
  click_element: AX_MUT('ax'),
  set_value: AX_MUT('ax'),
  press_button: AX_MUT('ax'),
  select_menu_item: AX_MUT('ax'),
  fill_form: AX_MUT('ax'),
  run_script: SCRIPTING('scripting'),
  get_app_dictionary: SCRIPT_READ('scripting'),
  list_menu_bar: AX_READ('ax'),
  get_tool_guide: NONE_READ('core'),
  get_app_capabilities: AX_READ('core'),
  list_spaces: NONE_READ('windows-admin'),
  get_active_space: NONE_READ('windows-admin'),
  create_agent_space: AX_MUT('windows-admin'),
  move_window_to_space: AX_MUT('windows-admin'),
  remove_window_from_space: AX_MUT('windows-admin'),
  destroy_space: AX_MUT('windows-admin'),
  get_tool_metadata: NONE_READ('core'),
  filesystem: NONE_MUT('scripting', { destructiveHint: true }),
  process_kill: NONE_MUT('windows-admin', { destructiveHint: true }),
  registry: NONE_MUT('windows-admin', { destructiveHint: true }),
  notification: NONE_MUT('windows-admin'),
  multi_select: CG_MUT('full'),
  multi_edit: CG_MUT('full'),
  scrape: NONE_READ('full', { openWorldHint: true }),
}

/** Tools that acquire the session lock (derived from catalog mutates flag). */
export const MUTATING_TOOLS = new Set(
  Object.entries(TOOL_CATALOG).filter(([, meta]) => meta.mutates).map(([name]) => name),
)

export function getToolMeta(name: string): ToolMeta | undefined {
  return TOOL_CATALOG[name]
}
