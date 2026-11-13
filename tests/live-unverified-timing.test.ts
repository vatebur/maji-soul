import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedPage } from './live-helpers.ts';
import { acceptLivePage } from '../src/app/live.ts';
import { LiveGameSession } from '../src/app/live-session.ts';
import { GameActor } from '../src/application/game/actor.ts';
import { StorageClient } from '../src/adapters/storage/client.ts';
import { EgoProductionTransport } from '../src/adapters/majsoul/ego-transport.ts';
import { ActionExecutor } from '../src/application/game/executor.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';
import type { DecisionSnapshot } from '../src/domain/game/types.ts';

// Synthetic Page only. Actor, SQLite reconciliation, synchronization, final
// execution fences and authoritative discard accounting remain production code.
class TimingPage extends ScriptedPage {
  step:number; generation=0; tail:any[]=[]; incoming:any[]=[]; acquisitions=0; rejected=false; waited=0;
  autoAdvance=false; advanceDuringRejection=false; ended=false; currentTile='0m';
  mutateRead:((value:any)=>void)|null=null;
  readonly mode:'reaction'|'draw';readonly code:string;
  constructor(databasePath:string,mode:'reaction'|'draw',code:string) {
    super(databasePath);this.mode=mode;this.code=code;this.step=mode==='reaction'?1:2;
  }
  append(name:string,payload:any) {
    const action={name,step:++this.step,payload};this.tail.push(action);
    this.incoming.push({...structuredClone(action),kind:'action',receivedAt:this.at,
      pageEpoch:1,generation:++this.generation,sourceStream:0,gameUuid:'contract-only-game-uuid',handSha256:'a'.repeat(64)});
  }
  advance() {
    if(this.mode==='draw') {
      this.append('ActionDiscardTile',{seat:1,tile:this.currentTile,moqie:true,is_liqi:false,is_wliqi:false});
      for(const seat of [2,3,0]) {
        this.append('ActionDealTile',{seat,tile:'',left_tile_count:67-this.step});
        this.append('ActionDiscardTile',{seat,tile:`${seat+1}z`,moqie:true,is_liqi:false,is_wliqi:false});
      }
    }
    this.currentTile='1p';
    this.append('ActionDealTile',{seat:1,tile:this.currentTile,left_tile_count:67-this.step,
      operation:{seat:1,operation_list:[{type:1}],time_fixed:300000,time_add:0}});
  }
  async evaluate(source:any,argument?:any):Promise<any> {
    const method=argument.method;
    if(method==='automaticTiming' && ++this.acquisitions===1) {
      this.calls.push(method);this.rejected=true;
      if(this.advanceDuringRejection)this.advance();
      throw Error(this.code);
    }
    if(method==='releaseAkagi')return {released:true,paused:true};
    if(method==='drain' && this.autoAdvance && this.rejected && !this.tail.length && ++this.waited===2)this.advance();
    const value=await super.evaluate(source,argument);
    if(method==='sync') {
      if(this.mode==='reaction') {
        value.game_restore.actions.splice(2);
        Object.assign(value.game_restore.actions[1].payload,{tile:'5m',operation:{seat:1,
          operation_list:[{type:3,combination:['5m|5m']}],time_fixed:300000,time_add:0}});
      }
      value.game_restore.actions.push(...structuredClone(this.tail));value.step=this.step+1;value.generation=this.generation;
    }
    if(method==='dispatch' && value.delivery==='accepted') {
      this.append('ActionDiscardTile',{seat:1,tile:this.currentTile,moqie:true,is_liqi:false,is_wliqi:false});
      this.append('ActionNoTile',{liujumanguan:false,gameend:true,scores:[]});this.ended=true;
      this.incoming.push({kind:'match-end',payload:{result:{players:[0,1,2,3].map(seat=>({seat,part_point_1:25000}))}},
        receivedAt:this.at,pageEpoch:1,generation:++this.generation,sourceStream:0,
        gameUuid:'contract-only-game-uuid',handSha256:'a'.repeat(64)});
    }
    if(['read','drain'].includes(method)) {
      Object.assign(value,{pageEpoch:1,lastStep:this.step,generation:this.generation,sourceStream:0,handSha256:'a'.repeat(64),
        gameUuid:'contract-only-game-uuid',nativeRestoreRevision:0,nativeRestorePending:false,handEnded:this.ended,matchEnded:this.ended,
        connected:true,freshConnection:true,paused:this.controls.at(-1)?.paused??true,
        controlEpoch:this.controls.at(-1)?.controlEpoch,queued:this.incoming.length,akagiEnabled:true,phase2ActionsEnabled:true});
      if(method==='read') {
        value.authSummary.otherSeatsAreRobots=true;
        Object.assign(value.authSummary.gameConfig.mode.detail_rule,{dora_count:3,shiduan:1,init_point:25000});
        if(this.rejected)this.mutateRead?.(value);
      } else value.records=this.incoming.splice(0);
    }
    if(['ensureAutoWin','verifyAutoWin'].includes(method))Object.assign(value,{step:this.step,generation:this.generation,nativeRestoreRevision:0});
    return value;
  }
}
async function fixture(mode:'reaction'|'draw'='reaction',code='COUNTDOWN_BANK_MISMATCH') {
  const directory=await mkdtemp(join(tmpdir(),'maji-unverified-timing-')),databasePath=join(directory,'state.sqlite');
  const page=new TimingPage(databasePath,mode,code),room=buildPhase1Fixture().projection.room!;
  room.rules.verifiedOptions.redFives=3;
  return {page,room,directory,databasePath,cleanup:()=>rm(directory,{recursive:true,force:true})};
}
async function sessionFixture(mode:'reaction'|'draw'='reaction',code='COUNTDOWN_BANK_MISMATCH') {
  const h=await fixture(mode,code),storage=new StorageClient(h.databasePath);
  const actor=await GameActor.open(storage,'unverified-session','process');
  const transport=new EgoProductionTransport(h.page),executor=new ActionExecutor(actor,{transport});
  const live=new LiveGameSession(actor,h.page,h.room,true);
  await live.synchronize(false);
  return {...h,actor,storage,live,transport,executor,cleanup:async()=>{await actor.idle();await storage.close();await h.cleanup();}};
}
async function reject(h:Awaited<ReturnType<typeof sessionFixture>>) {
  const before=h.actor.projection;
  let error:unknown;
  try{await h.live.synchronize(true,true);}catch(value){error=value;}
  assert.ok(error instanceof Error);assert.equal(error.message,h.page.code);
  return {error,before};
}

