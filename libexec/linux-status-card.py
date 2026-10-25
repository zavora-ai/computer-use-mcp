#!/usr/bin/env python3
# The Linux desktop status card for computer-use-mcp.
#
# The same card as macOS (libexec/macos-status-card.swift): what the agent is doing (the tool, the app and the window
# the server resolved), the last few actions, and Pause/Resume and Stop. Two differences, both forced by X11:
#
# - It is not kept on top. It is a DOCK window that reserves a strip on the right of the desktop with
#   _NET_WM_STRUT_PARTIAL, so the window manager shrinks the work area and maximized windows make room for it. A
#   fullscreen window still covers it, by design.
# - X11 cannot exclude a window from screen capture, so the card publishes where it is (card.json) and the server
#   paints that rectangle out of every capture and refuses clicks inside it. It also leaves the accessibility bus
#   (the server starts it with NO_AT_BRIDGE=1), so find_element never sees its buttons.
#
# It never takes focus, and it exits when the server's pid is gone or control.txt disappears. GTK 3 through python3-gi,
# run with GDK_BACKEND=x11 so one code path covers X11 and GNOME Wayland (XWayland).
#
# Protocol: argv[1] is a directory holding state.json (written by the server) and control.txt (written here:
# running | paused | stopped).
import ctypes
import ctypes.util
import json
import os
import sys
import time

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('GdkX11', '3.0')
from gi.repository import Gdk, GdkX11, GLib, Gtk, Pango  # noqa: E402,F401  (GdkX11 makes get_xid available)

WIDTH, HEIGHT, INSET, RADIUS = 340, 150, 16, 14

if len(sys.argv) < 2:
    sys.stderr.write('usage: linux-status-card.py <directory>\n')
    sys.exit(2)
directory = sys.argv[1]
state_path = os.path.join(directory, 'state.json')
control_path = os.path.join(directory, 'control.txt')
geometry_path = os.path.join(directory, 'card.json')


def read_control():
    try:
        with open(control_path, encoding='utf-8') as handle:
            return handle.read().strip().lower()
    except OSError:
        return ''


def write_control(value):
    temporary = '%s.%d.tmp' % (control_path, os.getpid())
    try:
        with open(temporary, 'w', encoding='utf-8') as handle:
            handle.write(value)
        os.chmod(temporary, 0o600)
        os.replace(temporary, control_path)
    except OSError:
        try:
            with open(control_path, 'w', encoding='utf-8') as handle:
                handle.write(value)
        except OSError:
            pass


