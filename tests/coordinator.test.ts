import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameCoordinator } from '../src/application/game/coordinator.ts';
import { GameActor } from '../src/application/game/actor.ts';
import { ActionExecutor } from '../src/application/game/executor.ts';
import type { GameObservation, GameProjection, ObservationPayloads } from '../src/domain/game/types.ts';
import { FIXTURE_SESSION, VIRTUAL_NOW } from '../scripts/build-phase1-fixtures.ts';
import { actorHarness, deferred, holdMethod, makeSync, redCandidate } from './helpers.ts';

function handEnd(epoch = 0, stream = 'fixture-hand-1', step = 2): GameObservation {
  return {schemaVersion:1,observationId:`end-${stream}`,connectionEpoch:epoch,source:'majsoul-network',sourceCursor:`${stream}:${step}`,
    sourceDedupKey:`${stream}:${step}:hand-end`,receivedAt:'2026-11-05T00:00:05.000Z',type:'HandEnded',
    payload:{scores:{0:25000,1:25000,2:25000,3:25000},reason:'abortive-draw',winners:[],resultLabel:'contract hand boundary'}};
}
function matchEnd(): GameObservation {
  return {schemaVersion:1,observationId:'match-end',connectionEpoch:0,source:'majsoul-network',sourceDedupKey:'match:end',
    receivedAt:'2026-11-05T00:00:06.000Z',type:'MatchEnded',payload:{scores:{0:25000,1:25000,2:25000,3:25000},ranks:{0:1,1:2,2:3,3:4}}};
}
function terminalSync(actor: GameActor, projection: GameProjection, opening: GameObservation,
  ending: Extract<GameObservation,{type:'HandEnded'}>, result?: ObservationPayloads['MatchEnded']) {
  const sync=makeSync(actor,projection);
  sync.historyCoverage='complete-hand';
  sync.handHistory=[opening,ending].map(event=>({...structuredClone(event),source:'majsoul-sync',connectionEpoch:sync.connectionEpoch}));
  sync.terminal={hand:structuredClone(ending.payload),...(result ? {match:structuredClone(result)} : {})};
  const scores=result?.scores ?? ending.payload.scores;
  for(const seat of [0,1,2,3] as const)sync.currentView!.players[seat].score=scores[seat];
  return sync;
}

test('a hand boundary revokes decisions and permits before persistence and dealer repeat requires explicit resume',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor),controls:{paused:boolean}[]=[];
  try {
    h.actor.attachControlSink(control=>{controls.push(control);});
    await coordinator.resume();
    const before=h.actor.projection,snapshot=await h.actor.freezeDecision(),permit=h.actor.issuePermit(snapshot.id,redCandidate(snapshot).id,'old-hand-permit');
    await h.actor.setPendingMode('llm');
    const held=holdMethod(h.hooks,'commitGameEvent','before'),ending=coordinator.ingest([handEnd()]);
    assert.equal(h.actor.control.paused,true);assert.equal(controls.at(-1)?.paused,true);
    assert.throws(()=>h.actor.consumePermit(permit),/PERMIT_INVALID/);
    assert.throws(()=>h.actor.decision(snapshot.id),/DECISION_STALE/);
    await held.entered;assert.equal(h.actor.projection.handStatus,'playing');
    held.release();await ending;
    await assert.rejects(coordinator.resume(),/GAME_NOT_PLAYING/);
    const next=structuredClone(h.fixture.events[15]!);assert.equal(next.type,'HandStarted');
    if(next.type==='HandStarted')next.payload.ordinal=await coordinator.resolveHandOrdinal('synthetic-match',next.payload.gameHandKey);
    await coordinator.ingest([next,h.fixture.events[16]!]);
    const after=h.actor.projection;
    assert.equal(after.handOrdinal,2);assert.equal(after.state!.dealer,before.state!.dealer);assert.equal(after.state!.handNumber,before.state!.handNumber);
    assert.equal(after.state!.honba,1);assert.notEqual(after.state!.handId,before.state!.handId);
    assert.equal(after.activeMode,'llm');assert.equal(h.actor.control.paused,true);
    await assert.rejects(h.actor.freezeDecision(),/EXECUTION_PAUSED/);
    await coordinator.resume();assert.equal((await h.actor.freezeDecision()).scope.handId,after.state!.handId);
    assert.throws(()=>h.actor.consumePermit(permit),/PERMIT_INVALID/);
    assert.throws(()=>h.actor.issuePermit(snapshot.id,redCandidate(snapshot).id,'late-old-decision'),/DECISION_STALE/);
    await assert.rejects(coordinator.resolveHandOrdinal('synthetic-match','synthetic-hand-1'),/HAND_LEDGER_STALE/);
  }finally{await h.cleanup();}
});

