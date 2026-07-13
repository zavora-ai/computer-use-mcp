# computer-use-supervisor

Local Picture-in-Picture supervisor alpha for the v8 runtime. It connects only
to the authenticated local supervisor socket and never loads the desktop native
module. The renderer is sandboxed and does not receive the socket token.
The CommonJS preload is required by Electron's sandboxed preload loader. Main
buffers authenticated socket replay until the renderer atomically installs its
message listener and acknowledges readiness, preventing a permanent
`connecting` state during fast local startup.

```bash
COMPUTER_USE_SUPERVISOR_SOCKET=/path/to/supervisor.sock \
COMPUTER_USE_SUPERVISOR_TOKEN=... \
COMPUTER_USE_SUPERVISOR_FRAMES=true \
COMPUTER_USE_PRINCIPAL_ID=local-user \
COMPUTER_USE_SESSION_ID=... \
npm start
```

The window shows lifecycle/action status and supports exact-action approval,
pause, resume, takeover, stop, and emergency stop. The emergency card displays
the configured physical chord and native latch generation. Reset requires an
explicit main-process confirmation and travels only over the authenticated
supervisor socket; it is never an MCP/model tool. Arbitrary event payloads are
not rendered; the view model copies only a fixed non-secret field allowlist.

When the server explicitly enables `COMPUTER_USE_SUPERVISOR_FRAMES`, PiP shows
target-only before/after or observation images. The runtime—not this app—captures
them. They remain process-memory-only, expire after five minutes, are bounded by
size and count, and are retrieved one frame at a time only after the authenticated
socket has subscribed to that session. Event journals contain metadata and hashes,
never image bytes. The supervisor process does not need desktop-control or screen-
capture permission.
