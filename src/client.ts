/**
 * Computer Use MCP Client — typed API over MCP protocol.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  ActionPostcondition,
  ActionProvenance,
  DataLabel,
  ExecutionMode,
  TargetEvidence,
} from './runtime/types.js'

export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface ListedTool {
  name: string
  description?: string
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
    title?: string
  }
  _meta?: Record<string, unknown>
  inputSchema?: unknown
  outputSchema?: unknown
}

export type FocusStrategy = 'strict' | 'best_effort' | 'none' | 'prepare_display'

/** Optional window-targeting and focus strategy options for input methods. */
export interface WindowTargetOpts {
  targetWindowId?: number
  focusStrategy?: FocusStrategy
}

/** Options for semantic mutating tools — window_id is already required positionally. */
export interface SemanticOpts {
  focusStrategy?: FocusStrategy
}

/** Criteria for find_element — at least one must be present. */
export interface FindElementCriteria {
  role?: string
  label?: string
  value?: string
  maxResults?: number
}

/** A single field for fill_form. */
export interface FillFormField {
  role: string
  label: string
  value: string
}

export interface V8ActionRequest {
  sessionId: string
  actionId?: string
  attempt?: number
  executionGroupId?: string
  agentId?: string
  tool: string
  operation?: string
  certificationId?: string
  arguments: Record<string, unknown>
  mode: ExecutionMode
  target?: TargetEvidence
  postcondition?: ActionPostcondition
  dataLabels?: DataLabel[]
  provenance?: ActionProvenance
  expiresInMs?: number
  leaseId?: string
  approvalGrantId?: string
}

export type OpenAIComputerAction = {
  type?: string
  action?: string
  [key: string]: unknown
}

