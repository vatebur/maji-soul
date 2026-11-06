import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {digest} from '../../src/domain/game/value.ts';
import {handSourceStream} from '../../src/adapters/majsoul/sync.ts';
import {legalOperationActions} from '../../src/adapters/majsoul/actions.ts';
import {closedShanten,pageScope,readUiCheckpoint,readUiProgress,assertCheckpointCurrent,chooseUiAction,
  planUiAction,assertUiPlanCurrent,createUiLatch,claimUiWindow,noteUiPointerOutcome,
  readUiDiscardAuthority,reconcileUiWindow} from './ui-validation-driver.mjs';

const clone=value=>structuredClone(value),now=1_000_000;
const tiles=['1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','1p','2z','2z','9s'];
function scenario({codes=tiles,ownSeat=2,operations=[{type:1,combination:[]}],reaction=false}={}) {
  const page={pageEpoch:3,sourceStream:2,generation:10,lastStep:8,controlEpoch:5,nativeRestoreRevision:4,
    gameUuid:'private-test-match',handSha256:'a'.repeat(64),ownSeat,paused:true,connected:true,freshConnection:true,
    reason:null,overflow:false,queued:0,phase2ActionsEnabled:false,handEnded:false,matchEnded:false,
    stats:{bridgeActionSends:0,clientRequests:7},operation:{step:8,value:{seat:ownSeat,operation_list:operations}},
    autoWin:{state:'enabled',pageEpoch:3,generation:10,step:8,nativeRestoreRevision:4,rgbaSha256:'b'.repeat(64),expiresInMs:900},
    lastAutoWinReadback:{state:'enabled',pageEpoch:3,sourceStream:2,generation:10,step:8,nativeRestoreRevision:4,rgbaSha256:'b'.repeat(64)}};
  const gameMatchKey=`game-${digest(page.gameUuid).slice(0,32)}`,gameHandKey=`hand-${digest([gameMatchKey,page.handSha256]).slice(0,32)}`;
  const sourceCursor=`${handSourceStream(gameMatchKey,gameHandKey)}:${page.lastStep}`;
  const players=Object.fromEntries([0,1,2,3].map(seat=>[seat,{seat,score:25000,river:[],melds:[],riichi:'none',concealedCount:{known:true,value:seat===ownSeat?codes.length:13}}]));
  const state={sessionId:'test-main-session',matchId:'test-match',handId:'test-hand',connectionEpoch:2,stateVersion:20,trust:'trusted',trustIssues:[],
    ownSeat,players,ownConcealed:codes.map((code,i)=>({instanceId:`physical-${i}`,code})),
    drawnTileRef:{known:true,value:reaction?null:`physical-${codes.length-1}`},currentActor:reaction?{known:false,reason:'BETWEEN_ACTIONS'}:{known:true,value:ownSeat},
    dealer:0,roundWind:'1z',seatWind:'3z',handNumber:1,honba:0,riichiSticks:0,doraIndicators:['1s'],doraTiles:['2s'],tilesRemaining:{known:true,value:60},unknownFields:[]};
  if(reaction){
    const other=(ownSeat+3)%4;players[other].river.push({tile:'2m',eventId:'public-discard',tsumogiri:true,riichiDeclaration:false});
    state.latestAction={kind:'discard',actor:other,eventId:'public-discard',tiles:['2m'],tsumogiri:{known:true,value:true},origin:'unknown'};
  }
  state.operationWindow={id:'test-window',connectionEpoch:2,status:'open',deadline:{known:false,reason:'READ_ONLY'},
    candidates:legalOperationActions(state,page.operation.value,'test-window','test-evidence')};
  const checkpoint={sessionId:state.sessionId,sequence:12,connectionEpoch:2,gameMatchKey,gameHandKey,sourceCursor,
    handStatus:'playing',matchStatus:'playing',matchEndPending:false,recoveryRequired:false,unresolvedAttempts:0,state};
  return {checkpoint,page};
}
function visualFor(choice,page) {
  const base={clientVersion:'4.0.51',width:2036,height:918,devicePixelRatio:1,layoutVerified:true,
    rgbaSha256:'c'.repeat(64),observedAtMs:now,scope:pageScope(page)};
  if(choice.kind==='skip')return {...base,kind:'verified-skip-button',label:'skip',selectedBinding:{x:1302,y:700,pngSha256:base.rgbaSha256}};
  const drawn=choice.action.tsumogiri,slot=drawn?13:0;
  return {...base,kind:'verified-selected-tile',selectedBinding:{code:choice.tileCode,drawn,slot,x:slot===13?1504:430.5,y:850,pngSha256:base.rgbaSha256}};
}
function planned(input=scenario()) {
  const {checkpoint,page}=input,choice=chooseUiAction(checkpoint,page),visual=visualFor(choice,page);
  const plan=planUiAction({checkpoint,pageState:page,choice,visual,nowMs:now});
  return {...input,choice,visual,plan,current:{checkpoint,pageState:page,nowMs:now+100}};
}
function authorityFor(plan) {
  return {sessionId:plan.sessionId,gameMatchKey:plan.gameMatchKey,gameHandKey:plan.gameHandKey,sourceCursor:plan.expectedSourceCursor,
    kind:'discard',actor:plan.ownSeat,tiles:[plan.tileCode],tsumogiri:{known:true,value:plan.action.tsumogiri},riichiDeclaration:false};
}
function advanced(f) {
  const checkpoint=clone(f.checkpoint),page=clone(f.page);page.lastStep+=3;page.generation+=3;
  checkpoint.sequence+=4;checkpoint.sourceCursor=`${handSourceStream(checkpoint.gameMatchKey,checkpoint.gameHandKey)}:${page.lastStep}`;
  return {checkpoint,pageState:page};
}

