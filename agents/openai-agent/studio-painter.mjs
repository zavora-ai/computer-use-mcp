const COLORS=['Midnight','Cobalt','Sky','Cream','Gold','Green','Brown','White']
const point={type:'array',items:{type:'number'},minItems:2,maxItems:2}
export function createStudioPainter(layout,controls,client,windowId) {
  return {
    schema:{type:'function',name:'paint_strokes',strict:false,
      description:'Paint one layer in the studio with real MCP mouse input. Select one named palette color, brush width 1..100, and up to 20 polylines in canvas coordinates x=0..1000,y=0..600. Use 2..150 points per stroke. The host reads current geometry, sets controls, executes your paths and returns a window screenshot.',
      parameters:{type:'object',properties:{color:{type:'string',enum:COLORS},width:{type:'number',minimum:1,maximum:100},strokes:{type:'array',minItems:1,maxItems:20,items:{type:'array',minItems:2,maxItems:150,items:point}}},required:['color','width','strokes'],additionalProperties:false}},
    execute:async(args,signal)=>{
      if(!COLORS.includes(args.color)||!Number.isFinite(args.width)||args.width<1||args.width>100||!Array.isArray(args.strokes)||args.strokes.length<1||args.strokes.length>20)throw Error('Invalid stroke batch')
      for(const path of args.strokes)if(!Array.isArray(path)||path.length<2||path.length>150||path.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<0||p[0]>1000||p[1]<0||p[1]>600))throw Error('Invalid canvas path')
      const geometry=async()=>{
        const result=await client.callTool('get_window',{window_id:windowId},{signal})
        if(result.isError)throw Error('Studio window unavailable')
        const w=result.structuredContent??JSON.parse(result.content[0].text)
        if(Math.abs(w.bounds.width-layout.width)>3||Math.abs(w.bounds.height-layout.height)>3)throw Error('Studio resized; restart before drawing')
        return {frame:{x:w.bounds.x+layout.border,y:w.bounds.y+layout.toolbar},canvas:layout.canvas}
      }
      const {frame}=await geometry()
      const brush=layout.brush, palette=layout.palette[COLORS.indexOf(args.color)]
      const center=box=>({x:frame.x+box.x+box.width/2,y:frame.y+box.y+box.height/2})
      const control=await client.callTool('openai_computer',{target_window_id:windowId,focus_strategy:'strict',actions:[
        {type:'click',...center(brush)},
        // `type` with clear delegates select-all/delete to the canonical input
        // handler.  A separate OpenAI `keypress` batch item can be delivered
        // while the native field still has its old value, which used to leave
        // the default 20 in place and append the requested width (for example
        // 2012).  Keeping the clear and type in one canonical action also
        // avoids platform-specific modifier naming in this compatibility layer.
        {type:'type',text:String(args.width),clear:true},
        {type:'click',...center(palette)},
      ]},{signal})
      if(control.isError)return control
      const expectedColor=['#111d3b','#234da2','#568fc1','#f6e3a2','#e9b83f','#214a3d','#704b36','#fff7dc'][COLORS.indexOf(args.color)]
      for(let i=0;i<30&&(controls().width!==args.width||controls().color!==expectedColor);i++){signal?.throwIfAborted();await new Promise(r=>setTimeout(r,50))}
      if(controls().width!==args.width||controls().color!==expectedColor)throw Error('Brush controls not applied; no strokes executed: '+JSON.stringify(controls()))
      const current=await geometry()
      if(current.frame.x!==frame.x||current.frame.y!==frame.y)throw Error('Window moved during brush selection; observe before retry')
      const actions=args.strokes.map(path=>({type:'drag',path:path.map(([x,y])=>({x:current.frame.x+current.canvas.x+Math.max(.5,Math.min(999.5,x))*current.canvas.width/1000,y:current.frame.y+current.canvas.y+Math.max(.5,Math.min(599.5,y))*current.canvas.height/600}))}))
      return client.callTool('openai_computer',{target_window_id:windowId,focus_strategy:'strict',actions,return_screenshot:true,width:1100},{signal})
    },
  }
}
