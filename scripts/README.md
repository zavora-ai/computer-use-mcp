# Development scripts

Run from the repository root after installing dependencies. Live desktop scripts
need a native build and OS permissions. They are not unattended unit tests.

| Command | Purpose |
|---|---|
| `npm test` | Build TypeScript and run the automated regression suite. |
| `npm run smoke` | Check native display/window access and application discovery without injecting input. |
| `npm run test:browser` | Exercise the isolated browser on a disposable local fixture. |
| `node scripts/test-office.mjs` | Create and verify scratch Word, Excel and PowerPoint files on macOS. |
| `npm run test:input-attribution` | Measure physical-input detection on a supported desktop. |
| `npm run measure:efficiency` | Compare catalog and observation payload sizes. |
| `npm run evaluate:strategy -- baseline.json candidate.json` | Compare matched, independently verified task traces. |
| `npm run prepare:packages` | Stamp platform manifests and copy available native binaries. |

`clean-dist.mjs` only removes generated TypeScript output. `live-windows.mjs` is
an attended Windows development probe. Legacy Mission Control/Spaces experiments
and obsolete v3–v5 scripts were removed in v7.2; their history remains in Git.
Only `verify-input-attribution.mjs` is included as a script in the npm package.
