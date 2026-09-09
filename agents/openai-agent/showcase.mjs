import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createComputerUseServer } from '../../dist/server.js'
import { connectInProcess } from '../../dist/client.js'
import { MUTATING_TOOLS } from '../../dist/tool-catalog.js'
import { runAgent } from './agent.mjs'
import { RECIPES } from './recipes.mjs'
import { startStudio } from './studio.mjs'

export function parseOptions(argv) {
  const scenario=argv.shift()??'paint'
  if(!RECIPES[scenario])throw Error('Choose paint, office, or inspect')
  const result={scenario,studio:false,turns:60,tokens:400000,minutes:15,reasoning:'low'}
  while(argv.length){const key=argv.shift();if(key==='--studio'){result.studio=true;continue}
    const field={'--app':'app','--output':'output','--turns':'turns','--tokens':'tokens','--minutes':'minutes','--reasoning':'reasoning'}[key]
    if(!field||!argv.length)throw Error('Unknown or missing option: '+key)
    result[field]=['turns','tokens','minutes'].includes(field)?Number(argv.shift()):argv.shift()
  }
  if(result.studio&&scenario!=='paint')throw Error('--studio is only for paint')
  for(const [key,min,max] of [['turns',1,200],['tokens',1000,2000000],['minutes',1,60]])if(!Number.isInteger(result[key])||result[key]<min||result[key]>max)throw Error('Invalid '+key)
  if(!['low','medium','high','xhigh','max'].includes(result.reasoning))throw Error('Invalid reasoning effort')
  return result
}
export function artifactEvidence(directory,scenario) {
  const names=scenario==='paint'?['painting.png']:scenario==='office'?['quarterly-review.xlsx','quarterly-review.docx','quarterly-review.pptx']:[]
  return names.map(name=>{
    const path=join(directory,name)
    if(!existsSync(path))return {name,present:false}
    const stat=lstatSync(path)
    if(!stat.isFile()||stat.size>50*1024*1024)return {name,present:false,error:'Invalid artifact'}
    const data=readFileSync(path)
    const signature=name.endsWith('.png')?data.subarray(0,8).toString('hex')==='89504e470d0a1a0a':data.subarray(0,4).toString('hex')==='504b0304'
    return {name,present:true,bytes:stat.size,signatureValid:signature,contentVerified:false}
  })
}
export function defaultOutputForScenario(scenario) {
  return scenario==='office'?join(homedir(),'Downloads','computer-use-showcases'):'showcase-output'
}
export async function detectOwnedOfficeAccessPrompt(client,directory) {
  const listed=await client.callTool('list_windows',{})
  if(listed.isError)return null
  const windows=listed.structuredContent?.windows??JSON.parse(listed.content.find(c=>c.type==='text')?.text??'{}').windows??[]
  for(const window of windows.filter(w=>w.title?.toLowerCase().includes('grant file access'))){
    const observed=await client.callTool('get_ui_tree',{window_id:window.windowId})
    const details=observed.isError?'':observed.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')
    if(details.includes(directory))return {windowId:window.windowId,title:window.title,details:details.slice(0,2000)}
  }
  return null
}
export async function preflightOfficeOutput(client,directory,{timeoutMs=10000,signal}={}) {
  const filename=`.computer-use-office-preflight-${process.pid}-${Date.now()}.xlsx`
  const path=join(directory,filename)
  const quote=value=>'"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"'
  const script=`tell application id "com.microsoft.Excel"
set fixture to make new workbook
set fixtureSheet to worksheet 1 of fixture
set value of range "A1:B2" of fixtureSheet to {{"Preflight", "OK"}, {"Owned", 1}}
save workbook as fixture filename ${quote(path)} file format Excel XML file format
close workbook ${quote(filename)} saving no
end tell`
  signal?.throwIfAborted()
  const result=await client.callTool('run_script',{language:'applescript',script,timeout_ms:timeoutMs},{signal})
  if(result.isError){
    const prompt=await detectOwnedOfficeAccessPrompt(client,directory)
    return prompt?{ok:false,reason:'access_dialog',path,prompt}:{ok:false,reason:'script_failed',path,error:result.content.find(c=>c.type==='text')?.text??'Office preflight failed'}
  }
  const valid=existsSync(path)&&lstatSync(path).isFile()&&readFileSync(path).subarray(0,4).toString('hex')==='504b0304'
  rmSync(path,{force:true})
  return valid?{ok:true,path}:{ok:false,reason:'artifact_missing_or_invalid',path}
}
export async function main(argv=process.argv.slice(2)) {
  const options=parseOptions([...argv])
  if(!process.env.OPENAI_API_KEY)throw Error('Set OPENAI_API_KEY in your shell before running a showcase')
  const {default:OpenAI}=await import('openai')
  const defaultOutput=defaultOutputForScenario(options.scenario)
  const base=resolve(options.output??defaultOutput);mkdirSync(base,{recursive:true})
  const directory=mkdtempSync(join(base,options.scenario+'-'))
  const controller=new AbortController();const stop=()=>controller.abort(Error('User stopped showcase'))
  process.once('SIGINT',stop)
  const deadline=setTimeout(()=>controller.abort(Error('Showcase deadline exceeded')),options.minutes*60000)
  let studio,client;let windowId;let lastImage=0
  const recipe=RECIPES[options.scenario]
  const model=process.env.OPENAI_MODEL??'gpt-6-astra'
  const report={scenario:options.scenario,model,status:'running',directory,usage:null,artifacts:[]}
  const trace=event=>appendFileSync(join(directory,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n',{mode:0o600})
  try {
    if(options.studio)studio=await startStudio(directory)
    const allowed=new Set(recipe.tools)
    client=await connectInProcess(createComputerUseServer({authorizeToolCall:({definition,args})=>{
      if(!allowed.has(definition.name))throw Error('Tool excluded from this showcase')
      if(studio){
        if(definition.name==='open_application')throw Error('Studio is already open; use its existing window')
        const targeted=args.target_window_id??args.window_id
        if((MUTATING_TOOLS.has(definition.name)&&definition.name!=='wait')||['screenshot','get_ui_tree','find_element','get_window'].includes(definition.name)) {
          if(!windowId||targeted!==windowId)throw Error('Target only the supplied studio window')
        }
      }
    }}))
    if(studio){
      for(let i=0;i<30;i++){
        const result=await client.callTool('list_windows',{}, {signal:controller.signal})
        const windows=result.structuredContent?.windows??JSON.parse(result.content[0].text).windows
        const matches=windows.filter(w=>w.title?.includes('MCP Paint Studio'))
        if(matches.length===1){windowId=matches[0].windowId;break}
        await new Promise(r=>setTimeout(r,100))
      }
      if(!windowId)throw Error('Could not identify the isolated studio window uniquely')
    }
    if(options.scenario==='office'){
      if(process.platform!=='darwin'){report.status='blocked';report.preflight={ok:false,reason:'platform_unsupported'};throw Error('Office output preflight currently requires macOS AppleScript')}
      const preflight=await preflightOfficeOutput(client,directory,{signal:controller.signal})
      report.preflight=preflight
      if(!preflight.ok){report.status='blocked';throw Error(preflight.reason==='access_dialog'?`Office output access unavailable for ${directory}; grant only that folder in Excel's file-access dialog and rerun`:`Office output preflight failed for ${directory}: ${preflight.error??preflight.reason}`)}
    }
    console.log(`${recipe.title}\nModel: ${model}\nOutput: ${directory}`)
    const result=await runAgent({openai:new OpenAI({maxRetries:0}),client,model,
      task:recipe.task({output:directory,app:options.app,studio:options.studio})+(windowId?`\nThe host identified studio window ID ${windowId}. Always target that window.`:''),
      customTools:studio?[studio.painter(client,windowId),studio.finisher(client,windowId)]:[],
      finalizeToolName:studio?'finish_painting':undefined,
      allowedTools:recipe.tools,maxTurns:options.turns,maxTokens:options.tokens,signal:controller.signal,reasoningEffort:options.reasoning,
      reuseImages:true,
      extraInstructions:'Describe progress briefly at layer or document milestones. Use the given output directory. Never change account settings, install software, send messages, publish, or touch pre-existing documents. Tool scope is limited by the host, but local desktop access is not a sandbox.',
      onProgress:event=>{console.log(`${event.state}: ${event.tool}`);trace(event)},
      onResponse:({response,usage})=>{report.usage=usage;trace({kind:'response',id:response.id,status:response.status,usage})},
      onToolResult:({tool,result})=>{
        trace({kind:'tool_result',tool,isError:Boolean(result.isError),images:result.content.filter(c=>c.type==='image').length})
        for(const image of result.content.filter(c=>c.type==='image'))writeFileSync(join(directory,`observation-${String(++lastImage).padStart(3,'0')}.${image.mimeType==='image/png'?'png':'jpg'}`),Buffer.from(image.data,'base64'),{mode:0o600})
      },
    })
    report.modelSummary=result.text;report.usage=result.usage;report.status='model_finished'
    writeFileSync(join(directory,'summary.md'),result.text,{mode:0o600})
    report.artifacts=artifactEvidence(directory,options.scenario)
    report.studio=studio?.evidence()
    report.artifactChecksPassed=report.artifacts.every(a=>a.present&&a.signatureValid)
    if(!report.artifactChecksPassed)report.status='incomplete_artifacts'
    console.log(result.text)
    console.log(JSON.stringify({status:report.status,usage:report.usage,artifacts:report.artifacts,studio:report.studio},null,2))
    if(!report.artifactChecksPassed)process.exitCode=1
    return report
  }catch(error){if(report.status!=='blocked')report.status='stopped';report.error=error.message;report.artifacts=artifactEvidence(directory,options.scenario);report.studio=studio?.evidence();throw error}
  finally{clearTimeout(deadline);process.removeListener('SIGINT',stop);writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2),{mode:0o600});await client?.close();await studio?.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1})
