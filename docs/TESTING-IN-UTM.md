# Testing in UTM virtual machines

CI runs the unit and smoke tests on Windows and Linux runners, x64 and ARM64. What it cannot do is use a desktop the
way a person does: Linux runs under Xvfb with no window manager, and nobody watches what the clicks did. A virtual
machine on an Apple Silicon Mac covers that:

- the Windows status card and its Pause and Stop buttons;
- capture and DPI handling on a scaled display (UTM's Retina mode gives Windows a 200% display);
- a real window manager on Linux, and Wayland;
- real applications (Notepad's tabs, Explorer, the GNOME apps), watched in the UTM window as they are driven.

The server runs inside each VM. On the Mac, [`scripts/utm-vms.mjs`](../scripts/utm-vms.mjs) opens an SSH tunnel to each
one and registers it with Claude Code, so one session on the Mac can drive both VMs.

## What you need

- An Apple Silicon Mac and UTM 5.0.6 or later, which added snapshots and `utmctl snapshot`.
- **ARM64 guests only.** UTM virtualizes ARM64 guests at close to native speed but emulates x86_64 ones, which is too
  slow to be useful. The package bundles the `win32-arm64` and `linux-arm64` binaries, so it installs in both guests as
  published.
- **The QEMU backend.** Create each VM with **Virtualize** and leave **Use Apple Virtualization** unchecked (Windows
  always uses QEMU). On macOS 26, UTM 5 snapshots only QEMU VMs. Apple Virtualization VMs need macOS 27.
- Disk space: about 25 GB for an updated Windows 11 and 10 GB for Ubuntu, plus snapshots. To keep a VM on an external
  drive, move its `.utm` bundle there and double-click it to add it to UTM again.
- Memory: 8 GB for Windows and 4 GB for Ubuntu.

`utmctl` is inside the app at `/Applications/UTM.app/Contents/MacOS/utmctl`. Link it onto your `PATH` to use the
commands below as written. The script finds it without the link.

## Ubuntu VM

1. Download the Ubuntu 24.04 LTS desktop image for arm64 (`ubuntu-24.04.x-desktop-arm64.iso` from
   <https://cdimage.ubuntu.com/releases/24.04/release/>). Stay on 24.04. Later releases dropped the GNOME Xorg session,
   and without X11 the server needs `ydotool`.
2. In UTM, choose **+ › Virtualize › Linux** and select the image. Give the VM 4 GB of memory, 4 cores and a 40 GB disk.
   The disk file only grows as it fills.
3. Install Ubuntu. Then, in the VM's terminal:

   ```bash
   sudo apt-get install -y openssh-server qemu-guest-agent spice-vdagent curl git xdotool wmctrl xclip scrot
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
   sudo npm install -g @zavora-ai/computer-use-mcp
   sudo sed -i 's/^#\s*WaylandEnable=false/WaylandEnable=false/' /etc/gdm3/custom.conf
   ```

   `utmctl ip-address` reads the VM's IP address through `qemu-guest-agent`. The last line makes the login screen start
   an Xorg session.
4. Turn on automatic login (Settings › System › Users). Turn off the screen lock and screen blanking (Settings ›
   Privacy & Security, Settings › Power). This way a desktop session is always there to drive.
5. Reboot. `echo $XDG_SESSION_TYPE` in a terminal on the desktop prints `x11`.

To test Wayland later, snapshot the VM first. Then comment the `WaylandEnable` line out again and install
`wl-clipboard ydotool grim`.

## Windows 11 VM

1. Download the Windows 11 ARM64 image from Microsoft (<https://www.microsoft.com/software-download/windows11arm64>), or
   build one with CrystalFetch.
2. In UTM, choose **+ › Virtualize › Windows**. Tick **Install Windows 10 or higher** and **Install drivers and SPICE
   tools**. Give the VM 8 GB of memory, 4 cores and a 64 GB disk.
3. Install Windows. Then install the UTM guest tools from the drive UTM mounts. They provide the network, display and
   clipboard drivers, and the guest agent that `utmctl ip-address` uses. If setup stops at the network screen before
   those drivers are in, follow [UTM's Windows guide](https://docs.getutm.app/guides/windows/).
4. In an administrator PowerShell:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Start-Service sshd; Set-Service sshd -StartupType Automatic
   ```

   Then, in a new terminal that is not elevated, run `npm install -g @zavora-ai/computer-use-mcp`. PowerShell may
   refuse to run `npm` with "running scripts is disabled on this system". If it does, run
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use Command Prompt.
5. For key-based SSH from an account in Administrators, put your public key in
   `C:\ProgramData\ssh\administrators_authorized_keys`, not in `~\.ssh\authorized_keys`, and restrict the file:
   `icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"`.
   A password works too: the script lets `ssh` prompt for it.
6. Set screen and sleep to **Never** (Settings › System › Power) so the desktop stays available.
7. For the DPI tests, turn on **Retina Mode** in the VM's Display settings. Take a snapshot with it on and another with
   it off.

## Start the server on the VM's desktop

The server acts on the desktop it runs on. Start it **from a terminal on the VM's desktop** (inside the UTM window), not
over SSH:

```bash
computer-use-mcp-http
```

On Windows this is required. A process started over SSH runs outside the interactive desktop session, so its input and
screenshots never reach the screen you see. On Linux, a terminal on the desktop gives the server the X display without
any extra setup.

`computer-use-mcp-http` listens on `127.0.0.1:3100` and refuses any other address, so the Mac reaches it through the
tunnel described in the next section. Put configuration in front of it as usual:
`COMPUTER_USE_STATUS_CARD=true computer-use-mcp-http` on Linux. On Windows the card is on by default since 7.7
(`$env:COMPUTER_USE_STATUS_CARD='false'` in PowerShell turns it off). On Linux the card needs
python3-gi and GTK 3 and an X display (XWayland on GNOME and KDE Wayland); it reserves a strip on the right of the
desktop rather than floating on top.

## Connect Claude Code on the Mac

From the repository root on the Mac:

```bash
node scripts/utm-vms.mjs up --windows-user <user> --linux-user <user>
```

For each VM the script:

1. asks `utmctl` whether the VM is running and for its IPv4 address;
2. opens an SSH tunnel from `127.0.0.1:3101` (Windows) or `127.0.0.1:3102` (Linux) on the Mac to `127.0.0.1:3100` in
   the VM, and keeps it under an ssh control socket in `~/.computer-use-mcp/`;
3. asks the server through the tunnel for its name and version, which shows whether a release or a branch build
   answered;
4. registers the VM with Claude Code as `win-vm` or `linux-vm` (`claude mcp add --transport http`). The default local
   scope covers this checkout only.

Start a new Claude Code session in the checkout. Its tool list has both VMs, `win-vm` and `linux-vm`.

| Command | Does |
|---|---|
| `node scripts/utm-vms.mjs up` | Open the tunnels and register the servers. Leaves an open tunnel and an existing registration alone. |
| `node scripts/utm-vms.mjs status` | VM state, tunnel, the server's version, registration. |
| `node scripts/utm-vms.mjs down` | Close the tunnels. `--unregister` also removes both registrations. |

| Option | Default |
|---|---|
| `--only windows` or `--only linux` | both VMs |
| `--windows-vm`, `--linux-vm`: the VM's name in UTM | `Windows 11`, `Ubuntu` |
| `--windows-user`, `--linux-user`: the SSH user in the VM | your Mac user name |
| `--windows-host`, `--linux-host`: use this address instead of asking `utmctl` | none |
| `--windows-port`, `--linux-port`: the local end of the tunnel | `3101`, `3102` |
| `--remote-port`: where the server listens in the VM | `3100` |
| `--scope local`, `user` or `project`: the Claude Code scope | `local` |

Another MCP host can use the same tunnel by hand. The server's host check ignores the port, so any free local port works:

```bash
ssh -N -L 127.0.0.1:3101:127.0.0.1:3100 <user>@<vm-ip>
```

Then point the host at `http://127.0.0.1:3101/mcp`.

## Testing a branch instead of the release

CI builds every native target for a pull request to `main`. Each target's addon is an artifact named
`computer-use-napi.<platform>-<arch>.node`.

**Windows** needs no Rust toolchain in the VM. First, in the VM's home directory:

```powershell
git clone -b <branch> https://github.com/zavora-ai/computer-use-mcp
cd computer-use-mcp
npm ci
npm run build:ts
```

Once the PR's native builds have finished, fetch the addon on the Mac and copy it into that checkout:

```bash
gh run list --branch <branch> --workflow ci.yml --limit 1
gh run download <run-id> -n computer-use-napi.win32-arm64.node
scp computer-use-napi.win32-arm64.node <user>@<vm-ip>:computer-use-mcp/
```

Back in the VM, select the addon and start the server:

```powershell
$env:COMPUTER_USE_NATIVE_PATH = "$PWD\computer-use-napi.win32-arm64.node"
node scripts/verify-local-native.mjs
node dist/http.js
```

**Linux** builds quickly in the VM:

```bash
sudo apt-get install -y build-essential pkg-config libx11-dev libxtst-dev libxrandr-dev libxi-dev
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh && . "$HOME/.cargo/env"
git clone -b <branch> https://github.com/zavora-ai/computer-use-mcp && cd computer-use-mcp
npm ci && npm run build
export COMPUTER_USE_NATIVE_PATH="$PWD/computer-use-napi.linux-arm64.node"
node scripts/verify-local-native.mjs
node dist/http.js
```

`node scripts/utm-vms.mjs status` on the Mac then reports the branch's version.

You can also run CI's suites against the real desktop, with the same `COMPUTER_USE_NATIVE_PATH`: `node --test
test/*.test.mjs` and `node test/smoke-new-tools.mjs` on both systems, plus `node test/smoke-windows.mjs` and
`node scripts/live-windows.mjs` on Windows. They start their own server, so stop `dist/http.js` first. They move the
VM's pointer and type into it.

## Snapshots between runs

Save a clean state once, and go back to it after each run:

```bash
utmctl snapshot create "Windows 11" --name clean
utmctl snapshot list "Windows 11"
utmctl snapshot restore "Windows 11" --snapshot clean
```

A snapshot of a shut-down VM holds only its disk. A snapshot of a running VM comes back running, with the desktop
logged in and the server started. Expect it to cost extra disk for the VM's memory. After restoring a running
snapshot, run `node scripts/utm-vms.mjs down` and then `up`, because the old tunnel's connection belongs to the state
you left.

## UTM 5 notes

- UTM 5.0.4 and later offer an experimental 3D (DirectX) driver for Windows, and UTM warns it can be unstable. Leave it
  out of the clean snapshot. It is worth one pass of its own, because it changes the graphics path that Windows capture
  reads. Snapshot before installing it.
- Shut VMs down before updating UTM. The release notes warn that a suspended VM may not resume after an update.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no IPv4 address from "…" (is the guest agent installed?)` | Install the UTM guest tools (Windows) or `qemu-guest-agent` (Linux). Or pass `--windows-host` / `--linux-host` with the address from `ipconfig` or `ip -4 addr`. |
| `server: nothing answers` | The tunnel is up but nothing listens in the VM. Start `computer-use-mcp-http` on the VM's desktop. |
| Windows clicks do nothing, or captures are black | The server was started over SSH or as a service. Start it from a terminal on the desktop. |
| Linux input fails and `echo $XDG_SESSION_TYPE` prints `wayland` | The session is Wayland. Disable it in `/etc/gdm3/custom.conf` as above, or install `ydotool`. |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | A reinstalled VM got the same address. Run `ssh-keygen -R <vm-ip>`. |
| `Address already in use` from ssh | Something else holds 3101 or 3102. Pick another with `--windows-port` or `--linux-port`. |
| Requests hang after a snapshot restore | Run `node scripts/utm-vms.mjs down`, then `up`. |
