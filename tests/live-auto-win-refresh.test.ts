import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedPage } from './live-helpers.ts';
import { StorageClient } from '../src/adapters/storage/client.ts';
import { GameActor } from '../src/application/game/actor.ts';
import { ActionExecutor } from '../src/application/game/executor.ts';
import { EgoProductionTransport } from '../src/adapters/majsoul/ego-transport.ts';
import { LiveGameSession } from '../src/app/live-session.ts';
import { buildPhase1Fixture } from '../scripts/build-phase1-fixtures.ts';

// The page boundary is synthetic; synchronization, action persistence,
// confirmation and skipped-discard attribution use the production assembly.
class RefreshPage extends ScriptedPage {
  nativeRestoreRevision=0; expired=false; staleRead=false; ensures=0; verifications=0;
  sampledState:'enabled'|'disabled'|null=null; rejectSample=false; sampleAcks=0; sampleBoundary=false;
  step=2; tail:any[]=[]; incoming:any[]=[];
  advance(tile:string,timeout=false,timeoutTile='1p') {
    const append=(name:string,payload:any)=>{
      const record={name,step:++this.step,payload};
      this.tail.push(record);this.incoming.push({...record,kind:'action',receivedAt:this.at});
    };
    if(timeout)append('ActionDiscardTile',{seat:1,tile:timeoutTile,moqie:true,is_liqi:false,is_wliqi:false});
    for(const seat of [2,3,0]) {
      append('ActionDealTile',{seat,tile:'',left_tile_count:67-this.step});
      append('ActionDiscardTile',{seat,tile:`${seat+1}z`,moqie:true,is_liqi:false,is_wliqi:false});
    }
    append('ActionDealTile',{seat:1,tile,left_tile_count:67-this.step,
      operation:{seat:1,operation_list:[{type:1}],time_fixed:300000,time_add:0}});
  }
  async evaluate(source:any,argument?:any):Promise<any> {
    const method=argument.method;
    if(method==='ackAutoWin') {
      this.sampleAcks++;
      if(this.sampleBoundary)this.nativeRestoreRevision++;
      if(this.rejectSample || this.sampleBoundary)throw Error('AUTO_WIN_READBACK_STALE');
      return {state:argument.argument.state,pageEpoch:1};
    }
    if(method==='ensureAutoWin' && ++this.ensures===1) {
      this.calls.push(method);throw Error('AUTO_WIN_READBACK_STALE');
    }
    if(method==='verifyAutoWin') {
      this.verifications++;
      if(this.staleRead){this.calls.push(method);throw Error('AUTO_WIN_READBACK_STALE');}
    }
    const value=await super.evaluate(source,argument);
    if(method==='sync') {
      value.game_restore.actions.push(...structuredClone(this.tail));
      value.step=this.step+1;value.generation=this.sends;
    }
    if(method==='automaticTiming' && this.expired) {
      value.raw.game_restore.passed_waiting_time=299;
      for(const [index,sample] of value.evidence.samples.entries()) {
        sample.passedWaitingTime=index?299:296;sample.displayedRemainingMs=index?1000:4000;
      }
    }
    if(method==='automaticTiming' && this.sampledState) value.autoWinReadback={
      source:'unity-button-pixels-v1',state:this.sampledState,observedAt:new Date().toISOString(),
      pageEpoch:1,generation:this.sends,step:this.step,nativeRestoreRevision:this.nativeRestoreRevision,
      rgbaSha256:'b'.repeat(64),profileVersion:'unity-4.0.51/2036x918',
    };
    if(['read','drain'].includes(method)) {
      Object.assign(value,{lastStep:this.step,generation:this.sends,sourceStream:0,handSha256:'a'.repeat(64),
        gameUuid:'contract-only-game-uuid',nativeRestoreRevision:this.nativeRestoreRevision,
        connected:true,freshConnection:true,paused:this.controls.at(-1)?.paused??true,
        controlEpoch:this.controls.at(-1)?.controlEpoch,queued:0,akagiEnabled:true,phase2ActionsEnabled:true});
      if(method==='read') {
        value.authSummary.otherSeatsAreRobots=true;
        Object.assign(value.authSummary.gameConfig.mode.detail_rule,{dora_count:3,shiduan:1,init_point:25000});
      } else value.records.push(...this.incoming.splice(0));
    }
    if(['ensureAutoWin','verifyAutoWin'].includes(method))
      Object.assign(value,{step:this.step,nativeRestoreRevision:this.nativeRestoreRevision});
    if(method==='dispatch') {
      const record={name:'ActionDiscardTile',step:++this.step,
        payload:{seat:1,tile:'0m',moqie:true,is_liqi:false,is_wliqi:false}};
      this.tail.push(record);
    }
    return value;
  }
}

