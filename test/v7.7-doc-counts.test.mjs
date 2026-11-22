// 7.7.0 (R5): the tool counts the docs state are derived from the catalog here, so a tool added, moved between
// profiles or made platform-specific cannot leave AGENTS.md, the README or the computer-use skill out of date.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { listedTools } from '../dist/instructions.js'

const PROFILES = ['core', 'desktop', 'scripting', 'windows-admin', 'ax', 'full']
const count = (platform, profile) => listedTools(platform, profile).length
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\s+/g, ' ')
const counts = platform => PROFILES.map(profile => count(platform, profile))

test('AGENTS.md states the tool counts by profile for every platform', () => {
  const agents = read('AGENTS.md')
  const [core, desktop, scripting, admin, ax, full] = counts('darwin')
  const expected = `Tool counts by profile on macOS: core ${core}, desktop ${desktop}, scripting ${scripting}, windows-admin ${admin}, ax ${ax}, full ${full}`
    + ` (Windows ${counts('win32').join('/')}, Linux ${counts('linux').join('/')})`
  assert.ok(agents.includes(expected), `AGENTS.md should say: ${expected}`)
  assert.ok(agents.includes(`the default \`desktop\` profile lists ${desktop} tools on macOS and ${count('win32', 'desktop')} on Windows and Linux, and \`full\` lists ${full}, ${count('win32', 'full')} and ${count('linux', 'full')}`))
  assert.ok(agents.includes(`On macOS the default \`desktop\` profile lists ${desktop} tools`))
  assert.ok(agents.includes(`\`COMPUTER_USE_PROFILE=full\` lists ${full} tools`))
  assert.ok(agents.includes(`on macOS ${desktop} tools against ${full} for \`full\``))
  assert.equal(count('win32', 'desktop'), count('linux', 'desktop'), 'the docs say Windows and Linux list the same desktop count')
  // 8.0: the read-only guide profile sits outside the nesting
  assert.equal(count('win32', 'guide'), count('linux', 'guide'))
  assert.ok(agents.includes(`the read-only \`guide\` profile lists ${count('darwin', 'guide')} on macOS and ${count('win32', 'guide')} on Windows and Linux`))
  assert.ok(agents.includes(`(${count('darwin', 'guide')} tools on macOS)`), 'the guide section states its count')
})

test('the README and the computer-use skill state the same counts', () => {
  const readme = read('README.md')
  assert.ok(readme.includes(`exposes ${count('darwin', 'desktop')} tools on macOS`))
  assert.ok(readme.includes(`for every tool (${count('darwin', 'full')} on macOS)`))
  const skill = read('skills/computer-use/SKILL.md')
  assert.ok(skill.includes(`(${count('darwin', 'desktop')} tools on macOS, ${count('win32', 'desktop')} on Windows and Linux)`))
})
