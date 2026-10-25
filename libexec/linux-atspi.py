"""Fixed AT-SPI operations over stdin; no model-authored Python or shell commands."""
import json
import re
import sys
import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

request = json.load(sys.stdin)
args = request['args']
window = request.get('window')
# get_ui_tree honours max_depth (default 10); a search walks as deep as the bridge allows, because GTK 4 nests its
# controls 15 to 20 levels down and a 10-level search could never find them (issue #21). The node caps keep both bounded.
TREE_NODES, SEARCH_NODES, SEARCH_DEPTH = 500, 3000, 30
roles = {'frame': 'AXWindow', 'dialog': 'AXWindow', 'push button': 'AXButton',
         'text': 'AXTextField', 'entry': 'AXTextField', 'password text': 'AXSecureTextField',
         'label': 'AXStaticText', 'check box': 'AXCheckBox', 'combo box': 'AXComboBox',
         'menu item': 'AXMenuItem', 'menu': 'AXMenu', 'list': 'AXList', 'panel': 'AXGroup'}


def children(node):
    return [node.get_child_at_index(i) for i in range(min(node.get_child_count(), 500))]


def facts(node):
    name = node.get_name() or ''
    raw_role = node.get_role_name()
    role = roles.get(raw_role, raw_role)
    sensitive = bool(re.search(r'password|passcode|secret|credential|one.time|otp|cvv', name + ' ' + raw_role, re.I))
    component = node.get_component_iface()
    rect = component.get_extents(Atspi.CoordType.SCREEN) if component else None
    action = node.get_action_iface()
    actions = [action.get_action_name(i) for i in range(action.get_n_actions())] if action else []
    return {'role': role, 'label': name[:1000], 'value': None, 'sensitive': sensitive,
            'sensitivitySignals': ['secure_role'] if raw_role == 'password text' else [],
            'bounds': {'x': rect.x, 'y': rect.y, 'width': rect.width, 'height': rect.height} if rect else None,
            'actions': actions}


class Structured(Exception):
    """An error with a typed payload the server returns as-is (7.6.1, issue #21)."""

    def __init__(self, payload):
        super().__init__(payload.get('error', 'atspi_error'))
        self.payload = payload


def find_window():
    """The AT-SPI frame for the window the server resolved: by PID, then title (exact, then case-insensitive
    substring), then the only frame the process has. On a miss the error lists what AT-SPI exposes for that PID, so a
    toolkit with accessibility off (empty list) is distinguishable from a title that differs."""
    desktop = Atspi.get_desktop(0)
    frames = []
    for app in children(desktop):
        if app is None or app.get_process_id() != window['pid']:
            continue
        frames.extend([child for child in children(app) if child is not None])
    title = (window.get('title') or '').strip()
    exact = [frame for frame in frames if (frame.get_name() or '') == title]
    if len(exact) == 1:
        return exact[0]
    loose = [frame for frame in frames if title and title.lower() in (frame.get_name() or '').lower()]
    if len(loose) == 1:
        return loose[0]
    if len(frames) == 1:
        return frames[0]
    raise Structured({
        'error': 'atspi_window_not_found' if not frames else 'atspi_window_ambiguous',
        'pid': window['pid'], 'title': title,
        'seen': [{'name': frame.get_name(), 'role': frame.get_role_name()} for frame in frames][:20],
        'remediation': [
            'The process exposes no accessible frames: enable toolkit accessibility (gsettings set org.gnome.desktop.interface toolkit-accessibility true; GTK_MODULES=gail:atk-bridge for GTK apps, QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 for Qt) and restart the app.'
            if not frames else
            'Several frames match; pass the window whose title is unique, or set_target with the exact title.',
        ],
    })


def has_state(node, state):
    try:
        return node.get_state_set().contains(state)
    except Exception:  # noqa: BLE001  (a node can go away while it is read)
        return False


def offscreen(node):
    """A helper window parked off screen or a few pixels wide (xfwm4 keeps a 5x5 one at -1000,-1000 that claims to be
    active and focused)."""
    component = node.get_component_iface()
    if not component:
        return False
    rect = component.get_extents(Atspi.CoordType.SCREEN)
    return rect.width <= 10 or rect.height <= 10 or rect.x + rect.width <= 0 or rect.y + rect.height <= 0