async function scenario() {
  const directory=await mkdtemp(join(tmpdir(),'maji-refresh-readback-'));
  const storage=new StorageClient(join(directory,'state.sqlite'));
  const actor=await GameActor.open(storage,'refresh-session','process');
  const page=new RefreshPage(join(directory,'state.sqlite'));
  const room=buildPhase1Fixture().projection.room!;room.rules.verifiedOptions.redFives=3;
  const transport=new EgoProductionTransport(page);
  const live=new LiveGameSession(actor,page,room,true);
  const executor=new ActionExecutor(actor,{transport});
  return {page,actor,live,storage,transport,executor,cleanup:async()=>{
    await actor.idle();await storage.close();await rm(directory,{recursive:true,force:true});
  }};
}

test('an expired offer retains read-only verification after initial recovery failed and a real attempt confirmed',async()=>{
  const h=await scenario();
  try {
    await h.live.synchronize(false);
    assert.equal(h.live.autoWinRecovery?.status,'unverified');
    const first=await h.live.synchronize(true,true);
    h.transport.bind({pageEpoch:first.cursor.pageEpoch,generation:first.cursor.generation,step:first.cursor.lastStep},first.timing!);
    await h.live.coordinator.resume();
    const snapshot=await h.actor.freezeDecision();
    const selected=snapshot.legalActions.find(action=>action.action.kind==='discard'&&action.action.tsumogiri)!;
    const attempt=await h.executor.executeLive(snapshot.id,selected.id);
    await h.live.pump();
    assert.equal((await h.storage.getAttempt(attempt.id))?.status,'confirmed');
    assert.equal(h.page.sends,1);
    h.page.advance('1p');await h.live.pump();
    h.page.expired=true;
    const expired=await h.live.synchronize(true,true);
    assert.equal(expired.expiredWindow,true);assert.equal(expired.sync.room.autoWin,'unknown');
    await h.live.skipExpiredWindow(expired.sync.sourceCursor,expired.sync.gameHandKey);
    h.page.advance('2p',true);await h.live.pump();h.page.expired=false;
    assert.equal(h.live.expiredWindowDiscards.size,1);
    h.page.staleRead=true;
    await assert.rejects(h.live.synchronize(true,true),/AUTO_WIN_SAMPLE_STALE/);
    assert.equal(h.actor.control.needsSync,false);
    assert.equal(h.page.ensures,2);assert.equal(h.page.sends,1);
    h.page.staleRead=false;
    const next=await h.live.synchronize(true,true);
    assert.equal(next.autoWinReadback.state,'enabled');assert.equal(next.expiredWindow,false);
    assert.equal(h.page.ensures,2);assert.equal(h.page.sends,1);
    assert.equal((await h.storage.inspectMatch(next.sync.gameMatchKey)).unresolvedAttempts.length,0);
  } finally {await h.cleanup();}
});

test('a new native restore cannot inherit the retained read-only path',async()=>{
  const h=await scenario();
  try {
    await h.live.synchronize(false);await h.live.synchronize(true,true);
    assert.equal(h.page.ensures,2);
    h.page.nativeRestoreRevision++;
    await h.live.synchronize(true,true);
    assert.equal(h.page.ensures,3);assert.equal(h.page.verifications,0);assert.equal(h.page.sends,0);
  } finally {await h.cleanup();}
});

test('a current countdown image avoids a duplicate sync capture while final prepare still verifies afresh',async()=>{
  const h=await scenario();
  try {
    await h.live.synchronize(false);h.page.sampledState='enabled';
    await h.live.synchronize(true,true);
    assert.equal(h.page.sampleAcks,0);assert.equal(h.page.ensures,2); // Initial readiness still uses ensure.
    const fresh=await h.live.synchronize(true,true);
    assert.equal(h.page.sampleAcks,1);assert.equal(h.page.verifications,0);
    h.transport.bind({pageEpoch:fresh.cursor.pageEpoch,generation:fresh.cursor.generation,step:fresh.cursor.lastStep},fresh.timing!);
    await h.live.coordinator.resume();
    const snapshot=await h.actor.freezeDecision();
    const selected=snapshot.legalActions.find(action=>action.action.kind==='discard'&&action.action.tsumogiri)!;
    await h.executor.executeLive(snapshot.id,selected.id);await h.live.pump();
    assert.equal(h.page.verifications,1);assert.equal(h.page.sends,1);
  } finally {await h.cleanup();}
});