test('closed shanten covers standard, seven pairs and thirteen orphans including red identities',()=>{
  const standard=['1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','2p','3p','1z'];
  assert.equal(closedShanten(standard).standard,0);assert.equal(closedShanten([...standard,'1z']).minimum,-1);
  const seven=['1m','1m','2p','2p','3s','3s','1z','1z','2z','2z','3z','3z','4z'];
  assert.equal(closedShanten(seven).sevenPairs,0);assert.equal(closedShanten([...seven,'4z']).minimum,-1);
  const orphan=['1m','9m','1p','9p','1s','9s','1z','2z','3z','4z','5z','6z','7z'];
  assert.equal(closedShanten(orphan).thirteenOrphans,0);assert.equal(closedShanten([...orphan,'1m']).minimum,-1);
  const quad=['1m','1m','1m','1m','2p','2p','3s','3s','1z','1z','2z','2z','3z'];
  assert.equal(closedShanten(quad).sevenPairs,2);
  const red=standard.map(t=>t==='5m'?'5mr':t);assert.deepEqual(closedShanten(red),closedShanten(standard));
  assert.throws(()=>closedShanten([...quad,'1m']),/UI_TILE_MULTIPLICITY/);
  assert.throws(()=>closedShanten(['??',...standard.slice(1)]),/UI_TILE_INVALID/);
});

// A separate whole-hand DFS checks the suit-profile implementation on varied
// synthetic shapes. Neither implementation reads a browser or live database.
function referenceStandard(input) {
  let best=8;
  function walk(counts,m,t,p){
    const i=counts.findIndex(n=>n>0);
    if(i<0){best=Math.min(best,8-2*m-Math.min(t,4-m)-p);return;}
    const branch=(removed,dm,dt,dp)=>{if(m+dm>4||p+dp>1)return;for(const j of removed)counts[j]--;walk(counts,m+dm,t+dt,p+dp);for(const j of removed)counts[j]++;};
    branch([i],0,0,0);
    if(counts[i]>=3)branch([i,i,i],1,0,0);
    if(counts[i]>=2){branch([i,i],0,1,0);branch([i,i],0,0,1);}
    if(i<27){
      if(i%9<7&&counts[i+1]&&counts[i+2])branch([i,i+1,i+2],1,0,0);
      if(i%9<8&&counts[i+1])branch([i,i+1],0,1,0);
      if(i%9<7&&counts[i+2])branch([i,i+2],0,1,0);
    }
  }
  walk([...input],0,0,0);return best;
}
test('shanten agrees with independent whole-hand decomposition on deterministic random hands',()=>{
  let seed=713;
  for(let sample=0;sample<60;sample++){
    const counts=Array(34).fill(0),codes=[];
    while(codes.length<13+sample%2){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const i=seed%34;if(counts[i]>=4)continue;counts[i]++;codes.push(i<27?`${i%9+1}${'mps'[Math.floor(i/9)]}`:`${i-26}z`);}
    assert.equal(closedShanten(codes).standard,referenceStandard(counts));
  }
});

