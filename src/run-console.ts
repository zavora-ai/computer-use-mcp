/**
 * Agent run console — a self-contained MCP App.
 *
 * Two panels: the conversation on the left, what the agent is looking at on the
 * right. The person watching sees the request, every line the agent says, the
 * plan with live task states, and the latest frame captured from the desktop.
 * They can also send a note mid-run, which reaches the agent on its next call.
 *
 * The console itself is generic: the same two panels serve an agent modelling in
 * Blender and one reading dashboards. Only the header names a use case, so it is
 * a parameter rather than a constant — see `runConsoleHtml`.
 *
 * Motion is deliberate and driven only by run state: a scan sweep and a pulsing
 * live badge while `working`, a fade when a new frame lands, nothing when idle.
 * All of it collapses under `prefers-reduced-motion`.
 *
 * Same posture as the session console: no network, no third-party assets, no
 * storage, and every value from the agent is written with `textContent`, never
 * interpolated as HTML. An agent that returns markup cannot inject it here.
 */

/** One segment of the byline under the agent's name. */
export type BrandCredit = string | { label: string; value: string }

/** What the console header says it is. Everything below the header is generic. */
export interface ConsoleBrand {
  /** The agent's name, in the header and the document title. */
  name?: string
  /** The stack line beneath it. A bare string is emphasised; a pair reads `label <b>value</b>`. */
  credits?: BrandCredit[]
}

/**
 * The Blender agent's branding, which is what the published console has always
 * shown. Kept as the default so existing hosts and their screenshots are
 * unaffected by the header becoming configurable.
 */
export const DEFAULT_BRAND: Required<ConsoleBrand> = {
  name: 'Blender Agent',
  credits: ['ADK Rust', 'Computer Use MCP', { label: 'running on', value: 'DeepSeek Flash' }],
}

/** The analytics agent's branding, for a host reading dashboards rather than modelling. */
export const ANALYTICS_BRAND: Required<ConsoleBrand> = {
  name: 'Analytics Agent',
  credits: ['ADK Rust', 'Business Intelligence MCP', { label: 'running on', value: 'DeepSeek Flash' }],
}

/**
 * Escape text destined for the header. A brand comes from the host operator
 * rather than a model, but it is the one string interpolated into this document
 * as markup, so it is escaped on the way in rather than trusted.
 */
function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderCredits(credits: BrandCredit[]): string {
  return credits
    .map(credit =>
      typeof credit === 'string'
        ? `<b>${escapeText(credit)}</b>`
        : `${escapeText(credit.label)} <b>${escapeText(credit.value)}</b>`,
    )
    .join(' · ')
}

/** Build the console app, named for whichever agent is reporting into it. */
export function runConsoleHtml(brand: ConsoleBrand = {}): string {
  const raw = brand.name ?? DEFAULT_BRAND.name
  const name = escapeText(raw)
  const credits = renderCredits(brand.credits ?? DEFAULT_BRAND.credits)
  // The identity the app announces itself under. Derived from the brand so one
  // use case never announces itself as another; `Blender Agent` still yields the
  // `blender-agent-run-console` this has always sent.
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
  return RUN_CONSOLE_TEMPLATE.replace(/__BRAND_NAME__/g, name)
    .replace('__BRAND_CREDITS__', credits)
    .replace('__BRAND_SLUG__', slug)
}

const RUN_CONSOLE_TEMPLATE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>__BRAND_NAME__</title><style>
:root{
  color-scheme:dark;
  --bg:#101215;--panel:#161a1f;--sunk:#0c0e11;--line:#262c34;
  --ink:#e8eaed;--dim:#8b95a3;--faint:#5d6875;
  --accent:#e87d0d;--accent-soft:#e87d0d24;
  --ok:#4ba566;--bad:#d9544d;--live:#f0873a;
  font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
}
*{box-sizing:border-box}
body{margin:0;height:100vh;overflow:hidden;background:var(--bg);color:var(--ink)}
#shell{display:grid;grid-template-columns:minmax(300px,378px) 1fr;grid-template-rows:auto minmax(0,1fr);height:100vh}

