import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { acceptLivePage } from '../src/app/live.ts';
import { acceptLiveViaNode } from '../src/app/live-broker.ts';
import { replay } from '../src/app/replay.ts';
import { loadReplay } from '../src/app/replay.ts';
import { LiveGameSession } from '../src/app/live-session.ts';
import { GameActor } from '../src/application/game/actor.ts';
import { StorageClient } from '../src/adapters/storage/client.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';
import { ScriptedPage } from './live-helpers.ts';
import { bridgeCall } from '../src/adapters/majsoul/ego-transport.ts';

/** Scripted wire/DOM port only; coordinator, actor, worker, ledger and capture are real. */
class LifecyclePage extends ScriptedPage {
  syncs=0; drains=0; lastStep=2; sourceRaw:any;
  mode:'sequence'|'early-result'|'result-only'|'reconnect-terminal'|'auth-pending'|'terminal'|'disconnect'='sequence';
  async evaluate(source:any, argument?:any):Promise<any> {
    const method=argument?.method;
    if(method==='sync') {
      this.syncs++;
      const raw=await super.evaluate(source,argument);
      const ended=this.mode==='terminal' || ['reconnect-terminal','auth-pending'].includes(this.mode) && this.syncs>1;
      if(ended) {
        raw.step=4; raw.is_end=true;
        raw.game_restore.actions.push({name:'ActionNoTile',step:3,payload:{liujumanguan:false,gameend:true,scores:[]}});
        raw.matchResult={result:{players:[0,1,2,3].map(seat=>({seat,part_point_1:25000}))}};
      }
      this.lastStep=raw.step-1;this.sourceRaw=structuredClone(raw);return raw;
    }
    if(method==='read') return {...await super.evaluate(source,argument),lastStep:this.lastStep,connected:true,freshConnection:true};
    if(method==='drain') {
      this.calls.push('drain');this.drains++;
      const base={generation:0,pageEpoch:1,lastStep:this.lastStep,connected:true,freshConnection:true,records:[]};
      if(this.drains===1 || this.mode==='terminal')return base;
      if(this.mode==='disconnect' || ['reconnect-terminal','auth-pending'].includes(this.mode) && this.drains===2)
        return {...base,connected:false,reason:'DISCONNECTED',records:[{kind:'disconnected',receivedAt:this.at}]};
      if(this.mode==='auth-pending' && this.drains===3) {
        assert.equal(this.syncs,1);return {...base,reason:'CONNECTION_CHANGED',authSummary:null};
      }
      if(this.mode==='reconnect-terminal' && this.drains===3 || this.mode==='auth-pending' && this.drains===4) {
        assert.equal(this.syncs,1);
        return {...base,authSummary:{},records:[{kind:'auth-summary',receivedAt:this.at}]};
      }
      if(this.mode==='result-only' && this.drains===2) return {...base,records:[{
        kind:'match-end',payload:{result:{players:[0,1,2,3].map(seat=>({seat,part_point_1:25000}))}},
        gameUuid:'contract-only-game-uuid',handSha256:'a'.repeat(64),receivedAt:this.at,
      }]};
      if(!['sequence','early-result'].includes(this.mode) || this.drains!==2)return base;
      const opening=this.sourceRaw.game_restore.actions[0].payload;
      const record=(name:string,step:number,payload:any,sha:string)=>({kind:'action',name,step,payload,
        receivedAt:this.at,gameUuid:'contract-only-game-uuid',handSha256:sha});
      const scores=[24000,28000,24000,24000];
      const records=[
        record('ActionNoTile',3,{liujumanguan:false,gameend:false,scores:[]},'a'.repeat(64)),
        record('ActionNewRound',0,{...opening,ben:1,sha256:'b'.repeat(64)},'b'.repeat(64)),
        record('ActionLiuJu',1,{type:1,seat:0},'b'.repeat(64)),
        record('ActionNewRound',0,{...opening,ju:1,tiles:[...opening.tiles,'9s'],sha256:'c'.repeat(64)},'c'.repeat(64)),
        record('ActionHule',1,{old_scores:[25000,25000,25000,25000],delta_scores:[-1000,3000,-1000,-1000],scores,
          hules:[{seat:1,zimo:true}],gameend:{scores}},'c'.repeat(64)),
        {kind:'match-end',payload:{result:{players:[1,0,2,3].map(seat=>({seat,part_point_1:scores[seat]}))}},
          gameUuid:'contract-only-game-uuid',handSha256:'c'.repeat(64),receivedAt:this.at},
      ];
      if(this.mode==='early-result') {
        const settlement=records[4]!,result=records[5]!;
        settlement.receivedAt=new Date(Date.parse(this.at)+2000).toISOString();
        result.receivedAt=new Date(Date.parse(this.at)+1000).toISOString();
        records.splice(4,2,result,settlement);
      }
      return {...base,records};
    }
    return super.evaluate(source,argument);
  }
}

async function scenario(mode:LifecyclePage['mode']) {
  const directory=await mkdtemp(join(tmpdir(),'maji-lifecycle-'));
  const page=new LifecyclePage(join(directory,'state.sqlite'));page.mode=mode;
  const options={outputDirectory:join(directory,'run'),databasePath:page.databasePath,
    room:buildPhase1Fixture().projection.room!,sourceVersion:'synthetic-lifecycle-contract',observeMs:500};
  return{directory,page,options,cleanup:()=>rm(directory,{recursive:true,force:true})};
}

