#!/usr/bin/env bash
# Run scripts/linux-check.mjs on a headless Linux desktop, the way CI does (7.7.x).
#
#   scripts/ci-linux-desktop.sh xfwm4     Xvfb with Xfce's window manager (Xubuntu)
#   scripts/ci-linux-desktop.sh openbox   Xvfb with Openbox (LXQt and Lubuntu use it)
#   scripts/ci-linux-desktop.sh sway      sway's headless backend (wlroots: sway, and what Hyprland shares)
#
# The unit tests run under Xvfb with no window manager, so activation, window geometry and the window-manager hints
# were never exercised. Each desktop here is real but invisible: it runs on its own display (or Wayland socket), its
# own runtime directory and its own D-Bus session bus, so it never touches the desktop you run it from. The headless sway has no input devices at all,
# so its input checks are skipped; window listing, activation and capture are checked.
#
# Needs a build (npm run build) and: xvfb, xfwm4 or openbox, sway and grim, zenity, xdotool, wmctrl, xclip,
# imagemagick, x11-utils and dbus (dbus-daemon).
set -euo pipefail

desktop=${1:?usage: scripts/ci-linux-desktop.sh xfwm4|openbox|sway}
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

wait_for() { # seconds, description, command...
  local seconds=$1 what=$2
  shift 2
  for _ in $(seq 1 $((seconds * 10))); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  echo "timed out waiting for $what" >&2
  return 1
}

# A private session bus that can start no services. A normal session bus starts xdg-desktop-portal when GTK asks it for
# the theme, the portal tries GNOME's backend, which cannot run here, and zenity waits 25 s for the D-Bus timeout
# before it shows a window. With nothing to start, the lookup fails at once and GTK uses its defaults.
cat >"$work/bus.conf" <<BUS
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=$work/bus</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
BUS
dbus-daemon --config-file="$work/bus.conf" --nofork --nopidfile >"$work/bus.log" 2>&1 &
pids+=($!)
wait_for 10 "the private session bus" test -S "$work/bus"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$work/bus"

# GTK without a GPU (zenity is GTK 4 on Ubuntu 24.04).
export GSK_RENDERER=cairo LIBGL_ALWAYS_SOFTWARE=1
# Never the caller's own session. Unsetting WAYLAND_DISPLAY is not enough on its own: with it unset, libwayland falls
# back to "wayland-0" in XDG_RUNTIME_DIR, which on a developer's machine is their real desktop. So every run gets its
# own runtime directory, and GTK is pinned to the display under test.
unset DISPLAY WAYLAND_DISPLAY SWAYSOCK HYPRLAND_INSTANCE_SIGNATURE LIBEI_SOCKET
export XDG_RUNTIME_DIR="$work/run"
mkdir -m 700 "$XDG_RUNTIME_DIR"

case "$desktop" in
  xfwm4 | openbox)
    number=${CU_DISPLAY_NUMBER:-97}
    Xvfb ":$number" -screen 0 1600x1000x24 -nolisten tcp >"$work/xvfb.log" 2>&1 &
    pids+=($!)
    wait_for 10 "Xvfb on :$number" test -S "/tmp/.X11-unix/X$number"
    export DISPLAY=":$number" XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=$desktop GDK_BACKEND=x11
    if [ "$desktop" = xfwm4 ]; then
      xfwm4 --compositor=off >"$work/wm.log" 2>&1 &
    else
      openbox >"$work/wm.log" 2>&1 &
    fi
    pids+=($!)
    # A window manager announces itself on the root window (EWMH); activation needs one.
    wait_for 10 "$desktop to manage the display" sh -c 'xprop -root _NET_SUPPORTING_WM_CHECK | grep -q "window id"'
    echo "desktop: $desktop on Xvfb :$number"
    node "$root/scripts/linux-check.mjs"
    ;;
  sway)
    export GDK_BACKEND=wayland
    printf 'output * resolution 1600x1000\n' >"$work/sway.conf"
    WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman \
      sway --config "$work/sway.conf" >"$work/sway.log" 2>&1 &
    pids+=($!)
    wait_for 15 "sway's IPC socket" sh -c 'ls "$XDG_RUNTIME_DIR"/sway-ipc.*.sock'
    SWAYSOCK=$(ls "$XDG_RUNTIME_DIR"/sway-ipc.*.sock | head -1)
    WAYLAND_DISPLAY=$(cd "$XDG_RUNTIME_DIR" && ls wayland-* | grep -v '\.lock$' | head -1)
    export SWAYSOCK WAYLAND_DISPLAY XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=sway
    echo "desktop: sway (headless) on $WAYLAND_DISPLAY"
    node "$root/scripts/linux-check.mjs" --skip-input
    ;;
  *)
    echo "unknown desktop: $desktop (xfwm4, openbox or sway)" >&2
    exit 2
    ;;
esac
