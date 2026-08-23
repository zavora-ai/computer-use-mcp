/**
 * MCP prompts — host-discoverable workflow templates (P1 §4 / PR-6).
 */

import { completable, type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { Session } from './session.js'

export function registerPrompts(server: McpServer, session?: Session): void {
  const appArgument = completable(
    z.string().describe('Bundle ID (macOS) or process name (Windows) of the target app'),
    async value => completeApps(session, value),
  )
  server.registerPrompt(
    'diagnose-desktop',
    {
      title: 'Diagnose desktop setup',
      description: 'Run doctor and summarize permission/setup fixes for computer-use-mcp.',
    },
    async () => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            'Run the computer-use doctor tool with include_remediation=true.',
            'Summarize any fail/warn checks and give exact fix steps for this OS.',
            'Then call policy_status and note whether approval is configured.',
          ].join('\n'),
        },
      }],
    }),
  )

  server.registerPrompt(
    'fill-form',
    {
      title: 'Fill a form via accessibility',
      description: 'Discover a window UI tree and fill form fields without coordinate clicking.',
      argsSchema: {
        app: appArgument,
        fields_description: z.string().describe('Natural language description of fields and values to fill'),
      },
    },
    async (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Fill a form in app "${args.app}".`,
            `Fields: ${args.fields_description}`,
            'Steps:',
            '1. list_windows for the app; pick the form window_id.',
            '2. get_ui_tree(window_id) or find_element for each field.',
            '3. fill_form with role/label/value entries (prefer over type).',
            '4. Verify with get_ui_tree or a targeted zoom — avoid full-screen screenshot loops.',
          ].join('\n'),
        },
      }],
    }),
  )

  server.registerPrompt(
    'script-first',
    {
      title: 'Script-first automation',
      description: 'Prefer AppleScript/JXA or PowerShell before GUI automation.',
      argsSchema: {
        task: z.string().describe('Task to automate'),
        app: appArgument.optional().describe('Optional target app id'),
      },
    },
    async (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Automate this task using scripting first: ${args.task}`,
            args.app ? `Preferred app: ${args.app}` : '',
            'Steps:',
            '1. get_tool_guide with the task description.',
            args.app ? `2. get_app_capabilities("${args.app}").` : '2. Identify the app and call get_app_capabilities.',
            '3. On macOS use run_script language applescript or javascript; on Windows use powershell.',
            '4. Fall back to accessibility only if scripting is unavailable.',
            '5. Use coordinate clicks only as a last resort.',
          ].filter(Boolean).join('\n'),
        },
      }],
    }),
  )

  server.registerPrompt(
    'safe-desktop-task',
    {
      title: 'Safe desktop task',
      description: 'Policy-aware desktop automation with approval awareness.',
      argsSchema: {
        task: z.string().describe('User task'),
      },
    },
    async (args) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            `Complete this desktop task carefully: ${args.task}`,
            'Steps:',
            '1. policy_status — note approval and blocked apps.',
            '2. get_tool_guide for the task.',
            '3. Prefer non-destructive paths; avoid process_kill, filesystem delete, and registry set unless required.',
            '4. For sensitive apps, obtain approval before mutating actions.',
            '5. Always set target_app or target_window_id for input.',
          ].join('\n'),
        },
      }],
    }),
  )
}

async function completeApps(session: Session | undefined, value: string): Promise<string[]> {
  if (!session) return []
  try {
    const result = await session.dispatch('list_running_apps', {})
    const text = result.content.find(item => item.type === 'text')
    if (!text || text.type !== 'text') return []
    const parsed = JSON.parse(text.text) as unknown
    const apps = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { apps?: unknown }).apps)
        ? (parsed as { apps: unknown[] }).apps
        : []
    return apps.flatMap(app => {
      if (typeof app !== 'object' || app === null) return []
      const record = app as Record<string, unknown>
      const candidate = String(record.bundleId ?? record.bundle_id ?? record.name ?? '')
      return candidate.toLowerCase().startsWith(value.toLowerCase()) ? [candidate] : []
    }).filter(Boolean).slice(0, 100)
  } catch {
    return []
  }
}