test('maximum-length observer follows hand boundaries and stops at the full match result without sending',async t=>{
  const h=await scenario('sequence');
  const timeouts=t.mock.method(globalThis,'setTimeout');
  try{
    const report=await acceptLiveViaNode(h.page,{...h.options,observeMs:1_800_000},process.execPath);
    assert.equal(report.status,'passed',JSON.stringify(report));
    assert.equal(report.scope,'lifecycle-observation');
    assert.ok(timeouts.mock.calls.some(call=>call.arguments[1]===1_845_000));
    assert.deepEqual(report.lifecycle,{handStarts:2,handEnds:3,matchEnds:1,reconnects:0,handOrdinal:3,
      handStatus:'finished',matchStatus:'finished',matchEndPending:false,awaitingSettlement:false,recovering:false});
    assert.equal(h.page.sends,0);assert.equal(report.counts.confirmations,0);
    assert.equal(report.autoWinRecovery?.trigger,'new-hand');assert.equal(report.autoWinRecovery?.status,'not-required');
    assert.equal(report.autoWinRecovery?.attempted,false);
    assert.equal(report.autoWinRecoveries[0].status,'unverified');assert.equal(report.autoWinRecoveries[0].code,'AUTO_WIN_READBACK_STALE');
    assert.equal(h.page.calls.filter(c=>c==='ensureAutoWin').length,1);assert.equal(h.page.calls.includes('prepare'),false);
    const replayed=await replay(report.captureDirectory,{outputDirectory:join(h.directory,'replay')});
    assert.equal(replayed.status,'passed');assert.equal(replayed.finalHandOrdinal,3);
    const db=new DatabaseSync(h.page.databasePath,{readOnly:true});
    try{
      const projection=JSON.parse(db.prepare('SELECT projection FROM checkpoints').get()!.projection as string);
      assert.equal(projection.matchResult.ranks[1],1);assert.equal(projection.matchResult.scores[1],28000);
      assert.equal(db.prepare('SELECT count(*) AS n FROM action_attempts').get()!.n,0);
    }finally{db.close();}
  }finally{await h.cleanup();}
});

test('opt-in observation holds real Actor fences across a committed new hand without opening the Page',async()=>{
  const h=await scenario('sequence');
  const evaluate=h.page.evaluate.bind(h.page);
  h.page.evaluate=async(source,argument)=>{
    const result=await evaluate(source,argument);
    if(argument?.method!=='read')return result;
    const control=h.page.controls.at(-1);
    return {...result,paused:control?.paused,controlEpoch:control?.controlEpoch,queued:0,sourceStream:0,
      stats:{bridgeActionSends:h.page.sends}};
  };
  try {
    const report=await acceptLiveViaNode(h.page,{...h.options,verifyBoundaryFences:true},process.execPath);
    assert.equal(report.status,'passed',JSON.stringify(report));
    assert.equal(report.lifecycle.matchStatus,'finished');
    assert.equal(report.boundaryFenceChallenge.status,'passed');
    const challenge=report.boundaryFenceChallenge;
    assert.equal(challenge.before.handOrdinal,1);
    assert.ok(challenge.after.handOrdinal>challenge.before.handOrdinal);
    assert.equal(challenge.before.gameMatchKey,challenge.after.gameMatchKey);
    assert.notEqual(challenge.before.gameHandKey,challenge.after.gameHandKey);
    assert.equal(challenge.before.connectionEpoch,challenge.after.connectionEpoch);
    assert.ok(challenge.after.controlEpoch>challenge.before.controlEpoch);
    assert.deepEqual(challenge.pageAtArm,{pageEpoch:1,sourceStream:0,step:2,paused:true,bridgeActionSends:0});
    assert.equal(challenge.decisionCode,'DECISION_STALE');
    assert.equal(challenge.permitCode,'PERMIT_INVALID');
    assert.match(challenge.permitSha256,/^[a-f0-9]{64}$/);
    assert.equal(h.page.controls.every(control=>control.paused),true);
    assert.equal(h.page.calls.some(call=>['prepare','dispatch'].includes(call)),false);
    assert.equal(report.counts.confirmations,0);
    const db=new DatabaseSync(h.page.databasePath,{readOnly:true});
    try {
      const decision=db.prepare('SELECT snapshot FROM decisions WHERE decision_id=?').get(challenge.decisionId);
      assert.equal(JSON.parse(decision!.snapshot as string).scope.handId,challenge.before.handId);
      assert.equal(db.prepare('SELECT count(*) AS n FROM decisions').get()!.n,1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM action_attempts').get()!.n,0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM action_slots').get()!.n,0);
    } finally { db.close(); }
  } finally { await h.cleanup(); }
});

test('a timing proof arming failure is preserved while passive observation reaches the authoritative result',async()=>{
  const h=await scenario('sequence');
  const evaluate=h.page.evaluate.bind(h.page);
  h.page.evaluate=async(source,argument)=>{
    if(argument?.method==='automaticTiming')throw Error('COUNTDOWN_SAMPLE_STALE');
    return evaluate(source,argument);
  };
  try {
    const report=await acceptLivePage(h.page,{...h.options,verifyBoundaryFences:true});
    assert.equal(report.status,'blocked',JSON.stringify(report));
    assert.ok('lifecycle' in report);
    assert.equal(report.lifecycle.matchStatus,'finished');
    assert.deepEqual(report.boundaryFenceChallenge,{status:'arming-failed',code:'COUNTDOWN_SAMPLE_STALE'});
    assert.equal(h.page.controls.every(control=>control.paused),true);
    const db=new DatabaseSync(h.page.databasePath,{readOnly:true});
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM decisions').get()!.n,0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM action_attempts').get()!.n,0);
    } finally { db.close(); }
  } finally { await h.cleanup(); }
});

test('the fence diagnostic refuses to arm alongside a send or without observation',async()=>{
  const h=await scenario('sequence');
  try {
    for(const options of [{discardOnce:true},{pauseBeforeDispatch:true},{observeMs:0}])
      await assert.rejects(acceptLivePage(h.page,{...h.options,verifyBoundaryFences:true,...options}),/INVALID_BOUNDARY_FENCE_CHALLENGE/);
    assert.deepEqual(h.page.calls,[]);
    await assert.rejects(access(h.options.outputDirectory),{code:'ENOENT'});
  } finally { await h.cleanup(); }
});

