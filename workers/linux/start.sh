#!/bin/sh
set -eu
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >&2 &
exec dbus-run-session -- sh -c 'openbox >&2 & exec node /app/dist/server.js'
