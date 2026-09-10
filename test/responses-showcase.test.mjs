import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {parseOptions,artifactEvidence,defaultOutputForScenario,detectOwnedOfficeAccessPrompt,preflightOfficeOutput} from '../agents/openai-agent/showcase.mjs'
import {runAgent,boundToolText} from '../agents/openai-agent/agent.mjs'
import {RECIPES,officePlatformInstructions} from '../agents/openai-agent/recipes.mjs'

test('Office recipe selects platform automation and makes save probing optional',()=>{
 assert.match(RECIPES.office.task({output:'C:/output',platform:'win32'}),/PowerShell/)
 assert.doesNotMatch(RECIPES.office.task({output:'C:/output',platform:'win32'}),/AppleScript/)
 assert.match(officePlatformInstructions('darwin'),/AppleScript/)
 assert.throws(()=>officePlatformInstructions('linux'),/does not implement LibreOffice/)
 assert.equal(parseOptions(['office']).officePreflight,undefined)
 assert.equal(parseOptions(['office','--office-preflight']).officePreflight,true)
 assert.throws(()=>parseOptions(['inspect','--office-preflight']),/only for office/)
})

test('model text budgets span all blocks, retain images and disclose omitted evidence',()=>{
 const picture={type:'image',data:'fixture',mimeType:'image/png'}
 const result=boundToolText({isError:true,content:[{type:'text',text:'abcdef'},picture,{type:'text',text:'ghijkl'}]},8)
 assert.equal(result.isError,true)
 assert.equal(result.content[0].text,'abcdef')
 assert.equal(result.content[1],picture)
 assert.equal(result.content[2].text,'gh')
 assert.equal(JSON.parse(result.content[3].text).omittedChars,4)
})

test('structured MCP results cannot bypass the model text budget',async()=>{
 let turn=0;const requests=[]
 await runAgent({task:'read',maxToolTextChars:256,
  client:{listTools:async()=>[]},
  customTools:[{schema:{type:'function',name:'read'},execute:async()=>({content:[],structuredContent:{large:'x'.repeat(20000)}})}],
  openai:{responses:{create:async request=>{requests.push(request);return {id:'r'+turn,status:'completed',output:turn++===0?[{type:'function_call',name:'read',arguments:'{}',call_id:'c'}]:[{type:'message'}],output_text:'done'}}}},
 })
 const output=requests[1].input.find(i=>i.type==='function_call_output').output
 assert.equal(output[0].text.length,256)
 assert.equal(JSON.parse(output[1].text).toolOutputTruncated,true)
})

test('convenience tools cannot bypass the runner allowlist even with an unguarded MCP client',async()=>{
 for(const call of [
  {name:'observe_window',arguments:JSON.stringify({window_id:1})},
  {name:'wait_for_element',arguments:JSON.stringify({window_id:1})},
  {name:'observe_window',arguments:JSON.stringify({window_id:1,include_screenshot:true}),allowed:['get_ui_tree']},
 ]) {
  let turn=0;const dispatched=[];const requests=[]
  await runAgent({task:'inspect',allowedTools:call.allowed??['list_windows'],
   client:{listTools:async()=>[],callTool:async name=>{dispatched.push(name);return {content:[]}}},
   openai:{responses:{create:async request=>{requests.push(request);return {id:'r'+turn,status:'completed',output:turn++===0?[{type:'function_call',name:call.name,arguments:call.arguments,call_id:'c'}]:[{type:'message'}],output_text:'done'}}}},
  })
  assert.deepEqual(dispatched,[])
  assert.match(JSON.stringify(requests[1].input),/Tool excluded/)
  if(!call.allowed)assert.ok(!requests[0].tools.some(t=>t.name===call.name))
 }
})
import {mapLegacyOpenAiAction} from '../dist/session/openai-compat.js'
import {OpenAiCompatibilityHandler} from '../dist/session/openai-handler.js'

test('showcase validates budgets and rejects misleading artifact paths',()=>{
 assert.equal(parseOptions(['paint','--studio','--turns','12']).turns,12)
 assert.throws(()=>parseOptions(['office','--studio']),/only for paint/)
 assert.throws(()=>parseOptions(['paint','--tokens','NaN']),/tokens/)
 const directory=mkdtempSync(join(tmpdir(),'cu-showcase-'))
 try {
  assert.equal(artifactEvidence(directory,'paint')[0].present,false)
  writeFileSync(join(directory,'painting.png'),'not a png')
  assert.equal(artifactEvidence(directory,'paint')[0].signatureValid,false)
  rmSync(join(directory,'painting.png'));symlinkSync(join(directory,'other'),join(directory,'painting.png'));writeFileSync(join(directory,'other'),'x')
  assert.equal(artifactEvidence(directory,'paint')[0].present,false)
 } finally {rmSync(directory,{recursive:true,force:true})}
})

test('Office showcases default to a Downloads subfolder while explicit outputs remain respected',()=>{
 assert.match(defaultOutputForScenario('office'),/Downloads[\\/]computer-use-showcases$/)
 assert.equal(defaultOutputForScenario('paint'),'showcase-output')
 assert.equal(parseOptions(['office','--output','/tmp/custom-office']).output,'/tmp/custom-office')
})

test('Office access preflight reports only a dialog tied to the owned output directory',async()=>{
 const client={callTool:async(tool,args)=>tool==='list_windows'
  ?{structuredContent:{windows:[{windowId:9,title:'Grant File Access'}]}}
  :{content:[{type:'text',text:JSON.stringify({label:'Grant File Access',value:'Additional permissions are required for /tmp/office-owned'})}]}}
 const found=await detectOwnedOfficeAccessPrompt(client,'/tmp/office-owned')
 assert.equal(found.windowId,9)
 const unrelated=await detectOwnedOfficeAccessPrompt(client,'/tmp/other-directory')
 assert.equal(unrelated,null)
})