test('a new boundary cannot be undone by a delayed synchronization result',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor);
  try{
    const sync=makeSync(h.actor,h.actor.projection),held=holdMethod(h.hooks,'commitSync'),pending=coordinator.applySync(sync);
    await held.entered;
    const boundary=coordinator.ingest([{...handEnd(1),sourceCursor:'fixture-hand-1:2'}]);
    const rejectedBoundary=assert.rejects(boundary,/SYNC_REQUIRED/);
    held.release();await pending;await rejectedBoundary;
    assert.equal(h.actor.control.paused,true);assert.equal(h.actor.control.needsSync,true);
    await assert.rejects(coordinator.resume(),/SYNC_REQUIRED/);
    await assert.rejects(coordinator.applySync(sync),/STALE_SYNC/);
  }finally{await h.cleanup();}
});

test('an executor prepared in the old hand cannot send after the new hand is committed',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor),prepared=deferred(),release=deferred();let sends=0;
  try{
    const executor=new ActionExecutor(h.actor,{transport:{kind:'contract-test',prepare:async()=>{
      prepared.resolve();await release.promise;return async()=>{sends++;return{callId:'must-not-send',delivery:'accepted',observedAt:VIRTUAL_NOW};};
    }}});
    await coordinator.resume();const snapshot=await h.actor.freezeDecision();
    const action=executor.executeContract(snapshot.id,redCandidate(snapshot).id);await prepared.promise;
    await coordinator.ingest([handEnd(),h.fixture.events[15]!,h.fixture.events[16]!]);
    await assert.rejects(coordinator.resume(),/ACTION_RECONCILIATION_REQUIRED/);
    release.resolve();const attempt=await action;
    assert.equal(attempt.status,'not-dispatched');assert.equal(sends,0);
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.confirmations,0);
    await coordinator.resume();assert.equal(h.actor.projection.handOrdinal,2);
  }finally{release.resolve();await h.cleanup();}
});

test('new hands and sessions retain unresolved attempts in the original match ledger',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor);
  try{
    await coordinator.resume();const snapshot=await h.actor.freezeDecision();
    const {attempt}=await h.store.reserveAction({attemptId:'old-uncertain',decisionId:snapshot.id,actionId:redCandidate(snapshot).id,
      processInstanceId:h.actor.processInstanceId,executionMode:'live',preparedAt:VIRTUAL_NOW});
    await h.store.markDispatching(attempt.id);
    await h.store.recordReceipt(attempt.id,{callId:'network-unknown',delivery:'unknown',observedAt:VIRTUAL_NOW});
    await coordinator.ingest([handEnd(),h.fixture.events[15]!,h.fixture.events[16]!]);
    await assert.rejects(coordinator.resume(),/ACTION_RECONCILIATION_REQUIRED/);
    const nextProjection=h.actor.projection,store=h.createStore(),recovered=await GameActor.open(store,'continued-session','continued-process',{clock:h.clock});
    const continuation=new GameCoordinator(recovered);
    assert.equal(await continuation.resolveHandOrdinal('synthetic-match','synthetic-hand-2'),2);
    const sync=makeSync(recovered,nextProjection);await continuation.applySync(sync);
    assert.equal(recovered.projection.handOrdinal,2);assert.equal(recovered.projection.gameHandKey,'synthetic-hand-2');
    await assert.rejects(continuation.resume(),/ACTION_RECONCILIATION_REQUIRED/);
    const ledger=await store.inspectMatch('synthetic-match');assert.equal(ledger.unresolvedAttempts.length,1);
    assert.equal(ledger.unresolvedAttempts[0]!.id,attempt.id);assert.equal(ledger.unresolvedAttempts[0]!.status,'uncertain');
    assert.deepEqual(ledger.hands.map(hand=>[hand.ordinal,hand.status]),[[1,'finished'],[2,'playing']]);
    assert.equal((await store.inspect('continued-session')).counts.confirmations,0);
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.confirmations,0);
  }finally{await h.cleanup();}
});