def read_frame():
    try:
        with open(state_path, encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def process_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False


def elapsed_text(started_at):
    seconds = max(0, int(time.time() - started_at / 1000))
    if seconds >= 3600:
        return '%d:%02d:%02d' % (seconds // 3600, (seconds % 3600) // 60, seconds % 60)
    return '%d:%02d' % (seconds // 60, seconds % 60)


def chord_label(chord):
    if not chord:
        return None
    names = {'ctrl': 'Ctrl', 'control': 'Ctrl', 'alt': 'Alt', 'shift': 'Shift', 'super': 'Super', 'meta': 'Super',
             'escape': 'Esc', 'esc': 'Esc'}
    return '+'.join(names.get(part.lower(), part.upper()) for part in chord.split('+'))


def short_app(app):
    # A Linux app id is a desktop file name, a WM_CLASS or a process name: keep the last dotted part.
    if not app:
        return None
    return app.rsplit('.', 1)[-1] if '.' in app and ' ' not in app else app


def describe(item):
    text = str(item.get('label') or item.get('tool') or '')
    app = short_app(item.get('app'))
    if app:
        text += ' in %s' % app
        if item.get('window'):
            text += ' · %s' % item['window']
    return text


class Xlib:
    """XChangeProperty through libX11, so reserving the strip needs no xprop."""

    def __init__(self):
        path = ctypes.util.find_library('X11')
        self.lib = ctypes.CDLL(path) if path else None
        self.display = None
        if self.lib:
            self.lib.XOpenDisplay.restype = ctypes.c_void_p
            self.lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
            self.lib.XInternAtom.restype = ctypes.c_ulong
            self.lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
            self.lib.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
                                                 ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
            self.lib.XFlush.argtypes = [ctypes.c_void_p]
            self.display = self.lib.XOpenDisplay(None)

    def set_cardinals(self, xid, name, values):
        if not self.display:
            return False
        atom = self.lib.XInternAtom(self.display, name.encode(), 0)
        data = (ctypes.c_long * len(values))(*values)  # format 32 is passed as longs
        self.lib.XChangeProperty(self.display, xid, atom, 6, 32, 0, ctypes.cast(data, ctypes.c_void_p), len(values))
        self.lib.XFlush(self.display)
        return True


def prefers_dark():
    try:
        from gi.repository import Gio
        source = Gio.SettingsSchemaSource.get_default()
        if source and source.lookup('org.gnome.desktop.interface', True):
            settings = Gio.Settings.new('org.gnome.desktop.interface')
            schema = settings.props.settings_schema
            if schema.has_key('color-scheme') and settings.get_string('color-scheme') == 'prefer-dark':
                return True
    except Exception:  # noqa: BLE001  (a theme hint is optional)
        pass
    settings = Gtk.Settings.get_default()
    return bool(settings and settings.get_property('gtk-application-prefer-dark-theme'))


# Frosted: X11 cannot blur what is behind a window, so a near-opaque tint with a hairline edge. CSS only, so the card
# needs no cairo bindings (python3-gi-cairo is often absent).
CSS_COMMON = b"""
window#card { background-color: transparent; }
#surface { border-radius: 14px; }
#surface.square { border-radius: 0; }
.dot { min-width: 10px; min-height: 10px; border-radius: 5px; }
.dot.blue { background-color: #0a84ff; }
.dot.orange { background-color: #ff9f0a; }
.dot.red { background-color: #ff453a; }
#card button { min-height: 22px; padding: 0 8px; border-radius: 6px; font-size: 11px; box-shadow: none;
  background-image: none; text-shadow: none; }
"""
CSS_LIGHT = CSS_COMMON + b"""
#surface { background-color: rgba(249, 250, 252, 0.95); border: 1px solid rgba(0, 0, 0, 0.10); }
#card label { color: rgba(30, 33, 40, 0.92); }
#card .action { color: rgba(60, 66, 78, 0.78); }
#card .recent { color: rgba(60, 66, 78, 0.52); }
#card .failed { color: #c9372c; }
#card button { background-color: rgba(255, 255, 255, 0.85); border: 1px solid rgba(0, 0, 0, 0.14); color: #1f2430; }
#card button:hover { background-color: #ffffff; }
#card button:disabled label { color: rgba(30, 33, 40, 0.35); }
"""
CSS_DARK = CSS_COMMON + b"""
#surface { background-color: rgba(33, 36, 41, 0.94); border: 1px solid rgba(255, 255, 255, 0.12); }
#card label { color: rgba(255, 255, 255, 0.92); }
#card .action { color: rgba(235, 238, 245, 0.70); }
#card .recent { color: rgba(235, 238, 245, 0.45); }
#card .failed { color: #ff6b61; }
#card button { background-color: rgba(255, 255, 255, 0.12); border: 1px solid rgba(255, 255, 255, 0.16); color: #ffffff; }
#card button:hover { background-color: rgba(255, 255, 255, 0.2); }
#card button:disabled label { color: rgba(255, 255, 255, 0.35); }
"""


def screen_extent():
    """The X screen's width and height (the union of the monitors), in GDK coordinates."""
    display = Gdk.Display.get_default()
    rects = [display.get_monitor(i).get_geometry() for i in range(display.get_n_monitors())]
    return max(r.x + r.width for r in rects), max(r.y + r.height for r in rects)


def label(size, weight=Pango.Weight.NORMAL, css=None):
    widget = Gtk.Label(xalign=0)
    widget.set_ellipsize(Pango.EllipsizeMode.END)
    attributes = Pango.AttrList()
    attributes.insert(Pango.attr_size_new_absolute(size * Pango.SCALE))  # pixels, as the macOS card's points
    attributes.insert(Pango.attr_weight_new(weight))
    widget.set_attributes(attributes)
    if css:
        widget.get_style_context().add_class(css)
    return widget


class Card:
    def __init__(self):
        self.dark = prefers_dark()
        self.x11 = Xlib()
        self.frame = None
        self.control = 'running'
        self.dot_color = 'blue'

        provider = Gtk.CssProvider()
        provider.load_from_data(CSS_DARK if self.dark else CSS_LIGHT)
        Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider,
                                                 Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

        window = Gtk.Window(type=Gtk.WindowType.TOPLEVEL, title='Agent status')
        window.set_name('card')
        window.set_type_hint(Gdk.WindowTypeHint.DOCK)   # no decorations, reserved space, not in the task switcher
        window.set_decorated(False)
        window.set_resizable(False)
        window.set_accept_focus(False)                  # never takes keyboard focus
        window.set_focus_on_map(False)
        window.set_skip_taskbar_hint(True)
        window.set_skip_pager_hint(True)
        window.stick()                                  # on every workspace, so the strip is reserved on each
        window.set_default_size(WIDTH, HEIGHT)
        window.set_size_request(WIDTH, HEIGHT)
        visual = window.get_screen().get_rgba_visual()
        self.composited = bool(visual and window.get_screen().is_composited())
        if visual:
            window.set_visual(visual)
        window.connect('realize', self.reserve)
        window.connect('destroy', lambda *_: Gtk.main_quit())
        self.window = window

        # The macOS layout, in top-left coordinates.
        surface = Gtk.Box()
        surface.set_name('surface')
        if not self.composited:
            surface.get_style_context().add_class('square')  # no compositor: corners would be black
        fixed = Gtk.Fixed()
        surface.pack_start(fixed, True, True, 0)
        self.dot = Gtk.Box()
        self.dot.set_size_request(10, 10)
        for name in ('dot', 'blue'):
            self.dot.get_style_context().add_class(name)
        fixed.put(self.dot, 18, 20)
        self.title = label(13, Pango.Weight.SEMIBOLD)
        self.title.set_size_request(WIDTH - 50, 20)
        fixed.put(self.title, 34, 15)
        self.action = label(12, css='action')
        self.action.set_size_request(WIDTH - 36, 18)
        fixed.put(self.action, 18, 40)
        self.recent = []
        for index in range(3):
            line = label(11, css='recent')
            line.set_size_request(WIDTH - 36, 16)
            fixed.put(line, 18, 62 + index * 16)
            self.recent.append(line)
        self.pause_button = Gtk.Button(label='Pause')
        self.pause_button.set_can_focus(False)
        self.pause_button.set_size_request(72, 24)
        self.pause_button.connect('clicked', self.toggle_pause)
        fixed.put(self.pause_button, WIDTH - 156, HEIGHT - 34)
        self.stop_button = Gtk.Button(label='Stop')
        self.stop_button.set_can_focus(False)
        self.stop_button.set_size_request(64, 24)
        self.stop_button.connect('clicked', self.stop)
        fixed.put(self.stop_button, WIDTH - 78, HEIGHT - 34)
        window.add(surface)

        self.published = None
        self.place()
        self.render()
        self.publish_geometry()
        window.show_all()
        GLib.timeout_add(300, self.publish_geometry)
        Gdk.Screen.get_default().connect('monitors-changed', lambda *_: (self.place(), self.reserve()))
        GLib.timeout_add(200, self.tick)

    # ── Placement ────────────────────────────────────────────────────────────

    def monitor(self):
        """The monitor at the right edge of the X screen (the primary one when it is there): a right strut is measured
        from the screen's edge, so the card goes where its strip can be reserved."""
        display = Gdk.Display.get_default()
        monitors = [display.get_monitor(i) for i in range(display.get_n_monitors())]
        screen_width = screen_extent()[0]
        primary = display.get_primary_monitor()
        at_edge = [m for m in monitors if m.get_geometry().x + m.get_geometry().width >= screen_width]
        if primary in at_edge:
            return primary
        return min(at_edge, key=lambda m: m.get_geometry().y) if at_edge else (primary or monitors[0])

    def place(self):
        monitor = self.monitor()
        geometry, area = monitor.get_geometry(), monitor.get_workarea()
        # x from the monitor (the work area already excludes this card's own strip), y below any top panel.
        self.x = geometry.x + geometry.width - WIDTH - INSET
        self.y = max(geometry.y, area.y) + INSET
        self.geometry = geometry
        self.window.move(self.x, self.y)

    def reserve(self, *_):
        """Ask the window manager for a strip as wide as the card plus its inset on both sides, the height of the
        monitor: maximized windows stop short of the card instead of going under it."""
        gdk_window = self.window.get_window()
        if gdk_window is None:
            return
        scale = self.window.get_scale_factor()
        geometry = self.geometry
        right = (screen_extent()[0] - (geometry.x + geometry.width) + WIDTH + 2 * INSET) * scale
        top, bottom = geometry.y * scale, (geometry.y + geometry.height) * scale - 1
        xid = gdk_window.get_xid()
        self.x11.set_cardinals(xid, '_NET_WM_STRUT_PARTIAL', [0, right, 0, 0, 0, 0, top, bottom, 0, 0, 0, 0])
        self.x11.set_cardinals(xid, '_NET_WM_STRUT', [0, right, 0, 0])

    def publish_geometry(self):
        """card.json: the card and its buttons in X root pixels. The server masks this rectangle out of captures and
        refuses clicks inside it; a test can find the buttons without a screenshot. Written once before the window is
        shown (from where it was placed), then kept current."""
        gdk_window = self.window.get_window()
        scale = self.window.get_scale_factor()
        origin_x, origin_y = gdk_window.get_origin()[1:] if gdk_window is not None else (self.x, self.y)

        def rect(x, y, width, height):
            return {'x': x * scale, 'y': y * scale, 'width': width * scale, 'height': height * scale}

        def button(widget, x, width):
            allocation = widget.get_allocation()
            if gdk_window is None or allocation.width <= 1:
                return rect(origin_x + x, origin_y + HEIGHT - 34, width, 24)
            return rect(origin_x + allocation.x, origin_y + allocation.y, allocation.width, allocation.height)

        payload = {'frame': rect(origin_x, origin_y, WIDTH, HEIGHT),
                   'buttons': {'pause': button(self.pause_button, WIDTH - 156, 72),
                               'stop': button(self.stop_button, WIDTH - 78, 64)},
                   'pid': os.getpid(), 'scale': scale, 'composited': self.composited}
        text = json.dumps(payload)
        if text != self.published:
            temporary = '%s.%d.tmp' % (geometry_path, os.getpid())
            try:
                with open(temporary, 'w', encoding='utf-8') as handle:
                    handle.write(text)
                os.replace(temporary, geometry_path)
                self.published = text
            except OSError:
                pass
        return True

    # ── Control ──────────────────────────────────────────────────────────────

    def toggle_pause(self, *_):
        current = read_control()
        if current == 'stopped':
            return
        self.control = 'running' if current == 'paused' else 'paused'
        write_control(self.control)
        self.render()

    def stop(self, *_):
        # Once the agent is stopped the button reads Close and dismisses the card; the server keeps the stopped
        # state (and does not open the card again), so closing it resumes nothing.
        if read_control() == 'stopped':
            Gtk.main_quit()
            return
        self.control = 'stopped'
        write_control(self.control)
        self.render()

    def tick(self):
        if not os.path.exists(control_path):
            Gtk.main_quit()
            return False
        frame = read_frame()
        if frame is not None:
            self.frame = frame
            if not process_alive(frame.get('pid')):
                Gtk.main_quit()
                return False
        self.control = read_control()
        self.render()
        return True

    def render(self):
        frame = self.frame or {}
        state = frame.get('state') or 'running'
        effective = 'stopped' if self.control == 'stopped' else 'paused' if self.control == 'paused' else state
        elapsed = elapsed_text(frame['startedAt']) if frame.get('startedAt') else '0:00'
        current = describe(frame['action']) if frame.get('action') else None
        keys = chord_label(frame.get('chord'))
        if effective == 'stopped':
            color, title = 'red', 'Agent stopped · %s' % elapsed
            action = 'No further desktop input this session. Restart the server to resume.'
            self.pause_button.set_sensitive(False)
            self.stop_button.set_label('Close')
        elif effective == 'paused':
            color = 'orange'
            if frame.get('reason') == 'takeover':
                title = 'You took over · %s' % elapsed
                action = 'The agent waits while you use the mouse or keyboard, and resumes when you stop.'
            else:
                title = 'Agent paused · %s' % elapsed
                action = 'Mutations are refused; it can still look. Resume when you are ready.'
            self.pause_button.set_label('Resume')
            self.pause_button.set_sensitive(True)
            self.stop_button.set_label('Stop')
        else:
            self.pause_button.set_label('Pause')
            self.pause_button.set_sensitive(True)
            self.stop_button.set_label('Stop')
            if frame.get('waiting') == 'user_active':
                color, title = 'orange', 'Agent waiting for you · %s' % elapsed
                action = 'You are typing or moving the mouse; it resumes when you stop.'
            elif frame.get('waiting') == 'approval':
                color, title = 'orange', 'Agent needs approval · %s' % elapsed
                action = current or "A gated action is waiting for the host's approval."
            else:
                color, title = 'blue', 'Agent is using this computer · %s' % elapsed
                action = current or ('Idle · %s stops it from any app' % keys if keys else 'Idle')
        self.stop_button.set_tooltip_text(
            'Close this card; the agent stays stopped' if self.control == 'stopped'
            else 'Stop the agent for this session (or press %s anywhere)' % keys if keys
            else 'Stop the agent for this session')
        if color != self.dot_color:
            self.dot.get_style_context().remove_class(self.dot_color)
            self.dot.get_style_context().add_class(color)
            self.dot_color = color
        if self.title.get_text() != title:
            self.title.set_text(title)
        if self.action.get_text() != action:
            self.action.set_text(action)
        recent = frame.get('recent') or []
        for index, line in enumerate(self.recent):
            context = line.get_style_context()
            if index < len(recent):
                item = recent[index]
                failed = item.get('outcome') == 'failed'
                line.set_text('%s %s' % ('✕' if failed else '✓', describe(item)))
                (context.add_class if failed else context.remove_class)('failed')
            else:
                line.set_text('')
                context.remove_class('failed')


def main():
    if Gdk.Display.get_default() is None:
        sys.stderr.write('linux-status-card: no X display (set DISPLAY; on Wayland, XWayland must be running)\n')
        sys.exit(3)
    if not isinstance(Gdk.Display.get_default(), GdkX11.X11Display):
        sys.stderr.write('linux-status-card: needs the X11 backend (run with GDK_BACKEND=x11)\n')
        sys.exit(3)
    Card()
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, Gtk.main_quit)  # SIGTERM from the server
    Gtk.main()
    try:
        os.remove(geometry_path)
    except OSError:
        pass


if __name__ == '__main__':
    main()
