/**
 * Two MCP servers behind one DeepSeek Flash agent.
 *
 * The official Blender MCP does everything inside Blender: it runs Python in the
 * live session, reads the scene, searches the bundled API docs, renders, and
 * reports its own window layout as JSON. computer-use does what has no API —
 * launching the app, seeing a modal dialog that is blocking the socket, gestural
 * strokes, and producing evidence a human can look at.
 *
 * Tools are namespaced by server (`blender.execute_blender_code`,
 * `desktop.screenshot`) so the model always knows which surface it is on, and so a
 * name collision between servers is impossible.
 */

import { readFileSync } from 'node:fs'
import { connectStdio, connectInProcess } from '../../dist/client.js'
import { createComputerUseServer } from '../../dist/server.js'

/** Separator between namespace and tool name. Chosen to be schema-safe. */
const NS = '__'

/**
 * Wrap a connected MCP client so its tools carry a namespace.
 *
 * Returns the shape `runAgent` expects from `client`, so the agent loop does not
 * need to know that more than one server exists.
 */
export function namespaceTools(sources) {
  const byNamespace = new Map(sources.map(source => [source.namespace, source]))
  /** Resolve `namespace__tool` without depending on a prior listTools() call. */
  const resolve = name => {
    const index = String(name).indexOf(NS)
    if (index < 0) throw new Error(`Tool name must be namespaced as namespace${NS}tool: ${name}`)
    const namespace = name.slice(0, index)
    const original = name.slice(index + NS.length)
    const source = byNamespace.get(namespace)
    if (!source) throw new Error(`Unknown namespace "${namespace}" in ${name}`)
    // Enforce the allowlist on the call, not only when advertising: a tool that is
    // never listed must also be unreachable by guessing its name.
    if (source.only && !source.only.includes(original)) {
      throw new Error(`Tool not permitted in this workflow: ${name}`)
    }
    return { client: source.client, original }
  }
  return {
    resolve,
    async listTools() {
      const listed = []
      for (const { namespace, client, only } of sources) {
        for (const tool of await client.listTools()) {
          if (only && !only.includes(tool.name)) continue
          listed.push({ ...tool, name: `${namespace}${NS}${tool.name}` })
        }
      }
      return listed
    },
    async callTool(name, args, options) {
      const { client, original } = resolve(name)
      return client.callTool(original, args, options)
    },
    async close() {
      // Close every source even if one throws, so a stuck server cannot leak the rest.
      const failures = []
      for (const { client } of sources) {
        try { await client.close() } catch (error) { failures.push(error) }
      }
      if (failures.length) throw failures[0]
    },
  }
}

/** The computer-use tools this workflow needs. Everything else is refused. */
export const DESKTOP_TOOLS = [
  'open_application', 'activate_app', 'list_windows', 'get_window',
  'screenshot', 'zoom', 'left_click', 'key', 'mouse_drag', 'wait',
]

/**
 * Connect both servers.
 *
 * `blenderCommand` is the official server's entry point. Note the official package
 * and the community one share the name `blender-mcp`: `uvx blender-mcp` fetches the
 * community package from PyPI, so the official server has to be installed from
 * projects.blender.org and invoked by path.
 */
export async function connectBoth({ blenderCommand, blenderArgs = ['--transport', 'stdio'], desktopTools = DESKTOP_TOOLS } = {}) {
  if (!blenderCommand) throw new Error('blenderCommand is required (path to the official blender-mcp)')
  const allowed = new Set(desktopTools)
  const desktop = await connectInProcess(createComputerUseServer({
    authorizeToolCall: ({ definition }) => {
      if (!allowed.has(definition.name)) throw new Error('Tool not permitted in this workflow: ' + definition.name)
    },
  }))
  let blender
  try {
    blender = await connectStdio(blenderCommand, blenderArgs)
  } catch (error) {
    await desktop.close()
    throw error
  }
  return {
    desktop,
    blender,
    client: namespaceTools([
      { namespace: 'blender', client: blender },
      { namespace: 'desktop', client: desktop, only: desktopTools },
    ]),
  }
}

/** Load a skill file so its routing policy reaches the model verbatim. */
export function loadSkill(name = 'blender-agent') {
  const path = new URL(`../../skills/${name}/SKILL.md`, import.meta.url)
  return readFileSync(path, 'utf8').replace(/^---[\s\S]*?---\n/, '').trim()
}

/** Namespaced name for a tool, for callers that need to reference one directly. */
export const nsName = (namespace, tool) => `${namespace}${NS}${tool}`