export interface ComputerUseClient {
  listTools(): Promise<ListedTool[]>
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>
  listResources?(): Promise<Array<{ uri: string; name: string; description?: string; mimeType?: string }>>
  listResourceTemplates?(): Promise<Array<{ uriTemplate: string; name: string; description?: string; mimeType?: string }>>
  readResource?(uri: string): Promise<unknown>
  listPrompts?(): Promise<Array<{ name: string; description?: string; arguments?: unknown }>>
  getPrompt?(name: string, args?: Record<string, string>): Promise<unknown>
  close(): Promise<void>
  // Typed convenience
  doctor(args?: { includeRemediation?: boolean }): Promise<ToolResult>
  policyStatus(): Promise<ToolResult>
  agentPointer(action: 'get' | 'move' | 'show' | 'hide' | 'reset', opts?: { coordinate?: [number, number]; visible?: boolean; nativeOverlay?: boolean }): Promise<ToolResult>
  openaiComputer(args: { action?: OpenAIComputerAction; actions?: OpenAIComputerAction[]; targetApp?: string; targetWindowId?: number; focusStrategy?: FocusStrategy; returnScreenshot?: boolean; useVirtualPointer?: boolean; nativeOverlay?: boolean; width?: number; quality?: number; provider?: 'anthropic' | 'openai' | 'openai-low' | 'gemini' | 'llama' | 'grok' | 'mistral' | 'qwen' | 'nova' | 'deepseek-vl' | 'phi' | 'auto'; approvalToken?: string }): Promise<ToolResult>
  screenshot(args?: { width?: number; quality?: number; target_app?: string; target_window_id?: number; provider?: 'anthropic' | 'openai' | 'openai-low' | 'gemini' | 'llama' | 'grok' | 'mistral' | 'qwen' | 'nova' | 'deepseek-vl' | 'phi' | 'auto'; show_agent_pointer?: boolean }): Promise<ToolResult>
  zoom(region: [number, number, number, number], quality?: number): Promise<ToolResult>
  click(x: number, y: number, targetApp?: string, opts?: WindowTargetOpts): Promise<ToolResult>
  doubleClick(x: number, y: number, targetApp?: string, opts?: WindowTargetOpts): Promise<ToolResult>
  tripleClick(x: number, y: number, targetApp?: string, opts?: WindowTargetOpts): Promise<ToolResult>
  rightClick(x: number, y: number, targetApp?: string, opts?: WindowTargetOpts): Promise<ToolResult>
  middleClick(x: number, y: number, targetApp?: string, opts?: WindowTargetOpts): Promise<ToolResult>
  moveMouse(x: number, y: number, targetApp?: string, opts?: WindowTargetOpts): Promise<ToolResult>
  drag(to: [number, number], from?: [number, number], targetApp?: string, opts?: WindowTargetOpts): Promise<ToolResult>
  mouseDown(x: number, y: number, targetApp?: string, opts?: WindowTargetOpts): Promise<ToolResult>
  mouseUp(x: number, y: number, targetApp?: string, opts?: WindowTargetOpts): Promise<ToolResult>
  type(text: string, targetApp?: string, opts?: WindowTargetOpts & { clear?: boolean; pressEnter?: boolean; caretPosition?: 'start' | 'end' | 'idle' }): Promise<ToolResult>
  key(combo: string, targetApp?: string, opts?: WindowTargetOpts & { repeat?: number }): Promise<ToolResult>
  holdKey(keys: string[], durationSecs: number, targetApp?: string, opts?: WindowTargetOpts): Promise<ToolResult>
  scroll(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right', amount?: number, targetApp?: string, opts?: WindowTargetOpts): Promise<ToolResult>
  readClipboard(): Promise<ToolResult>
  writeClipboard(text: string): Promise<ToolResult>
  openApp(bundleId: string): Promise<ToolResult>
  getFrontmostApp(): Promise<ToolResult>
  listWindows(bundleId?: string): Promise<ToolResult>
  cursorPosition(): Promise<ToolResult>
  wait(seconds: number): Promise<ToolResult>
  listRunningApps(): Promise<ToolResult>
  hideApp(bundleId: string): Promise<ToolResult>
  unhideApp(bundleId: string): Promise<ToolResult>
  getDisplaySize(displayId?: number): Promise<ToolResult>
  listDisplays(): Promise<ToolResult>
  // v4 methods
  getWindow(windowId: number): Promise<ToolResult>
  getCursorWindow(): Promise<ToolResult>
  activateApp(bundleId: string, timeoutMs?: number): Promise<ToolResult>
  activateWindow(windowId: number, timeoutMs?: number): Promise<ToolResult>

  // ── v5: Accessibility observation ─────────────────────────────────────
  getUiTree(windowId: number, maxDepth?: number): Promise<ToolResult>
  getFocusedElement(): Promise<ToolResult>
  findElement(windowId: number, criteria: FindElementCriteria): Promise<ToolResult>

  // ── v5: Semantic actions ──────────────────────────────────────────────
  clickElement(windowId: number, role: string, label: string, opts?: SemanticOpts): Promise<ToolResult>
  setValue(windowId: number, role: string, label: string, value: string, opts?: SemanticOpts): Promise<ToolResult>
  pressButton(windowId: number, label: string, opts?: SemanticOpts): Promise<ToolResult>
  selectMenuItem(bundleId: string, menu: string, item: string, submenu?: string): Promise<ToolResult>
  listMenuBar(bundleId: string): Promise<ToolResult>
  fillForm(windowId: number, fields: FillFormField[], opts?: SemanticOpts): Promise<ToolResult>

  // ── v5: Scripting bridge ──────────────────────────────────────────────
  runScript(language: 'applescript' | 'javascript' | 'powershell', script: string, timeoutMs?: number): Promise<ToolResult>
  getAppDictionary(bundleId: string, suite?: string): Promise<ToolResult>

  // ── v5: Strategy advisor + capabilities ───────────────────────────────
  getToolGuide(taskDescription: string): Promise<ToolResult>
  getAppCapabilities(bundleId: string): Promise<ToolResult>

  // ── v5: Spaces (best effort) ──────────────────────────────────────────
  listSpaces(): Promise<ToolResult>
  getActiveSpace(): Promise<ToolResult>
  createAgentSpace(): Promise<ToolResult>
  moveWindowToSpace(windowId: number, spaceId: number): Promise<ToolResult>
  removeWindowFromSpace(windowId: number, spaceId: number): Promise<ToolResult>
  destroySpace(spaceId: number): Promise<ToolResult>

  // ── v5.2: Tool metadata ───────────────────────────────────────────────
  getToolMetadata(toolName: string): Promise<ToolResult>

  // ── Windows-parity tools ──────────────────────────────────────────────
  filesystem(mode: string, path: string, opts?: Record<string, unknown>): Promise<ToolResult>
  processKill(mode: 'list' | 'kill', opts?: { name?: string; pid?: number; force?: boolean }): Promise<ToolResult>
  registry(mode: string, path: string, opts?: { name?: string; value?: string; type?: string }): Promise<ToolResult>
  notification(title: string, message: string, appId?: string): Promise<ToolResult>
  multiSelect(locs?: [number, number][], opts?: { labels?: string[]; pressCtrl?: boolean; targetApp?: string }): Promise<ToolResult>
  multiEdit(locs?: [number, number, string][], opts?: { labels?: [string, string][]; targetApp?: string }): Promise<ToolResult>
  scrape(url: string, opts?: { query?: string; useDom?: boolean }): Promise<ToolResult>
  resizeWindow(opts: { windowName?: string; windowId?: number; windowSize?: [number, number]; windowLoc?: [number, number] }): Promise<ToolResult>
  snapshot(opts?: { useVision?: boolean; useAnnotation?: boolean; gridLines?: [number, number]; display?: number[]; width?: number; targetApp?: string }): Promise<ToolResult>
  // v8 developer-preview facade (requires COMPUTER_USE_V8=true / enableV8)
  getExecutionCapabilities(tool: string, appId?: string): Promise<ToolResult>
  getCertificationTrace(certificationId: string): Promise<ToolResult>
  previewAction(request: V8ActionRequest): Promise<ToolResult>
  executeAction(request: V8ActionRequest & { actionId: string }): Promise<ToolResult>
  acquireControlLease(request: { sessionId: string; agentId?: string; kind: 'cooperative' | 'exclusive'; mode: 'background' | 'foreground'; ttlMs: number; actionBudget: number; priority?: number; appIds?: string[]; windowIds?: Array<string | number>; displayIds?: string[] }): Promise<ToolResult>
  releaseControlLease(leaseId: string): Promise<ToolResult>
  emergencyStop(reason?: string): Promise<ToolResult>
  startSession(opts?: { objective?: string; executionGroupId?: string }): Promise<ToolResult>
  getSession(sessionId: string): Promise<ToolResult>
  pauseSession(sessionId: string, reason?: string): Promise<ToolResult>
  resumeSession(sessionId: string): Promise<ToolResult>
  takeOver(sessionId: string): Promise<ToolResult>
  stopSession(sessionId: string, reason?: string): Promise<ToolResult>
  approveAction(sessionId: string, actionId: string, ttlMs?: number, opts?: {
    scope?: 'exact_action' | 'session_operation'
    uses?: number
  }): Promise<ToolResult>
  completeSession(sessionId: string, evidence: { summary: string; postconditions: Array<{ description: string; satisfied: boolean; evidenceHash?: string }>; lastAppId?: string; lastWindowId?: string | number; actionCounts: Record<string, number>; reason?: string }): Promise<ToolResult>
  getSessionEvents(sessionId: string, opts?: { afterSequence?: number; limit?: number }): Promise<ToolResult>
  submitFollowUp(sessionId: string, instruction: string): Promise<ToolResult>
  getFollowUps(sessionId: string, opts?: { afterSequence?: number; limit?: number }): Promise<ToolResult>
  deleteSession(sessionId: string): Promise<ToolResult>
  pruneSessions(olderThan: string, limit?: number): Promise<ToolResult>
  reserveTarget(request: { sessionId: string; intentId: string; executionGroupId?: string; agentId?: string; appId: string; windowId?: string | number; ttlMs: number }): Promise<ToolResult>
  releaseTargetReservation(sessionId: string, reservationId: string): Promise<ToolResult>
  onboarding(action: 'start' | 'status' | 'diagnose' | 'test_capture' | 'show_pointer' | 'confirm_pointer' | 'test_pointer' | 'test_semantic' | 'acknowledge_emergency' | 'configure' | 'complete', args?: Record<string, unknown>): Promise<ToolResult>
}

export async function connectStdio(command: string, args: string[], cwd?: string): Promise<ComputerUseClient> {
  const transport = new StdioClientTransport({ command, args, cwd })
  const client = new Client({ name: 'computer-use-client', version: '2.0.0' })
  await client.connect(transport)
  return wrap(client, () => client.close())
}

export async function connectInProcess(server: McpServer): Promise<ComputerUseClient> {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'computer-use-client', version: '2.0.0' })
  await server.connect(st)
  await client.connect(ct)
  return wrap(client, async () => { await client.close(); await server.close() })
}

