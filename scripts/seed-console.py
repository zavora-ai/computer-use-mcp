#!/usr/bin/env python3
"""Seed the console with a realistic run, for capturing documentation images.

Everything visual is real: the attachment is a render the agent actually produced,
and the frame is a capture of the live Blender window. The narration and the
activity lines are written here, which is why this is a documentation helper and
not something that ships.

Usage: seed-console.py <blender-window-id> [render.png] [base-url]
"""
import base64
import json
import sys
import urllib.request

WINDOW = int(sys.argv[1])
RENDER = sys.argv[2] if len(sys.argv) > 2 else None
BASE = (sys.argv[3] if len(sys.argv) > 3 else 'http://127.0.0.1:4517').rstrip('/')


def post(path, payload):
    request = urllib.request.Request(
        f'{BASE}{path}', data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode()


def page(name, arguments):
    return json.loads(post('/rpc', {'name': name, 'arguments': arguments}))


def tool(call_id, name, arguments):
    """Call a run tool the way the agent does, over /mcp."""
    raw = post('/mcp', {'jsonrpc': '2.0', 'id': call_id, 'method': 'tools/call',
                        'params': {'name': name, 'arguments': arguments}})
    return raw


ask = 'The bezel reads too heavy in this render. Thin it to something realistic and show me the viewport.'
arguments = {'text': ask}
if RENDER:
    with open(RENDER, 'rb') as handle:
        arguments['image'] = {
            'name': RENDER.split('/')[-1], 'mimeType': 'image/png',
            'data': base64.b64encode(handle.read()).decode(),
        }
opened = page('run_say', arguments)
run_id = json.loads(opened['content'][0]['text'])['runId']
print('run', run_id)

tool(1, 'run_plan', {'runId': run_id, 'tasks': [
    {'id': 'look', 'title': 'Look at the render you sent'},
    {'id': 'check', 'title': 'Find a realistic bezel width'},
    {'id': 'thin', 'title': 'Thin the bezel on the case'},
    {'id': 'show', 'title': 'Show you the viewport'},
]})
# Notes on every step, but few narrations: the transcript is for what a person
# needs to understand, and a wall of agent lines pushes their own request out of
# view. The mechanics are in the activity feed instead.
for task, note, narration in [
    ('look', 'Bezel measures about 3.1 mm in the render — heavy for a 42 mm case',
     'Looking at your render first: the bezel is about 3.1 mm, which is heavy on a 42 mm case. '
     'Checking what real watches use before I change it.'),
    ('check', '1.4–1.8 mm is typical on a 40–44 mm case', None),
    ('thin', 'Bezel inset to 1.6 mm; Watch_Screen rescaled to sit inside it, 12,864 tris',
     'Real cases this size use 1.4 to 1.8 mm, so the bezel is 1.6 mm now and the glass was '
     'rescaled to sit inside it.'),
]:
    update = {'runId': run_id, 'taskId': task, 'status': 'done', 'note': note}
    if narration:
        update['narration'] = narration
    tool(2, 'run_progress', update)

# The frame is Blender's own window. Capturing without a window id takes the whole
# desktop, which is what made the previous documentation image wrong.
tool(3, 'run_progress', {
    'runId': run_id, 'taskId': 'show', 'status': 'active',
    'narration': 'Here is the viewport with the thinner bezel.',
    'capture': True, 'window_id': WINDOW,
    'caption': 'Blender viewport: the 42 mm case with its bezel thinned to 1.6 mm',
})

post('/driver/activity', {'events': [
    {'kind': 'thought', 'detail': 'They sent a render rather than describing the problem, so I should measure the bezel in the image before changing anything.'},
    {'kind': 'tool', 'name': 'run_attachment', 'detail': 'index: 0'},
    {'kind': 'result', 'name': 'run_attachment', 'detail': 'smartwatch_42mm_preview.png, 807 KB', 'ms': 54},
    {'kind': 'thought', 'detail': 'Roughly 3.1 mm of bezel against a 42 mm case. Heavy — but I want a real figure rather than my impression of one.'},
    {'kind': 'tool', 'name': 'web_search', 'detail': 'query: smartwatch bezel width mm 42mm case'},
    {'kind': 'result', 'name': 'web_search', 'detail': '5 results, top: dimensions.com/collection/smartwatches', 'ms': 774},
    {'kind': 'tool', 'name': 'scrape', 'detail': 'url: dimensions.com/collection/smartwatches'},
    {'kind': 'result', 'name': 'scrape', 'detail': '2.8 KB of text — bezel 1.4–1.8 mm on 40–44 mm cases', 'ms': 612},
    {'kind': 'thought', 'detail': '1.6 mm sits mid-range and keeps the glass clear of the case wall. Applying it as an inset on Watch_Body.'},
    {'kind': 'tool', 'name': 'execute_blender_code', 'detail': 'inset Watch_Body bezel to 1.6 mm, rescale Watch_Screen'},
    {'kind': 'result', 'name': 'execute_blender_code', 'detail': 'bezel: 1.6 mm, tris: 12864', 'ms': 486},
    {'kind': 'tool', 'name': 'get_objects_summary', 'detail': '{}'},
    {'kind': 'result', 'name': 'get_objects_summary', 'detail': '3 meshes: Watch_Body, Watch_Band, Watch_Screen', 'ms': 47},
]})

run = json.loads(page('run_console', {})['content'][0]['text'])
shot = run.get('screenshot') or {}
done = sum(1 for task in run['tasks'] if task['status'] == 'done')
print(f"state={run['state']} tasks={done}/{len(run['tasks'])} activity={len(run['activity'])}")
print(f"frame={shot.get('mimeType')} {len(shot.get('data') or '')} b64 chars")
print('attachment:', (run['messages'][0].get('attachment') or {}).get('name', 'none'))