test('ranking uses only current legal ordinary discards, preserves red and drawn identity, and is deterministic',()=>{
  const f=scenario(),choice=chooseUiAction(f.checkpoint,f.page);
  assert.equal(choice.kind,'discard');assert.equal(choice.tileCode,'9s');assert.equal(choice.action.tsumogiri,true);
  assert.equal(choice.shanten,0);assert.equal(choice.ukeireUpperBound,4);
  assert.deepEqual(chooseUiAction(f.checkpoint,f.page),choice);
  const codes=['5m','5mr',...tiles.filter(t=>t!=='5m').slice(0,12)];
  const prohibited=[...new Set(codes.filter(t=>!t.startsWith('5m')))];
  const red=scenario({codes,operations:[{type:1,combination:prohibited},{type:7,combination:['5m','0m']}]});
  const keepRed=chooseUiAction(red.checkpoint,red.page);
  assert.equal(keepRed.tileCode,'5m');assert.equal(keepRed.action.kind,'discard');assert.equal(keepRed.ranking.length,2);
  const copies=scenario({codes:[...tiles.slice(0,13),'1p'],operations:[{type:1,combination:[...new Set(tiles.filter(t=>t!=='1p'))]}]});
  const drawn=chooseUiAction(copies.checkpoint,copies.page);assert.equal(drawn.action.tile,'physical-13');assert.equal(drawn.action.tsumogiri,true);
});

test('only 2/3/5 reaction offers select skip; win offers and prior native win never select input',()=>{
  for(const [type,owned,combination]of [[2,['3m','4m'],'3m|4m'],[3,['2m','2m'],'2m|2m'],[5,['2m','2m','2m'],'2m|2m|2m']]){
    const f=scenario({reaction:true,codes:[...owned,...['1p','2p','3p','4p','5p','6p','7p','8p','9p','1s','2s'].slice(0,13-owned.length)],operations:[{type,combination:[combination]}]});
    assert.equal(chooseUiAction(f.checkpoint,f.page).kind,'skip');
    f.page.operation.value.operation_list.push({type:9,combination:[]});
    assert.deepEqual(chooseUiAction(f.checkpoint,f.page),{kind:'wait',code:'CLIENT_AUTO_WIN_WINDOW'});
  }
  const f=scenario();f.page.operation.value.operation_list.push({type:8});
  assert.equal(chooseUiAction(null,f.page).code,'CLIENT_AUTO_WIN_WINDOW');
  f.page.operation.value.operation_list.pop();f.page.lastClientWin={pageEpoch:f.page.pageEpoch,sourceStream:f.page.sourceStream};
  assert.equal(chooseUiAction(f.checkpoint,f.page).code,'UI_CLIENT_WIN_IN_FLIGHT');
});

test('runtime own seat, source identity, committed window and strict candidate membership are mandatory',()=>{
  const f=scenario();assert.equal(f.checkpoint.state.ownSeat,2);assertCheckpointCurrent(f.checkpoint,f.page);
  for(const mutate of [p=>p.ownSeat=0,p=>p.operation.value.seat=0,p=>p.handSha256='d'.repeat(64),p=>p.gameUuid='other-match',p=>p.lastStep++,p=>p.queued=1,p=>p.paused=false,p=>p.phase2ActionsEnabled=true]){
    const page=clone(f.page);mutate(page);assert.throws(()=>chooseUiAction(f.checkpoint,page));
  }
  for(const mutate of [c=>c.unresolvedAttempts=1,c=>c.recoveryRequired=true,c=>c.state.trust='syncing',c=>c.state.operationWindow.status='closed',c=>c.state.operationWindow.candidates[0].action.tsumogiri=true]){
    const checkpoint=clone(f.checkpoint);mutate(checkpoint);assert.throws(()=>chooseUiAction(checkpoint,f.page));
  }
});

test('selected pixel binding must prove exact red/code and drawn slot; no complete hand order is invented',()=>{
  const f=planned();assert.deepEqual(f.plan.point,{x:1504,y:850});assert.equal(f.plan.ownSeat,2);
  for(const mutate of [v=>v.selectedBinding.code='5mr',v=>v.selectedBinding.drawn=false,v=>v.selectedBinding.slot=0,v=>v.selectedBinding.x=430.5,
    v=>v.selectedBinding.pngSha256='d'.repeat(64),v=>v.width=1920,v=>v.layoutVerified=false,v=>v.scope.sourceStream++,v=>v.observedAtMs=now-1001]){
    const visual=clone(f.visual);mutate(visual);assert.throws(()=>planUiAction({checkpoint:f.checkpoint,pageState:f.page,choice:f.choice,visual,nowMs:now}));
  }
  const unknown=clone(f.page);unknown.autoWin=null;assert.throws(()=>planUiAction({checkpoint:f.checkpoint,pageState:unknown,choice:f.choice,visual:f.visual,nowMs:now}),/UI_FRESH_AUTO_WIN_PROOF_REQUIRED/);
  const badChoice=clone(f.choice);badChoice.action.tile='physical-0';assert.throws(()=>planUiAction({checkpoint:f.checkpoint,pageState:f.page,choice:badChoice,visual:f.visual,nowMs:now}),/UI_CHOICE_CHANGED/);
});

