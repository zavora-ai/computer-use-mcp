import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComputerUseServer, createComputerUseHttpHandler } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { DesktopBroker } from '../dist/desktop-broker.js'
import { FileTaskStore } from '../dist/task-store.js'
import { principalKey } from '../dist/authority.js'
import { acquireSessionLock, coordinateDesktop } from '../dist/session/lock.js'
import { OpenAiCompatibilityHandler } from '../dist/session/openai-handler.js'
import { mapLegacyOpenAiAction } from '../dist/session/openai-compat.js'
import { useApproval, issueApproval } from '../dist/approval-ledger.js'
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server'

const env = capabilities => ({ [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: { name: 'strategy-test', version: '1' }, [CLIENT_CAPABILITIES_META_KEY]: capabilities ?? {} })
async function request(handler, method, params, authInfo, capabilities = {}, sessionId) {
  const name = params.name ?? params.uri ?? params.taskId
  const r = await handler.fetch(new Request('http://localhost/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
      ...(name ? { 'mcp-name': name } : {}), ...(sessionId ? { 'computer-use-session': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: env(capabilities) } }),
  }), { authInfo })
  return r.json()
}
const auth = subject => ({ clientId: 'shared-app', token: 'token-'+subject, scopes: [], extra: { issuer: 'test', subject } })
function fixture() {
  let x = 100, mutations = 0, closed = 0
  const dispatch = async (name, args) => {
    const values = {
      list_windows: [{ windowId: 1, pid: 20, bundleId: 'editor', displayId: 1, bounds: { x, y: 200, width: 800, height: 600 } }],
      get_ui_tree: { role: 'AXWindow', children: [{ role: 'AXButton', label: 'Save', actions: ['AXPress'] }] },
      find_element: [{ role: 'AXButton', label: 'Save', actions: ['AXPress'] }],
    }
    if (name === 'screenshot') return { content: [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }, { type: 'text', text: '400x300' }] }
    if (name === 'left_click' || name === 'click_element') { mutations++; values[name] = { args } }
    return { content: [{ type: 'text', text: JSON.stringify(values[name] ?? {}) }] }
  }
  return { session: { dispatch, close: () => { closed++ } }, dispatch, move: () => { x++ }, mutations: () => mutations, closed: () => closed }
}

test('resource and completion alternate surfaces obey host authorization', async () => {
  const f = fixture()
  const server = createComputerUseServer({ session: f.session, authorizeToolCall: () => { throw Error('denied') } })
  const client = await connectInProcess(server)
  try {
    for (const uri of ['computer://windows', 'computer://frontmost', 'computer://screenshot/latest', 'computer://profile/tools']) {
      await assert.rejects(client.readResource(uri), /denied/)
    }
    assert.equal(f.mutations(), 0)
  } finally { await client.close() }
})

test('modern filesystem resources request roots before reading data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cu-strategy-'))
  const file = join(directory, 'allowed.txt'); writeFileSync(file, 'private fixture')
  const handler = createComputerUseHttpHandler({ session: fixture().session })
  try {
    const result = await request(handler, 'resources/read', { uri: 'computer://filesystem/'+encodeURIComponent(file) }, auth('a'), { roots: {} })
    assert.equal(result.result?.resultType, 'input_required')
    assert.ok(!JSON.stringify(result).includes('private fixture'))
  } finally { await handler.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('same-process locks exclude independent owners and do not release replacement files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cu-lock-')); const path = join(directory, 'lock')
  const first = acquireSessionLock(path)
  try {
    assert.throws(() => acquireSessionLock(path), /locked/)
    // Rename the held inode: Windows cannot recreate a delete-pending open file.
    renameSync(path, join(directory, 'original')); writeFileSync(path, 'replacement')
    first.release()
    assert.equal(existsSync(path), true)
  } finally { first.release(); rmSync(directory, { recursive: true, force: true }) }
})

test('desktop queue serializes independent writers and permits nested operations', async () => {
  const calls = []
  await Promise.all([1,2,3].map(i => coordinateDesktop('test-queue', async () => {
    calls.push('start'+i)
    await new Promise(r => setTimeout(r, 2))
    await coordinateDesktop('test-queue', async () => calls.push('nested'+i))
    calls.push('end'+i)
  })))
  assert.deepEqual(calls, [1,2,3].flatMap(i => ['start'+i,'nested'+i,'end'+i]))
})

