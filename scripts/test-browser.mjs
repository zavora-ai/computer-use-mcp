import { spawnSync } from 'node:child_process'
const result = spawnSync(process.execPath, ['--test','test/browser-backend.test.mjs'], {
  stdio: 'inherit', env: { ...process.env, COMPUTER_USE_BROWSER_TESTS: 'true' },
})
process.exitCode = result.status ?? 1
