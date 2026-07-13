# computer-use-supervisor

Local Picture-in-Picture supervisor alpha for the v8 runtime. It connects only
to the authenticated local supervisor socket and never loads the desktop native
module. The renderer is sandboxed and does not receive the socket token.

```bash
COMPUTER_USE_SUPERVISOR_SOCKET=/path/to/supervisor.sock \
COMPUTER_USE_SUPERVISOR_TOKEN=... \
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
