/**
 * Tool guide — maps a task description to a recommended automation approach.
 * Extracted verbatim from session.ts (PR-13a mechanical split; zero behavior change).
 */

export type AutomationApproach = 'scripting' | 'accessibility' | 'keyboard' | 'coordinate'

export interface ToolGuideEntry {
  approach: AutomationApproach
  toolSequence: string[]
  explanation: string
  bundleIdHints?: string[]
  confidence?: number
  fallbackSequence?: string[]
  platform?: 'darwin' | 'win32' | 'any'
  unavailableInProfile?: string[]
  remediation?: string
}

interface ToolGuidePattern extends ToolGuideEntry {
  pattern: RegExp
}

const TOOL_GUIDE_TABLE: ToolGuidePattern[] = [
  // ── Windows-specific entries (checked first on Windows) ─────────────────
  ...(process.platform === 'win32' ? [
    {
      pattern: /\b(file|folder|directory|rename|move|copy)\b.*\b(file|folder|directory|desktop)\b|\b(desktop)\b.*\b(file|folder|save|copy)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['filesystem', 'run_script'],
      explanation:
        'Use the filesystem tool for file operations, or PowerShell via run_script for complex tasks. Faster than GUI clicks.',
    },
    {
      pattern: /\b(registry|regedit|hkey|hkcu|hklm)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['registry'],
      explanation:
        'Use the registry tool for Windows Registry operations. Accepts PowerShell-format paths.',
    },
    {
      pattern: /\b(send|compose|reply|new|write).*(email|mail|message)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Use PowerShell via run_script to automate email. For Outlook: `$ol = New-Object -ComObject Outlook.Application; $mail = $ol.CreateItem(0)`.',
    },
    {
      pattern: /\b(open|visit|navigate).*(url|website|https?:|web\s*page|tab)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Use PowerShell: `Start-Process "https://example.com"` to open URLs in the default browser.',
    },
    {
      pattern: /\b(powershell|cmd|terminal|command|shell|script)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Use run_script with language "powershell" for system automation, CLI tools, and scripting.',
    },
    {
      pattern: /\b(process|task|kill|terminate|stop)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['process_kill'],
      explanation:
        'Use process_kill to list or terminate processes by name or PID.',
    },
    {
      pattern: /\b(notify|notification|alert|toast)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['notification'],
      explanation:
        'Use the notification tool to send Windows toast notifications.',
    },
  ] as ToolGuidePattern[] : []),
  // ── macOS-specific entries ──────────────────────────────────────────────
  ...(process.platform === 'darwin' ? [
    {
      pattern: /\b(send|compose|reply|new|write).*(email|mail|message)\b/i,
      bundleIdHints: ['com.apple.mail'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['get_app_capabilities', 'run_script'],
      explanation:
        'Mail is scriptable. Use AppleScript `make new outgoing message` or `send` — one call replaces the whole compose flow.',
    },
    {
      pattern: /\b(open|visit|navigate).*(url|website|https?:|web\s*page|tab)\b/i,
      bundleIdHints: ['com.apple.Safari', 'com.google.Chrome'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Safari and Chrome are scriptable. `tell application "Safari" to open location "<url>"` beats screenshot-and-click.',
    },
    {
      pattern: /\b(spreadsheet|cell|row|column|numbers|sheet)\b/i,
      bundleIdHints: ['com.apple.iWork.Numbers', 'com.microsoft.Excel'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['get_app_dictionary', 'run_script'],
      explanation:
        'Numbers is deeply scriptable — read/write cells via AppleScript. Fall back to fill_form if scripting is unavailable.',
    },
    {
      pattern: /\b(file|folder|directory|finder|rename|move|copy|desktop)\b/i,
      bundleIdHints: ['com.apple.finder'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Finder is scriptable (and shell is often even better). Prefer `osascript` or direct filesystem calls over GUI clicks.',
    },
    {
      pattern: /\b(calendar|event|reminder|note|todo|task)\b/i,
      bundleIdHints: ['com.apple.iCal', 'com.apple.reminders', 'com.apple.Notes'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['get_app_capabilities', 'run_script'],
      explanation:
        'Calendar, Reminders, and Notes are all scriptable. One `make new <event/reminder/note>` call does the work.',
    },
    {
      pattern: /\b(play|pause|track|playlist|song|music)\b/i,
      bundleIdHints: ['com.apple.Music'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Music.app is scriptable: `tell application "Music" to play` / `pause` / `next track`.',
    },
    {
      pattern: /\b(imessage|send\s+message|chat|sms)\b/i,
      bundleIdHints: ['com.apple.iChat'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Messages is scriptable. Use AppleScript to send messages to a buddy without UI.',
    },
  ] as ToolGuidePattern[] : []),
  // ── Cross-platform entries ─────────────────────────────────────────────
  {
    pattern: /\b(fill|enter|type)\b.*\b(form|field|input)\b/i,
    approach: 'accessibility',
    toolSequence: ['get_ui_tree', 'fill_form'],
    explanation:
      'Batch-set form fields by accessibility label — one fill_form call instead of click+type per field.',
  },
  {
    pattern: /\b(menu|menubar|file\s*(menu)?|edit\s*menu)\b/i,
    approach: 'accessibility',
    toolSequence: ['select_menu_item'],
    explanation:
      'Use select_menu_item — walks the menu bar programmatically, faster and more reliable than visual navigation.',
  },
  {
    pattern: /\b(click|press|tap)\b.*\b(button|link)\b/i,
    approach: 'accessibility',
    toolSequence: ['find_element', 'press_button'],
    explanation:
      'press_button finds buttons by label — avoids pixel-coordinate drift across window moves and resolution changes.',
  },
  {
    pattern: /\b(read|inspect|verify|check|examine|zoom|detail|small\s*text|tiny|pixel|magnif|enlarge|close.?up)\b/i,
    approach: 'coordinate' as AutomationApproach,
    toolSequence: ['zoom'],
    explanation:
      'Use the zoom tool to inspect a specific screen region at full native resolution. Pass region: [x1, y1, x2, y2] to crop without downscaling. Best for reading small text, verifying values, or checking pixel-level details. Default output is lossless PNG. Tip: take a screenshot first to identify the region coordinates, then zoom into the area of interest.',
  },
  {
    pattern: /\b(text|value|number|label|title|heading|content|status|what\s*does\s*it\s*say|read\s*the|what\s*is\s*written|what\s*does.*say)\b/i,
    approach: 'accessibility' as AutomationApproach,
    toolSequence: ['get_ui_tree', 'zoom'],
    explanation:
      'To read text on screen: first try get_ui_tree which returns element labels and values as structured data (fastest, no image needed). If the text is in an image or non-accessible element, use zoom with a tight region around the text for a full-resolution lossless PNG crop.',
  },
  {
    pattern: /\b(screenshot|see|show|look|observe|capture|screen)\b/i,
    approach: 'accessibility' as AutomationApproach,
    toolSequence: ['screenshot', 'zoom'],
    explanation:
      'Use screenshot for a full-screen overview (resized for efficiency). If you need to read specific text or inspect details, follow up with zoom on the region of interest — it returns full native resolution without downscaling. For structured UI data without an image, use get_ui_tree instead.',
  },
  {
    pattern: /.*/,
    approach: 'accessibility',
    toolSequence: ['get_app_capabilities', 'get_ui_tree', 'find_element', 'click_element'],
    explanation:
      'No specific pattern matched. Probe capabilities, then prefer accessibility — fall back to coordinate input only as a last resort.',
  },
]

export function lookupToolGuide(
  taskDescription: string,
  profile?: string,
): ToolGuideEntry & {
  confidence?: number
  fallbackSequence?: string[]
  platform?: 'darwin' | 'win32' | 'any'
  unavailableInProfile?: string[]
  remediation?: string
} {
  for (const entry of TOOL_GUIDE_TABLE) {
    if (entry.pattern.test(taskDescription)) {
      const result: ToolGuideEntry & {
        confidence?: number
        fallbackSequence?: string[]
        platform?: 'darwin' | 'win32' | 'any'
        unavailableInProfile?: string[]
        remediation?: string
      } = {
        approach: entry.approach,
        toolSequence: entry.toolSequence,
        explanation: entry.explanation,
        ...(entry.bundleIdHints ? { bundleIdHints: entry.bundleIdHints } : {}),
        confidence: entry.pattern.source === '.*' ? 0.3 : 0.85,
        platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'any',
        fallbackSequence: ['get_app_capabilities', 'get_ui_tree', 'find_element', 'click_element'],
      }
      if (profile && profile !== 'full') {
        // Lazy import avoided — check against catalog in server; here flag tools not in generic core-like sets
        const coreish = new Set([
          'doctor', 'policy_status', 'get_tool_guide', 'get_tool_metadata', 'get_app_capabilities',
          'screenshot', 'zoom', 'get_display_size', 'list_displays', 'list_windows', 'get_window',
          'get_frontmost_app', 'cursor_position', 'read_clipboard', 'write_clipboard',
          'left_click', 'double_click', 'right_click', 'mouse_move', 'scroll', 'type', 'key',
          'hold_key', 'wait', 'open_application', 'activate_app', 'activate_window',
        ])
        if (profile === 'core') {
          const missing = entry.toolSequence.filter(t => !coreish.has(t))
          if (missing.length) {
            result.unavailableInProfile = missing
            result.remediation = `Active profile is "${profile}". Missing tools: ${missing.join(', ')}. Set COMPUTER_USE_PROFILE=full or restart with a broader profile.`
          }
        }
      }
      return result
    }
  }
  return {
    approach: 'accessibility',
    toolSequence: ['get_ui_tree'],
    explanation: 'Default fallback.',
    confidence: 0.2,
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'any',
  }
}