test('the final guard rejects every scope change, stale images/proofs, altered plans and new win offers',()=>{
  const f=planned();assert.equal(assertUiPlanCurrent(f.plan,f.current),true);
  for(const key of ['pageEpoch','sourceStream','generation','lastStep','controlEpoch','nativeRestoreRevision']){
    const page=clone(f.page);page[key]++;assert.throws(()=>assertUiPlanCurrent(f.plan,{...f.current,pageState:page}));
  }
  const staleProof=clone(f.page);staleProof.autoWin.expiresInMs=0;assert.throws(()=>assertUiPlanCurrent(f.plan,{...f.current,pageState:staleProof}));
  assert.throws(()=>assertUiPlanCurrent(f.plan,{...f.current,nowMs:now+750}),/UI_PLAN_STALE/);
  const forged=clone(f.plan);forged.point.x=100;assert.throws(()=>assertUiPlanCurrent(forged,f.current),/UI_PLAN_CHANGED/);
  for(const [key,value]of [['ownSeat',0],['gameMatchKey','other-match'],['gameHandKey','other-hand'],['sourceCursor','other:8'],
    ['expectedSourceCursor','other:9'],['sequence',f.plan.sequence+1]]){
    const tampered=clone(f.plan);tampered[key]=value;assert.throws(()=>assertUiPlanCurrent(tampered,f.current),/UI_PLAN_STALE/);
  }
  const winning=clone(f.page);winning.operation.value.operation_list.push({type:8});assert.throws(()=>assertUiPlanCurrent(f.plan,{...f.current,pageState:winning}),/CLIENT_AUTO_WIN_WINDOW/);
});

test('one reservation per window survives restart/reconnect and uncertain input never retries',()=>{
  const f=planned(),reserved=claimUiWindow(createUiLatch(),f.plan,f.current);
  assert.throws(()=>claimUiWindow(reserved,f.plan,f.current),/UI_INPUT_PENDING/);
  assert.throws(()=>claimUiWindow(createUiLatch(reserved.consumedWindowKeys),f.plan,f.current),/UI_WINDOW_ALREADY_ATTEMPTED/);
  const another=scenario();another.checkpoint.sessionId='replacement-session';another.checkpoint.state.sessionId='replacement-session';
  const replacement=planned(another);assert.equal(replacement.plan.windowKey,f.plan.windowKey);
  assert.throws(()=>claimUiWindow(createUiLatch(reserved.consumedWindowKeys),replacement.plan,replacement.current),/UI_WINDOW_ALREADY_ATTEMPTED/);
  for(const outcome of ['not-started','uncertain']){
    const state=noteUiPointerOutcome(reserved,outcome);assert.equal(state.halted,true);
    assert.throws(()=>reconcileUiWindow(state,{...advanced(f),authority:authorityFor(f.plan)}),/UI_INPUT_NOT_RECONCILABLE/);
  }
  const released=noteUiPointerOutcome(reserved,'released');assert.equal(released.halted,false);
  assert.equal(reconcileUiWindow(released,{checkpoint:f.checkpoint,pageState:f.page}).status,'awaiting-authority');
  assert.equal(reconcileUiWindow(released,advanced(f)).status,'awaiting-authority');
  const confirmed=reconcileUiWindow(released,{...advanced(f),authority:authorityFor(f.plan)});
  assert.equal(confirmed.status,'discard-observed');assert.equal(confirmed.latch.pending,null);assert.deepEqual(confirmed.latch.consumedWindowKeys,reserved.consumedWindowKeys);
});