test('the original ledger prevents a fresh session from reviving a finished match or relabelling a hand',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor);
  try{
    const playing=h.actor.projection;
    await coordinator.ingest([handEnd(),matchEnd()]);
    await assert.rejects(coordinator.resume(),/GAME_NOT_PLAYING/);
    await assert.rejects(coordinator.resolveHandOrdinal('synthetic-match','synthetic-hand-2'),/MATCH_LEDGER_TERMINAL/);
    const store=h.createStore(),fresh=await GameActor.open(store,'fresh-session','fresh-process',{clock:h.clock});
    const sync=makeSync(fresh,playing);
    await assert.rejects(new GameCoordinator(fresh).applySync(sync),/HAND_LEDGER_TERMINAL/);
    assert.equal((await store.inspect('fresh-session')).projection.sequence,0);
    assert.equal((await store.inspectMatch('synthetic-match')).matchStatus,'finished');
    assert.equal((await store.inspect(FIXTURE_SESSION)).counts.confirmations,0);
  }finally{await h.cleanup();}
});

test('the session owner can restart without losing hand ordinal or reusing an earlier decision',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor);
  try{
    await coordinator.resume();const old=await h.actor.freezeDecision();
    await coordinator.ingest([handEnd(),h.fixture.events[15]!,h.fixture.events[16]!]);
    const current=h.actor.projection,recovered=await GameActor.open(h.createStore(),FIXTURE_SESSION,'restarted-process',{clock:h.clock});
    const continuation=new GameCoordinator(recovered);
    assert.equal(await continuation.resolveHandOrdinal('synthetic-match','synthetic-hand-2'),2);
    await assert.rejects(continuation.resume(),/SYNC_REQUIRED/);
    await continuation.applySync(makeSync(recovered,current));await continuation.resume();
    assert.equal(recovered.projection.handOrdinal,2);assert.throws(()=>recovered.decision(old.id),/DECISION_STALE/);
    assert.equal((await recovered.storage.inspectMatch('synthetic-match')).hands.length,2);
  }finally{await h.cleanup();}
});

test('a complete terminal sync restores the ended match in a new session without reopening execution',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor);
  try{
    const end=handEnd(),finished=matchEnd();assert.equal(end.type,'HandEnded');assert.equal(finished.type,'MatchEnded');
    await coordinator.ingest([end,finished]);const terminal=h.actor.projection;
    const recovered=await GameActor.open(h.createStore(),'terminal-session','terminal-process',{clock:h.clock});
    const continuation=new GameCoordinator(recovered),sync=makeSync(recovered,terminal);
    sync.historyCoverage='complete-hand';
    sync.handHistory=[h.fixture.events[2]!,end].map(event=>({...structuredClone(event),source:'majsoul-sync',connectionEpoch:sync.connectionEpoch}));
    if(end.type==='HandEnded'&&finished.type==='MatchEnded')sync.terminal={hand:end.payload,match:finished.payload};
    await continuation.applySync(sync);
    assert.equal(recovered.projection.handStatus,'finished');assert.equal(recovered.projection.matchStatus,'finished');
    assert.equal(recovered.control.paused,true);await assert.rejects(continuation.resume(),/GAME_NOT_PLAYING/);
    assert.equal((await recovered.storage.inspectMatch('synthetic-match')).hands.length,1);
    assert.equal((await recovered.storage.inspect('terminal-session')).counts.confirmations,0);
  }finally{await h.cleanup();}
});