test('a rejected first pon/pass window sends nothing and the next fresh draw executes once',async t=>{
  for(const code of ['COUNTDOWN_PROTOCOL_MISMATCH','COUNTDOWN_BANK_MISMATCH'])await t.test(code,async()=>{
    const h=await fixture('reaction',code);h.page.autoAdvance=true;
    let decisions=0;
    try {
      const report=await acceptLivePage(h.page,{outputDirectory:join(h.directory,'run'),databasePath:h.databasePath,
        room:h.room,sourceVersion:'contract-only',akagi:true,resumeMatch:true,observeMs:3000},undefined,()=>({
        init:async()=>{},close:async()=>{},decide:async(snapshot:DecisionSnapshot)=>{
          decisions++;assert.ok(snapshot.legalActions.every(candidate=>candidate.action.kind==='discard'));
          return snapshot.legalActions.find(candidate=>candidate.action.kind==='discard'&&candidate.action.tsumogiri)!;
        }}));
      assert.equal(report.status,'passed',JSON.stringify(report));
      assert.equal(report.automated?.skippedUnverifiedTimingWindows,1);assert.equal(report.automated?.skippedExpiredWindows,0);
      assert.equal(report.automated?.confirmedDiscards,1);assert.equal(report.automated?.acceptedPasses,0);
      assert.equal(h.page.sends,1);assert.equal(decisions,1);assert.equal(h.page.acquisitions,2);
      assert.ok('unverifiedTimingWindowDiscards' in report);assert.equal(report.unverifiedTimingWindowDiscards?.length,0);
    }finally{await h.cleanup();}
  });
});

test('a rejected own draw retains a queued native timeout, attributes it separately, then sends the next draw once',async()=>{
  const h=await fixture('draw');h.page.advanceDuringRejection=true;
  try{
    const report=await acceptLivePage(h.page,{outputDirectory:join(h.directory,'run'),databasePath:h.databasePath,
      room:h.room,sourceVersion:'contract-only',akagi:true,resumeMatch:true,observeMs:3000},undefined,()=>({
      init:async()=>{},close:async()=>{},decide:async(snapshot:DecisionSnapshot)=>
        snapshot.legalActions.find(candidate=>candidate.action.kind==='discard'&&candidate.action.tsumogiri)!}));
    assert.equal(report.status,'passed',JSON.stringify(report));
    assert.ok('counts' in report);
    assert.equal(report.automated?.skippedUnverifiedTimingWindows,1);assert.equal(report.automated?.skippedExpiredWindows,0);
    assert.equal(report.automated?.attempted,1);assert.equal(report.automated?.confirmedDiscards,1);assert.equal(h.page.sends,1);
    assert.ok('unverifiedTimingWindowDiscards' in report);assert.equal(report.unverifiedTimingWindowDiscards?.length,1);
    assert.equal(report.expiredWindowDiscards?.length,0);assert.equal(report.unmatchedOwnDiscards,0);
    assert.equal(report.counts?.confirmations,1);assert.equal(h.page.acquisitions,2);
  }finally{await h.cleanup();}
});

