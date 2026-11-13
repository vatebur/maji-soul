import{test}from'node:test';
import assert from'node:assert/strict';
import{waitForLiveOpening,openingTableVisible}from'../src/app/console/opening.ts';
import type{EgoPagePort}from'../src/adapters/majsoul/ego-transport.ts';
import{readFileSync}from'node:fs';
import{png}from'./countdown-helpers.ts';
const page:EgoPagePort={evaluate:async()=>null};
const nativeLifecycleTrace=['authGame','enterGame'].flatMap((method,i)=>['request','response','response-forwarded'].map((phase,j)=>({method,phase,owner:'client',pageEpoch:1,observedMonoMs:i*10+j,accepted:phase==='request'?'unknown':true,...(method==='enterGame'&&phase!=='request'?{hasRestore:false}:{})})));
const ready={pageEpoch:1,generation:0,nativeRestoreRevision:0,controlEpoch:0,paused:true,executorActive:false,
 gameUuid:'game',connected:true,authSummary:{},nativeLifecycleTrace,matchEnded:false,reason:'MATCH_CHANGED'};
test('new-match admission waits through empty and start-only restores for ActionNewRound',async()=>{
 let syncs=0;
 assert.equal(await waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>{
  if(method==='read')return ready;
  syncs++;
  if(syncs===1)return{gameUuid:'game',game_restore:{actions:[]}};
  if(syncs===2)throw Error('SYNC_HISTORY_INCOMPLETE');
  return{gameUuid:'game',game_restore:{actions:[{name:'ActionMJStart'},{name:'ActionNewRound'}]}};
 },60_000,async()=>true),true);
 assert.equal(syncs,3);
});
test('opening wait honors stop without creating or dispatching a game session',async()=>{
 const cancellation=new AbortController();const methods:string[]=[];
 assert.equal(await waitForLiveOpening(page,'game',cancellation.signal,async(_page,method)=>{
  methods.push(method);if(method==='read')return ready;
  cancellation.abort();return{gameUuid:'game',game_restore:{actions:[]}};
 }),false);
 assert.deepEqual(methods,['read','sync']);
});
test('cancellation during the initial opening read cannot issue a synchronizing RPC',async()=>{
 const cancellation=new AbortController();const methods:string[]=[];
 assert.equal(await waitForLiveOpening(page,'game',cancellation.signal,async(_page,method)=>{
  methods.push(method);cancellation.abort();return ready;
 }),false);
 assert.deepEqual(methods,['read']);
});
test('a positive table image that arrives after the opening deadline cannot admit a worker',async t=>{
 let now=0;t.mock.method(performance,'now',()=>now);
 await assert.rejects(waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>
  method==='read'?ready:{gameUuid:'game',game_restore:{actions:[{name:'ActionNewRound'}]}},50,async()=>{now=51;return true;}),/GAME_OPENING_TIMEOUT/);
});
test('opening wait rejects a replaced game and an ended game',async()=>{
 for(const patch of [{gameUuid:'other'},{matchEnded:true}]){
  await assert.rejects(waitForLiveOpening(page,'game',new AbortController().signal,async()=>({...ready,...patch})),/OPENING_GAME_CHANGED|MATCH_ENDED_BEFORE_OPENING/);
 }
});
test('native restore and a complete hand cannot admit a worker before Unity table pixels settle',async()=>{
 let frames=0,reads=0;
 assert.equal(await waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>{
  if(method==='read'){reads++;return ready;}
  return{gameUuid:'game',game_restore:{actions:[{name:'ActionNewRound'}]}};
 },2000,async()=>++frames===3),true);
 assert.equal(frames,3);assert.equal(reads,4);
});
test('table admission rejects page or game changes during capture and respects cancellation after a visible image',async()=>{
 for(const mode of ['game','epoch','cancel']as const){
  let captured=false;const stop=new AbortController();
  const run=waitForLiveOpening(page,'game',stop.signal,async(_page,method)=>{
   if(method==='sync')return{gameUuid:'game',game_restore:{actions:[{name:'ActionNewRound'}]}};
   return{...ready,generation:1,...(captured?mode==='game'?{gameUuid:'other'}:mode==='epoch'?{pageEpoch:2}:{}:{})};
  },2000,async()=>{captured=true;if(mode==='cancel')stop.abort();return true;});
  if(mode==='cancel')assert.equal(await run,false);
  else await assert.rejects(run,/OPENING_GAME_CHANGED|OPENING_PAGE_UNTRUSTED/);
 }
});
test('normal generation or native restore advancement discards the first image and admits only a new stable sample',async()=>{
 for(const field of ['generation','nativeRestoreRevision']as const){
  let revision=0,frames=0,reads=0,syncs=0;
  assert.equal(await waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>{
   if(method==='read'){
    reads++;
    // A restore request may still be in flight immediately after capture. The
    // next complete cycle must be observed before another sync/image attempt.
    return{...ready,[field]:revision,...(field==='nativeRestoreRevision'&&reads===2?{nativeLifecycleTrace:[]}:{} )};
   }
   assert.equal(method,'sync');syncs++;return{gameUuid:'game',game_restore:{actions:[{name:'ActionNewRound'}]}};
  },2000,async()=>{if(++frames===1)revision++;return true;}),true);
  assert.equal(frames,2);assert.equal(reads,4);assert.equal(syncs,2);
 }
});
test('continuous table advancement reaches the original deadline without admitting or sending an action',async t=>{
 let now=0,generation=0,frames=0;t.mock.method(performance,'now',()=>now);
 const methods:string[]=[];
 await assert.rejects(waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>{
  methods.push(method);
  return method==='read'?{...ready,generation}:{gameUuid:'game',game_restore:{actions:[{name:'ActionNewRound'}]}};
 },60_000,async()=>{frames++;generation++;now+=20_000;return true;}),/GAME_OPENING_TIMEOUT/);
 assert.equal(frames,3);assert.equal(now,60_000);
 assert.deepEqual(methods,['read','sync','read','read','sync','read','read','sync','read']);
});
test('stop interrupts the resample wait after normal advancement without another sync or capture',async()=>{
 let generation=0,frames=0;const stop=new AbortController(),methods:string[]=[];
 const result=await waitForLiveOpening(page,'game',stop.signal,async(_page,method)=>{
  methods.push(method);return method==='read'?{...ready,generation}:{gameUuid:'game',game_restore:{actions:[{name:'ActionNewRound'}]}};
 },2000,async()=>{frames++;generation++;setTimeout(()=>stop.abort(),5);return true;});
 assert.equal(result,false);assert.equal(frames,1);assert.deepEqual(methods,['read','sync','read']);
});
test('resampling cannot migrate to another page or accept counters that move backwards',async()=>{
 for(const mode of ['next-page','generation-backwards','revision-backwards']as const){
  let frames=0,reads=0;
  await assert.rejects(waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>{
   if(method==='sync')return{gameUuid:'game',game_restore:{actions:[{name:'ActionNewRound'}]}};
   reads++;
   return{...ready,generation:mode==='generation-backwards'&&frames?0:1,nativeRestoreRevision:mode==='revision-backwards'&&frames?0:1,
    ...(mode==='next-page'&&reads===2?{generation:2}:{}),...(mode==='next-page'&&reads>2?{pageEpoch:2}:{} )};
  },2000,async()=>{frames++;return true;}),/OPENING_PAGE_UNTRUSTED/);
  assert.equal(frames,1);
 }
});
test('real Linux public table anchors admit the rendered table while loading and unknown screens wait',async()=>{
 const fixture=JSON.parse(readFileSync('tests/fixtures/auto-win/linux-glyph.json','utf8'));
 const image={width:fixture.width,height:fixture.height,rgba:new Uint8Array(fixture.width*fixture.height*4)};
 const capture:EgoPagePort={evaluate:async()=>null,cdp:async()=>({data:png(image)})};
 assert.equal(await openingTableVisible(capture),false);
 for(const a of fixture.anchors)image.rgba.set(a.rgba,(a.y*image.width+a.x)*4);
 assert.equal(await openingTableVisible(capture),true);
 const a=fixture.anchors[0];image.rgba.set([0,0,0,255],(a.y*image.width+a.x)*4);
 assert.equal(await openingTableVisible(capture),false);
 await assert.rejects(waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>
  method==='read'?ready:{gameUuid:'game',game_restore:{actions:[{name:'ActionNewRound'}]}},0,async()=>false),/GAME_OPENING_TIMEOUT/);
});
test('an opening cannot sync or admit across an active, missing or invalid executor scope',async()=>{
 const invalid=[{paused:false},{paused:undefined},{executorActive:true},{executorActive:undefined},{controlEpoch:1},{controlEpoch:undefined},
  ...['pageEpoch','generation','nativeRestoreRevision'].flatMap(field=>[undefined,-1,.5,Number.NaN,Number.MAX_SAFE_INTEGER+1].map(value=>({[field]:value}))),
  {pageEpoch:0}];
 for(const patch of invalid){
  let syncs=0;
  await assert.rejects(waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>{
   if(method==='sync')syncs++;
   return{...ready,...patch};
  },2000,async()=>true),/OPENING_PAGE_UNTRUSTED/);
  assert.equal(syncs,0,'unsafe scope must be rejected before sync can pause another actor');
  let captured=false;
  await assert.rejects(waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>{
   if(method==='sync')return{gameUuid:'game',game_restore:{actions:[{name:'ActionNewRound'}]}};
   return{...ready,...(captured?patch:{})};
  },2000,async()=>{captured=true;return true;}),/OPENING_PAGE_UNTRUSTED/);
 }
});
test('a sync response missing its match identity cannot admit a worker from an unrelated complete hand',async()=>{
 for(const gameUuid of [undefined,'other']){
  let samples=0;
  await assert.rejects(waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>
   method==='read'?ready:{gameUuid,game_restore:{actions:[{name:'ActionNewRound'}]}},2000,async()=>{samples++;return true;}),/OPENING_GAME_CHANGED/);
  assert.equal(samples,0);
 }
});

