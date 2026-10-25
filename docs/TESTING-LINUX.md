# Testing 7.7.0 on Linux

Thanks for testing. CI runs the unit tests on Linux runners, but nobody has driven a real Linux desktop with 7.7.0
yet. This takes about 30 minutes, and most of it is setup. You need a Linux desktop you can watch, either a physical
machine or a VM with a display (see [Testing in UTM virtual machines](TESTING-IN-UTM.md) for an Ubuntu VM on a Mac).

## What to send back

1. The full output of `node scripts/linux-check.mjs` (and of `--takeover` if you run it).
2. The output of `echo $XDG_SESSION_TYPE $XDG_CURRENT_DESKTOP` and `cat /etc/os-release | head -3`.
3. Anything that surprised you, especially a check that printed PASS while you saw something else on screen.

## 1. Prepare the desktop

Ubuntu 24.04 with the **X11 session** ("Ubuntu on Xorg" on the login screen's gear menu) is the main target. Other
setups are welcome, and section 4 lists what to check on them.

Turn off the screen lock and screen blanking for the session (Settings › Privacy & Security › Screen Lock, and
Settings › Power). A locked screen makes the checks fail by design.

Install the tools the server drives (X11):

```bash
sudo apt-get update
sudo apt-get install -y xdotool wmctrl xclip scrot imagemagick zenity
```

On Wayland, add `ydotool wl-clipboard` everywhere, `grim` on sway or Hyprland, and `python3-gi` for the screenshot
portal on GNOME or KDE.

## 2. Build 7.7.0 from source

7.7.0 is not on npm yet, so build it from `main`. You need Node 20 or later, Rust 1.94.1 or later, and the X11
development headers:

```bash
sudo apt-get install -y git build-essential pkg-config libx11-dev libxtst-dev libxrandr-dev libxi-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . "$HOME/.cargo/env"
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
git clone https://github.com/zavora-ai/computer-use-mcp.git && cd computer-use-mcp
npm ci
npm run build
```

`npm run build` compiles the native addon (a few minutes the first time) and the TypeScript. Then run the unit tests.
They do not touch the desktop:

```bash
npm test
```

No test should fail. A few are skipped (an opt-in browser test, and macOS-only checks).

## 3. Run the live check

Open a terminal **on the desktop itself**, not over SSH: the server acts on the display the terminal belongs to. Leave
the mouse and keyboard alone for about a minute, then run:

```bash
node scripts/linux-check.mjs
```

It prints `doctor`'s report, then one PASS or FAIL line per check:

| Check | What it shows |
|---|---|
| doctor passes the platform check and names the Linux backends | `doctor` used to fail on Linux; now it says which window list, capture and input tools it found |
| windows have real bounds | before 7.7, every X11 window was reported at 0,0 sized 0x0 |
| JPEG quality is honoured | a capture at quality 95 is larger than one at 20 |
| the zenity window is found, activated (`effect: verified`) and captured | window listing, activation and the result contract |
| `run_steps` clicked and typed in one call, and the text reads back exactly | batching, input and the clipboard |
| a missing tool is an error that names it | with an empty `PATH`, the error says what to install instead of returning nothing |

It opens a small zenity window titled `cu-linux-check-…`, types `computer-use 7.7 on linux` into it, copies the text
back, and closes the window. It changes nothing else.

Then run it once more with the takeover step, which needs you:

```bash
node scripts/linux-check.mjs --takeover
```

When it prints **GO**, move the mouse for about two seconds. The agent should pause with `taken_over` while you move it,
and resume on its own about 5 s after you stop.

## 4. Other setups, if you have them

Run `node scripts/linux-check.mjs` on each and send the output. What to expect:

| Session | Window list | Screenshots | Input |
|---|---|---|---|
| X11 (any desktop) | `wmctrl`, with real geometry | `scrot`, ImageMagick `import` for one window | `xdotool` |
| sway | `swaymsg` | `grim`, cropped to the window | `ydotool` (start `ydotoold` with access to `/dev/uinput`) |
| Hyprland | `hyprctl` | `grim`, cropped to the window | `ydotool` |
| GNOME on Wayland | only XWayland windows (GNOME stops other programs listing its windows) | `gnome-screenshot`, then the desktop portal (GNOME asks you once) | the RemoteDesktop portal and libei on GNOME 46+ (GNOME asks you once; no ydotool needed) |

On GNOME Wayland, expect `doctor` to warn that only XWayland windows are listed, and expect zenity (a native Wayland
window there) to be missing from the list. That is a known limit, so please confirm you see it. The plan for it is in
[`docs/specs/v7.7/wayland.md`](specs/v7.7/wayland.md).

## 5. Optional: a locked screen

Input on a locked screen should be refused with `screen_locked`, instead of typing into the lock screen. To check it,
start the run after a delay and lock the screen (Super+L) before it begins:

```bash
sleep 15; node scripts/linux-check.mjs
```

Unlock after a minute. The input checks should FAIL, and the reason they print should mention `screen_locked`. Send that
output too. A run where the input checks pass while the screen was locked is a bug.

## If something goes wrong

- `wmctrl is not installed` (or `xdotool`, `scrot` and so on): install the package named in the message. That message
  is one of the things being tested.
- `cannot open display`: the terminal is not on the desktop session. Run it from a terminal opened on the desktop.
- A check fails and the screen showed something else: send the output and a phone photo of the screen. Both help.
