import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { SESSION_CONSOLE_HTML } from '../dist/session-console.js'

for (const origin of ['https://host.example', 'null']) test(`MCP App handshake, selection and takeover with host origin ${origin}`, async () => {
  const nodes = new Map()
  const element = () => ({textContent:'', disabled:false, children:[], replaceChildren(){this.children=[]}, append(node){this.children.push(node)}})
  const document = {getElementById(id){if(!nodes.has(id))nodes.set(id,element());return nodes.get(id)},createElement:element}
  let receive
  const messages=[]
  const parent={postMessage(message){
    messages.push(message)
    if(!message.id||!message.method)return
    const result=message.method==='tools/call'?{structuredContent:{sessionId:'desktop_fixture',state:message.params.name==='desktop_pause'?'paused':'ready'}}:{}
    queueMicrotask(()=>receive({source:parent,origin,data:{jsonrpc:'2.0',id:message.id,result}}))
  }}
  runInNewContext(SESSION_CONSOLE_HTML.match(/<script>([\s\S]*)<\/script>/)[1],{
    parent,document,window:{addEventListener:(_name,callback)=>{receive=callback}},setTimeout,clearTimeout,
  })
  await new Promise(r=>setImmediate(r))
  receive({source:parent,origin,data:{jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{
    sessionId:'desktop_fixture',state:'ready',observation:{id:'obs_1',nodes:[{elementId:'element_1',role:'button',label:'<img src=x>'}]},
  }}}})
  assert.match(document.getElementById('state').textContent,/ready/)
  assert.equal(document.getElementById('controls').children[0].textContent,'button: <img src=x>')
  await document.getElementById('controls').children[0].onclick()
  assert.ok(messages.some(m=>m.method==='ui/message'))
  await document.getElementById('stop').onclick()
  assert.match(document.getElementById('state').textContent,/paused/)
  assert.ok(messages.some(m=>m.method==='ui/notifications/initialized'))
})
