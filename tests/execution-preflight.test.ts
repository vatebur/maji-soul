import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor, type ProductionTransport } from '../src/application/game/executor.ts';
import { EgoProductionTransport, type EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import type { ActionAttempt, DecisionSnapshot, FencedActionCommand } from '../src/domain/game/types.ts';
import { actorHarness, AdjustableClock, deferred, redCandidate } from './helpers.ts';

const advance=(clock:AdjustableClock,ms:number)=>{clock.mono+=ms;clock.wall+=ms;};

test('slow preflight follows durable intent and precedes a fresh one-second send permit',async()=>{
  const clock=new AdjustableClock(),h=await actorHarness(4,{clock});
  let sent=0,checked=0;
  h.hooks.set('assertDispatchCurrent',async proceed=>{checked++;return proceed();});
  try{
    const transport:ProductionTransport={kind:'live',invalidate:()=>{},
      preflight:async(snapshot,intent)=>{
        assert.equal((await h.store.getAttempt(intent.id))?.status,'dispatching');
        assert.equal(intent.decisionId,snapshot.id);
        advance(clock,1500);
      },
      prepare:async command=>{
        assert.equal(Date.parse(command.expiresAt)-clock.wall,1000);
        return async()=>{sent++;return{callId:'preflight-contract',delivery:'accepted',observedAt:new Date(clock.wall).toISOString()};};
      }};
    const executor=new ActionExecutor(h.actor,{transport});await h.actor.resume();
    const snapshot=await h.actor.freezeDecision();
    const attempt=await executor.executeLive(snapshot.id,redCandidate(snapshot).id);
    assert.equal(attempt.status,'awaiting-confirmation');assert.equal(sent,1);assert.equal(checked,1);
    assert.equal(executor.diagnostic,null);
  }finally{await h.cleanup();}
});

test('control, ingress and original-window expiration during preflight prevent permission and send',async t=>{
  for(const cause of ['pause','ingress','deadline','readback'] as const)await t.test(cause,async()=>{
    const clock=new AdjustableClock(),h=await actorHarness(4,{clock});let prepared=0,sent=0;
    try{
      const transport:ProductionTransport={kind:'live',invalidate:()=>{},preflight:async()=>{
        advance(clock,1500);
        if(cause==='pause'){h.actor.pause();await h.actor.awaitControlBarrier();}
        if(cause==='ingress')await h.ingest(h.fixture.events[4]!);
        if(cause==='deadline')advance(clock,70000);
        if(cause==='readback')throw Error('AUTO_WIN_READBACK_STALE');
      },prepare:async()=>{prepared++;return async()=>{sent++;throw Error('UNEXPECTED_SEND');};}};
      const executor=new ActionExecutor(h.actor,{transport});await h.actor.resume();
      const snapshot=await h.actor.freezeDecision(),attempt=await executor.executeLive(snapshot.id,redCandidate(snapshot).id);
      assert.equal(attempt.status,'not-dispatched');assert.equal(attempt.receipt?.delivery,'not-sent');
      assert.equal(prepared,0);assert.equal(sent,0);assert.equal(executor.diagnostic?.invocationStarted,false);
      assert.equal(executor.diagnostic?.phase,cause==='readback'?'preflight':'issue-permit');
    }finally{await h.cleanup();}
  });
});

test('the final ledger check still blocks a stale attempt after successful preflight',async()=>{
  const h=await actorHarness();let sent=0,preflight=0,checked=0;
  try{
    h.hooks.set('assertDispatchCurrent',async()=>{checked++;throw Error('ATTEMPT_SCOPE_STALE');});
    const transport:ProductionTransport={kind:'live',invalidate:()=>{},preflight:async()=>{preflight++;},
      prepare:async()=>async()=>{sent++;throw Error('UNEXPECTED_SEND');}};
    const executor=new ActionExecutor(h.actor,{transport});await h.actor.resume();
    const snapshot=await h.actor.freezeDecision(),attempt=await executor.executeLive(snapshot.id,redCandidate(snapshot).id);
    assert.equal(attempt.status,'not-dispatched');assert.equal(preflight,1);assert.equal(checked,1);assert.equal(sent,0);
    assert.deepEqual(executor.diagnostic,{phase:'ledger-check',code:'ATTEMPT_SCOPE_STALE',invocationStarted:false});
  }finally{await h.cleanup();}
});

test('region capture failures preserve only the three exact fixed diagnostics',async t=>{
  const codes=['AUTO_WIN_SCREENSHOT_REGION_INVALID','BROWSER_REGION_CAPTURE_UNAVAILABLE','BROWSER_SCREENSHOT_REGION_INVALID'];
  for(const code of [...codes,'AUTO_WIN_SCREENSHOT_REGION_INVALID_PRIVATE'])await t.test(code,async()=>{
    const h=await actorHarness();let prepared=0;
    try{
      const transport:ProductionTransport={kind:'live',invalidate:()=>{},preflight:async()=>{throw Error(code);},
        prepare:async()=>{prepared++;throw Error('UNEXPECTED_PREPARE');}};
      const executor=new ActionExecutor(h.actor,{transport});await h.actor.resume();
      const snapshot=await h.actor.freezeDecision(),attempt=await executor.executeLive(snapshot.id,redCandidate(snapshot).id);
      assert.equal(attempt.status,'not-dispatched');assert.equal(attempt.receipt?.delivery,'not-sent');assert.equal(prepared,0);
      assert.deepEqual(executor.diagnostic,{phase:'preflight',code:codes.includes(code)?code:'EXECUTION_ERROR',invocationStarted:false});
      assert.equal(JSON.stringify(executor.diagnostic).includes('PRIVATE'),false);
    }finally{await h.cleanup();}
  });
});

async function egoHarness(receiptTimeoutMs=10000) {
  const clock=new AdjustableClock(),h=await actorHarness(4,{clock});
  const calls:string[]=[];let onVerify=async()=>{},onPrepare=async()=>{};
  let prepared:{command:FencedActionCommand;snapshot:DecisionSnapshot;intent:ActionAttempt}|undefined;
  const page:EgoPagePort={evaluate:async(_source,input:any)=>{
    calls.push(input.method);
    if(input.method==='pause')return{paused:input.argument.paused};
    if(input.method==='verifyAutoWin'){await onVerify();return{state:'enabled'};}
    if(input.method==='dispatchPrepared'){
      prepared=input.argument;
      try{await onPrepare();}
      catch(error){return{callId:`bridge:1:not-sent:${error instanceof Error?error.message:'FENCE_STALE'}:00000000-0000-4000-8000-000000000000`,delivery:'not-sent',observedAt:new Date(clock.wall).toISOString()};}
      calls.push('dispatch');
      return{callId:'contract-dispatch',delivery:'accepted',observedAt:new Date(clock.wall).toISOString()};
    }
    if(input.method==='prepare'){prepared=input.argument;await onPrepare();return{token:'contract-token'};}
    if(input.method==='dispatch')return{callId:'contract-dispatch',delivery:'accepted',observedAt:new Date(clock.wall).toISOString()};
    throw Error('UNSCRIPTED_PAGE_METHOD');
  }};
  const transport=new EgoProductionTransport(page),executor=new ActionExecutor(h.actor,{transport,receiptTimeoutMs});
  await h.actor.resume();
  const cursor={pageEpoch:1,generation:0,step:1};
  const timing={source:'protocol-operation' as const,origin:'sync-game' as const,pageEpoch:1,step:1,connectionEpoch:1,
    sampledAt:new Date(clock.wall).toISOString(),sampledMonoMs:0,remainingMs:60000,uncertaintyMs:100,
    fixedMs:60000,addMs:0,elapsedMs:0,networkAllowanceMs:100,quantizationAllowanceMs:0};
  transport.bind(cursor,timing);
  const snapshot=await h.actor.freezeDecision(),candidate=redCandidate(snapshot);
  return{...h,clock,calls,transport,executor,snapshot,candidate,cursor,timing,
    setVerify:(fn:()=>Promise<void>)=>{onVerify=fn;},setPrepare:(fn:()=>Promise<void>)=>{onPrepare=fn;},
    prepared:()=>{assert.ok(prepared);return prepared;}};
}

test('Ego preflight avoids only its matching prepare capture and direct prepare remains fresh',async()=>{
  const h=await egoHarness();
  try{
    h.setVerify(async()=>{advance(h.clock,1500);});
    h.hooks.set('assertDispatchCurrent',async proceed=>{
      assert.equal(h.calls.includes('dispatchPrepared'),false);
      assert.equal(h.calls.includes('prepare'),false);
      return proceed();
    });
    const attempt=await h.executor.executeLive(h.snapshot.id,h.candidate.id);
    assert.equal(attempt.status,'awaiting-confirmation');
    assert.equal(h.calls.filter(call=>call==='verifyAutoWin').length,1);
    assert.equal(h.calls.filter(call=>call==='dispatch').length,1);
    assert.equal(h.calls.filter(call=>call==='dispatchPrepared').length,1);
    assert.equal(h.calls.includes('prepare'),false);
    const {command,snapshot,intent}=h.prepared();
    assert.equal(Date.parse(command.expiresAt)-h.clock.wall,1000);
    await h.transport.prepare(command,snapshot,intent);
    assert.equal(h.calls.filter(call=>call==='verifyAutoWin').length,2,'preflight is single use');
  }finally{await h.cleanup();}
});

test('Ego preflight cannot cross changed intent, snapshot, binding or control',async t=>{
  for(const change of ['intent','snapshot','binding','control'] as const)await t.test(change,async()=>{
    const h=await egoHarness();
    try{
      await h.executor.executeLive(h.snapshot.id,h.candidate.id);
      const {command,snapshot,intent}=h.prepared();
      await h.transport.preflight(snapshot,intent);
      const before=h.calls.filter(call=>call==='verifyAutoWin').length;
      if(change==='binding')h.transport.bind({...h.cursor,generation:1},h.timing);
      if(change==='control')await h.transport.invalidate({...h.actor.control,paused:true});
      await h.transport.prepare(command,change==='snapshot'?{...snapshot,createdAt:new Date(h.clock.wall+1).toISOString()}:snapshot,
        change==='intent'?{...intent,id:'different-attempt'}:intent);
      assert.equal(h.calls.filter(call=>call==='verifyAutoWin').length,before+1);
      assert.equal(h.calls.filter(call=>call==='dispatch').length,1,'direct preparations never dispatch');
    }finally{await h.cleanup();}
  });
});

test('page replacement and control invalidation during Ego preflight cannot send',async t=>{
  for(const changed of ['page','control'] as const)await t.test(changed,async()=>{
    const h=await egoHarness();
    try{
      h.setVerify(async()=>{
        advance(h.clock,1500);
        if(changed==='control')await h.transport.invalidate({...h.actor.control,paused:true});
        else h.setPrepare(async()=>{throw Error('SOURCE_CURSOR_STALE');});
      });
      const attempt=await h.executor.executeLive(h.snapshot.id,h.candidate.id);
      assert.equal(attempt.status,'not-dispatched');assert.equal(h.calls.includes('dispatch'),false);
      assert.equal(h.executor.diagnostic?.invocationStarted,changed==='page');
      assert.equal(h.executor.diagnostic?.code,changed==='page'?'TRANSPORT_NOT_SENT':'FENCE_STALE');
      if(changed==='page')assert.equal(h.executor.diagnostic?.notSentReason,'SOURCE_CURSOR_STALE');
    }finally{await h.cleanup();}
  });
});

test('timed-out Ego preflight cannot publish a late proof or send, and a direct prepare reads again',async()=>{
  const h=await egoHarness(20),ready=deferred();let settled=false,intent:ActionAttempt|undefined;
  try{
    h.hooks.set('markDispatching',async proceed=>{
      const value=await proceed() as {attempt:ActionAttempt};intent=value.attempt;return value;
    });
    const preflight=h.transport.preflight.bind(h.transport);
    h.transport.preflight=async(...args)=>{try{await preflight(...args);}finally{settled=true;}};
    h.setVerify(async()=>{await ready.promise;});
    const attempt=await h.executor.executeLive(h.snapshot.id,h.candidate.id);
    assert.equal(attempt.status,'not-dispatched');assert.equal(h.calls.includes('dispatch'),false);
    assert.deepEqual(h.executor.diagnostic,{phase:'preflight',code:'ACTION_TIMEOUT',invocationStarted:false});
    ready.resolve();while(!settled)await new Promise(resolve=>setTimeout(resolve,0));
    assert.ok(intent);
    const command=h.actor.issuePermit(h.snapshot.id,h.candidate.id,intent.id);
    await h.transport.prepare(command,h.snapshot,intent);
    assert.equal(h.calls.filter(call=>call==='verifyAutoWin').length,2);
    assert.equal(h.calls.includes('dispatch'),false);
  }finally{ready.resolve();await h.cleanup();}
});

test('an older concurrent Ego preflight cannot overwrite the newer one-use proof',async()=>{
  const h=await egoHarness(),ready=deferred();
  try{
    await h.executor.executeLive(h.snapshot.id,h.candidate.id);
    const {command,snapshot,intent}=h.prepared();
    let captures=0;
    h.setVerify(async()=>{if(++captures===1)await ready.promise;});
    const older=h.transport.preflight(snapshot,intent),rejected=assert.rejects(older,/FENCE_STALE/);
    await h.transport.preflight(snapshot,intent);
    ready.resolve();await rejected;
    await h.transport.prepare(command,snapshot,intent);
    assert.equal(captures,2,'latest matching proof remains usable once');
    await h.transport.prepare(command,snapshot,intent);
    assert.equal(captures,3,'the consumed proof cannot be reused');
  }finally{ready.resolve();await h.cleanup();}
});

test('only exact known zero-send guard receipts add a diagnostic reason',async t=>{
  const uuid='00000000-0000-4000-8000-000000000000';
  for(const mode of ['valid','visual-expiry','unknown-code','malformed','prefix','unknown-delivery','visual-expiry-unknown-delivery'] as const)await t.test(mode,async()=>{
    const h=await actorHarness();
    try{
      let callId=`bridge:1:not-sent:PERMIT_EXPIRED:${uuid}`;
      if(mode.startsWith('visual-expiry'))callId=`bridge:1:not-sent:AUTO_WIN_READBACK_EXPIRED:${uuid}`;
      if(mode==='unknown-code')callId=`bridge:1:not-sent:PRIVATE_SECRET:${uuid}`;
      if(mode==='malformed')callId='bridge:1:not-sent:PERMIT_EXPIRED:------------------------------------';
      if(mode==='prefix')callId='untrusted:'+callId;
      const transport:ProductionTransport={kind:'live',invalidate:()=>{},prepare:async()=>async()=>({
        callId,delivery:mode.endsWith('unknown-delivery')?'unknown':'not-sent',observedAt:new Date(h.clock.wallTimeMs()).toISOString(),
      })};
      const executor=new ActionExecutor(h.actor,{transport});await h.actor.resume();
      const snapshot=await h.actor.freezeDecision(),attempt=await executor.executeLive(snapshot.id,redCandidate(snapshot).id);
      assert.equal(attempt.status,mode.endsWith('unknown-delivery')?'uncertain':'not-dispatched');
      assert.equal(executor.diagnostic?.notSentReason,mode==='valid'?'PERMIT_EXPIRED':mode==='visual-expiry'?'AUTO_WIN_READBACK_EXPIRED':undefined);
      assert.equal(JSON.stringify(executor.diagnostic).includes('PRIVATE'),false);
    }finally{await h.cleanup();}
  });
});

test('the combined send closure is consumed before awaiting and cannot retry even a zero-send refusal',async t=>{
  for(const outcome of ['accepted','not-sent'] as const)await t.test(outcome,async()=>{
    const h=await egoHarness(),entered=deferred(),release=deferred();
    try{
      const reserved=await h.store.reserveAction({attemptId:'closure-once',decisionId:h.snapshot.id,actionId:h.candidate.id,
        processInstanceId:h.actor.processInstanceId,executionMode:'live',preparedAt:h.snapshot.createdAt});
      const intent=(await h.store.markDispatching(reserved.attempt.id)).attempt;
      await h.transport.preflight(h.snapshot,intent);
      const command=h.actor.issuePermit(h.snapshot.id,h.candidate.id,intent.id);
      const send=await h.transport.prepare(command,h.snapshot,intent);
      h.setPrepare(async()=>{entered.resolve();await release.promise;if(outcome==='not-sent')throw Error('FENCE_STALE');});
      const first=send(h.candidate);await entered.promise;
      await assert.rejects(send(h.candidate),/PERMIT_INVALID/);
      release.resolve();assert.equal((await first).delivery,outcome);
      await assert.rejects(send(h.candidate),/PERMIT_INVALID/);
      assert.equal(h.calls.filter(call=>call==='dispatchPrepared').length,1);
      assert.equal(h.calls.filter(call=>call==='dispatch').length,outcome==='accepted'?1:0);
    }finally{release.resolve();await h.cleanup();}
  });
});