test('OpenAI mapping preserves buttons, two scroll axes and every drag point', async () => {
  const options = { common: {}, useVirtualPointer: false }
  assert.equal(mapLegacyOpenAiAction({ type: 'click', button: 'right', x: 1, y: 2 }, options).tool, 'right_click')
  const scroll = mapLegacyOpenAiAction({ type: 'scroll', x: 1, y: 2, scroll_x: 0, scroll_y: 600 }, options)
  assert.equal(scroll.args.delta_y, 6)
  const drag = mapLegacyOpenAiAction({ type: 'drag', path: [{x:1,y:2},{x:5,y:8},{x:10,y:3}] }, options)
  assert.deepEqual(drag.args.path, [[1,2],[5,8],[10,3]])
  assert.throws(() => mapLegacyOpenAiAction({ type: 'click', x: 1, y: 2, keys: ['SHIFT'] }, options), /unsupported/)
  let count = 0
  const handler = new OpenAiCompatibilityHandler(async () => { count++; return { content: [] } })
  assert.equal((await handler.handle('openai_computer', { actions: [{type:'click',x:1,y:2}, null] })).isError, true)
  assert.equal(count, 0)
})

test('observation transforms, staleness, ownership, verification, and deduplication', async () => {
  const f = fixture(); const broker = new DesktopBroker({ createSession: () => f.session })
  try {
    const { sessionId } = await broker.open('alice')
    await assert.rejects(broker.session('bob', sessionId), /unavailable/)
    const { observation } = await broker.observe('alice', sessionId, 1, f.dispatch, true)
    const input = { operationId: 'click-operation', observationId: observation.id, action: { type: 'click', x: 200, y: 150 }, expect: { label: 'Save', state: 'present' } }
    const result = await broker.act('alice', sessionId, input, f.dispatch)
    assert.equal(result.status, 'verified')
    const args = JSON.parse(result.result.content[0].text).args
    assert.deepEqual(args.coordinate, [500,500])
    await broker.act('alice', sessionId, input, f.dispatch)
    assert.equal(f.mutations(), 1)
    const fresh = await broker.observe('alice', sessionId, 1, f.dispatch, true)
    f.move()
    await assert.rejects(broker.act('alice', sessionId, { ...input, operationId: 'moved-window', observationId: fresh.observation.id }, f.dispatch), /geometry changed/)
    await broker.pause('alice', sessionId)
    await assert.rejects(broker.act('alice', sessionId, { ...input, operationId: 'paused-operation' }, f.dispatch), /paused|takeover/)
  } finally { broker.close() }
})