/* ── brand bar ─────────────────────────────────────────────── */
#brand{grid-column:1/3;display:flex;align-items:center;gap:13px;padding:13px 18px;
  border-bottom:1px solid var(--line);background:linear-gradient(180deg,#1a1f25,#141317)}
.mark{width:30px;height:30px;border-radius:50%;flex:none;position:relative;
  border:3px solid var(--accent);box-shadow:0 0 16px #e87d0d55}
.mark::after{content:"";position:absolute;inset:5px;border-radius:50%;background:var(--accent)}
body[data-busy] .mark{animation:spin 3.4s linear infinite}
.who{flex:1;min-width:0}
h1{font-size:15.5px;font-weight:650;margin:0;letter-spacing:.2px}
.stack{margin:1px 0 0;font-size:11.5px;color:var(--faint);letter-spacing:.35px}
.stack b{color:var(--dim);font-weight:550}
.live{display:flex;align-items:center;gap:7px;font-size:11.5px;letter-spacing:.9px;
  text-transform:uppercase;color:var(--dim);padding:5px 11px;border:1px solid var(--line);
  border-radius:999px;background:var(--sunk);white-space:nowrap}
.pip{width:7px;height:7px;border-radius:50%;background:var(--faint);flex:none}
body[data-busy] .pip{background:var(--live);animation:pulse 1.25s ease-in-out infinite}
body[data-state=done] .pip{background:var(--ok)}
body[data-state=failed] .pip{background:var(--bad)}
body[data-busy] .live{color:var(--live);border-color:#e87d0d44}
body[data-state=done] .live{color:var(--ok)}

/* ── left: conversation ────────────────────────────────────── */
#left{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line);background:var(--panel)}
h2{font-size:10.5px;text-transform:uppercase;letter-spacing:.13em;color:var(--faint);
  margin:0;padding:12px 18px 8px;font-weight:600}
#chat{flex:1;min-height:0;overflow-y:auto;padding:2px 18px 8px;display:flex;flex-direction:column;gap:9px;scroll-behavior:smooth}
.turn{max-width:92%;padding:8px 11px;border-radius:12px;font-size:13px;
  overflow-wrap:anywhere;white-space:pre-wrap;animation:rise .28s ease both}
.turn.user{align-self:flex-end;background:var(--accent);color:#1b1205;border-bottom-right-radius:4px;font-weight:500}
.turn.agent{align-self:flex-start;background:#1e242b;border:1px solid var(--line);border-bottom-left-radius:4px}
.at{display:block;margin-top:3px;font-size:10.5px;font-variant-numeric:tabular-nums;opacity:.55}
#typing{display:none;gap:4px;align-items:center;padding:0 18px 10px;color:var(--faint);font-size:11.5px}
body[data-busy] #typing{display:flex}
#typing i{width:5px;height:5px;border-radius:50%;background:var(--live);animation:bounce 1.05s ease-in-out infinite}
#typing i:nth-child(2){animation-delay:.16s}
#typing i:nth-child(3){animation-delay:.32s}
#typing span{margin-left:5px;letter-spacing:.06em}
/* Activity: everything the agent thought and every call it made. Capped so the
   conversation above it stays the main thing. */
#feed{flex:none;display:flex;flex-direction:column;min-height:0;max-height:32vh;
  border-top:1px solid var(--line);background:#0c0e11}
#feedhead{display:flex;align-items:center;gap:8px;padding:8px 18px 6px;flex:none}
#feedhead h2{margin:0;font-size:10.5px;letter-spacing:.11em;text-transform:uppercase;color:var(--faint)}
#feedcount{margin-left:auto;font-size:10.5px;color:var(--faint);font-variant-numeric:tabular-nums}
#fold{appearance:none;border:1px solid var(--line);background:transparent;color:var(--dim);
  border-radius:6px;font:inherit;font-size:10.5px;padding:1px 7px;cursor:pointer}
#acts{margin:0;padding:0 18px 10px;list-style:none;overflow-y:auto;min-height:0;
  display:flex;flex-direction:column;gap:5px}
body[data-folded] #acts,body[data-folded] #feedcount{display:none}
.act{display:grid;grid-template-columns:13px 1fr auto;gap:8px;align-items:baseline;font-size:11.5px;line-height:1.45}
.act .ic{color:var(--faint);font-size:10px}
.act .tx{overflow-wrap:anywhere;color:var(--dim)}
.act .ms{color:var(--faint);font-size:10.5px;font-variant-numeric:tabular-nums}
/* A thought is the model reasoning, so it reads as prose rather than a log line. */
.act.thought .tx{color:#9aa6b6;font-style:italic}
.act.tool .tx b{color:var(--text);font-weight:500;font-style:normal}
.act.result .tx{color:var(--faint)}
.act.failed .tx{color:var(--bad)}
/* An image the person attached, shown in the turn that carried it. */
.shot{margin-top:7px;border-radius:8px;border:1px solid var(--line);max-width:100%;
  max-height:150px;display:block;object-fit:contain;background:#000}
.file{margin-top:5px;font-size:10.5px;color:var(--faint);overflow-wrap:anywhere}
#composer{display:flex;gap:8px;padding:11px 14px;border-top:1px solid var(--line);background:var(--sunk);align-items:center}
#clip{appearance:none;flex:none;width:32px;height:32px;border:1px solid var(--line);border-radius:9px;
  background:var(--panel);color:var(--dim);cursor:pointer;font-size:15px;line-height:1;display:grid;place-items:center}
#clip:hover{color:var(--text);border-color:#3a424e}
#clip[data-has]{color:var(--accent);border-color:#e87d0d66}
#pick{display:none}
#chip{padding:0 18px 8px;margin:0;font-size:11px;color:var(--accent);display:none;overflow-wrap:anywhere}
#chip[data-on]{display:block}
#say{flex:1;min-width:0;padding:9px 12px;border-radius:9px;border:1px solid var(--line);
  background:#12151a;color:inherit;font:inherit;font-size:13px}
#say:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
#say::placeholder{color:var(--faint)}
button{padding:9px 15px;border-radius:9px;border:1px solid var(--line);background:#1e242b;
  color:var(--ink);font:inherit;font-size:13px;font-weight:550;cursor:pointer}
button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
button:disabled{opacity:.4;cursor:default}
#idle{display:none;margin:0;padding:0 18px 12px;font-size:12.5px;line-height:1.5;color:var(--faint)}
/* No run yet: render sets data-state, so its absence is the idle state. */
body:not([data-state]) #idle{display:block}
#thinking{display:none;padding:10px 4px 2px;font-size:12.5px;color:var(--faint)}
/* Before the agent has declared a plan there is nothing to list. */
body[data-state=planning] #thinking{display:block}
#composer-error{padding:0 18px 9px;margin:0;font-size:11.5px;color:var(--bad);display:none}

/* ── right: what it is looking at ──────────────────────────── */
#right{display:flex;flex-direction:column;min-height:0;padding:12px 16px 14px;gap:10px}
#stage{position:relative;flex:1;min-height:0;border:1px solid var(--line);border-radius:13px;
  background:var(--sunk) repeating-conic-gradient(#15181d 0 25%,#101317 0 50%) 0 0/22px 22px;
  overflow:hidden;transition:border-color .3s,box-shadow .3s}
body[data-busy] #stage{border-color:#e87d0d55;box-shadow:0 0 0 1px #e87d0d22,0 12px 42px #00000066}
#shot{width:100%;height:100%;object-fit:contain;display:none}
#shot.fresh{animation:land .55s cubic-bezier(.2,.7,.3,1) both}
#empty{position:absolute;inset:0;display:grid;place-items:center;color:var(--faint);font-size:12.5px;letter-spacing:.04em}
/* Scan sweep: reads as "being looked at", and only runs while working. */
#scan{position:absolute;inset:0;pointer-events:none;opacity:0;
  background:linear-gradient(180deg,#e87d0d00 0%,#e87d0d00 42%,#e87d0d26 50%,#e87d0d00 58%,#e87d0d00 100%)}
body[data-busy] #scan{opacity:1;animation:sweep 2.9s cubic-bezier(.45,0,.55,1) infinite}
#badge{position:absolute;top:10px;left:10px;display:none;align-items:center;gap:6px;
  padding:4px 9px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.14em;
  background:#0b0d10cc;color:var(--live);border:1px solid #e87d0d55;backdrop-filter:blur(3px)}
body[data-busy] #badge{display:flex}
#badge .pip{background:var(--live);animation:pulse 1.25s ease-in-out infinite}
#caption{margin:0;font-size:11.5px;color:var(--dim);min-height:1.4em;overflow-wrap:anywhere}

#plan{border:1px solid var(--line);border-radius:13px;background:var(--panel);
  padding:0 0 8px;max-height:44%;display:flex;flex-direction:column;min-height:0}
.planhead{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding-right:16px}
.planhead h2{padding:11px 16px 7px}
#counts{font-size:11.5px;color:var(--dim);font-variant-numeric:tabular-nums;white-space:nowrap}
#bar{height:3px;margin:0 16px 9px;border-radius:2px;background:#22282f;overflow:hidden}
#fill{height:100%;width:0;border-radius:2px;background:linear-gradient(90deg,#e87d0d,#f5a623);
  transition:width .45s cubic-bezier(.3,.8,.3,1)}
ol{list-style:none;margin:0;padding:0 12px;overflow-y:auto;min-height:0;display:grid;gap:4px}
li{display:grid;grid-template-columns:18px 1fr auto;gap:9px;align-items:baseline;
  padding:6px 8px;border-radius:8px;position:relative}
.mk{font-size:12px;text-align:center;line-height:1.4}
li[data-status=pending]{color:var(--faint)}
li[data-status=pending] .mk{color:var(--faint)}
li[data-status=done] .mk{color:var(--ok)}
li[data-status=failed] .mk{color:var(--bad)}
li[data-status=skipped]{color:var(--faint);text-decoration:line-through}
li[data-status=active]{background:var(--accent-soft);color:var(--ink);overflow:hidden}
li[data-status=active] .mk{color:var(--accent)}
li[data-status=active] .tt{font-weight:600}
/* A shimmer travelling across the active row: the one row that is moving. */
li[data-status=active]::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(100deg,#fff0 30%,#ffffff14 50%,#fff0 70%);animation:shimmer 1.9s linear infinite}
.tt{overflow-wrap:anywhere}
.nt{grid-column:2/4;font-size:11.5px;color:var(--dim);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.tm{font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}

@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes sweep{0%{transform:translateY(-100%)}100%{transform:translateY(100%)}}
@keyframes land{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}
@keyframes rise{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
@keyframes bounce{0%,100%{transform:translateY(0);opacity:.4}50%{transform:translateY(-4px);opacity:1}}
@keyframes shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}

@media (max-width:820px){
  body{overflow:auto}
  #shell{grid-template-columns:1fr;grid-template-rows:auto auto auto;height:auto}
  #brand{grid-column:1}
  #left{border-right:0;border-bottom:1px solid var(--line)}
  #chat{max-height:38vh}
  #stage{min-height:46vh}
  #plan{max-height:none}
}
@media (prefers-reduced-motion:reduce){
  *,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}
  body[data-state=working] #scan{opacity:.35}
}
</style></head><body data-state="planning">
<div id="shell">
  <header id="brand">
    <div class="mark" aria-hidden="true"></div>
    <div class="who">
      <h1>__BRAND_NAME__</h1>
      <p class="stack">__BRAND_CREDITS__</p>
    </div>
    <div class="live"><span class="pip" aria-hidden="true"></span><span id="state" role="status" aria-live="polite">connecting</span></div>
  </header>

  <section id="left" aria-label="Conversation">
    <h2>Conversation</h2>
    <div id="chat" role="log" aria-live="polite" aria-relevant="additions"></div>
    <div id="typing" aria-hidden="true"><i></i><i></i><i></i><span>agent is working</span></div>
    <p id="idle">Ask for something and the agent will plan it, work on your desktop, and show you each frame as it goes. Attach an image to give it a reference.</p>
    <section id="feed" aria-label="Agent activity">
      <div id="feedhead">
        <h2>Activity</h2>
        <span id="feedcount"></span>
        <button id="fold" type="button" aria-expanded="true">hide</button>
      </div>
      <ul id="acts" aria-live="polite" aria-relevant="additions"></ul>
    </section>
    <p id="chip"></p>
    <p id="composer-error" role="alert"></p>
    <form id="composer">
      <label class="sr" for="say" hidden>Message the agent</label>
      <input id="pick" type="file" accept="image/png,image/jpeg,image/webp,image/gif">
      <button id="clip" type="button" title="Attach an image" aria-label="Attach an image">+</button>
      <input id="say" placeholder="Ask the agent to build something…" maxlength="2000" autocomplete="off" disabled>
      <button id="send" type="submit" disabled>Send</button>
    </form>
  </section>

  <section id="right" aria-label="What the agent is looking at">
    <div id="stage">
      <img id="shot" alt="The most recent frame the agent captured from the desktop">
      <div id="empty">no frame captured yet</div>
      <div id="scan" aria-hidden="true"></div>
      <div id="badge" aria-hidden="true"><span class="pip"></span>live</div>
    </div>
    <p id="caption"></p>
    <div id="plan">
      <div class="planhead"><h2>Plan</h2><span id="counts"></span></div>
      <div id="bar"><div id="fill"></div></div>
      <ol id="tasks"></ol>
      <p id="thinking">working out the steps…</p>
    </div>
  </section>
</div>
<script>
let sequence=0,runId,hostOrigin,ready=false,shotAt='',chatSig='',actSig='',startedAt='',finished=false,attached=null;
const pending=new Map();
const el=id=>document.getElementById(id);
const clock=iso=>iso?String(iso).slice(11,19):'';
function send(message){parent.postMessage({jsonrpc:'2.0',...message},hostOrigin&&hostOrigin!=='null'?hostOrigin:'*')}
function rpc(method,params){return new Promise((resolve,reject)=>{const id=++sequence;const timeout=setTimeout(()=>{pending.delete(id);reject(Error('Host did not respond'))},10000);pending.set(id,{resolve,reject,timeout});send({id,method,params})})}
const MARK={pending:'○',active:'▶',done:'✓',failed:'✕',skipped:'–'};

/** Elapsed since the run began, ticking while it works. */
function tick(){
  if(!startedAt)return;
  const started=Date.parse(startedAt);
  if(Number.isNaN(started))return;
  const seconds=Math.max(0,Math.round(((finished?Date.parse(el('counts').dataset.until||startedAt):Date.now())-started)/1000));
  el('counts').dataset.elapsed=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
  paintCounts();
}
function paintCounts(){
  const counts=el('counts');
  const parts=[];
  if(counts.dataset.progress)parts.push(counts.dataset.progress);
  if(counts.dataset.elapsed)parts.push(counts.dataset.elapsed);
  counts.textContent=parts.join(' · ');
}

function drawChat(messages){
  // Rebuild only when the transcript actually changed, so animations do not
  // replay and the scroll position survives a poll that changed nothing.
  const signature=messages.map(m=>m.role+m.at+m.text.length+(m.attachment?'+'+m.attachment.name:'')).join('|');
  if(signature===chatSig)return;
  chatSig=signature;
  const chat=el('chat');
  const atBottom=chat.scrollHeight-chat.scrollTop-chat.clientHeight<60;
  chat.replaceChildren();
  let attachmentIndex=0;
  for(const message of messages){
    const turn=document.createElement('div');
    turn.className='turn '+(message.role==='user'?'user':'agent');
    const body=document.createElement('span');
    body.textContent=message.text;
    turn.append(body);
    if(message.attachment){
      // Served by the host from disk, so the run payload carries no image bytes.
      const shot=document.createElement('img');
      shot.className='shot';
      shot.src='/attachment/'+attachmentIndex;
      shot.alt=message.attachment.name;
      shot.addEventListener('load',()=>{if(atBottom)chat.scrollTop=chat.scrollHeight});
      const file=document.createElement('span');
      file.className='file';
      file.textContent=message.attachment.name+' · saved for the agent to open';
      turn.append(shot,file);
      attachmentIndex++;
    }
    const at=document.createElement('span');
    at.className='at';
    at.textContent=(message.role==='user'?'you':'agent')+' · '+clock(message.at);
    turn.append(at);
    chat.append(turn);
  }
  if(atBottom)chat.scrollTop=chat.scrollHeight;
}

function drawTasks(tasks){
  const list=el('tasks');
  list.replaceChildren();
  let active;
  for(const task of tasks){
    const item=document.createElement('li');
    item.dataset.status=task.status||'pending';
    const mark=document.createElement('span');mark.className='mk';mark.textContent=MARK[task.status]||'○';
    const title=document.createElement('span');title.className='tt';title.textContent=task.title||task.id;
    const when=document.createElement('span');when.className='tm';when.textContent=clock(task.at);
    item.append(mark,title,when);
    if(task.note){const note=document.createElement('span');note.className='nt';note.textContent=task.note;item.append(note)}
    list.append(item);
    if(task.status==='active')active=item;
  }
  // A long plan scrolls, so follow the step being worked on rather than the top.
  if(active)active.scrollIntoView({block:'nearest'});
}

function drawShot(screenshot){
  const shot=el('shot');
  if(screenshot&&screenshot.data){
    if(screenshot.at!==shotAt){
      shotAt=screenshot.at;
      shot.src='data:'+(screenshot.mimeType||'image/png')+';base64,'+screenshot.data;
      shot.classList.remove('fresh');
      void shot.offsetWidth;              // restart the fade for the new frame
      shot.classList.add('fresh');
    }
    shot.style.display='block';
    el('empty').style.display='none';
    el('caption').textContent=[screenshot.caption||'frame from this desktop',clock(screenshot.at)].filter(Boolean).join(' · ');
  }else{
    shot.style.display='none';
    el('empty').style.display='grid';
    el('caption').textContent='';
  }
}

function render(run){
  if(!run||!run.runId)return;
  runId=run.runId;
  startedAt=run.startedAt||startedAt;
  finished=run.state==='done'||run.state==='failed';
  document.body.dataset.state=run.state||'working';
  // Planning counts as busy: the agent is thinking, it just has nothing
  // to show yet, and a still screen reads as a hang.
  document.body.toggleAttribute('data-busy',run.state==='planning'||run.state==='working');
  el('state').textContent=run.state||'working';
  const tasks=Array.isArray(run.tasks)?run.tasks:[];
  const done=tasks.filter(t=>t.status==='done'||t.status==='skipped').length;
  const counts=el('counts');
  counts.dataset.progress=tasks.length?done+' of '+tasks.length:'';
  counts.dataset.until=run.updatedAt||'';
  el('fill').style.width=(tasks.length?Math.round(done/tasks.length*100):0)+'%';
  drawTasks(tasks);
  const messages=Array.isArray(run.messages)&&run.messages.length
    ?run.messages
    :[{role:'user',text:run.prompt||'(no prompt recorded)',at:run.startedAt}];
  drawChat(messages);
  drawActs(run.activity);
  drawShot(run.screenshot);
  el('say').disabled=!ready;
  el('send').disabled=!ready;
  tick();
}

function drawActs(activity){
  const list=Array.isArray(activity)?activity:[];
  const signature=list.length+'|'+(list[list.length-1]||{}).at;
  if(signature===actSig)return;
  actSig=signature;
  const acts=el('acts');
  const atBottom=acts.scrollHeight-acts.scrollTop-acts.clientHeight<70;
  acts.replaceChildren();
  for(const event of list){
    const row=document.createElement('li');
    row.className='act '+(event.kind||'')+(event.failed?' failed':'');
    const ic=document.createElement('span');
    ic.className='ic';
    ic.textContent=event.kind==='thought'?'\u25cb':event.kind==='tool'?'\u2192':'\u2190';
    const tx=document.createElement('span');
    tx.className='tx';
    if(event.name){
      // The tool name is the thing worth scanning for, so it leads and is bolder.
      const name=document.createElement('b');
      name.textContent=event.name;
      tx.append(name);
      if(event.detail)tx.append(document.createTextNode(' '+event.detail));
    }else{
      tx.textContent=event.detail||'';
    }
    const ms=document.createElement('span');
    ms.className='ms';
    ms.textContent=typeof event.ms==='number'?(event.ms>=1000?(event.ms/1000).toFixed(1)+'s':event.ms+'ms'):'';
    row.append(ic,tx,ms);
    acts.append(row);
  }
  el('feedcount').textContent=list.length?list.length+(list.length===1?' step':' steps'):'';
  if(atBottom)acts.scrollTop=acts.scrollHeight;
}

function showError(error){el('state').textContent='error';el('composer-error').style.display='block';el('composer-error').textContent=error.message||String(error)}
function valueOf(result){if(result.isError)throw Error(result.content?.[0]?.text||'Operation failed');return result.structuredContent||JSON.parse(result.content?.find(c=>c.type==='text')?.text||'{}')}
async function call(name,args){return valueOf(await rpc('tools/call',{name,arguments:args}))}
async function refresh(){if(runId)render(await call('run_console',{runId}))}

// Attaching: the file is read here and sent with the message. The host writes it
// to disk, which is what makes it openable by an application later.
el('clip').addEventListener('click',()=>el('pick').click());
el('pick').addEventListener('change',()=>{
  const file=el('pick').files&&el('pick').files[0];
  if(!file)return;
  const reader=new FileReader();
  reader.onerror=()=>showError(new Error('That file could not be read'));
  reader.onload=()=>{
    // A data URL is "data:<mime>;base64,<payload>"; the host wants the payload.
    const url=String(reader.result||'');
    const comma=url.indexOf(',');
    attached={name:file.name,mimeType:file.type,data:comma<0?'':url.slice(comma+1)};
    el('clip').dataset.has='';
    const chip=el('chip');
    chip.dataset.on='';
    chip.textContent='attached '+file.name+' — send to give the agent this reference';
  };
  reader.readAsDataURL(file);
});

function clearAttachment(){
  attached=null;
  el('pick').value='';
  delete el('clip').dataset.has;
  const chip=el('chip');
  delete chip.dataset.on;
  chip.textContent='';
}

el('composer').addEventListener('submit',event=>{
  event.preventDefault();
  const input=el('say');
  const text=input.value.trim();
  // A message may be the first thing that happens: with no run yet the host
  // opens one from this text, so do not require a runId to speak. An image on
  // its own is also a message — "look at this" needs no sentence.
  if(!text&&!attached)return;
  el('composer-error').style.display='none';
  input.disabled=true;el('send').disabled=true;
  const image=attached;
  call('run_say',{...(runId?{runId}:{}),text,role:'user',...(image?{image}:{})})
    .then(run=>{input.value='';clearAttachment();render(run)})
    .catch(showError)
    .finally(()=>{input.disabled=!ready;el('send').disabled=!ready;input.focus()});
});

// Folding the feed away, for when the conversation is what matters.
el('fold').addEventListener('click',()=>{
  const folded=document.body.toggleAttribute('data-folded');
  el('fold').textContent=folded?'show':'hide';
  el('fold').setAttribute('aria-expanded',folded?'false':'true');
});

window.addEventListener('message',event=>{
  if(event.source!==parent||!event.data||event.data.jsonrpc!=='2.0')return;
  if(hostOrigin&&event.origin!==hostOrigin)return;
  const message=event.data;
  if(message.id&&pending.has(message.id)){
    if(!hostOrigin)hostOrigin=event.origin;
    const p=pending.get(message.id);pending.delete(message.id);clearTimeout(p.timeout);
    message.error?p.reject(Error(message.error.message)):p.resolve(message.result);
  } else if(message.method==='ui/notifications/tool-result'){
    try{render(valueOf(message.params))}catch(e){showError(e)}
  } else if(message.method==='ui/resource-teardown'){
    send({id:message.id,result:{}});
  }
});

setInterval(tick,1000);
rpc('ui/initialize',{appInfo:{name:'__BRAND_SLUG__-run-console',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'})
  .then(()=>{ready=true;send({method:'ui/notifications/initialized',params:{}});el('state').textContent='ready';el('say').disabled=false;el('send').disabled=false;if(runId)refresh().catch(showError)})
  .catch(showError);
</script></body></html>`

/**
 * The console as it has always shipped, branded for the Blender agent. Hosts that
 * want a different name call `runConsoleHtml` instead; nothing else differs.
 */
export const RUN_CONSOLE_HTML = runConsoleHtml()