test('finished restore needs no countdown or switch UI and archives a stopped match',async()=>{
  const h=await scenario('terminal');
  try{
    const report=await acceptLivePage(h.page,h.options);
    assert.equal(report.status,'passed',JSON.stringify(report));assert.ok('lifecycle' in report);
    assert.equal(report.lifecycle.matchStatus,'finished');assert.equal(report.programPaused,true);
    assert.equal(h.page.calls.includes('ensureAutoWin'),false);assert.equal(h.page.calls.includes('ackTiming'),false);
    const replayed=await replay(report.captureDirectory,{outputDirectory:join(h.directory,'replay')});
    assert.equal(replayed.status,'passed');assert.equal(h.page.sends,0);
  }finally{await h.cleanup();}
});

test('observer reconnects into complete terminal history in the same actor and database',async()=>{
  const h=await scenario('reconnect-terminal');
  try{
    const report=await acceptLivePage(h.page,{...h.options,observeMs:1000});
    assert.equal(report.status,'passed',JSON.stringify(report));assert.ok('lifecycle' in report);
    assert.equal(report.lifecycle.reconnects,1);assert.equal(report.lifecycle.handOrdinal,1);
    assert.equal(report.lifecycle.matchStatus,'finished');assert.equal(report.captureDirectories.length,2);
    for(const[index,path]of report.captureDirectories.entries())assert.equal((await replay(path,{outputDirectory:join(h.directory,`replay-${index}`)})).status,'passed');
    const db=new DatabaseSync(h.page.databasePath,{readOnly:true});
    try{assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()!.n,1);}finally{db.close();}
    assert.equal(h.page.sends,0);
  }finally{await h.cleanup();}
});

test('an observation timeout while disconnected remains paused and reports recovery required',async()=>{
  const h=await scenario('disconnect');
  try{
    const report=await acceptLivePage(h.page,{...h.options,observeMs:150});
    assert.equal(report.status,'blocked');assert.ok('lifecycle'in report);
    assert.equal(report.lifecycle.recovering,true);assert.equal(report.programPaused,true);assert.equal(h.page.sends,0);
  }finally{await h.cleanup();}
});

test('observer waits through an open but unauthenticated replacement socket before terminal recovery',async()=>{
  const h=await scenario('auth-pending');
  try {
    const report=await acceptLivePage(h.page,{...h.options,observeMs:1500});
    assert.equal(report.status,'passed',JSON.stringify(report));assert.ok('lifecycle'in report);
    assert.equal(report.lifecycle.reconnects,1);assert.equal(h.page.syncs,2);assert.equal(h.page.sends,0);
    assert.equal(report.lifecycle.matchStatus,'finished');
  }finally{await h.cleanup();}
});

test('a final notification received before settlement is committed causally and replays with original timestamps',async()=>{
  const h=await scenario('early-result');
  try {
    const report=await acceptLivePage(h.page,h.options);
    assert.equal(report.status,'passed',JSON.stringify(report));assert.ok('lifecycle'in report);
    const fixture=await loadReplay(report.captureDirectory);
    const handEnd=fixture.events.at(-2)!,matchEnd=fixture.events.at(-1)!;
    assert.equal(handEnd.type,'HandEnded');assert.equal(matchEnd.type,'MatchEnded');
    assert.ok(Date.parse(handEnd.receivedAt)>Date.parse(matchEnd.receivedAt));
    assert.equal((await replay(report.captureDirectory,{outputDirectory:join(h.directory,'replay')})).status,'passed');
    assert.equal(report.lifecycle.awaitingSettlement,false);assert.equal(h.page.sends,0);
  }finally{await h.cleanup();}
});

test('notification without its final settlement stays blocked and cannot resume an old decision window',async()=>{
  const h=await scenario('result-only');
  try {
    const report=await acceptLivePage(h.page,{...h.options,observeMs:150});
    assert.equal(report.status,'blocked');assert.ok('lifecycle'in report);
    assert.equal(report.lifecycle.awaitingSettlement,true);assert.equal(report.programPaused,true);
    const storage=new StorageClient(join(h.directory,'direct.sqlite'));
    try {
      const actor=await GameActor.open(storage,'pending-result-session','process');
      const page=new LifecyclePage(join(h.directory,'direct.sqlite'));page.mode='result-only';
      const live=new LiveGameSession(actor,page,h.options.room);
      await live.synchronize(false);await live.pump();
      assert.equal(live.awaitingSettlement,true);assert.equal(actor.control.needsSync,true);
      await assert.rejects(live.coordinator.resume(),/SYNC_REQUIRED/);
      assert.equal(page.sends,0);await actor.idle();
    }finally{await storage.close();}
  }finally{await h.cleanup();}
});

