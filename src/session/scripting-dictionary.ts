/**
 * Scripting dictionary (.sdef) parser — extracted verbatim from session.ts
 * (PR-13b session split; zero behavior change).
 */

// ── Scripting dictionary parser ───────────────────────────────────────────────

export interface ScriptingDictionaryCommand {
  name: string
  description?: string
}

export interface ScriptingDictionaryClass {
  name: string
  properties?: string[]
}

export interface ScriptingDictionarySuite {
  name: string
  commands: ScriptingDictionaryCommand[]
  classes: ScriptingDictionaryClass[]
}

export interface ScriptingDictionary {
  bundleId: string
  suites: ScriptingDictionarySuite[]
}

/** Minimal `.sdef` parser — extracts suite/command/class names from the XML. */
export function parseSdef(xml: string, bundleId: string): ScriptingDictionary {
  const suites: ScriptingDictionarySuite[] = []
  const suiteRe = /<suite\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/suite>/g
  let m: RegExpExecArray | null
  while ((m = suiteRe.exec(xml)) !== null) {
    const suiteName = m[1]
    const body = m[2]
    const commands: ScriptingDictionaryCommand[] = []
    const cmdRe = /<command\b[^>]*\bname="([^"]+)"[^>]*(?:\/>|>([\s\S]*?)<\/command>)/g
    let cm: RegExpExecArray | null
    while ((cm = cmdRe.exec(body)) !== null) {
      const desc = cm[0].match(/\bdescription="([^"]*)"/)?.[1]
      commands.push(desc ? { name: cm[1], description: desc } : { name: cm[1] })
    }
    const classes: ScriptingDictionaryClass[] = []
    const classRe = /<class\b[^>]*\bname="([^"]+)"[^>]*(?:\/>|>([\s\S]*?)<\/class>)/g
    let classMatch: RegExpExecArray | null
    while ((classMatch = classRe.exec(body)) !== null) {
      const clsName = classMatch[1]
      const clsBody = classMatch[2] ?? ''
      const propNames: string[] = []
      const propRe = /<property\b[^>]*\bname="([^"]+)"/g
      let pm: RegExpExecArray | null
      while ((pm = propRe.exec(clsBody)) !== null) {
        propNames.push(pm[1])
      }
      classes.push(propNames.length ? { name: clsName, properties: propNames } : { name: clsName })
    }
    suites.push({ name: suiteName, commands, classes })
  }
  return { bundleId, suites }
}
