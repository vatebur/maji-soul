import{test}from'node:test';
import assert from'node:assert/strict';
import{waitForLiveOpening}from'../src/app/console/opening.ts';
import type{EgoPagePort}from'../src/adapters/majsoul/ego-transport.ts';
const page:EgoPagePort={evaluate:async()=>null};
const nativeLifecycleTrace=['authGame','enterGame'].flatMap((method,i)=>['request','response','response-forwarded'].map((phase,j)=>({method,phase,owner:'client',pageEpoch:1,observedMonoMs:i*10+j,accepted:phase==='request'?'unknown':true,...(method==='enterGame'&&phase!=='request'?{hasRestore:false}:{})})));
const ready={pageEpoch:1,gameUuid:'game',connected:true,authSummary:{},nativeLifecycleTrace,matchEnded:false,reason:'MATCH_CHANGED'};
test('new-match admission waits through empty and start-only restores for ActionNewRound',async()=>{
 let syncs=0;
 assert.equal(await waitForLiveOpening(page,'game',new AbortController().signal,async(_page,method)=>{
  if(method==='read')return ready;
  syncs++;
  if(syncs===1)return{game_restore:{actions:[]}};
  if(syncs===2)throw Error('SYNC_HISTORY_INCOMPLETE');
  return{gameUuid:'game',game_restore:{actions:[{name:'ActionMJStart'},{name:'ActionNewRound'}]}};
 }),true);
 assert.equal(syncs,3);
});
test('opening wait honors stop without creating or dispatching a game session',async()=>{
 const cancellation=new AbortController();const methods:string[]=[];
 assert.equal(await waitForLiveOpening(page,'game',cancellation.signal,async(_page,method)=>{
  methods.push(method);if(method==='read')return ready;
  cancellation.abort();return{game_restore:{actions:[]}};
 }),false);
 assert.deepEqual(methods,['read','sync']);
});
test('opening wait rejects a replaced game and an ended game',async()=>{
 for(const patch of [{gameUuid:'other'},{matchEnded:true}]){
  await assert.rejects(waitForLiveOpening(page,'game',new AbortController().signal,async()=>({...ready,...patch})),/OPENING_GAME_CHANGED|MATCH_ENDED_BEFORE_OPENING/);
 }
});
