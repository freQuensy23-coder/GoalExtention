const test = require('node:test');
const assert = require('node:assert/strict');
const {createService} = require('../src/background/goal-service.js');
const verdict = (overrides={}) => ({complete:false, reason:'Need tests', missing:['Run tests'], confidence:.95, needsReview:false,...overrides});
const turn=(index,role='assistant',text='answer',complete=true)=>({index,role,text,complete,id:`message-${index}`,artifacts:[]});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{resolve,promise};};
function harness(evaluate=async()=>verdict(),maxIterations=2) {
  const data={}; let id=0,requests=0;
  // Browser storage boundary is asynchronous and structured-clones values, unlike shared test dictionaries.
  const storage={get:async key=>structuredClone({[key]:data[key]}),set:async values=>{await new Promise(r=>setImmediate(r));Object.assign(data,structuredClone(values));},remove:async key=>{delete data[key];}};
  const service=createService({storage,getSettings:async()=>({maxIterations}),evaluate:async args=>{requests++;return evaluate(args)},randomId:()=>`lease-${++id}`});
  const send=(type,extra={},tab=1,thread='alpha')=>service.handleMessage({type,threadUrl:`https://chatgpt.com/c/${thread}`,...extra},{tab:{id:tab},frameId:0,url:`https://chatgpt.com/c/${thread}`});
  const anchor=turn(1,'user','/goal ship');
  return{service,send,anchor,requests:()=>requests,start:()=>send('CG_SET_GOAL',{objective:'ship',anchor}),judge:(transcript=[anchor,turn(2)])=>send('CG_EVALUATE',{transcript})};
}
test('requires an observed goal submission and a top-level authenticated extension sender',async()=>{
  const h=harness();await assert.rejects(h.send('CG_SET_GOAL',{objective:'ship',anchor:turn(1,'user','not a goal')}));
  await assert.rejects(h.service.handleMessage({type:'CG_GET_GOAL',threadUrl:'https://chatgpt.com/c/alpha'},{tab:{id:1},frameId:1,url:'https://chatgpt.com/c/alpha'}));
  await assert.rejects(h.service.handleMessage({type:'CG_GET_GOAL',threadUrl:'https://chatgpt.com/c/alpha'},{tab:{id:1},frameId:0,url:'https://evil.test/c/alpha'}));
});
test('no judging unfinished assistant, previous assistant after a user, or duplicate observed answer',async()=>{
  const h=harness(async()=>verdict({complete:true,missing:[]}));await h.start();
  await h.judge([h.anchor,turn(2,'assistant','partial',false)]);await h.judge([h.anchor,turn(2),turn(3,'user','new request')]);assert.equal(h.requests(),0);
  const result=await h.judge();assert.equal(result.goal.status,'complete');await h.judge();assert.equal(h.requests(),1);
});
test('incomplete evaluation reserves one send; only an echoed new user turn increments iterations',async()=>{
  const h=harness();await h.start();const r=await h.judge();assert.equal(r.goal.iteration,0);assert.equal(r.goal.pending.phase,'ready');
  await h.judge();assert.equal(h.requests(),1);
  await h.send('CG_CLAIM_SEND',{token:r.token});
  assert.equal((await h.send('CG_CLAIM_SEND',{token:r.token})).skipped,true);
  await assert.rejects(h.send('CG_SENT',{token:r.token,turn:turn(3,'user','wrong')}));
  const result=await h.send('CG_SENT',{token:r.token,turn:turn(3,'user',r.continuation)});
  assert.equal(result.goal.iteration,1);assert.equal(result.goal.pending,null);
  assert.equal((await h.send('CG_SENT',{token:r.token,turn:turn(3,'user',r.continuation)})).skipped,true);
});
test('full loop performs exactly N sends then blocks an incomplete goal',async()=>{
  const h=harness(undefined,2);await h.start();let transcript=[h.anchor];
  for(let n=0;n<2;n++){
    transcript.push(turn(n*2+2));const r=await h.judge(transcript);assert.equal(r.shouldContinue,true);
    await h.send('CG_CLAIM_SEND',{token:r.token});const sent=turn(n*2+3,'user',r.continuation);
    await h.send('CG_SENT',{token:r.token,turn:sent});transcript.push(sent);
  }
  transcript.push(turn(6));const r=await h.judge(transcript);assert.equal(r.goal.status,'blocked');assert.equal(r.goal.iteration,2);assert.equal(r.shouldContinue,false);
});
for(const action of ['CG_PAUSE_GOAL','CG_CLEAR_GOAL','CG_SET_GOAL']) test(`${action} wins over an in-flight evaluator result`,async()=>{
  const pending=deferred();const h=harness(()=>pending.promise);await h.start();const evaluating=h.judge();
  while(!h.requests())await new Promise(r=>setImmediate(r));
  await (action==='CG_SET_GOAL'?h.start():h.send(action));pending.resolve(verdict());
  assert.equal((await evaluating).skipped,true);const g=await h.service.read(1);
  assert.equal(g?.pending||null,null);assert.equal(g?.status||null,action==='CG_CLEAR_GOAL'?null:action==='CG_SET_GOAL'?'active':'paused');
});
test('concurrent checks acquire only one evaluator lease',async()=>{
  const p=deferred();const h=harness(()=>p.promise);await h.start();const a=h.judge(),b=h.judge();
  while(!h.requests())await new Promise(r=>setImmediate(r));p.resolve(verdict());
  const results=await Promise.all([a,b]);assert.equal(h.requests(),1);assert.equal(results.filter(r=>r.shouldContinue).length,1);
});
test('tab isolation and conversation navigation do not leak or overwrite goals',async()=>{
  const h=harness();await Promise.all([h.start(),h.send('CG_SET_GOAL',{objective:'ship',anchor:h.anchor},2,'beta')]);
  assert.equal((await h.send('CG_GET_GOAL',{},1,'beta')).goal,null);
  assert.equal((await h.service.read(2)).threadKey,'chatgpt:beta');await h.service.remove(1);assert.equal(await h.service.read(1),null);assert.ok(await h.service.read(2));
});
test('missing virtualized turns, branch changes and media-only output fail closed',async()=>{
  for(const kind of ['gap','branch','image']){
    const h=harness();await h.start();let transcript=[h.anchor,turn(2)];
    if(kind==='gap')transcript=[h.anchor,turn(4)];
    if(kind==='branch')transcript[0]={...h.anchor,id:'edited-branch'};
    if(kind==='image')transcript[1]={...turn(2,'assistant',''),artifacts:[{kind:'image',name:'diagram'}]};
    await h.judge(transcript);assert.equal(h.requests(),0);assert.ok(['paused','needs_review'].includes((await h.service.read(1)).status));
  }
});
test('API errors pause instead of repeatedly charging for failing requests',async()=>{
  const h=harness(async()=>{throw Error('private provider error')});await h.start();
  await h.judge();await h.judge();assert.equal(h.requests(),1);
  const g=await h.service.read(1);assert.equal(g.status,'paused');assert.doesNotMatch(g.lastError,/private provider error/);
});
test('failed acknowledgement pauses; explicit resume clears the dedupe marker',async()=>{
  const h=harness();await h.start();const r=await h.judge();await h.send('CG_CLAIM_SEND',{token:r.token});
  await h.send('CG_SEND_FAILED',{token:r.token});assert.equal((await h.service.read(1)).status,'paused');
  await h.send('CG_RESUME_GOAL');assert.equal((await h.service.read(1)).lastEvaluatedFingerprint,'');
});