test('unverified timing abandonment requires a real rejection and exact actor/window identity',async t=>{
  for(const fault of ['fake-error','different-window','needs-sync','actor-changed','unresolved'] as const)await t.test(fault,async()=>{
    const h=await sessionFixture();
    try{
      assert.deepEqual(h.actor.projection.state!.operationWindow!.candidates.map(candidate=>candidate.action.kind).sort(),['pass','pon']);
      const {error,before}=await reject(h);
      if(fault==='needs-sync')h.actor.failClosed('TEST_FAULT');
      if(fault==='actor-changed'){h.page.advance();await h.live.pump();}
      if(fault==='unresolved'){
        const inspect=h.storage.inspectMatch.bind(h.storage);
        h.storage.inspectMatch=async key=>({...await inspect(key),unresolvedAttempts:[{status:'uncertain'} as any]});
      }
      await assert.rejects(h.live.skipUnverifiedTimingWindow(fault==='fake-error'?Error(h.page.code):error,
        fault==='different-window'?`${before.sourceCursor}x`:before.sourceCursor!,before.gameHandKey!),
      fault==='unresolved'?/ACTION_RECONCILIATION_REQUIRED/:/UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED/);
      assert.equal(h.page.sends,0);assert.equal(h.page.calls.includes('prepare'),false);
    }finally{await h.cleanup();}
  });
});

test('a rejected timing read cannot inherit changed page, native, control, input, fault or send scope',async t=>{
  const faults:Record<string,(v:any)=>void>={
    page:v=>v.pageEpoch++,game:v=>v.gameUuid='other',hand:v=>v.handSha256='b'.repeat(64),stream:v=>v.sourceStream++,
    restore:v=>v.nativeRestoreRevision++,restoring:v=>v.nativeRestorePending=true,control:v=>v.controlEpoch++,
    resumed:v=>v.paused=false,disconnected:v=>v.connected=false,staleSocket:v=>v.freshConnection=false,
    fault:v=>v.reason='DISCONNECTED',overflow:v=>v.overflow=true,send:v=>v.stats.bridgeActionSends++,
    manualInput:v=>v.generation++,unexplainedStep:v=>v.lastStep++,missingCounter:v=>delete v.stats.bridgeActionSends,
  };
  for(const [name,mutate] of Object.entries(faults))await t.test(name,async()=>{
    const h=await sessionFixture('draw');
    try{
      const {error,before}=await reject(h);h.page.mutateRead=mutate;
      await assert.rejects(h.live.skipUnverifiedTimingWindow(error,before.sourceCursor!,before.gameHandKey!),/UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED/);
      assert.equal(h.page.sends,0);assert.equal(h.live.unverifiedTimingWindowDiscards.size,0);
    }finally{await h.cleanup();}
  });
});

test('the skipped window keeps its page fence across pump awaits and never absorbs manual generations',async t=>{
  for(const stage of ['read-await','ledger-await','pump-page','pump-input','pump-send','pump-record'] as const)await t.test(stage,async()=>{
    const h=await sessionFixture('draw');
    try{
      const {error,before}=await reject(h);
      if(stage==='ledger-await'){
        const inspect=h.storage.inspectMatch.bind(h.storage);
        h.storage.inspectMatch=async key=>{const value=await inspect(key);h.actor.failClosed('ASYNC_FAULT');return value;};
      }else if(stage==='read-await')h.page.mutateRead=()=>h.actor.failClosed('ASYNC_FAULT');
      if(stage.endsWith('-await')){
        await assert.rejects(h.live.skipUnverifiedTimingWindow(error,before.sourceCursor!,before.gameHandKey!),/UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED/);
      }else{
        await h.live.skipUnverifiedTimingWindow(error,before.sourceCursor!,before.gameHandKey!);
        h.page.advance();
        const evaluate=h.page.evaluate.bind(h.page);
        h.page.evaluate=async(source,argument)=>{
          const value=await evaluate(source,argument);
          if((argument as any).method==='drain'){
            if(stage==='pump-page')value.pageEpoch++;
            if(stage==='pump-input')value.generation++;
            if(stage==='pump-send')value.stats.bridgeActionSends++;
            if(stage==='pump-record')value.records[0].pageEpoch++;
          }
          return value;
        };
        await assert.rejects(h.live.pump(),/UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED/);
      }
      assert.equal(h.page.sends,0);assert.equal(h.live.unverifiedTimingWindowDiscards.size,0);
    }finally{await h.cleanup();}
  });
});