test('authority mismatch, reconnect and same-step new hand do not release a pending gesture',()=>{
  const f=planned(),latch=noteUiPointerOutcome(claimUiWindow(createUiLatch(),f.plan,f.current),'released');
  for(const mutate of [a=>a.tiles=['5mr'],a=>a.actor=0,a=>a.tsumogiri.value=false,a=>a.riichiDeclaration=true,a=>a.sourceCursor+='0',a=>a.sessionId='another-session']){
    const authority=authorityFor(f.plan);mutate(authority);const result=reconcileUiWindow(latch,{...advanced(f),authority});
    assert.equal(result.status,'authority-mismatch');assert.equal(result.latch.halted,true);assert.ok(result.latch.pending);
  }
  const reconnected=advanced(f);reconnected.pageState.pageEpoch++;assert.equal(reconcileUiWindow(latch,reconnected).status,'scope-changed');
  const newHand=advanced(f);newHand.checkpoint.gameHandKey='next-hand';newHand.pageState.lastStep=f.page.lastStep;newHand.pageState.sourceStream++;
  assert.equal(reconcileUiWindow(latch,newHand).status,'scope-changed');
  const notReady=advanced(f);notReady.pageState.reason='DISCONNECTED';
  assert.equal(reconcileUiWindow(latch,{...notReady,authority:authorityFor(f.plan)}).status,'observer-not-ready');
});

test('skip is audited as a window advance, never an authoritative discard or a program send',()=>{
  const f=planned(scenario({reaction:true,codes:['3m','4m','1p','2p','3p','4p','5p','6p','7p','8p','9p','1s','2s'],operations:[{type:2,combination:['3m|4m']}]}));
  assert.equal(f.plan.kind,'skip');assert.equal(f.plan.executionKind,'private-ui-input');assert.equal(f.plan.expectedSourceCursor,undefined);
  const forged=clone(f.plan);forged.expectedSourceCursor='another-hand:9';assert.throws(()=>assertUiPlanCurrent(forged,f.current),/UI_PLAN_STALE/);
  const latch=noteUiPointerOutcome(claimUiWindow(createUiLatch(),f.plan,f.current),'released');
  assert.equal(reconcileUiWindow(latch,advanced(f)).status,'skip-window-advanced');
});