def focused():
    """The focused accessible, or None. AT-SPI has no global focus query, so a frame is walked for the node that says
    it is focused: first the window the server reports as focused (by pid and title), then any frame that says it is
    active. The second alone is not enough: GTK 4 dialogs do not always set ACTIVE, and a window manager's hidden
    window may claim it."""
    frames = []
    if window:
        try:
            frames.append(find_window())
        except Structured:
            pass
    for app in children(Atspi.get_desktop(0)):
        if app is not None:
            frames.extend(frame for frame in children(app) if frame is not None and frame not in frames
                          and has_state(frame, Atspi.StateType.ACTIVE) and not offscreen(frame))
    seen = [0]

    def walk(node, depth):
        seen[0] += 1
        if has_state(node, Atspi.StateType.FOCUSED) and not offscreen(node):
            return node
        if depth >= SEARCH_DEPTH or seen[0] >= SEARCH_NODES:
            return None
        for child in children(node):
            if child is not None:
                found = walk(child, depth + 1)
                if found is not None:
                    return found
        return None

    for frame in frames:
        found = walk(frame, 0)
        if found is not None:
            info = facts(found)
            info['children'] = []
            return info
    return None


def run():
    if request['tool'] == 'get_focused_element':
        return focused()
    root = find_window()
    visited = []
    count = [0]
    search = request['tool'] != 'get_ui_tree'
    limit = SEARCH_DEPTH if search else min(max(int(args.get('max_depth', 10)), 1), SEARCH_DEPTH)
    nodes = SEARCH_NODES if search else TREE_NODES

    def tree(node, depth):
        count[0] += 1
        info = facts(node)
        visited.append((node, info))
        child_count = node.get_child_count()
        info['children'] = []
        info['truncated'] = child_count > 0 and (depth >= limit or count[0] >= nodes)
        if not info['truncated']:
            for child in children(node):
                if count[0] >= nodes:
                    info['truncated'] = True
                    break
                info['children'].append(tree(child, depth + 1))
        return info

    snapshot = tree(root, 0)
    if request['tool'] == 'get_ui_tree':
        return snapshot

    def matches(query):
        return [(node, info) for node, info in visited
                if (not query.get('role') or info['role'] == query['role'])
                and (not query.get('label') or info['label'] == query['label'])]

    if args.get('value') and request['tool'] == 'find_element':
        raise RuntimeError('Value-based lookup is unavailable in the value-free AT-SPI bridge')
    if request['tool'] == 'find_element':
        if any(info['truncated'] for _, info in visited):
            raise RuntimeError('AT-SPI search truncated; absence cannot be established')
        return [info for _, info in matches(args)][:min(int(args.get('max_results', 25)), 100)]
    operations = args.get('fields', []) if request['tool'] == 'fill_form' else [dict(args)]
    if request['tool'] == 'press_button':
        operations[0]['role'] = 'AXButton'
    resolved = []
    for operation in operations:
        found = matches(operation)
        if len(found) != 1 or found[0][1]['sensitive']:
            raise RuntimeError('Control inaccessible, sensitive or ambiguous')
        resolved.append((found[0][0], operation))
    completed = 0
    for node, operation in resolved:
        if request['tool'] in ('set_value', 'fill_form'):
            editable = node.get_editable_text_iface()
            if not editable or not editable.set_text_contents(operation['value']):
                return {'error': 'set_failed', 'completed': completed, 'status': 'partial'}
        else:
            action = node.get_action_iface()
            indices = [i for i in range(action.get_n_actions()) if action.get_action_name(i).lower() in ('click', 'press', 'activate')] if action else []
            if len(indices) != 1 or not action.do_action(indices[0]):
                return {'error': 'invoke_failed', 'completed': completed, 'status': 'unknown_outcome'}
        completed += 1
    return {'status': 'executed', 'succeeded': completed, 'failed': 0}


try:
    print(json.dumps(run()))
except Structured as error:
    print(json.dumps({**error.payload, 'backend': 'atspi'}))
except Exception as error:
    print(json.dumps({'error': str(error), 'backend': 'atspi'}))