test('a stale session cannot reserve its saved decision after another session advances the original ledger',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor);
  try{
    await coordinator.resume();const snapshot=await h.actor.freezeDecision();
    // A second session observes the actual new hand while the first Actor has
    // not yet received that ingress. The durable reservation must still refuse.
    const store=h.createStore(),observer=await GameActor.open(store,'other-session','other-process',{clock:h.clock});
    const other=new GameCoordinator(observer);
    await other.applySync(makeSync(observer,h.actor.projection));
    const epoch=observer.projection.connectionEpoch;
    await other.ingest([handEnd(epoch),{...structuredClone(h.fixture.events[15]!),connectionEpoch:epoch}]);
    await assert.rejects(h.store.reserveAction({attemptId:'late-stale-reservation',decisionId:snapshot.id,actionId:redCandidate(snapshot).id,
      processInstanceId:h.actor.processInstanceId,executionMode:'live',preparedAt:VIRTUAL_NOW}),/HAND_LEDGER_STALE/);
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).attempts.length,0);
  }finally{await h.cleanup();}
});

test('a reserved intent cannot enter dispatching after another session advances the same game',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor);let prepares=0,sends=0;
  try{
    await coordinator.resume();const snapshot=await h.actor.freezeDecision();
    const held=holdMethod(h.hooks,'markDispatching','before');
    const executor=new ActionExecutor(h.actor,{transport:{kind:'contract-test',prepare:async()=>{
      prepares++;return async()=>{sends++;return{callId:'must-not-send',delivery:'accepted',observedAt:VIRTUAL_NOW};};
    }}});
    const pending=executor.executeContract(snapshot.id,redCandidate(snapshot).id);await held.entered;
    const observer=await GameActor.open(h.createStore(),'reservation-observer','reservation-observer-process',{clock:h.clock}),other=new GameCoordinator(observer);
    await other.applySync(makeSync(observer,h.actor.projection));const epoch=observer.projection.connectionEpoch;
    await other.ingest([handEnd(epoch),{...structuredClone(h.fixture.events[15]!),connectionEpoch:epoch}]);
    held.release();const attempt=await pending;
    assert.equal(attempt.status,'not-dispatched');assert.equal(attempt.receipt?.delivery,'not-sent');
    assert.equal(prepares,0);assert.equal(sends,0);assert.equal(h.actor.control.paused,true);
    assert.throws(()=>h.actor.decision(snapshot.id),/DECISION_STALE/);
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.confirmations,0);
    assert.equal((await h.store.getAttempt(attempt.id))?.status,'not-dispatched');
  }finally{await h.cleanup();}
});

test('a prepared transport rechecks the shared ledger before consuming its old Actor permit',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor),prepared=deferred(),release=deferred();let sends=0;
  try{
    await coordinator.resume();const snapshot=await h.actor.freezeDecision();
    const executor=new ActionExecutor(h.actor,{transport:{kind:'contract-test',prepare:async()=>{
      prepared.resolve();await release.promise;return async()=>{sends++;return{callId:'must-not-send',delivery:'accepted',observedAt:VIRTUAL_NOW};};
    }}});
    const pending=executor.executeContract(snapshot.id,redCandidate(snapshot).id);await prepared.promise;
    const observer=await GameActor.open(h.createStore(),'prepare-observer','prepare-observer-process',{clock:h.clock}),other=new GameCoordinator(observer);
    await other.applySync(makeSync(observer,h.actor.projection));const epoch=observer.projection.connectionEpoch;
    await other.ingest([handEnd(epoch),{...structuredClone(h.fixture.events[15]!),connectionEpoch:epoch}]);
    assert.equal(h.actor.projection.handOrdinal,1); // No source ingress reached Actor A.
    release.resolve();const attempt=await pending;
    assert.equal(attempt.status,'not-dispatched');assert.equal(attempt.receipt?.delivery,'not-sent');assert.equal(sends,0);
    assert.equal(h.actor.control.paused,true);assert.equal(h.actor.control.needsSync,true);
    assert.throws(()=>h.actor.decision(snapshot.id),/DECISION_STALE/);
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.confirmations,0);
  }finally{release.resolve();await h.cleanup();}
});

