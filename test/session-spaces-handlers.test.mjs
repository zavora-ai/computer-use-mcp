import assert from 'node:assert/strict'
import test from 'node:test'
import { SpacesHandler } from '../dist/session/spaces-handlers.js'

test('extracted Windows Spaces handler creates and destroys desktops through bounded shortcuts', async () => {
  let count = 1
  const calls = []
  const native = {
    listSpaces: () => ({ displays: [{ spaces: Array.from({ length: count }, (_, i) => ({ uuid: `space-${i + 1}` })) }] }),
    getActiveSpace: () => 'space-1',
    keyPress: key => { calls.push(key); count += key === 'ctrl+win+d' ? 1 : -1 },
  }
  const handler = new SpacesHandler({
    native, platform: 'win32', sleep: async () => {},
    spawnBounded: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }),
  })
  const created = JSON.parse((await handler.handle('create_agent_space', {})).content[0].text)
  assert.equal(created.created, true)
  assert.equal(created.space_id, 'space-2')
  const destroyed = JSON.parse((await handler.handle('destroy_space', {})).content[0].text)
  assert.equal(destroyed.destroyed, true)
  assert.deepEqual(calls, ['ctrl+win+d', 'ctrl+win+f4'])
})

test('extracted macOS Spaces handler caches only an attached numeric native space', async () => {
  let creates = 0
  const native = {
    listSpaces: () => ({ displays: [] }), getActiveSpace: () => null,
    createAgentSpace: () => { creates += 1; return { supported: true, spaceId: 7, created: true, attached: true } },
    destroySpace: () => ({ destroyed: true }),
  }
  const handler = new SpacesHandler({
    native, platform: 'darwin', env: { COMPUTER_USE_SPACES_BACKEND: 'cgs' },
    sleep: async () => {},
    spawnBounded: async () => ({ stdout: '', stderr: '', code: 1, timedOut: false }),
  })
  const first = JSON.parse((await handler.handle('create_agent_space', {})).content[0].text)
  const second = JSON.parse((await handler.handle('create_agent_space', {})).content[0].text)
  assert.equal(first.space_id, 7)
  assert.equal(second.cached, true)
  assert.equal(creates, 1)
  await handler.handle('destroy_space', { space_id: 7 })
  await handler.handle('create_agent_space', {})
  assert.equal(creates, 2)
})

test('extracted yabai failure exposes scripting-addition remediation', async () => {
  const spawnBounded = async (_command, args) => {
    if (args[0] === '--version') return { stdout: '7.0', stderr: '', code: 0, timedOut: false }
    if (args.includes('--create')) return {
      stdout: '', stderr: 'scripting-addition is not loaded', code: 1, timedOut: false,
    }
    return { stdout: '[]', stderr: '', code: 0, timedOut: false }
  }
  const handler = new SpacesHandler({
    native: { listSpaces: () => ({ displays: [] }) },
    platform: 'darwin', env: { COMPUTER_USE_SPACES_BACKEND: 'yabai' },
    sleep: async () => {}, spawnBounded,
  })
  const result = await handler.handle('create_agent_space', {})
  assert.equal(result.isError, true)
  const error = JSON.parse(result.content[0].text)
  assert.equal(error.requires_scripting_addition, true)
  assert.deepEqual(error.setup_commands, ['sudo yabai --load-sa'])
})
