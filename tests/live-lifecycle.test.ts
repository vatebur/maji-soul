import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('production observer follows draw, dealer repeat, abortive draw, next dealer and full match result without sending',async()=>{
  const h=await scenario('sequence');
  try{
    const report=await acceptLiveViaNode(h.page,h.options,process.execPath);
    assert.equal(report.status,'passed',JSON.stringify(report));
    assert.equal(report.scope,'lifecycle-observation');
    assert.deepEqual(report.lifecycle,{handStarts:2,handEnds:3,matchEnds:1,reconnects:0,handOrdinal:3,
      handStatus:'finished',matchStatus:'finished',matchEndPending:false,awaitingSettlement:false,recovering:false});
    assert.equal(h.page.sends,0);assert.equal(report.counts.confirmations,0);
    assert.equal(report.autoWinRecovery?.status,'unverified');assert.equal(report.autoWinRecovery?.code,'AUTO_WIN_READBACK_STALE');
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
  records:any[]=[];ensureCalls=0;uiError:string|null=null;ingressDuringEnsure=false;inputAfterProof=false;lastReadback:any=null;
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
      this.calls.push(method);this.ensureCalls++;
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
    assert.equal(live.autoWinRecovery?.status,'verified');assert.equal(live.autoWinRecovery?.trigger,'reconnect');
    assert.equal(live.autoWinRecovery?.connectionEpoch,2);assert.equal(live.autoWinRecovery?.pageEpoch,2);
    assert.equal(live.autoWinRecovery?.readback?.clicked,true);assert.equal(live.autoWinRecoveries.length,2);
    assert.equal(actor.projection.sessionId,'same-session');assert.equal(actor.control.paused,true);
    assert.equal((await storage.inspect('same-session')).counts.faults,1); // The explicit disconnect only.
    assert.equal(page.sends,0);assert.equal(page.calls.includes('prepare'),false);assert.equal(page.calls.includes('automaticTiming'),false);
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

test('a newer disabled or unknown readback revokes the earlier enabled proof without a generation change',async t=>{
  for (const state of ['disabled','unknown']) await t.test(state,async()=>{
    const directory=await mkdtemp(join(tmpdir(),'maji-auto-win-negative-')),storage=new StorageClient(join(directory,'state.sqlite'));
    try {
      const page=new AutoWinRecoveryPage(join(directory,'state.sqlite'));
      const actor=await GameActor.open(storage,'negative-session','process'),live=new LiveGameSession(actor,page,buildPhase1Fixture().projection.room!);
      await live.synchronize(false);assert.equal(live.autoWinRecovery?.status,'verified');
      const generation=page.generation;page.lastReadback={...page.lastReadback,state};await live.pump();
      assert.equal(page.generation,generation);assert.equal(live.autoWinRecovery?.status,'unverified');
      assert.equal(live.autoWinRecovery?.code,'AUTO_WIN_READBACK_STALE');assert.equal(page.ensureCalls,1);assert.equal(page.sends,0);
      assert.equal((await storage.inspect('negative-session')).counts.faults,0);
    }finally{await storage.close();await rm(directory,{recursive:true,force:true});}
  });
});