test('expired or disabled joint images fall back safely and changed native scope cannot reuse one',async t=>{
  for(const mode of ['expired','disabled','changed'] as const)await t.test(mode,async()=>{
    const h=await scenario();
    try {
      await h.live.synchronize(false);await h.live.synchronize(true,true);
      h.page.sampledState=mode==='disabled'?'disabled':'enabled';
      h.page.rejectSample=mode==='expired';h.page.sampleBoundary=mode==='changed';
      if(mode==='changed')await assert.rejects(h.live.synchronize(true,true),/AUTO_WIN_READBACK_STALE/);
      else await h.live.synchronize(true,true);
      assert.equal(h.page.sampleAcks,1);assert.equal(h.page.sends,0);
      assert.equal(h.page.verifications,mode==='expired'?1:0);
      assert.equal(h.page.ensures,mode==='disabled'?3:2);
    } finally {await h.cleanup();}
  });
});

test('native timeout arriving after expired sync commit stays queued until its skipped offer is marked',async()=>{
  const h=await scenario();
  try {
    await h.live.synchronize(false);h.page.expired=true;
    const apply=h.live.coordinator.applySync.bind(h.live.coordinator);
    h.live.coordinator.applySync=async sync=>{const result=await apply(sync);h.page.advance('2p',true,'0m');return result;};
    const expired=await h.live.synchronize(true,true);
    assert.equal(expired.expiredWindow,true);assert.equal(h.page.incoming.length,8);
    assert.equal(h.live.cursor?.lastStep,2);assert.equal(h.actor.projection.sourceCursor,expired.sync.sourceCursor);
    await h.live.skipExpiredWindow(expired.sync.sourceCursor,expired.sync.gameHandKey);
    await h.live.pump();
    assert.equal(h.page.incoming.length,0);assert.equal(h.live.cursor?.lastStep,10);
    assert.equal(h.live.expiredWindowDiscards.size,1);
    assert.equal((await h.storage.inspect('refresh-session')).counts.outbox,1);
    assert.equal(h.page.sends,0);assert.equal(h.page.calls.includes('prepare'),false);
    assert.equal(h.actor.control.paused,true);
  } finally {await h.cleanup();}
});

test('expired-sync queue preservation rejects changed page, game, hand, native or control scope and faults',async t=>{
  for(const fault of ['pageEpoch','gameUuid','sourceStream','handSha256','nativeRestoreRevision','controlEpoch','paused','reason','overflow','send'] as const)
    await t.test(fault,async()=>{
      const h=await scenario();
      try {
        await h.live.synchronize(false);h.page.expired=true;
        let committed=false;
        const apply=h.live.coordinator.applySync.bind(h.live.coordinator);
        h.live.coordinator.applySync=async sync=>{const result=await apply(sync);h.page.advance('2p',true,'0m');committed=true;return result;};
        const evaluate=h.page.evaluate.bind(h.page);
        h.page.evaluate=async(source,argument)=>{
          const value=await evaluate(source,argument);
          if(committed && argument.method==='read') {
            if(fault==='gameUuid'||fault==='handSha256')value[fault]='changed';
            else if(fault==='paused')value.paused=false;
            else if(fault==='reason')value.reason='DISCONNECTED';
            else if(fault==='overflow')value.overflow=true;
            else if(fault==='send')value.stats.bridgeActionSends++;
            else value[fault]++;
          }
          return value;
        };
        await assert.rejects(h.live.synchronize(true,true),/SYNC_CAPTURE_RACE/);
        assert.equal(h.page.incoming.length,8);assert.equal(h.page.sends,0);
        assert.equal(h.page.calls.includes('prepare'),false);
      } finally {await h.cleanup();}
    });
});

test('an expired-sync read cannot bypass the unresolved-action check before skipping',async()=>{
  const h=await scenario();
  try {
    await h.live.synchronize(false);h.page.expired=true;
    const expired=await h.live.synchronize(true,true);
    const inspect=h.storage.inspectMatch.bind(h.storage);
    h.storage.inspectMatch=async key=>({...await inspect(key),unresolvedAttempts:[{status:'uncertain'} as any]});
    await assert.rejects(h.live.skipExpiredWindow(expired.sync.sourceCursor,expired.sync.gameHandKey),/ACTION_RECONCILIATION_REQUIRED/);
    assert.equal(h.page.sends,0);assert.equal(h.live.expiredWindowDiscards.size,0);
    assert.equal(h.actor.control.paused,true);
  } finally {await h.cleanup();}
});
