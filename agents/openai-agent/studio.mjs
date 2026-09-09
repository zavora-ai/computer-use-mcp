import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStudioPainter } from './studio-painter.mjs'

/** Local paint UI. Only pointer events paint; the host only receives explicit PNG exports. */
export async function startStudio(directory, { launch } = {}) {
  const token=randomBytes(24).toString('hex')
  let evidence=null;let controls={width:20,color:'#111d3b'}
  const html=readFileSync(new URL('./paint-studio.html',import.meta.url))
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/') {res.setHeader('Content-Type','text/html');res.end(html);return}
    if(req.method!=='POST'||!['/export/'+token,'/state/'+token].includes(req.url)){res.writeHead(404);res.end();return}
    try {
      let bytes=0;const chunks=[]
      for await (const chunk of req){bytes+=chunk.length;if(bytes>8*1024*1024)throw Error('Export too large');chunks.push(chunk)}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if(req.url==='/state/'+token){if(!Number.isFinite(body.width)||typeof body.color!=='string')throw Error('Invalid control state');controls=body;res.end('OK');return}
      if(typeof body.image!=='string'||!body.image.startsWith('data:image/png;base64,')||!Array.isArray(body.strokes)||body.strokes.length>10000)throw Error('Invalid export')
      const png=Buffer.from(body.image.slice('data:image/png;base64,'.length),'base64')
      if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Invalid PNG')
      const colors=new Set();let points=0
      for(const s of body.strokes){if(!Array.isArray(s.points)||s.points.length>10000||typeof s.color!=='string')throw Error('Invalid stroke');colors.add(s.color);points+=s.points.length}
      writeFileSync(join(directory,'painting.png'),png,{mode:0o600})
      evidence={artifactSaved:true,strokeCount:body.strokes.length,colors:colors.size,points,
        trustedPointerEvents:body.strokes.length>0&&body.strokes.every(s=>s.trusted===true),artisticQuality:'Requires visual review'}
      writeFileSync(join(directory,'strokes.json'),JSON.stringify(body.strokes),{mode:0o600})
      res.end('Saved')
    }catch{res.writeHead(400);res.end('Invalid export')}
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  let browser
  try {
    const {chromium}=await import('playwright')
    browser=await (launch?.()??chromium.launch({headless:false,chromiumSandbox:true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{}),args:['--force-renderer-accessibility']}))
    const page=await browser.newPage({viewport:{width:1100,height:760}})
    await page.goto(`http://127.0.0.1:${server.address().port}/#${token}`,{waitUntil:'networkidle'})
    const layout=await page.evaluate(()=>{
      const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}
      const border=(window.outerWidth-window.innerWidth)/2
      return {border,toolbar:window.outerHeight-window.innerHeight-border,width:window.outerWidth,height:window.outerHeight,canvas:box('#canvas'),brush:box('#width'),export:box('#export'),palette:Array.from(document.querySelectorAll('#palette button'),el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})}
    })
    return {url:page.url(),evidence:()=>evidence, painter:(client,windowId)=>createStudioPainter(layout,()=>controls,client,windowId), finisher:(client,windowId)=>({schema:{type:'function',name:'finish_painting',strict:false,description:'Click the studio Export PNG button through MCP, verify that the local export arrived, and return a final screenshot.',parameters:{type:'object',properties:{},additionalProperties:false}},execute:async(_args,signal)=>{
      const result=await client.callTool('get_window',{window_id:windowId},{signal});if(result.isError)return result;const w=result.structuredContent??JSON.parse(result.content[0].text);
      const clicked=await client.callTool('openai_computer',{target_window_id:windowId,focus_strategy:'strict',actions:[{type:'click',x:w.bounds.x+layout.border+layout.export.x+layout.export.width/2,y:w.bounds.y+layout.toolbar+layout.export.y+layout.export.height/2}],return_screenshot:true},{signal});
      for(let i=0;i<20&&!evidence;i++){signal?.throwIfAborted();await new Promise(r=>setTimeout(r,50))}
      if(clicked.isError||!evidence||evidence.strokeCount<1||!evidence.trustedPointerEvents)throw Error('Export was not verified: requires at least one trusted pointer stroke')
      return {content:[{type:'text',text:JSON.stringify(evidence)},...clicked.content]}
    }}), close:async()=>{
      try {if(!evidence)await page.locator('#canvas').screenshot({path:join(directory,'recovered-canvas.png')})}
      finally {await browser.close();await new Promise(resolve=>server.close(resolve))}
    }}
  }catch(error){await browser?.close();await new Promise(resolve=>server.close(resolve));throw error}
}