class AutoWinRecoveryPage extends ScriptedPage {
  epoch=1;generation=0;lastStep=2;sourceStream=0;connected=true;reason:string|null=null;
  records:any[]=[];ensureCalls=0;ensureArguments:unknown[]=[];uiError:string|null=null;ingressDuringEnsure=false;inputAfterProof=false;lastReadback:any=null;
  constructor(path:string){super(path);this.autoWinNeedsEnable=true;this.autoWinState='disabled';}
  enqueueDiscard() {
    this.generation++;this.lastStep=3;
    this.records.push({kind:'action',name:'ActionDiscardTile',step:3,receivedAt:this.at,
      gameUuid:'contract-only-game-uuid',handSha256:'a'.repeat(64),
      payload:{seat:1,tile:'0m',moqie:true,is_liqi:false,is_wliqi:false}});
  }
  disconnect() {
    this.epoch++;this.connected=false;this.reason='DISCONNECTED';this.lastReadback=null;
    this.records.push({kind:'disconnected',receivedAt:this.at});this.generation++;
  }
  localInput() {this.generation++;this.lastReadback=null;}
  authenticate() {
    this.connected=true;this.reason='CONNECTION_CHANGED';this.autoWinNeedsEnable=true;this.autoWinState='disabled';
    this.records.push({kind:'auth-summary',receivedAt:this.at});this.generation++;
  }
  async evaluate(source:any,input?:any):Promise<any> {
    const method=input?.method;
    if(method==='read'||method==='drain') {
      const base=await super.evaluate(source,{method:'read'});
      const result={...base,pageEpoch:this.epoch,generation:this.generation,lastStep:this.lastStep,sourceStream:this.sourceStream,
        connected:this.connected,freshConnection:true,reason:this.reason,overflow:false,queued:this.records.length,
        lastAutoWinReadback:this.lastReadback};
      if(method==='drain'){this.calls.push('drain');return {...result,records:this.records.splice(0)};}
      return result;
    }
    if(method==='sync') {
      const raw=await super.evaluate(source,input);raw.pageEpoch=this.epoch;raw.generation=this.generation;return raw;
    }
    if(method==='ackSync') {this.records=[];this.reason=null;this.calls.push(method);return {};}
    if(method==='ensureAutoWin') {
      this.calls.push(method);this.ensureCalls++;this.ensureArguments.push(input.argument);
      if(this.ingressDuringEnsure)this.enqueueDiscard();
      if(this.uiError)throw Error(this.uiError);
      const clicked=this.autoWinNeedsEnable;
      if(clicked){this.generation++;this.autoWinState='enabled';this.autoWinNeedsEnable=false;}
      const proof={source:'unity-button-pixels-v1',state:'enabled',pageEpoch:this.epoch,generation:this.generation,step:this.lastStep,
        observedAt:this.at,rgbaSha256:'a'.repeat(64),clicked};
      this.lastReadback={...proof,sourceStream:this.sourceStream};
      if(this.inputAfterProof){this.generation++;this.lastReadback=null;}
      return proof;
    }
    return super.evaluate(source,input);
  }
}

test('an observer restores the switch once after initial sync and again after reconnect in the original actor',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'maji-auto-win-recovery-')),storage=new StorageClient(join(directory,'state.sqlite'));
  try {
    const actor=await GameActor.open(storage,'same-session','process'),page=new AutoWinRecoveryPage(join(directory,'state.sqlite'));
    const live=new LiveGameSession(actor,page,buildPhase1Fixture().projection.room!);
    await live.synchronize(false);
    assert.equal(live.autoWinRecovery?.status,'verified');assert.equal(live.autoWinRecovery?.readback?.clicked,true);
    assert.equal(page.ensureCalls,1);assert.equal(live.cursor?.generation,1);assert.equal(actor.projection.room?.autoWin,'unknown');
    page.disconnect();await live.pump();assert.equal(live.recovering,true);
    page.authenticate();await live.pump();
    assert.equal(page.ensureCalls,2);assert.equal(live.counts.reconnects,1);assert.equal(live.recovering,false);
    assert.deepEqual(page.ensureArguments,[null,{purpose:'reconnect'}]);
    assert.equal(live.autoWinRecovery?.status,'verified');assert.equal(live.autoWinRecovery?.trigger,'reconnect');
    assert.equal(live.autoWinRecovery?.connectionEpoch,2);assert.equal(live.autoWinRecovery?.pageEpoch,2);
    assert.equal(live.autoWinRecovery?.readback?.clicked,true);assert.equal(live.autoWinRecoveries.length,2);
    assert.equal(actor.projection.sessionId,'same-session');assert.equal(actor.control.paused,true);
    assert.equal((await storage.inspect('same-session')).counts.faults,1); // The explicit disconnect only.
    assert.equal(page.sends,0);assert.equal(page.calls.includes('prepare'),false);assert.equal(page.calls.includes('automaticTiming'),false);
  }finally{await storage.close();await rm(directory,{recursive:true,force:true});}
});

test('reconnect purpose crosses the real observer child process while retaining one actor and ledger',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'maji-auto-win-broker-reconnect-'));
  class BrokerReconnectPage extends AutoWinRecoveryPage {
    drains=0;
    async evaluate(source:any,input?:any):Promise<any> {
      if(input?.method==='drain') {
        this.drains++;
        if(this.drains===3)this.disconnect();
        if(this.drains===4)this.authenticate();
      }
      return super.evaluate(source,input);
    }
  }
  try {
    const page=new BrokerReconnectPage(join(directory,'state.sqlite'));
    const report=await acceptLiveViaNode(page,{outputDirectory:join(directory,'run'),databasePath:page.databasePath,
      room:buildPhase1Fixture().projection.room!,sourceVersion:'synthetic-auto-win-broker-reconnect',observeMs:700},process.execPath);
    assert.equal(report.status,'passed');assert.equal(report.lifecycle.reconnects,1);
    assert.deepEqual(page.ensureArguments,[null,{purpose:'reconnect'}]);assert.equal(report.autoWinRecovery?.status,'verified');
    assert.equal(page.sends,0);assert.equal(report.captureDirectories.length,2);
    const db=new DatabaseSync(page.databasePath,{readOnly:true});
    try {assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()!.n,1);}
    finally {db.close();}
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('unfinished native recovery keeps the observer paused and ingests authority without another toggle',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'maji-auto-win-not-ready-')),storage=new StorageClient(join(directory,'state.sqlite'));
  try {
    const actor=await GameActor.open(storage,'not-ready-session','process'),page=new AutoWinRecoveryPage(join(directory,'state.sqlite'));
    const live=new LiveGameSession(actor,page,buildPhase1Fixture().projection.room!);
    await live.synchronize(false);
    page.disconnect();await live.pump();
    page.authenticate();page.uiError='AUTO_WIN_RECOVERY_NOT_READY';page.ingressDuringEnsure=true;
    await live.pump();
    assert.equal(live.counts.reconnects,1);assert.equal(live.recovering,false);
    assert.equal(live.autoWinRecovery?.status,'unverified');assert.equal(live.autoWinRecovery?.code,'AUTO_WIN_RECOVERY_NOT_READY');
    assert.equal(live.autoWinRecovery?.readback,null);assert.equal(actor.control.paused,true);
    assert.equal(live.segments.at(-1)?.subsequent.filter(e=>e.type==='TileDiscarded').length,1);
    assert.equal(live.cursor?.lastStep,3);assert.equal((await storage.inspect('not-ready-session')).counts.faults,1);
    await live.pump();assert.equal(page.ensureCalls,2);assert.equal(page.sends,0);
    assert.equal(page.calls.includes('prepare'),false);assert.equal(page.calls.includes('automaticTiming'),false);
  }finally{await storage.close();await rm(directory,{recursive:true,force:true});}
});

