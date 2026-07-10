/**
 * Zod output schemas for priority tools (Appendix C).
 * Only attach to registerTool when success path always emits matching structuredContent (K17).
 */

import { z } from 'zod'

const DoctorCheck = z.object({
  id: z.string(),
  status: z.enum(['pass', 'fail', 'warn', 'skip']),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  remediation: z.array(z.string()).optional(),
})

export const DoctorOutput = z.object({
  ok: z.boolean(),
  summary: z.object({
    passed: z.number(),
    warned: z.number(),
    failed: z.number(),
    skipped: z.number(),
  }),
  platform: z.object({
    os: z.string(),
    arch: z.string(),
    node: z.string(),
  }),
  checks: z.array(DoctorCheck),
})

export const PolicyStatusOutput = z.object({
  allowed_apps: z.array(z.string()),
  blocked_apps: z.array(z.string()),
  sensitive_apps: z.array(z.string()),
  require_approval_for: z.array(z.string()),
  approval_required_for_all: z.boolean(),
  destructive_requires_approval: z.boolean(),
  approval_token_configured: z.boolean(),
  audit: z.object({
    enabled: z.boolean(),
    path: z.string().nullable(),
  }),
  profile: z.string().optional(),
})

export const ToolGuideOutput = z.object({
  approach: z.enum(['scripting', 'accessibility', 'keyboard', 'coordinate']),
  toolSequence: z.array(z.string()),
  explanation: z.string(),
  bundleIdHints: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  fallbackSequence: z.array(z.string()).optional(),
  platform: z.enum(['darwin', 'win32', 'any']).optional(),
  unavailableInProfile: z.array(z.string()).optional(),
  remediation: z.string().optional(),
})

export const ToolMetadataOutput = z.object({
  tool_name: z.string(),
  focusRequired: z.enum(['scripting', 'ax', 'cgevent', 'none']),
  mutates: z.boolean(),
  requiresFocus: z.boolean(),
  movesUserCursor: z.boolean(),
  usesVirtualPointer: z.boolean(),
  physicalInput: z.boolean(),
})

export const AppCapabilitiesOutput = z.object({
  bundle_id: z.string(),
  scriptable: z.boolean().optional(),
  accessible: z.boolean().optional(),
  running: z.boolean().optional(),
  hidden: z.boolean().optional(),
  powershell: z.boolean().optional(),
  suites: z.array(z.string()).optional(),
  topLevelCount: z.number().optional(),
}).passthrough()

const WindowRecord = z.object({
  windowId: z.number(),
  bundleId: z.string().nullable().optional(),
  displayName: z.string().optional(),
  pid: z.number().optional(),
  title: z.string().nullable().optional(),
  bounds: z.object({
    x: z.number(), y: z.number(), width: z.number(), height: z.number(),
  }).optional(),
  isOnScreen: z.boolean().optional(),
  isFocused: z.boolean().optional(),
  displayId: z.number().optional(),
}).passthrough()

export const GetWindowOutput = WindowRecord

export const ListWindowsOutput = z.object({
  windows: z.array(WindowRecord),
})

export const FrontmostAppOutput = z.object({
  app: z.object({
    bundleId: z.string(),
    displayName: z.string(),
    pid: z.number(),
  }).passthrough().nullable(),
})

export const GetActiveSpaceOutput = z.object({
  active_space_id: z.number().nullable(),
})

export const DisplaySizeOutput = z.object({
  width: z.number(),
  height: z.number(),
  pixelWidth: z.number().optional(),
  pixelHeight: z.number().optional(),
  scaleFactor: z.number().optional(),
}).passthrough()

/** Map of tool name → Zod shape for registerTool outputSchema (raw shape). */
export const PRIORITY_OUTPUT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  doctor: DoctorOutput,
  policy_status: PolicyStatusOutput,
  get_tool_guide: ToolGuideOutput,
  get_tool_metadata: ToolMetadataOutput,
  get_app_capabilities: AppCapabilitiesOutput,
  get_window: GetWindowOutput,
  list_windows: ListWindowsOutput,
  get_frontmost_app: FrontmostAppOutput,
  get_active_space: GetActiveSpaceOutput,
  get_display_size: DisplaySizeOutput,
}
