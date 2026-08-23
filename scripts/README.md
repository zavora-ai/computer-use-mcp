# Development scripts

These scripts support local platform debugging and release preparation. Only `verify-input-attribution.mjs` is included in the published package.

- `prepare-platform-packages.mjs` stamps the root version into platform packages and copies native binaries.
- `clean-dist.mjs` removes only the generated `dist` directory before TypeScript compilation.
- `verify-input-attribution.mjs` validates the native physical-input observation latency when explicitly run on a supported desktop.
- `test-v5-smoke.mjs` runs the established read-only desktop smoke sequence.
- `test-v5-e2e.mjs` and the platform-specific scripts are manual development probes and are not release gates.

All scripts that operate a live desktop require an attended session and the same OS permissions as the MCP server.