test('read-only checkpoint and authority access require exact committed session and preserve database bytes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'maji-ui-driver-')),path=join(dir,'test.sqlite'),f=planned();
  try{
    const db=new DatabaseSync(path);
    db.exec(`PRAGMA application_id=1296124489; PRAGMA user_version=2;
      CREATE TABLE sessions(session_id TEXT PRIMARY KEY,recovery_required INTEGER);
      CREATE TABLE checkpoints(session_id TEXT PRIMARY KEY,sequence INTEGER,projection TEXT);
      CREATE TABLE game_events(session_id TEXT,sequence INTEGER);
      CREATE TABLE action_attempts(game_match_key TEXT,execution_mode TEXT,status TEXT);
      CREATE TABLE observed_actions(session_id TEXT,game_match_key TEXT,game_hand_key TEXT,source_cursor TEXT,body TEXT);`);
    db.prepare('INSERT INTO sessions VALUES (?,0)').run(f.checkpoint.sessionId);
    const privateInput=clone(f.checkpoint);privateInput.extraProtocol='must-not-return';privateInput.state.unrecognizedPayload='must-not-return';
    privateInput.state.players[0].hiddenTiles=['7z'];privateInput.state.ownConcealed[0].unrecognizedSecret='must-not-return';
    db.prepare('INSERT INTO checkpoints VALUES (?,?,?)').run(f.checkpoint.sessionId,f.checkpoint.sequence,JSON.stringify(privateInput));
    db.prepare('INSERT INTO game_events VALUES (?,?)').run(f.checkpoint.sessionId,f.checkpoint.sequence);
    const authority=authorityFor(f.plan);db.prepare('INSERT INTO observed_actions VALUES (?,?,?,?,?)').run(authority.sessionId,authority.gameMatchKey,authority.gameHandKey,authority.sourceCursor,JSON.stringify(authority));db.close();
    const before=await readFile(path);
    assert.deepEqual(await readUiCheckpoint({databasePath:path,sessionId:f.checkpoint.sessionId,pageState:f.page}),f.checkpoint);
    assert.deepEqual(await readUiDiscardAuthority({databasePath:path,plan:f.plan}),authority);
    assert.deepEqual(await readFile(path),before);
    await assert.rejects(readUiCheckpoint({databasePath:path,sessionId:'wrong-session',pageState:f.page}),/UI_SESSION_NOT_FOUND/);
    await assert.rejects(readUiCheckpoint({databasePath:path,sessionId:f.checkpoint.sessionId,pageState:{...f.page,lastStep:9}}));
    const writer=new DatabaseSync(path);writer.prepare('UPDATE game_events SET sequence=?').run(f.checkpoint.sequence-1);writer.close();
    await assert.rejects(readUiCheckpoint({databasePath:path,sessionId:f.checkpoint.sessionId,pageState:f.page}),/UI_CHECKPOINT_NOT_COMMITTED/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('pending progress reads committed opponent turns without an own offer and rejects recovery or unresolved attempts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'maji-ui-progress-')),path=join(dir,'test.sqlite'),f=planned(),after=advanced(f);
  after.pageState.operation=null;after.checkpoint.state.currentActor={known:true,value:3};
  after.checkpoint.state.operationWindow.status='closed';after.checkpoint.state.ownConcealed.pop();
  try{
    const db=new DatabaseSync(path);
    db.exec(`PRAGMA application_id=1296124489; PRAGMA user_version=2;
      CREATE TABLE sessions(session_id TEXT PRIMARY KEY,recovery_required INTEGER);
      CREATE TABLE checkpoints(session_id TEXT PRIMARY KEY,sequence INTEGER,projection TEXT);
      CREATE TABLE game_events(session_id TEXT,sequence INTEGER);
      CREATE TABLE action_attempts(game_match_key TEXT,execution_mode TEXT,status TEXT);`);
    db.prepare('INSERT INTO sessions VALUES (?,0)').run(f.checkpoint.sessionId);
    db.prepare('INSERT INTO checkpoints VALUES (?,?,?)').run(f.checkpoint.sessionId,after.checkpoint.sequence,JSON.stringify(after.checkpoint));
    db.prepare('INSERT INTO game_events VALUES (?,?)').run(f.checkpoint.sessionId,after.checkpoint.sequence);db.close();
    const args={databasePath:path,sessionId:f.checkpoint.sessionId},before=await readFile(path);
    const progress=await readUiProgress(args);
    assert.deepEqual(progress,{...after.checkpoint,state:{trust:'trusted'}});
    assert.equal(JSON.stringify(progress).includes('ownConcealed'),false);assert.deepEqual(await readFile(path),before);
    await assert.rejects(readUiCheckpoint({...args,pageState:after.pageState}),/UI_OWN_OFFER_REQUIRED/);
    const latch=noteUiPointerOutcome(claimUiWindow(createUiLatch(),f.plan,f.current),'released');
    assert.equal(reconcileUiWindow(latch,{checkpoint:progress,pageState:after.pageState,authority:authorityFor(f.plan)}).status,'discard-observed');
    await assert.rejects(readUiProgress({...args,sessionId:'missing'}),/UI_SESSION_NOT_FOUND/);
    await assert.rejects(readUiProgress({...args,sessionId:undefined}),/UI_SESSION_REQUIRED/);
    const mutate=sql=>{const writer=new DatabaseSync(path);writer.exec(sql);writer.close();};
    mutate('UPDATE sessions SET recovery_required=1');
    await assert.rejects(readUiProgress(args),/UI_PROGRESS_RECONCILIATION_REQUIRED/);
    mutate('UPDATE sessions SET recovery_required=0');
    const writer=new DatabaseSync(path);writer.prepare('INSERT INTO action_attempts VALUES (?,?,?)').run(f.checkpoint.gameMatchKey,'live','uncertain');writer.close();
    await assert.rejects(readUiProgress(args),/UI_PROGRESS_RECONCILIATION_REQUIRED/);
    mutate("UPDATE action_attempts SET status='not-dispatched'; UPDATE game_events SET sequence=1");
    await assert.rejects(readUiProgress(args),/UI_CHECKPOINT_NOT_COMMITTED/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('four pre-dispatch ranking passes stay measurable on varied and dense closed hands',()=>{
  const hands=[tiles,...['11223344556677','11112222333344','11112223334455'].map(text=>[...text].map(n=>`${n}m`)),
    ['1z','1z','2z','2z','3z','3z','4z','4z','5z','5z','6z','6z','7z','7z']];
  const times=[];
  for(const codes of hands){
    const f=scenario({codes}),start=performance.now();
    for(let repeat=0;repeat<4;repeat++)assert.equal(chooseUiAction(f.checkpoint,f.page).kind,'discard');
    times.push(performance.now()-start);
  }
  console.log(JSON.stringify({benchmark:'four-private-ranking-passes',cases:hands.length,maxMs:Number(Math.max(...times).toFixed(1)),
    exceededOneSecond:times.some(ms=>ms>1000)}));
});