function targetArgs(app?: string, opts?: WindowTargetOpts): Record<string, unknown> {
  return {
    ...(app ? { target_app: app } : {}),
    ...(opts?.targetWindowId !== undefined ? { target_window_id: opts.targetWindowId } : {}),
    ...(opts?.focusStrategy ? { focus_strategy: opts.focusStrategy } : {}),
  }
}

function v8ActionArgs(request: V8ActionRequest): Record<string, unknown> {
  const target = request.target
  return {
    session_id: request.sessionId,
    ...(request.actionId ? { action_id: request.actionId } : {}),
    ...(request.attempt !== undefined ? { attempt: request.attempt } : {}),
    ...(request.executionGroupId ? { execution_group_id: request.executionGroupId } : {}),
    ...(request.agentId ? { agent_id: request.agentId } : {}),
    tool: request.tool,
    ...(request.operation ? { operation: request.operation } : {}),
    ...(request.certificationId ? { certification_id: request.certificationId } : {}),
    arguments: request.arguments,
    mode: request.mode,
    ...(target ? { target: {
      platform: target.platform,
      app_id: target.appId,
      ...(target.pid !== undefined ? { pid: target.pid } : {}),
      ...(target.windowId !== undefined ? { window_id: target.windowId } : {}),
      ...(target.windowTitleDigest ? { window_title_digest: target.windowTitleDigest } : {}),
      ...(target.displayId ? { display_id: target.displayId } : {}),
      ...(target.role ? { role: target.role } : {}),
      ...(target.labelDigest ? { label_digest: target.labelDigest } : {}),
      ...(target.bounds ? { bounds: target.bounds } : {}),
      observation_id: target.observationId,
      ...(target.screenshotHash ? { screenshot_hash: target.screenshotHash } : {}),
      ...(target.uiTreeRevision ? { ui_tree_revision: target.uiTreeRevision } : {}),
      confidence: target.confidence,
      captured_at: target.capturedAt,
    } } : {}),
    ...(request.postcondition ? { postcondition: request.postcondition.kind === 'ui_element'
      ? {
          kind: request.postcondition.kind,
          ...(request.postcondition.role ? { role: request.postcondition.role } : {}),
          ...(request.postcondition.label ? { label: request.postcondition.label } : {}),
          exists: request.postcondition.exists,
          ...(request.postcondition.valueDigest ? { value_digest: request.postcondition.valueDigest } : {}),
        }
      : request.postcondition.kind === 'filesystem'
        ? {
            kind: request.postcondition.kind, path: request.postcondition.path,
            exists: request.postcondition.exists,
            ...(request.postcondition.contentDigest ? { content_digest: request.postcondition.contentDigest } : {}),
          }
        : request.postcondition.kind === 'registry'
          ? {
              kind: request.postcondition.kind, path: request.postcondition.path,
              name: request.postcondition.name, exists: request.postcondition.exists,
              ...(request.postcondition.valueDigest ? { value_digest: request.postcondition.valueDigest } : {}),
            }
          : request.postcondition.kind === 'process'
            ? { kind: request.postcondition.kind, pid: request.postcondition.pid, running: request.postcondition.running }
            : {
                kind: request.postcondition.kind, window_id: request.postcondition.windowId,
                exists: request.postcondition.exists,
              } } : {}),
    ...(request.dataLabels ? { data_labels: request.dataLabels } : {}),
    ...(request.provenance ? { provenance: {
      untrusted_instruction: request.provenance.untrustedInstruction,
      source_observation_ids: request.provenance.sourceObservationIds,
      ...(request.provenance.crossesDataBoundary !== undefined
        ? { crosses_data_boundary: request.provenance.crossesDataBoundary }
        : {}),
    } } : {}),
    ...(request.expiresInMs !== undefined ? { expires_in_ms: request.expiresInMs } : {}),
    ...(request.leaseId ? { lease_id: request.leaseId } : {}),
    ...(request.approvalGrantId ? { approval_grant_id: request.approvalGrantId } : {}),
  }
}