for (const conflict of ['hand-scores','hand-reason','hand-winners','match-ranks'] as const) {
  test(`a fresh session cannot overwrite the original ${conflict} settlement`,async()=>{
    const h=await actorHarness(),coordinator=new GameCoordinator(h.actor);
    try{
      const ending=handEnd(),result=matchEnd();assert.equal(ending.type,'HandEnded');assert.equal(result.type,'MatchEnded');
      if(ending.type!=='HandEnded'||result.type!=='MatchEnded')return;
      if(conflict==='hand-winners'){ending.payload.reason='win';ending.payload.winners=[0];}
      await coordinator.ingest(conflict==='match-ranks' ? [ending,result] : [ending]);
      const original=h.actor.projection,store=h.createStore();
      const recovered=await GameActor.open(store,`conflict-${conflict}`,`process-${conflict}`,{clock:h.clock});
      const changed=structuredClone(ending),changedResult=structuredClone(result.payload);
      if(conflict==='hand-scores'){changed.payload.scores[0]=26000;changed.payload.scores[1]=24000;}
      if(conflict==='hand-reason')changed.payload.reason='draw';
      if(conflict==='hand-winners')changed.payload.winners=[1];
      if(conflict==='match-ranks')changedResult.ranks={0:4,1:3,2:2,3:1};
      const sync=terminalSync(recovered,original,h.fixture.events[2]!,changed,conflict==='match-ranks' ? changedResult : undefined);
      await assert.rejects(new GameCoordinator(recovered).applySync(sync),conflict==='match-ranks' ? /MATCH_LEDGER_RESULT_CONFLICT/ : /HAND_LEDGER_RESULT_CONFLICT/);
      const ledger=await store.inspectMatch('synthetic-match');
      assert.deepEqual(ledger.hands[0]!.result,ending.payload);
      if(conflict==='match-ranks')assert.deepEqual(ledger.matchResult,result.payload);
      assert.equal((await store.inspect(`conflict-${conflict}`)).projection.sequence,0);
      assert.equal((await store.inspect(`conflict-${conflict}`)).counts.confirmations,0);
    }finally{await h.cleanup();}
  });
}

test('a concurrent session cannot commit a conflicting hand-end event',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor);
  try{
    const store=h.createStore(),observer=await GameActor.open(store,'terminal-observer','terminal-observer-process',{clock:h.clock}),other=new GameCoordinator(observer);
    await other.applySync(makeSync(observer,h.actor.projection));
    await coordinator.ingest([handEnd()]);
    const changed=handEnd(observer.projection.connectionEpoch);assert.equal(changed.type,'HandEnded');
    if(changed.type==='HandEnded')changed.payload.reason='draw';
    await assert.rejects(other.ingest([changed]),/HAND_LEDGER_RESULT_CONFLICT/);
    assert.equal((await store.inspect('terminal-observer')).counts.events,1);
    assert.equal((await store.inspectMatch('synthetic-match')).hands[0]!.result?.reason,'abortive-draw');
  }finally{await h.cleanup();}
});

test('the original hand settlement permits only a monotonic match-end marker',async()=>{
  const h=await actorHarness(),coordinator=new GameCoordinator(h.actor);
  try{
    const ending=handEnd();assert.equal(ending.type,'HandEnded');if(ending.type!=='HandEnded')return;
    await coordinator.ingest([ending]);const original=h.actor.projection;
    const store=h.createStore(),recovered=await GameActor.open(store,'end-marker-session','end-marker-process',{clock:h.clock});
    const terminal=structuredClone(ending);terminal.payload.matchEnded=true;
    await new GameCoordinator(recovered).applySync(terminalSync(recovered,original,h.fixture.events[2]!,terminal));
    assert.equal((await store.inspectMatch('synthetic-match')).matchStatus,'pending-result');
    assert.equal((await store.inspectMatch('synthetic-match')).hands[0]!.result?.matchEnded,true);
    const later=await GameActor.open(h.createStore(),'end-retraction-session','end-retraction-process',{clock:h.clock});
    await assert.rejects(new GameCoordinator(later).applySync(terminalSync(later,original,h.fixture.events[2]!,ending)),/MATCH_LEDGER_TERMINAL/);
  }finally{await h.cleanup();}
});