test('observer pixel failure remains separate from protocol trust and retains authority received during the readback',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'maji-auto-win-pixels-'));
  try {
    const page=new AutoWinRecoveryPage(join(directory,'state.sqlite'));page.uiError='AUTO_WIN_READBACK_STALE';page.ingressDuringEnsure=true;
    const report=await acceptLivePage(page,{outputDirectory:join(directory,'run'),databasePath:page.databasePath,
      room:buildPhase1Fixture().projection.room!,sourceVersion:'synthetic-auto-win-recovery',observeMs:1});
    assert.equal(report.status,'blocked');assert.ok('autoWinRecovery'in report);
    assert.equal(report.autoWinRecovery?.status,'unverified');assert.equal(report.autoWinRecovery?.code,'AUTO_WIN_READBACK_STALE');
    assert.ok('counts'in report);assert.equal(report.counts.faults,0);assert.equal(report.counts.outbox,1);
    assert.equal(report.lifecycle.recovering,false);assert.equal(page.ensureCalls,1);assert.equal(page.sends,0);
    const fixture=await loadReplay(report.captureDirectory);
    assert.equal(fixture.events.filter(e=>e.type==='TileDiscarded'&&e.payload.actor===1).length,1);
    assert.equal((await replay(report.captureDirectory,{outputDirectory:join(directory,'replay')})).status,'passed');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a local input after the switch proof invalidates recovery even without a new protocol record',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'maji-auto-win-input-')),storage=new StorageClient(join(directory,'state.sqlite'));
  try {
    const page=new AutoWinRecoveryPage(join(directory,'state.sqlite'));page.inputAfterProof=true;
    const actor=await GameActor.open(storage,'input-session','process'),live=new LiveGameSession(actor,page,buildPhase1Fixture().projection.room!);
    await live.synchronize(false);
    assert.equal(live.autoWinRecovery?.status,'unverified');assert.equal(live.autoWinRecovery?.code,'AUTO_WIN_READBACK_STALE');
    assert.equal(live.cursor?.generation,page.generation);assert.equal((await storage.inspect('input-session')).counts.faults,0);
    assert.equal(page.ensureCalls,1);assert.equal(actor.control.paused,true);
  }finally{await storage.close();await rm(directory,{recursive:true,force:true});}
});

test('protocol errors still reject observer recovery and arbitrary error messages cannot enter its diagnostic record',async()=>{
  for(const code of ['BRIDGE_UNTRUSTED','PRIVATE_ACCOUNT_SENTINEL']) {
    const directory=await mkdtemp(join(tmpdir(),'maji-auto-win-fatal-')),storage=new StorageClient(join(directory,'state.sqlite'));
    try {
      const page=new AutoWinRecoveryPage(join(directory,'state.sqlite'));page.uiError=code;
      const actor=await GameActor.open(storage,'fatal-session','process'),live=new LiveGameSession(actor,page,buildPhase1Fixture().projection.room!);
      await assert.rejects(live.synchronize(false),error=>error instanceof Error&&error.message===(code==='BRIDGE_UNTRUSTED'?code:'AUTO_WIN_RECOVERY_FAILED'));
      assert.equal(live.autoWinRecovery?.code,code==='BRIDGE_UNTRUSTED'?code:'AUTO_WIN_RECOVERY_FAILED');
      assert.equal(JSON.stringify(live.autoWinRecoveries).includes('PRIVATE_ACCOUNT_SENTINEL'),false);
      assert.equal(page.ensureCalls,1);assert.equal(page.sends,0);
    }finally{await storage.close();await rm(directory,{recursive:true,force:true});}
  }
});

test('local input in a later observer pump cannot reuse the earlier recovery proof',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'maji-auto-win-later-input-')),storage=new StorageClient(join(directory,'state.sqlite'));
  try {
    const page=new AutoWinRecoveryPage(join(directory,'state.sqlite'));
    const actor=await GameActor.open(storage,'later-input-session','process'),live=new LiveGameSession(actor,page,buildPhase1Fixture().projection.room!);
    await live.synchronize(false);assert.equal(live.autoWinRecovery?.status,'verified');
    page.enqueueDiscard();await live.pump();assert.equal(live.autoWinRecovery?.status,'verified');
    page.localInput();await live.pump();
    assert.equal(live.autoWinRecovery?.status,'unverified');assert.equal(live.autoWinRecovery?.code,'AUTO_WIN_READBACK_STALE');
    assert.equal(live.cursor?.generation,page.generation);assert.equal(page.ensureCalls,1);assert.equal(page.sends,0);
    assert.equal((await storage.inspect('later-input-session')).counts.faults,0);
  }finally{await storage.close();await rm(directory,{recursive:true,force:true});}
});