test('a same-window native discard with the wrong tile or non-tsumogiri remains unexplained',async t=>{
  for(const kind of ['wrong-tile','not-tsumogiri','riichi'] as const)await t.test(kind,async()=>{
    const h=await sessionFixture('draw');
    try{
      const {error,before}=await reject(h);
      await h.live.skipUnverifiedTimingWindow(error,before.sourceCursor!,before.gameHandKey!);
      h.page.append('ActionDiscardTile',{seat:1,tile:kind==='wrong-tile'?'1m':'0m',moqie:kind!=='not-tsumogiri',is_liqi:kind==='riichi',is_wliqi:false});
      if(kind==='wrong-tile')h.page.incoming[0].payload.moqie=false;
      if(kind==='not-tsumogiri')await assert.rejects(h.live.pump(),/DISCARD_TILE_MISSING/);
      else await h.live.pump();
      assert.equal(h.live.unverifiedTimingWindowDiscards.size,0);assert.equal(h.live.expiredWindowDiscards.size,0);assert.equal(h.page.sends,0);
    }finally{await h.cleanup();}
  });
});

test('observation deadline or cancellation safely closes a still-open rejected window with zero sends',async t=>{
  for(const mode of ['deadline','abort'] as const)await t.test(mode,async()=>{
    const h=await fixture(),abort=new AbortController();
    if(mode==='abort'){
      const evaluate=h.page.evaluate.bind(h.page);
      h.page.evaluate=async(source,argument)=>{
        const result=await evaluate(source,argument);
        if((argument as any).method==='drain' && h.page.rejected)abort.abort();
        return result;
      };
    }
    try{
      const report=await acceptLivePage(h.page,{outputDirectory:join(h.directory,'run'),databasePath:h.databasePath,
        room:h.room,sourceVersion:'contract-only',akagi:true,resumeMatch:true,observeMs:mode==='deadline'?300:3000},abort.signal,()=>({
        init:async()=>{},close:async()=>{},decide:async()=>{throw Error('REJECTED_WINDOW_MUST_NOT_DECIDE');}}));
      assert.ok('lifecycle' in report,JSON.stringify(report));
      if(mode==='deadline'){assert.ok('code' in report);assert.equal(report.code,'MATCH_OBSERVATION_LIMIT');}
      assert.equal(report.recovery.canResume,true);assert.equal(report.programPaused,true);
      assert.equal(report.automated?.skippedUnverifiedTimingWindows,1);assert.equal(report.automated?.attempted,0);
      assert.equal(h.page.acquisitions,1);assert.equal(h.page.sends,0);
    }finally{await h.cleanup();}
  });
});

test('the final pause tolerates only its own control change and preserves timeout attribution fences',async t=>{
  for(const mode of ['native-timeout','second-pause','fault','manual','new-unresolved'] as const)await t.test(mode,async()=>{
    const h=await sessionFixture('draw');
    try{
      const {error,before}=await reject(h);
      await h.live.skipUnverifiedTimingWindow(error,before.sourceCursor!,before.gameHandKey!);
      const evaluate=h.page.evaluate.bind(h.page);
      let inserted=false;
      h.page.evaluate=async(source,argument)=>{
        const result=await evaluate(source,argument);
        if((argument as any).method==='pause' && !inserted){
          inserted=true;
          if(mode==='native-timeout')h.page.advance();
          if(mode==='second-pause')h.actor.pause();
          if(mode==='fault')h.actor.failClosed('ASYNC_FAULT');
          if(mode==='manual')h.page.generation++;
        }
        return result;
      };
      if(mode==='new-unresolved'){
        const inspect=h.storage.inspectMatch.bind(h.storage);
        h.storage.inspectMatch=async key=>({...await inspect(key),unresolvedAttempts:[{status:'uncertain'} as any]});
      }
      if(mode==='native-timeout'){
        await h.live.pauseAndDrain();assert.equal(h.live.unverifiedTimingWindowDiscards.size,1);
      }else{
        await assert.rejects(h.live.pauseAndDrain(),mode==='new-unresolved'?/ACTION_RECONCILIATION_REQUIRED/:/UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED/);
        assert.equal(h.live.unverifiedTimingWindowDiscards.size,0);
      }
      assert.equal(h.page.sends,0);assert.equal(h.actor.control.needsSync,true);
      if(mode==='manual'){
        h.page.generation--;
        // The exceptional needsSync allowance must end with the final drain.
        await assert.rejects(h.live.pump(),/UNVERIFIED_TIMING_WINDOW_SCOPE_CHANGED/);
      }
    }finally{await h.cleanup();}
  });
});