function wrap(client: Client, closeFn: () => Promise<void>): ComputerUseClient {
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const raw = await client.callTool({ name, arguments: args }) as ToolResult & { structuredContent?: Record<string, unknown> }
    return {
      content: raw.content,
      ...(raw.structuredContent !== undefined ? { structuredContent: raw.structuredContent } : {}),
      ...(raw.isError ? { isError: true } : {}),
    }
  }

  return {
    async listTools() {
      return (await client.listTools()).tools.map(t => ({
        name: t.name,
        description: t.description,
        annotations: t.annotations as ListedTool['annotations'],
        _meta: (t as { _meta?: Record<string, unknown> })._meta,
        inputSchema: t.inputSchema,
        outputSchema: (t as { outputSchema?: unknown }).outputSchema,
      }))
    },
    callTool: call,
    async listResources() {
      const r = await client.listResources()
      return r.resources.map(res => ({
        uri: res.uri,
        name: res.name,
        description: res.description,
        mimeType: res.mimeType,
      }))
    },
    async listResourceTemplates() {
      const result = await client.listResourceTemplates()
      return result.resourceTemplates.map(template => ({
        uriTemplate: template.uriTemplate,
        name: template.name,
        description: template.description,
        mimeType: template.mimeType,
      }))
    },
    async readResource(uri: string) {
      return client.readResource({ uri })
    },
    async listPrompts() {
      const r = await client.listPrompts()
      return r.prompts.map(p => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      }))
    },
    async getPrompt(name: string, args?: Record<string, string>) {
      return client.getPrompt({ name, arguments: args })
    },
    close: closeFn,
    doctor: (args?) => call('doctor', { ...(args?.includeRemediation !== undefined ? { include_remediation: args.includeRemediation } : {}) }),
    policyStatus: () => call('policy_status'),
    agentPointer: (action, opts?) => call('agent_pointer', {
      action,
      ...(opts?.coordinate ? { coordinate: opts.coordinate } : {}),
      ...(opts?.visible !== undefined ? { visible: opts.visible } : {}),
      ...(opts?.nativeOverlay !== undefined ? { native_overlay: opts.nativeOverlay } : {}),
    }),
    openaiComputer: (args) => call('openai_computer', {
      ...(args.action ? { action: args.action } : {}),
      ...(args.actions ? { actions: args.actions } : {}),
      ...(args.targetApp ? { target_app: args.targetApp } : {}),
      ...(args.targetWindowId !== undefined ? { target_window_id: args.targetWindowId } : {}),
      ...(args.focusStrategy ? { focus_strategy: args.focusStrategy } : {}),
      ...(args.returnScreenshot !== undefined ? { return_screenshot: args.returnScreenshot } : {}),
      ...(args.useVirtualPointer !== undefined ? { use_virtual_pointer: args.useVirtualPointer } : {}),
      ...(args.nativeOverlay !== undefined ? { native_overlay: args.nativeOverlay } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
      ...(args.quality !== undefined ? { quality: args.quality } : {}),
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.approvalToken ? { approval_token: args.approvalToken } : {}),
    }),
    screenshot: (args?) => call('screenshot', args ?? {}),
    zoom: (region, quality?) => call('zoom', { region, ...(quality !== undefined ? { quality } : {}) }),
    click: (x, y, app?, opts?) => call('left_click', { coordinate: [x, y], ...targetArgs(app, opts) }),
    doubleClick: (x, y, app?, opts?) => call('double_click', { coordinate: [x, y], ...targetArgs(app, opts) }),
    tripleClick: (x, y, app?, opts?) => call('triple_click', { coordinate: [x, y], ...targetArgs(app, opts) }),
    rightClick: (x, y, app?, opts?) => call('right_click', { coordinate: [x, y], ...targetArgs(app, opts) }),
    middleClick: (x, y, app?, opts?) => call('middle_click', { coordinate: [x, y], ...targetArgs(app, opts) }),
    moveMouse: (x, y, app?, opts?) => call('mouse_move', { coordinate: [x, y], ...targetArgs(app, opts) }),
    drag: (to, from?, app?, opts?) => call('left_click_drag', { coordinate: to, ...(from ? { start_coordinate: from } : {}), ...targetArgs(app, opts) }),
    mouseDown: (x, y, app?, opts?) => call('left_mouse_down', { coordinate: [x, y], ...targetArgs(app, opts) }),
    mouseUp: (x, y, app?, opts?) => call('left_mouse_up', { coordinate: [x, y], ...targetArgs(app, opts) }),
    type: (text, app?, opts?) => call('type', { text, ...targetArgs(app, opts), ...(opts?.clear !== undefined ? { clear: opts.clear } : {}), ...(opts?.pressEnter !== undefined ? { press_enter: opts.pressEnter } : {}), ...(opts?.caretPosition ? { caret_position: opts.caretPosition } : {}) }),
    key: (combo, app?, opts?) => call('key', { text: combo, ...targetArgs(app, opts), ...(opts?.repeat !== undefined ? { repeat: opts.repeat } : {}) }),
    holdKey: (keys, durationSecs, app?, opts?) => call('hold_key', { keys, duration: durationSecs, ...targetArgs(app, opts) }),
    scroll: (x, y, dir, amt = 3, app?, opts?) => call('scroll', { coordinate: [x, y], direction: dir, amount: amt, ...targetArgs(app, opts) }),
    readClipboard: () => call('read_clipboard'),
    writeClipboard: (text) => call('write_clipboard', { text }),
    openApp: (id) => call('open_application', { bundle_id: id }),
    getFrontmostApp: () => call('get_frontmost_app'),
    listWindows: (bundleId) => call('list_windows', bundleId ? { bundle_id: bundleId } : {}),
    cursorPosition: () => call('cursor_position'),
    wait: (s) => call('wait', { duration: s }),
    listRunningApps: () => call('list_running_apps'),
    hideApp: (id) => call('hide_app', { bundle_id: id }),
    unhideApp: (id) => call('unhide_app', { bundle_id: id }),
    getDisplaySize: (id) => call('get_display_size', id !== undefined ? { display_id: id } : {}),
    listDisplays: () => call('list_displays'),
    // v4 methods
    getWindow: (windowId) => call('get_window', { window_id: windowId }),
    getCursorWindow: () => call('get_cursor_window'),
    activateApp: (bundleId, timeoutMs?) => call('activate_app', { bundle_id: bundleId, ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) }),
    activateWindow: (windowId, timeoutMs?) => call('activate_window', { window_id: windowId, ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}) }),

    // v5: Accessibility observation
    getUiTree: (windowId, maxDepth?) => call('get_ui_tree', {
      window_id: windowId,
      ...(maxDepth !== undefined ? { max_depth: maxDepth } : {}),
    }),
    getFocusedElement: () => call('get_focused_element'),
    findElement: (windowId, criteria) => call('find_element', {
      window_id: windowId,
      ...(criteria.role !== undefined ? { role: criteria.role } : {}),
      ...(criteria.label !== undefined ? { label: criteria.label } : {}),
      ...(criteria.value !== undefined ? { value: criteria.value } : {}),
      ...(criteria.maxResults !== undefined ? { max_results: criteria.maxResults } : {}),
    }),

    // v5: Semantic actions
    clickElement: (windowId, role, label, opts?) => call('click_element', {
      window_id: windowId, role, label,
      ...(opts?.focusStrategy ? { focus_strategy: opts.focusStrategy } : {}),
    }),
    setValue: (windowId, role, label, value, opts?) => call('set_value', {
      window_id: windowId, role, label, value,
      ...(opts?.focusStrategy ? { focus_strategy: opts.focusStrategy } : {}),
    }),
    pressButton: (windowId, label, opts?) => call('press_button', {
      window_id: windowId, label,
      ...(opts?.focusStrategy ? { focus_strategy: opts.focusStrategy } : {}),
    }),
    selectMenuItem: (bundleId, menu, item, submenu?) => call('select_menu_item', {
      bundle_id: bundleId, menu, item,
      ...(submenu !== undefined ? { submenu } : {}),
    }),
    listMenuBar: (bundleId) => call('list_menu_bar', { bundle_id: bundleId }),
    fillForm: (windowId, fields, opts?) => call('fill_form', {
      window_id: windowId, fields,
      ...(opts?.focusStrategy ? { focus_strategy: opts.focusStrategy } : {}),
    }),

    // v5: Scripting bridge
    runScript: (language, script, timeoutMs?) => call('run_script', {
      language, script,
      ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
    }),
    getAppDictionary: (bundleId, suite?) => call('get_app_dictionary', {
      bundle_id: bundleId,
      ...(suite !== undefined ? { suite } : {}),
    }),

    // v5: Strategy advisor
    getToolGuide: (taskDescription) => call('get_tool_guide', { task_description: taskDescription }),
    getAppCapabilities: (bundleId) => call('get_app_capabilities', { bundle_id: bundleId }),

    // v5: Spaces
    listSpaces: () => call('list_spaces'),
    getActiveSpace: () => call('get_active_space'),
    createAgentSpace: () => call('create_agent_space'),
    moveWindowToSpace: (windowId, spaceId) => call('move_window_to_space', {
      window_id: windowId, space_id: spaceId,
    }),
    removeWindowFromSpace: (windowId, spaceId) => call('remove_window_from_space', {
      window_id: windowId, space_id: spaceId,
    }),
    destroySpace: (spaceId) => call('destroy_space', { space_id: spaceId }),

    // v5.2: Tool metadata
    getToolMetadata: (toolName) => call('get_tool_metadata', { tool_name: toolName }),

    // Windows-parity tools
    filesystem: (mode, path, opts?) => call('filesystem', { mode, path, ...opts }),
    processKill: (mode, opts?) => call('process_kill', { mode, ...opts }),
    registry: (mode, path, opts?) => call('registry', { mode, path, ...opts }),
    notification: (title, message, appId?) => call('notification', { title, message, ...(appId ? { app_id: appId } : {}) }),
    multiSelect: (locs?, opts?) => call('multi_select', { ...(locs ? { locs } : {}), ...(opts?.labels ? { labels: opts.labels } : {}), ...(opts?.pressCtrl !== undefined ? { press_ctrl: opts.pressCtrl } : {}), ...(opts?.targetApp ? { target_app: opts.targetApp } : {}) }),
    multiEdit: (locs?, opts?) => call('multi_edit', { ...(locs ? { locs } : {}), ...(opts?.labels ? { labels: opts.labels } : {}), ...(opts?.targetApp ? { target_app: opts.targetApp } : {}) }),
    scrape: (url, opts?) => call('scrape', { url, ...(opts?.query ? { query: opts.query } : {}), ...(opts?.useDom !== undefined ? { use_dom: opts.useDom } : {}) }),
    resizeWindow: (opts) => call('resize_window', { ...(opts.windowName ? { window_name: opts.windowName } : {}), ...(opts.windowId !== undefined ? { window_id: opts.windowId } : {}), ...(opts.windowSize ? { window_size: opts.windowSize } : {}), ...(opts.windowLoc ? { window_loc: opts.windowLoc } : {}) }),
    snapshot: (opts?) => call('snapshot', { ...(opts?.useVision !== undefined ? { use_vision: opts.useVision } : {}), ...(opts?.useAnnotation !== undefined ? { use_annotation: opts.useAnnotation } : {}), ...(opts?.gridLines ? { grid_lines: opts.gridLines } : {}), ...(opts?.display ? { display: opts.display } : {}), ...(opts?.width ? { width: opts.width } : {}), ...(opts?.targetApp ? { target_app: opts.targetApp } : {}) }),
    getExecutionCapabilities: (tool, appId?) => call('get_execution_capabilities', { tool, ...(appId ? { app_id: appId } : {}) }),
    getCertificationTrace: certificationId => call('get_certification_trace', { certification_id: certificationId }),
    previewAction: (request) => call('preview_action', v8ActionArgs(request)),
    executeAction: (request) => call('execute_action', v8ActionArgs(request)),
    acquireControlLease: (request) => call('acquire_control_lease', {
      session_id: request.sessionId,
      ...(request.agentId ? { agent_id: request.agentId } : {}),
      kind: request.kind,
      mode: request.mode,
      ttl_ms: request.ttlMs,
      action_budget: request.actionBudget,
      ...(request.priority !== undefined ? { priority: request.priority } : {}),
      ...(request.appIds ? { app_ids: request.appIds } : {}),
      ...(request.windowIds ? { window_ids: request.windowIds } : {}),
      ...(request.displayIds ? { display_ids: request.displayIds } : {}),
    }),
    releaseControlLease: (leaseId) => call('release_control_lease', { lease_id: leaseId }),
    emergencyStop: (reason?) => call('emergency_stop', { ...(reason ? { reason } : {}) }),
    startSession: (opts?) => call('start_session', {
      ...(opts?.objective ? { objective: opts.objective } : {}),
      ...(opts?.executionGroupId ? { execution_group_id: opts.executionGroupId } : {}),
    }),
    getSession: (sessionId) => call('get_session', { session_id: sessionId }),
    pauseSession: (sessionId, reason?) => call('pause_session', { session_id: sessionId, ...(reason ? { reason } : {}) }),
    resumeSession: (sessionId) => call('resume_session', { session_id: sessionId }),
    takeOver: (sessionId) => call('take_over', { session_id: sessionId }),
    stopSession: (sessionId, reason?) => call('stop_session', { session_id: sessionId, ...(reason ? { reason } : {}) }),
    approveAction: (sessionId, actionId, ttlMs?, opts?) => call('approve_action', {
      session_id: sessionId, action_id: actionId, ...(ttlMs !== undefined ? { ttl_ms: ttlMs } : {}),
      ...(opts?.scope ? { scope: opts.scope } : {}),
      ...(opts?.uses !== undefined ? { uses: opts.uses } : {}),
    }),
    completeSession: (sessionId, evidence) => call('complete_session', {
      session_id: sessionId,
      summary: evidence.summary,
      postconditions: evidence.postconditions.map(item => ({
        description: item.description, satisfied: item.satisfied,
        ...(item.evidenceHash ? { evidence_hash: item.evidenceHash } : {}),
      })),
      ...(evidence.lastAppId ? { last_app_id: evidence.lastAppId } : {}),
      ...(evidence.lastWindowId !== undefined ? { last_window_id: evidence.lastWindowId } : {}),
      action_counts: evidence.actionCounts,
      ...(evidence.reason ? { reason: evidence.reason } : {}),
    }),
    getSessionEvents: (sessionId, opts?) => call('get_session_events', {
      session_id: sessionId,
      ...(opts?.afterSequence !== undefined ? { after_sequence: opts.afterSequence } : {}),
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    }),
    submitFollowUp: (sessionId, instruction) => call('submit_follow_up', { session_id: sessionId, instruction }),
    getFollowUps: (sessionId, opts?) => call('get_follow_ups', {
      session_id: sessionId,
      ...(opts?.afterSequence !== undefined ? { after_sequence: opts.afterSequence } : {}),
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    }),
    deleteSession: (sessionId) => call('delete_session', { session_id: sessionId, confirm: true }),
    pruneSessions: (olderThan, limit?) => call('prune_sessions', {
      older_than: olderThan,
      ...(limit !== undefined ? { limit } : {}),
      confirm: true,
    }),
    reserveTarget: (request) => call('reserve_target', {
      session_id: request.sessionId,
      intent_id: request.intentId,
      ...(request.executionGroupId ? { execution_group_id: request.executionGroupId } : {}),
      ...(request.agentId ? { agent_id: request.agentId } : {}),
      app_id: request.appId,
      ...(request.windowId !== undefined ? { window_id: request.windowId } : {}),
      ttl_ms: request.ttlMs,
    }),
    releaseTargetReservation: (sessionId, reservationId) => call('release_target_reservation', {
      session_id: sessionId, reservation_id: reservationId,
    }),
    onboarding: (action, args?) => call('onboarding', { action, ...args }),
  }
}
