/**
 * Tool catalog — single source of truth for ToolMeta, MCP annotations,
 * profile membership, and mutating-tool set (K4, K7, Appendix A/B).
 */

export type FocusRequired = 'scripting' | 'ax' | 'cgevent' | 'none'
export type ProfileName = 'core' | 'desktop' | 'ax' | 'scripting' | 'windows-admin' | 'full'
/** What a tool is for (v7.6 R7): the axis the instructions and get_tool_guide are organised by. */
export type ToolJob = 'observe' | 'act' | 'semantic' | 'script' | 'admin' | 'browser' | 'spaces' | 'meta'

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
  /** v7.6 R7: the job this tool does. */
  job: ToolJob
  /** v7.6 R7: platforms the tool exists on; undefined = every platform. A tool not for the running platform is neither listed nor callable. */
  platforms?: readonly NodeJS.Platform[]
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

/** Nested inclusion: core ⊆ desktop ⊆ ax/scripting/windows-admin ⊆ full (desktop is the v7.6 default) */
export function profilesForTier(tier: ProfileName): ProfileName[] {
  switch (tier) {
    case 'core':
      return ['core', 'desktop', 'ax', 'scripting', 'windows-admin', 'full']
    case 'desktop':
      return ['desktop', 'ax', 'scripting', 'windows-admin', 'full']
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

/** The default profile is `desktop` since v7.6 (core plus the OCR and wait tools); `full` lists everything. */
export const DEFAULT_PROFILE: ProfileName = 'desktop'

export function parseProfile(raw: string | undefined | null): ProfileName {
  const v = (raw ?? DEFAULT_PROFILE).toLowerCase()
  if (v === 'core' || v === 'desktop' || v === 'ax' || v === 'scripting' || v === 'windows-admin' || v === 'full') {
    return v
  }
  return DEFAULT_PROFILE
}

/** Whether a tool exists on a platform (v7.6 R7). */
export function toolAvailableOn(meta: ToolMeta, platform: NodeJS.Platform): boolean {
  return !meta.platforms || meta.platforms.includes(platform)
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
  job: 'act',
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

/** Appendix A + B — every tool (73 in v7.5; 80 in v7.6 with click, set_target, get_target, wait_for_text, wait_for_stable) */
export const TOOL_CATALOG: Record<string, ToolMeta> = {
  doctor: NONE_READ('core'),
  policy_status: NONE_READ('core'),
  agent_pointer: NONE_MUT('desktop', { usesVirtualPointer: true }),
  openai_computer: m('cgevent', true, {
    requiresFocus: true, movesUserCursor: true, usesVirtualPointer: true, physicalInput: true,
    openWorldHint: true, tier: 'full',
  }),
  screenshot: NONE_READ('core'),
  zoom: NONE_READ('core'),
  // v7.6 R7: one click; the five variants stay as thin aliases (tiny schemas) so existing agents keep working
  click: CG_MUT('core'),
  left_click: CG_MUT('core'),
  right_click: CG_MUT('core'),
  middle_click: CG_MUT('core'),
  double_click: CG_MUT('core'),
  triple_click: CG_MUT('core'),
  mouse_move: CG_MUT('core'),
  left_click_drag: CG_MUT('ax'),
  mouse_drag: CG_MUT('ax'),
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
  web_search: NONE_READ('full', { openWorldHint: true }),
  browser_tabs: NONE_READ('full', { openWorldHint: true }),
  browser_page_text: NONE_READ('full', { openWorldHint: true }),
  browser_find: NONE_READ('full', { openWorldHint: true }),
  // v7.5 agent desktop
  read_window_text: NONE_READ('core'),
  click_text: CG_MUT('core'),
  wait_for_window: NONE_READ('core', { idempotentHint: false }),
  // v7.6 R3 waits and R7 session target
  wait_for_text: NONE_READ('desktop', { idempotentHint: false }),
  wait_for_stable: NONE_READ('desktop', { idempotentHint: false }),
  set_target: NONE_READ('core', { idempotentHint: false }),
  get_target: NONE_READ('core'),
}

/** v7.6 R7: the job of every tool (the instructions and get_tool_guide are organised by it). */
const TOOL_JOBS: Record<ToolJob, readonly string[]> = {
  meta: ['doctor', 'policy_status', 'get_tool_guide', 'get_tool_metadata', 'get_app_capabilities', 'discover_applications', 'set_target', 'get_target'],
  observe: ['screenshot', 'zoom', 'snapshot', 'read_window_text', 'list_windows', 'get_window', 'get_cursor_window', 'get_frontmost_app',
    'list_running_apps', 'get_display_size', 'list_displays', 'cursor_position', 'read_clipboard', 'wait', 'wait_for_window', 'wait_for_text', 'wait_for_stable'],
  act: ['click', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'click_text', 'mouse_move', 'left_click_drag', 'mouse_drag',
    'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key', 'hold_key', 'write_clipboard', 'agent_pointer', 'openai_computer', 'multi_select', 'multi_edit',
    'open_application', 'hide_app', 'unhide_app', 'activate_app', 'activate_window', 'resize_window'],
  semantic: ['get_ui_tree', 'get_focused_element', 'find_element', 'click_element', 'set_value', 'press_button', 'select_menu_item', 'fill_form', 'list_menu_bar'],
  script: ['run_script', 'get_app_dictionary'],
  admin: ['filesystem', 'process_kill', 'registry', 'notification'],
  browser: ['scrape', 'web_search', 'browser_tabs', 'browser_page_text', 'browser_find'],
  spaces: ['list_spaces', 'get_active_space', 'create_agent_space', 'move_window_to_space', 'remove_window_from_space', 'destroy_space'],
}
/** v7.6 R7: tools that exist on some platforms only. Everything else is on every platform. */
const TOOL_PLATFORMS: Record<string, readonly NodeJS.Platform[]> = {
  registry: ['win32'],
  notification: ['win32'],
  read_window_text: ['darwin'],
  click_text: ['darwin'],
  wait_for_text: ['darwin'],
  wait_for_stable: ['darwin'],
  list_spaces: ['darwin', 'win32'],
  get_active_space: ['darwin', 'win32'],
  create_agent_space: ['darwin', 'win32'],
  move_window_to_space: ['darwin', 'win32'],
  remove_window_from_space: ['darwin', 'win32'],
  destroy_space: ['darwin', 'win32'],
}
for (const [job, names] of Object.entries(TOOL_JOBS) as [ToolJob, readonly string[]][]) {
  for (const name of names) {
    const meta = TOOL_CATALOG[name]
    if (!meta) throw new Error(`TOOL_JOBS names unknown tool ${name}`)
    meta.job = job
  }
}
for (const [name, platforms] of Object.entries(TOOL_PLATFORMS)) {
  const meta = TOOL_CATALOG[name]
  if (!meta) throw new Error(`TOOL_PLATFORMS names unknown tool ${name}`)
  meta.platforms = platforms
}
{
  const jobbed = new Set(Object.values(TOOL_JOBS).flat())
  const missing = Object.keys(TOOL_CATALOG).filter(name => !jobbed.has(name))
  if (missing.length) throw new Error(`tools without a job: ${missing.join(', ')}`)
}

/** Tools that acquire the session lock (derived from catalog mutates flag). */
export const MUTATING_TOOLS = new Set(
  Object.entries(TOOL_CATALOG).filter(([, meta]) => meta.mutates).map(([name]) => name),
)

export function getToolMeta(name: string): ToolMeta | undefined {
  return TOOL_CATALOG[name]
}
