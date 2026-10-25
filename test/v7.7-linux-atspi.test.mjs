// Issue #21: the Linux AT-SPI bridge on GTK 4 depth, and get_focused_element. The real libexec/linux-atspi.py runs
// against a fake `gi` package that serves a tree from JSON, so no accessibility bus is needed.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleLinuxAccessibility } from '../dist/session/linux-atspi.js'

const bridge = join(fileURLToPath(import.meta.url), '..', '..', 'libexec', 'linux-atspi.py')
const python = spawnSync('python3', ['--version']).status === 0

const FAKE_ATSPI = `
import json, os

class CoordType:
    SCREEN = 0

class StateType:
    ACTIVE = 'active'
    FOCUSED = 'focused'

class _States:
    def __init__(self, states):
        self.states = states
    def contains(self, state):
        return state in self.states

class _Action:
    def __init__(self, names):
        self.names = names
    def get_n_actions(self):
        return len(self.names)
    def get_action_name(self, index):
        return self.names[index]
    def do_action(self, index):
        return True

class _Rect:
    def __init__(self, x, y, width, height):
        self.x, self.y, self.width, self.height = x, y, width, height

class _Component:
    def __init__(self, rect):
        self.rect = rect
    def get_extents(self, coord_type):
        return _Rect(*self.rect)

class _Node:
    def __init__(self, spec):
        self.spec = spec
        self.kids = [_Node(child) for child in spec.get('children', [])]
    def get_child_count(self):
        return len(self.kids)
    def get_child_at_index(self, index):
        return self.kids[index]
    def get_name(self):
        return self.spec.get('name', '')
    def get_role_name(self):
        return self.spec.get('role', 'panel')
    def get_process_id(self):
        return self.spec.get('pid', 0)
    def get_component_iface(self):
        return _Component(self.spec['rect']) if 'rect' in self.spec else None
    def get_action_iface(self):
        return _Action(self.spec['actions']) if 'actions' in self.spec else None
    def get_editable_text_iface(self):
        return None
    def get_state_set(self):
        return _States(self.spec.get('states', []))

def get_desktop(index):
    with open(os.environ['FAKE_ATSPI_TREE']) as handle:
        return _Node(json.load(handle))
`

/** A frame whose button sits `depth` panels down, as GTK 4 nests them. */
function nested(depth, leaf) {
  let node = leaf
  for (let i = 0; i < depth; i++) node = { role: 'panel', children: [node] }
  return node
}

function desktop(apps) {
  return { role: 'desktop frame', children: apps }
}

