"""Fixed AT-SPI operations over stdin; no model-authored Python or shell commands."""
import json
import re
import sys
import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

request = json.load(sys.stdin)
args = request['args']
window = request['window']
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


def run():
    desktop = Atspi.get_desktop(0)
    windows = []
    for app in children(desktop):
        if app.get_process_id() != window['pid']:
            continue
        windows.extend([child for child in children(app) if child.get_name() == window.get('title')])
    if len(windows) != 1:
        raise RuntimeError('Window inaccessible or ambiguous by PID and title')
    root = windows[0]
    visited = []
    count = [0]
    limit = min(max(int(args.get('max_depth', 10)), 1), 30)

    def tree(node, depth):
        count[0] += 1
        info = facts(node)
        visited.append((node, info))
        child_count = node.get_child_count()
        info['children'] = []
        info['truncated'] = child_count > 0 and (depth >= limit or count[0] >= 500)
        if not info['truncated']:
            for child in children(node):
                if count[0] >= 500:
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
except Exception as error:
    print(json.dumps({'error': str(error), 'backend': 'atspi'}))