test('unknown recovery failures cannot enter the full acceptance report',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'maji-auto-win-report-'));
  try {
    const page=new AutoWinRecoveryPage(join(directory,'state.sqlite'));page.uiError='PRIVATE_ACCOUNT_SENTINEL';
    const report=await acceptLivePage(page,{outputDirectory:join(directory,'run'),databasePath:page.databasePath,
      room:buildPhase1Fixture().projection.room!,sourceVersion:'synthetic-auto-win-recovery',observeMs:1});
    assert.equal(report.status,'blocked');assert.ok('code'in report);assert.equal(report.code,'AUTO_WIN_RECOVERY_FAILED');
    assert.equal(report.autoWinRecovery?.code,'AUTO_WIN_RECOVERY_FAILED');
    assert.equal(JSON.stringify(report).includes('PRIVATE_ACCOUNT_SENTINEL'),false);
    assert.equal(page.ensureCalls,1);assert.equal(page.sends,0);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('a revoked, replaced, disabled or unknown readback invalidates recovery without a generation change',async t=>{
  for (const state of ['disabled','unknown','revoked','replaced']) await t.test(state,async()=>{
    const directory=await mkdtemp(join(tmpdir(),'maji-auto-win-negative-')),storage=new StorageClient(join(directory,'state.sqlite'));
    try {
      const page=new AutoWinRecoveryPage(join(directory,'state.sqlite'));
      const actor=await GameActor.open(storage,'negative-session','process'),live=new LiveGameSession(actor,page,buildPhase1Fixture().projection.room!);
      await live.synchronize(false);assert.equal(live.autoWinRecovery?.status,'verified');
      const generation=page.generation;
      page.lastReadback=state==='revoked'?null:state==='replaced'?{...page.lastReadback,rgbaSha256:'b'.repeat(64)}:{...page.lastReadback,state};
      await live.pump();
      assert.equal(page.generation,generation);assert.equal(live.autoWinRecovery?.status,'unverified');
      assert.equal(live.autoWinRecovery?.code,'AUTO_WIN_READBACK_STALE');assert.equal(page.ensureCalls,1);assert.equal(page.sends,0);
      assert.equal((await storage.inspect('negative-session')).counts.faults,0);
    }finally{await storage.close();await rm(directory,{recursive:true,force:true});}
  });
});

class HandRecoveryPage extends AutoWinRecoveryPage {
  opening:any;handEnded=false;matchEnded=false;operation:any=null;initialTerminal=false;
  beforeRead:(()=>void)|undefined;beforeDrain:(()=>void)|undefined;afterEnsure:(()=>void)|undefined;
  action(name:string,payload:any,step=this.lastStep+1) {
    this.lastStep=step;this.generation++;
    this.operation=payload.operation?{step,value:payload.operation}:null;
    this.records.push({kind:'action',name,step,payload,receivedAt:this.at,
      gameUuid:'contract-only-game-uuid',handSha256:this.opening.sha256});
  }
  endHand(final=false) {
    this.action('ActionNoTile',{liujumanguan:false,gameend:final,scores:[]});
    this.handEnded=true;this.lastReadback=null;
    if (final) {
      this.matchEnded=true;this.generation++;
      this.records.push({kind:'match-end',receivedAt:this.at,gameUuid:'contract-only-game-uuid',handSha256:this.opening.sha256,
        payload:{result:{players:[0,1,2,3].map(seat=>({seat,part_point_1:25000}))}}});
    }
  }
  nextHand(commitment='b',dealer=0) {
    if (!this.handEnded) this.endHand();
    this.opening={...this.opening,ju:dealer,ben:this.opening.ben+1,sha256:commitment.repeat(64),
      tiles:[...this.opening.tiles.slice(0,13),...(dealer===1?['9s']:[])],operation:dealer===1?{seat:1,operation_list:[{type:1}]}:null};
    this.sourceStream++;this.handEnded=false;
    this.action('ActionNewRound',structuredClone(this.opening),0);
    this.autoWinState='disabled';this.autoWinNeedsEnable=true;this.lastReadback=null;
  }
  ownTurn(winning=false) {
    this.action('ActionDiscardTile',{seat:0,tile:'9m',moqie:false,is_liqi:false,is_wliqi:false});
    this.action('ActionDealTile',{seat:1,tile:'0m',left_tile_count:68,
      operation:{seat:1,operation_list:[{type:winning?8:1}]}});
  }
  async evaluate(source:any,input?:any):Promise<any> {
    const method=input?.method;
    if (method==='read') {const next=this.beforeRead;this.beforeRead=undefined;next?.();}
    if (method==='drain') this.beforeDrain?.();
    const result=await super.evaluate(source,input);
    if (method==='sync') {
      this.opening=structuredClone(result.game_restore.actions[0].payload);
      if (this.initialTerminal) {
        result.game_restore.actions.push({name:'ActionNoTile',step:3,payload:{liujumanguan:false,gameend:false,scores:[]}});
        result.step=4;this.lastStep=3;this.handEnded=true;
      }
    }
    if (method==='read'||method==='drain') return {...result,paused:this.controls.at(-1)?.paused ?? true,
      handEnded:this.handEnded,matchEnded:this.matchEnded,operation:this.operation};
    if (method==='ensureAutoWin') {const next=this.afterEnsure;this.afterEnsure=undefined;next?.();}
    return result;
  }
}

async function handRecoveryScenario() {
  const directory=await mkdtemp(join(tmpdir(),'maji-hand-auto-win-')),storage=new StorageClient(join(directory,'state.sqlite'));
  const actor=await GameActor.open(storage,'hand-recovery-session','process'),page=new HandRecoveryPage(join(directory,'state.sqlite'));
  actor.attachControlSink(control=>bridgeCall(page,'pause',control));
  const live=new LiveGameSession(actor,page,buildPhase1Fixture().projection.room!);
  return {directory,storage,actor,page,live,cleanup:async()=>{await actor.idle();await storage.close();await rm(directory,{recursive:true,force:true});}};
}

test('a new hand waits for its own non-winning window and restores once without reviving old decisions or permits',async t=>{
  for(const dealer of [0,1])await t.test(dealer===0?'dealer-repeat-then-own-draw':'own-dealer-opening',async()=>{
    const h=await handRecoveryScenario();
    try {
      await h.live.synchronize(true);await h.actor.resume();
      const decision=await h.actor.freezeDecision(),oldHand=h.actor.projection.gameHandKey;
      const permit=h.actor.issuePermit(decision.id,decision.legalActions[0]!.id,'previous-hand-permit');
      h.page.nextHand('b',dealer);await h.live.pump();
      if(dealer===0) {
        assert.equal(h.live.autoWinRecovery?.status,'pending');assert.equal(h.live.autoWinRecovery?.attempted,false);
        assert.equal(h.page.ensureCalls,1);assert.equal(h.page.autoWinState,'disabled');
        h.page.ownTurn();await h.live.pump();
      } else assert.equal(h.actor.projection.state!.operationWindow,undefined);
      assert.equal(h.live.autoWinRecovery?.trigger,'new-hand');assert.equal(h.live.autoWinRecovery?.status,'verified');
      assert.equal(h.live.autoWinRecovery?.gameHandKey,h.actor.projection.gameHandKey);
      assert.notEqual(h.actor.projection.gameHandKey,oldHand);assert.equal(h.actor.projection.handOrdinal,2);
      assert.equal(h.page.ensureCalls,2);assert.equal(h.live.autoWinRecovery?.readback?.clicked,true);
      assert.deepEqual(h.page.ensureArguments.at(-1),{purpose:'new-hand',expected:{pageEpoch:1,sourceStream:1,
        generation:h.live.autoWinRecovery!.generation,step:dealer===0?2:0}});
      assert.throws(()=>h.actor.decision(decision.id),/DECISION_STALE/);
      assert.throws(()=>h.actor.consumePermit(permit),/PERMIT_INVALID/);
      await h.live.pump();assert.equal(h.page.ensureCalls,2);assert.equal(h.actor.control.paused,true);
      assert.equal(h.page.sends,0);assert.equal(h.page.calls.includes('prepare'),false);
      assert.equal((await h.storage.inspect('hand-recovery-session')).counts.outbox,0);
    }finally{await h.cleanup();}
  });
});

test('a winning first window keeps new-hand recovery pending without a competing toggle',async()=>{
  const h=await handRecoveryScenario();
  try {
    await h.live.synchronize(false);h.page.nextHand();await h.live.pump();
    h.page.ownTurn(true);await h.live.pump();
    assert.equal(h.live.autoWinRecovery?.status,'pending');assert.equal(h.live.autoWinRecovery?.attempted,false);
    assert.equal(h.page.ensureCalls,1);assert.equal(h.page.autoWinState,'disabled');assert.equal(h.page.sends,0);
  }finally{await h.cleanup();}
});

test('new-hand readiness defers opposing, stale, empty, unknown or mixed winning offers without spending its attempt',async()=>{
  const h=await handRecoveryScenario();
  try {
    await h.live.synchronize(false);h.page.nextHand('b',1);
    const offer=structuredClone(h.page.operation);
    const unavailable=[{...offer,value:{...offer.value,seat:0}},{...offer,step:1},
      ...[[],[{type:0}],[{type:'1'}],[{type:1},{type:9}]].map(operation_list=>({...offer,value:{...offer.value,operation_list}}))];
    for(const operation of unavailable) {
      h.page.operation=operation;await h.live.pump();
      assert.equal(h.live.autoWinRecovery?.status,'pending');assert.equal(h.live.autoWinRecovery?.attempted,false);
      assert.equal(h.page.ensureCalls,1);assert.equal(h.page.sends,0);
    }
    h.page.operation=offer;await h.live.pump();
    assert.equal(h.live.autoWinRecovery?.status,'verified');assert.equal(h.page.ensureCalls,2);assert.equal(h.page.sends,0);
  }finally{await h.cleanup();}
});

test('a failed new-hand toggle is attempted once while later authority is still ingested',async()=>{
  const h=await handRecoveryScenario();
  try {
    await h.live.synchronize(false);h.page.nextHand('b',1);h.page.uiError='AUTO_WIN_READBACK_FAILED';
    await h.live.pump();assert.equal(h.live.autoWinRecovery?.status,'unverified');
    assert.equal(h.live.autoWinRecovery?.code,'AUTO_WIN_READBACK_FAILED');assert.equal(h.live.autoWinRecovery?.attempted,true);
    h.page.uiError=null;h.page.action('ActionDiscardTile',{seat:1,tile:'9s',moqie:false,is_liqi:false,is_wliqi:false});
    await h.live.pump();await h.live.pump();
    assert.equal(h.actor.projection.state!.players[1].river.length,1);assert.equal(h.page.ensureCalls,2);
    assert.equal(h.live.autoWinRecovery?.status,'unverified');assert.equal(h.actor.control.paused,true);assert.equal(h.page.sends,0);
  }finally{await h.cleanup();}
});

test('new-hand ingress during preflight or readback defers the replacement hand without recursive toggles',async t=>{
  for(const phase of ['preflight','readback'])await t.test(phase,async()=>{
    const h=await handRecoveryScenario();
    try {
      await h.live.synchronize(false);h.page.nextHand('b',1);
      if(phase==='preflight')h.page.beforeRead=()=>h.page.nextHand('c',1);
      else h.page.afterEnsure=()=>h.page.nextHand('c',1);
      await h.live.pump();assert.equal(h.page.ensureCalls,phase==='preflight'?1:2);
      assert.equal(h.live.autoWinRecovery?.status,'pending');assert.equal(h.live.autoWinRecovery?.attempted,false);
      await h.live.pump();
      assert.equal(h.actor.projection.handOrdinal,3);assert.equal(h.live.autoWinRecovery?.status,'verified');
      assert.equal(h.live.autoWinRecovery?.gameHandKey,h.actor.projection.gameHandKey);
      assert.equal(h.page.ensureCalls,phase==='preflight'?2:3);assert.equal(h.page.sends,0);
      if(phase==='readback')assert.equal(h.live.autoWinRecoveries[1]!.status,'unverified');
    }finally{await h.cleanup();}
  });
});

test('a new hand ending in the same batch needs no toggle',async()=>{
  const h=await handRecoveryScenario();
  try {
    await h.live.synchronize(false);h.page.nextHand('b',1);h.page.endHand(true);await h.live.pump();
    assert.equal(h.actor.projection.matchStatus,'finished');assert.equal(h.live.autoWinRecovery?.trigger,'new-hand');
    assert.equal(h.live.autoWinRecovery?.status,'not-required');assert.equal(h.live.autoWinRecovery?.attempted,false);
    assert.equal(h.page.ensureCalls,1);assert.equal(h.page.sends,0);
  }finally{await h.cleanup();}
});

test('new-hand recovery crosses stdio and pending cannot inherit an initial terminal hand exemption',async t=>{
  for(const initiallyTerminal of [false,true])await t.test(initiallyTerminal?'pending-blocks-report':'new-hand-scope-over-stdio',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'maji-hand-auto-win-broker-'));
    try {
      const page=new HandRecoveryPage(join(directory,'state.sqlite'));page.initialTerminal=initiallyTerminal;
      let drains=0;
      page.beforeDrain=()=>{if(++drains===(initiallyTerminal?2:3))page.nextHand('b',initiallyTerminal?0:1);};
      const report=await acceptLiveViaNode(page,{outputDirectory:join(directory,'run'),databasePath:page.databasePath,
        room:buildPhase1Fixture().projection.room!,sourceVersion:'synthetic-new-hand-recovery',observeMs:150},process.execPath);
      assert.equal(report.status,initiallyTerminal?'blocked':'passed');assert.equal(report.autoWinRecovery.trigger,'new-hand');
      assert.equal(report.autoWinRecovery.status,initiallyTerminal?'pending':'verified');
      assert.equal(report.autoWinRecovery.attempted,!initiallyTerminal);assert.equal(report.lifecycle.handOrdinal,2);
      assert.equal(report.programPaused,true);assert.equal(page.sends,0);assert.equal(page.calls.includes('prepare'),false);
      if(initiallyTerminal) {assert.equal(page.ensureCalls,0);assert.equal(report.autoWinRecoveries[0].status,'not-required');}
      else assert.deepEqual(page.ensureArguments.at(-1),{purpose:'new-hand',expected:{pageEpoch:1,sourceStream:1,generation:3,step:0}});
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});

test('a stale Akagi clock sample keeps ingress available for the new authoritative cursor', async () => {
  const directory = await mkdtemp(join(tmpdir(),'maji-akagi-window-race-'));
  const store = new StorageClient(join(directory,'state.sqlite'));
  const actor = await GameActor.open(store,'akagi-window-race','test-process');
  const page = new ScriptedPage(join(directory,'state.sqlite'));
  const evaluate = page.evaluate.bind(page);
  let advanced = false;
  page.evaluate = async (source, argument) => {
    const { method } = argument as { method: string };
    if (method === 'automaticTiming') {
      advanced = true;
      throw Error('COUNTDOWN_SAMPLE_STALE');
    }
    const result = await evaluate(source, argument);
    if (method === 'read') {
      Object.assign(result, { akagiEnabled: true, phase2ActionsEnabled: true, queued: 0 });
      result.authSummary.otherSeatsAreRobots = true;
      Object.assign(result.authSummary.gameConfig.mode.detail_rule, { dora_count: 3, shiduan: 1, init_point: 25000 });
    }
    if (method === 'drain' && advanced) {
      result.lastStep = 3;
      result.generation++;
      result.records = [{ kind: 'action', name: 'ActionDiscardTile', step: 3, receivedAt: page.at,
        payload: { seat: 1, tile: '0m', moqie: true, is_liqi: false, is_wliqi: false } }];
    }
    return result;
  };
  try {
    const room = structuredClone(buildPhase1Fixture().projection.room!);
    room.rules.verifiedOptions.redFives = 3;
    const session = new LiveGameSession(actor, page, room, true);
    await session.synchronize(false);
    const previous = actor.projection.sourceCursor;
    await assert.rejects(session.synchronize(true, true), /COUNTDOWN_SAMPLE_STALE/);
    assert.equal(actor.control.needsSync, false);
    assert.equal(actor.control.paused, true);
    await session.pump();
    assert.notEqual(actor.projection.sourceCursor, previous);
    assert.equal(actor.projection.state?.latestAction?.actor, 1);
    assert.equal(page.sends, 0);
  } finally {
    await actor.idle();
    await store.close();
    await rm(directory,{recursive:true,force:true});
  }
});

test('settlement failure diagnostics retain only public score fields for reproducing parsing errors',async()=>{
  const h=await scenario('sequence');
  const original=h.page.evaluate.bind(h.page);
  h.page.evaluate=async(source:any,argument?:any)=>{
    const result=await original(source,argument);
    if(argument?.method==='drain' && result.records?.[0]?.name==='ActionNoTile')
      result.records[0].payload={liujumanguan:false,gameend:false,scores:[{seat:0,old_scores:[],delta_scores:[3000,-1000,-1000,-1000]}],hidden:'must-not-export'};
    return result;
  };
  try{
    const report=await acceptLivePage(h.page,h.options);
    assert.ok('code' in report);
    assert.equal(report.code,'INVALID_PROTOCOL_SCORES');
    assert.equal(report.settlementDiagnostics?.name,'ActionNoTile');
    assert.deepEqual(report.settlementDiagnostics?.before,[25000,25000,25000,25000]);
    assert.ok(!JSON.stringify(report.settlementDiagnostics).includes('must-not-export'));
  }finally{await h.cleanup();}
});