test('Office output preflight bounds a blocked save and returns the owned access dialog',async()=>{
 const calls=[];const controller=new AbortController()
 const client={callTool:async(tool,args,options)=>{
  calls.push([tool,args])
  if(tool==='run_script')assert.equal(options.signal,controller.signal)
  if(tool==='run_script')return {isError:true,content:[{type:'text',text:'script timed out after 1000ms'}]}
  if(tool==='list_windows')return {structuredContent:{windows:[{windowId:11,title:'Grant File Access'}]}}
  return {content:[{type:'text',text:JSON.stringify({value:'Additional permissions for /tmp/office-preflight'})}]}
 }}
 const result=await preflightOfficeOutput(client,'/tmp/office-preflight',{timeoutMs:1000,signal:controller.signal})
 assert.equal(result.ok,false);assert.equal(result.reason,'access_dialog');assert.equal(result.prompt.windowId,11)
 assert.equal(calls[0][0],'run_script');assert.equal(calls[0][1].timeout_ms,1000)
})

test('Responses agent filters lazy tools, stops at token limit and emits actual usage',async()=>{
 let dispatched=0,usage
 await assert.rejects(runAgent({task:'test',maxTokens:10,allowedTools:['screenshot'],
  client:{listTools:async()=>[{name:'run_script',inputSchema:{}},{name:'screenshot',inputSchema:{}}],callTool:async()=>{dispatched++}},
  onResponse:event=>{usage=event.usage},
  openai:{responses:{create:async()=>({status:'completed',id:'r',usage:{input_tokens:11,output_tokens:1},output:[{type:'function_call',name:'screenshot',call_id:'a',arguments:'{}'}]})}},
 }),/token budget/)
 assert.equal(dispatched,0);assert.equal(usage.inputTokens,11)
})

test('OpenAI screenshot actions and final captures retain the requested window',async()=>{
 const options={common:{target_window_id:321},useVirtualPointer:false}
 assert.equal(mapLegacyOpenAiAction({type:'screenshot'},options).args.target_window_id,321)
 const typed=mapLegacyOpenAiAction({type:'type',text:'12',clear:true,press_enter:true},options)
 assert.deepEqual(typed.args,{text:'12',clear:true,press_enter:true,target_window_id:321})
 const calls=[]
 const handler=new OpenAiCompatibilityHandler(async(tool,args)=>{calls.push({tool,args});return {content:[]}})
 await handler.handle('openai_computer',{actions:[],target_window_id:321,return_screenshot:true})
 assert.equal(calls[0].args.target_window_id,321)
})

test('studio painter rejects invalid paths before touching the browser or MCP',async()=>{
 const {createStudioPainter}=await import('../agents/openai-agent/studio-painter.mjs')
 const painter=createStudioPainter({}, ()=>({}), {callTool:()=>{throw Error('must not call')}}, 1)
 await assert.rejects(painter.execute({color:'Cobalt',width:12,strokes:[[[0,0],[1001,20]]]}),/Invalid canvas/)
 await assert.rejects(painter.execute({color:'Other',width:12,strokes:[[[0,0],[20,20]]]}),/Invalid stroke/)
})

test('custom tools remain available without lazy discovery and receive cancellation',async()=>{
 const signal=new AbortController().signal;let turn=0,called=0
 const result=await runAgent({task:'draw',signal,client:{listTools:async()=>[],callTool:async()=>{throw Error('unexpected MCP call')}},
  customTools:[{schema:{type:'function',name:'paint_strokes',parameters:{type:'object'}},execute:async(_args,received)=>{assert.equal(received,signal);called++;return {content:[{type:'text',text:'painted'}]}}}],
  openai:{responses:{create:async request=>{assert.ok(request.tools.some(t=>t.name==='paint_strokes'));assert.ok(request.input.some(i=>i.role==='developer'&&i.content.includes('Runtime budget')));return {id:'r'+turn,status:'completed',output:turn++===0?[{type:'function_call',name:'paint_strokes',arguments:'{}',call_id:'p'}]:[{type:'message',phase:'final_answer'}],output_text:'done'}}}},
 })
 assert.equal(called,1);assert.equal(result.text,'done')
})

test('Responses runner forces the registered finalizer near the turn limit',async()=>{
 const requests=[];let turn=0;let painted=0;let finalized=0
 const tools=[
  {schema:{type:'function',name:'paint_strokes',parameters:{type:'object'}},execute:async()=>{painted++;return {content:[{type:'text',text:'painted'}]}}},
  {schema:{type:'function',name:'finish_painting',parameters:{type:'object'}},execute:async()=>{finalized++;return {content:[{type:'text',text:'exported'}]}}},
 ]
 const result=await runAgent({task:'paint and export',maxTurns:3,maxTokens:10000,customTools:tools,finalizeToolName:'finish_painting',
  client:{listTools:async()=>[],callTool:async()=>{throw Error('unexpected MCP call')}},
  openai:{responses:{create:async request=>{requests.push(request);const index=turn++;const output=index===0?[{type:'function_call',name:'paint_strokes',arguments:'{}',call_id:'paint'}]:index===1?[{type:'function_call',name:'finish_painting',arguments:'{}',call_id:'finish'}]:[{type:'message',phase:'final_answer'}];return {id:'r'+turn,status:'completed',output,output_text:'complete',usage:{input_tokens:1,output_tokens:1}}}}},
 })
 assert.equal(result.text,'complete');assert.equal(painted,1);assert.equal(finalized,1)
 assert.equal(requests[1].tool_choice.type,'function');assert.equal(requests[1].tool_choice.name,'finish_painting')
 assert.equal(requests[2].tool_choice,'none')
})