test('a notice arriving during admission is dismissed before resampling native restore and table proof',async()=>{
 let checks=0,syncs=0,frames=0,reads=0,dismissed=false;
 assert.equal(await waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>{
  if(method==='read'){reads++;return {...ready,generation:dismissed?2:1};}
  syncs++;assert.equal(dismissed,true);return{gameUuid:'game',game_restore:{actions:[{name:'ActionNewRound'}]}};
 },2000,async()=>{frames++;return true;},async()=>{checks++;dismissed=true;return true;}),true);
 assert.equal(checks,1);assert.equal(syncs,1);assert.equal(frames,1);assert.equal(reads,3);
});

test('opening notice handling never runs under another executor and cannot migrate after dismissal',async()=>{
 let clicks=0;
 await assert.rejects(waitForLiveOpening(page,'game',new AbortController().signal,async()=>({...ready,executorActive:true}),
  2000,async()=>true,async()=>{clicks++;return true;}),/OPENING_PAGE_UNTRUSTED/);
 assert.equal(clicks,0);
 await assert.rejects(waitForLiveOpening(page,'game',new AbortController().signal,async()=>({...ready,gameUuid:clicks?'other':'game'}),
  2000,async()=>true,async()=>{clicks++;return true;}),/OPENING_GAME_CHANGED/);
 assert.equal(clicks,1);
});