test('desktop operation journal survives restart without replaying actions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cu-journal-')); const f = fixture()
  const options = { createSession: () => f.session, store: new FileTaskStore(directory) }
  let broker = new DesktopBroker(options)
  try {
    const { sessionId } = await broker.open('alice')
    const { observation } = await broker.observe('alice', sessionId, 1, f.dispatch)
    const input = { operationId: 'saved-operation', observationId: observation.id, action: { type: 'invoke', elementId: observation.nodes[1].elementId } }
    await broker.act('alice', sessionId, input, f.dispatch); broker.close()
    broker = new DesktopBroker(options)
    assert.equal((await broker.status('alice', sessionId)).state, 'paused')
    assert.equal((await broker.act('alice', sessionId, input, f.dispatch)).status, 'executed')
    assert.equal(f.mutations(), 1)
  } finally { broker.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('verified subjects of one OAuth client have distinct identities; approvals are one-shot', () => {
  assert.notEqual(principalKey(auth('alice')), principalKey(auth('bob')))
  const id = issueApproval()
  assert.equal(useApproval(id, true), true)
  assert.equal(useApproval(id, false), true)
  assert.equal(useApproval(id, false), false)
  assert.equal(useApproval('unissued', false), false)
})

test('strategy MCP tools return image blocks and UI resource with a text fallback', async () => {
  const f = fixture(); const broker = new DesktopBroker({ createSession: () => f.session })
  const client = await connectInProcess(createComputerUseServer({ session: f.session, desktopBroker: broker }))
  try {
    const opened = await client.callTool('desktop_session', { action: 'open' })
    const { sessionId } = JSON.parse(opened.content[0].text)
    const observed = await client.callTool('desktop_observe', { sessionId, windowId: 1, screenshot: true })
    assert.ok(observed.content.some(c => c.type === 'image'))
    const console = await client.callTool('desktop_console', { sessionId })
    assert.equal(JSON.parse(console.content[0].text).state, 'ready')
    const tools = await client.listTools()
    assert.equal(tools.find(t => t.name === 'desktop_console')._meta.ui.resourceUri, 'ui://computer-use/session-console/v1')
    const ui = await client.readResource('ui://computer-use/session-console/v1')
    assert.equal(ui.contents[0].mimeType, 'text/html;profile=mcp-app')
  } finally { await client.close(); broker.close() }
})

test('Tasks resolve approvals before creation and reject replayed decisions', async () => {
  const previous = process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR
  process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR = 'get_ui_tree'
  let observations = 0
  const handler = createComputerUseHttpHandler({ disableSessionLock: true, native: {
    getWindow: () => null, getUiTree: () => { observations++; return { role: 'AXWindow', children: [] } },
  } })
  const capabilities = { elicitation: { form: {} }, extensions: { 'io.modelcontextprotocol/tasks': {} } }
  const params = { name:'get_ui_tree', arguments:{window_id:1} }
  try {
    const first = await request(handler,'tools/call',params,auth('alice'),capabilities)
    assert.equal(first.result.resultType,'input_required')
    assert.equal(observations,0)
    const accepted = {...params,requestState:first.result.requestState,inputResponses:{computer_use_approval:{action:'accept',content:{approve:true}}}}
    const created = await request(handler,'tools/call',accepted,auth('alice'),capabilities)
    assert.equal(created.result.resultType,'task')
    let task
    for(let i=0;i<30;i++) {
      task = await request(handler,'tasks/get',{taskId:created.result.taskId},auth('alice'),capabilities)
      if(task.result.status==='completed')break
      await new Promise(r=>setTimeout(r,5))
    }
    assert.equal(task.result.status,'completed')
    assert.equal(observations,1)
    const replay = await request(handler,'tools/call',accepted,auth('alice'),capabilities)
    assert.equal(replay.result.isError,true)
    assert.equal(observations,1)
    const other = await request(handler,'tasks/get',{taskId:created.result.taskId},auth('bob'),capabilities)
    assert.ok(other.error)
  } finally {
    await handler.close()
    if(previous===undefined)delete process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR
    else process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR=previous
  }
})

test('HTTP application sessions preserve private screenshot cache between requests', async () => {
  const broker = new DesktopBroker({ createSession: () => {
    let cached
    return { dispatch: async name => {
      if(name==='screenshot')cached={mimeType:'image/png',data:'YWJj',capturedAt:Date.now()}
      return {content:cached?[{type:'image',mimeType:cached.mimeType,data:cached.data}]:[]}
    },getLastScreenshot:()=>cached }
  } })
  const handler=createComputerUseHttpHandler({session:fixture().session,desktopBroker:broker})
  try {
    const opened=await request(handler,'tools/call',{name:'desktop_session',arguments:{action:'open'}},auth('alice'))
    const sessionId=JSON.parse(opened.result.content[0].text).sessionId
    await request(handler,'tools/call',{name:'screenshot',arguments:{}},auth('alice'),{},sessionId)
    const cached=await request(handler,'resources/read',{uri:'computer://screenshot/latest'},auth('alice'),{},sessionId)
    assert.equal(cached.result.contents[0].blob,'YWJj')
    const fresh=await request(handler,'resources/read',{uri:'computer://screenshot/latest'},auth('alice'))
    assert.ok(!JSON.stringify(fresh).includes('YWJj'))
  } finally {await handler.close();broker.close()}
})

 test('action approval preflight leaves observations retryable without journaling a mutation', async () => {
  const f = fixture(); const broker = new DesktopBroker({ createSession: () => f.session })
  try {
    const { sessionId } = await broker.open('alice')
    const { observation } = await broker.observe('alice', sessionId, 1, f.dispatch, true)
    const input = { operationId: 'approval-preflight', observationId: observation.id, action: { type: 'click', x: 20, y: 20 } }
    f.dispatch.preflight = async () => { throw new Error('Approval required') }
    await assert.rejects(broker.act('alice', sessionId, input, f.dispatch), /Approval required/)
    assert.equal(f.mutations(), 0)
    f.dispatch.preflight = async () => ({ content: [] })
    assert.equal((await broker.act('alice', sessionId, input, f.dispatch)).status, 'executed')
    assert.equal(f.mutations(), 1)
    const session = await broker.session('alice', sessionId)
    await broker.pause('alice', sessionId)
    const paused = await session.dispatch('left_click', { coordinate: [1, 1] })
    assert.equal(paused.isError, true)
    assert.match(paused.content[0].text, /paused/)
    assert.equal(f.mutations(), 1)
  } finally { broker.close() }
})