function runBridge(tree, request) {
  const root = mkdtempSync(join(tmpdir(), 'fake-gi-'))
  mkdirSync(join(root, 'gi', 'repository'), { recursive: true })
  writeFileSync(join(root, 'gi', '__init__.py'), 'def require_version(name, version):\n    pass\n')
  writeFileSync(join(root, 'gi', 'repository', '__init__.py'), '')
  writeFileSync(join(root, 'gi', 'repository', 'Atspi.py'), FAKE_ATSPI)
  writeFileSync(join(root, 'tree.json'), JSON.stringify(tree))
  const result = spawnSync('python3', [bridge], {
    input: JSON.stringify(request), encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: root, FAKE_ATSPI_TREE: join(root, 'tree.json') },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

const WINDOW = { pid: 42, title: 'New Document - Text Editor' }
const gtk4 = (states = ['active']) => desktop([{
  role: 'application', pid: 42, children: [{
    role: 'frame', name: WINDOW.title, states,
    children: [nested(17, { role: 'push button', name: 'Open', actions: ['click'] })],
  }],
}])

test('a search reaches a GTK 4 button 17 levels down; it used to stop at 10 and report truncated', { skip: !python && 'needs python3' }, () => {
  const found = runBridge(gtk4(), { tool: 'find_element', args: { role: 'AXButton', label: 'Open' }, window: WINDOW })
  assert.equal(found.length, 1, JSON.stringify(found))
  assert.equal(found[0].label, 'Open')
  const pressed = runBridge(gtk4(), { tool: 'press_button', args: { label: 'Open' }, window: WINDOW })
  assert.deepEqual(pressed, { status: 'executed', succeeded: 1, failed: 0 })
})

test('get_ui_tree still honours max_depth: 10 by default (marked truncated), deeper on request', { skip: !python && 'needs python3' }, () => {
  const labels = node => [node.label, ...(node.children ?? []).flatMap(labels)]
  const truncated = node => node.truncated || (node.children ?? []).some(truncated)
  const shallow = runBridge(gtk4(), { tool: 'get_ui_tree', args: {}, window: WINDOW })
  assert.equal(labels(shallow).includes('Open'), false)
  assert.equal(truncated(shallow), true, 'the cut is reported, so the caller knows to go deeper')
  const deep = runBridge(gtk4(), { tool: 'get_ui_tree', args: { max_depth: 20 }, window: WINDOW })
  assert.equal(labels(deep).includes('Open'), true)
})

test('get_focused_element looks in the window the window manager says has focus, past a decoy that claims focus', { skip: !python && 'needs python3' }, () => {
  // Seen live on xfwm4 with zenity (GTK 4): the window manager's hidden 5x5 window says active and focused, and the
  // dialog that really has the focus does not say active.
  const tree = desktop([
    { role: 'application', pid: 3, children: [{ role: 'window', name: '', states: ['active', 'focused'], rect: [-1000, -1000, 5, 5] }] },
    { role: 'application', pid: 42, children: [{ role: 'dialog', name: 'issue21', states: [], rect: [0, 0, 310, 237], children: [
      nested(6, { role: 'text', name: 'Name', states: ['focused'], rect: [0, 0, 216, 34] }),
    ] }] },
  ])
  const viaWindow = runBridge(tree, { tool: 'get_focused_element', args: {}, window: { pid: 42, title: 'issue21' } })
  assert.equal(viaWindow.label, 'Name')
  assert.equal(runBridge(tree, { tool: 'get_focused_element', args: {}, window: null }), null, 'the decoy is never returned')
})

test('get_focused_element returns the focused control of the active frame, or null', { skip: !python && 'needs python3' }, () => {
  const tree = desktop([
    { role: 'application', pid: 7, children: [{ role: 'frame', name: 'Background', states: [], children: [
      { role: 'text', name: 'Elsewhere', states: ['focused'] },
    ] }] },
    { role: 'application', pid: 42, children: [{ role: 'frame', name: WINDOW.title, states: ['active'], children: [
      nested(12, { role: 'entry', name: 'Search', states: ['focused'] }),
    ] }] },
  ])
  const focused = runBridge(tree, { tool: 'get_focused_element', args: {}, window: null })
  assert.equal(focused.role, 'AXTextField')
  assert.equal(focused.label, 'Search', 'the active frame wins over a stale focus in an inactive one')
  assert.deepEqual(focused.children, [])
  assert.equal(runBridge(gtk4(), { tool: 'get_focused_element', args: {}, window: null }), null)
})

test('the handler asks the bridge for the focused element without a window, and still needs one for the rest', async () => {
  const requests = []
  const spawn = async (_cmd, _args, _timeout, _signal, input) => {
    requests.push(JSON.parse(input))
    return { code: 0, stdout: JSON.stringify({ role: 'AXButton', label: 'Open', value: null, sensitive: false, sensitivitySignals: [], bounds: null, actions: ['click'], children: [] }), stderr: '', timedOut: false }
  }
  const context = { native: { getWindow: () => null }, focus: { ensure: async () => { throw new Error('no focus for a read') } } }
  const focused = await handleLinuxAccessibility('get_focused_element', {}, context, spawn)
  assert.equal(focused.isError, undefined)
  assert.equal(JSON.parse(focused.content[0].text).label, 'Open')
  assert.deepEqual(requests[0], { tool: 'get_focused_element', args: {}, window: null })

  const withFocus = { ...context, native: { getWindow: () => null, listWindows: () => [
    { windowId: 1, pid: 7, title: 'Other', isFocused: false }, { windowId: 2, pid: 42, title: 'issue21', isFocused: true },
  ] } }
  await handleLinuxAccessibility('get_focused_element', {}, withFocus, spawn)
  assert.equal(requests[1].window.pid, 42, 'the focused window is handed to the bridge')

  const nothing = await handleLinuxAccessibility('get_focused_element', {}, context,
    async () => ({ code: 0, stdout: 'null', stderr: '', timedOut: false }))
  assert.equal(nothing.content[0].text, 'null')

  const missing = await handleLinuxAccessibility('find_element', { window_id: 9, role: 'AXButton' }, context, spawn)
  assert.equal(JSON.parse(missing.content[0].text).error, 'window_unavailable')
})
