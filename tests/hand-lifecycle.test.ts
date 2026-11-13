import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhase1Fixture, initialView } from '../scripts/build-phase1-fixtures.ts';
import { normalizeAction, normalizeNewRound, normalizeMatchEnd } from '../src/adapters/majsoul/normalize.ts';
import { normalizeSyncGame, type SyncGameContext } from '../src/adapters/majsoul/sync.ts';
import { initialProjection, known, reduceObservation, reduceSync } from '../src/domain/game/reducer.ts';
import { parseSync } from '../src/schemas/game.ts';
import type { GameProjection } from '../src/domain/game/types.ts';

const at = '2026-11-05T00:00:20.000Z';
const base = (count = 4) => buildPhase1Fixture().events.slice(0,count).reduce(reduceObservation,initialProjection('fixture-phase1-discard'));
const context = (projection:GameProjection, step=2) => ({projection,step,sourceStream:'fixture-hand-1',connectionEpoch:0,receivedAt:at});
const end = (p:GameProjection,name:string,payload:unknown,step=2) => normalizeAction(name,payload,context(p,step)).reduce(reduceObservation,p);
const hule = { old_scores:[25000,25000,25000,25000],delta_scores:[4000,-2000,-1000,-1000],scores:[29000,23000,24000,24000],hules:[{seat:0,zimo:true}] };
const standings = {result:{players:[{seat:0,part_point_1:29000},{seat:2,part_point_1:24000},{seat:3,part_point_1:24000},{seat:1,part_point_1:23000}]}};

function restoreSetup(terminal = true, match = false) {
  const room = buildPhase1Fixture().projection.room!, opening = {chang:0,ju:0,ben:0,liqibang:0,left_tile_count:69,scores:[25000,25000,25000,25000],
    tiles:initialView().ownConcealed.map(t=>t.code.endsWith('r')?`0${t.code[1]}`:t.code),doras:['4z'],opens:[],sha256:'a'.repeat(64)};
  const actions:any[]=[{name:'ActionNewRound',step:0,payload:opening}];
  if(terminal)actions.push({name:'ActionHule',step:1,payload:{...hule,...(match?{gameend:{scores:hule.scores}}:{})}});
  const raw={is_end:match,step:actions.length,game_restore:{actions},...(match?{matchResult:standings}:{})};
  const c:SyncGameContext={sessionId:'restored',room,gameMatchKey:'game-stable',gameHandKey:'hand-stable',ownSeat:0,handOrdinal:7,syncId:'s1',connectionEpoch:1,receivedAt:at};
  return {raw,c,opening};
}

test('authoritative win settlement closes the window and rejects mismatched scores or ambiguous winners',()=>{
  const p=base(),done=end(p,'ActionHule',hule);
  assert.equal(done.handStatus,'finished'); assert.equal(done.state!.operationWindow!.status,'closed');
  assert.equal(done.state!.players[0].score,29000); assert.deepEqual(done.handResult?.winners,[0]);
  assert.equal(p.state!.players[0].score,25000);
  for(const malformed of [{...hule,scores:[29001,23000,24000,24000]}, {...hule,old_scores:[25001,25000,25000,25000]},
    {...hule,hules:[{seat:0,zimo:true},{seat:1,zimo:false}]}, {...hule,hules:[{seat:0,zimo:false},{seat:0,zimo:false}]}]) {
    assert.throws(()=>end(p,'ActionHule',malformed),/SETTLEMENT_SCORE_MISMATCH|INVALID_HULE_RESULT/);
  }
});

test('exhaustive draw sums all authoritative score components and refuses an inconsistent old-score vector',()=>{
  const p=base(5); p.state!.tilesRemaining=known(0);
  const payload={liujumanguan:true,gameend:false,scores:[
    {seat:0,old_scores:[25000,25000,25000,25000],delta_scores:[3000,-1000,-1000,-1000]},
    {seat:1,old_scores:[25000,25000,25000,25000],delta_scores:[-2000,6000,-2000,-2000]},
  ]};
  const done=end(p,'ActionNoTile',payload,3);
  assert.deepEqual([0,1,2,3].map(s=>done.state!.players[s as 0|1|2|3].score),[26000,30000,22000,22000]);
  assert.equal(done.handResult!.reason,'draw'); assert.equal(done.handStatus,'finished');
  const bad=structuredClone(payload);bad.scores[1]!.old_scores[0]=28000;
  assert.throws(()=>end(p,'ActionNoTile',bad,3),/SETTLEMENT_SCORE_MISMATCH/);
  assert.equal(end(p,'ActionNoTile',{liujumanguan:false,gameend:false,scores:[]},3).state!.players[0].score,25000);
  const unchanged={liujumanguan:false,gameend:false,scores:[{seat:0,old_scores:[25000,25000,25000,25000],delta_scores:[]}]};
  assert.equal(end(p,'ActionNoTile',unchanged,3).state!.players[0].score,25000);
  assert.throws(()=>end(p,'ActionNoTile',{...unchanged,liujumanguan:true},3),/INVALID_PROTOCOL_SCORES/);
  assert.throws(()=>end(p,'ActionNoTile',{...unchanged,scores:[{...unchanged.scores[0],old_scores:[25001,25000,25000,25000]}]},3),/SETTLEMENT_SCORE_MISMATCH/);
});

test('abortive draw applies only the explicit last riichi deposit and keeps generic reason codes',()=>{
  const p=base();
  const declared=normalizeAction('ActionDiscardTile',{seat:0,tile:'0m',moqie:true,is_liqi:true,is_wliqi:false},context(p)).reduce(reduceObservation,p);
  const done=end(declared,'ActionLiuJu',{type:4,seat:0,liqi:{seat:0,score:24000,liqibang:1,failed:false}},3);
  assert.equal(done.state!.players[0].score,24000);assert.equal(done.state!.riichiSticks,1);
  assert.equal(done.handResult!.reason,'abortive-draw');assert.equal(done.handResult!.resultLabel,'途中流局（4）');
  assert.throws(()=>end(declared,'ActionLiuJu',{type:4,seat:0,liqi:{seat:0,score:25000,liqibang:1,failed:false}},3),/RIICHI_SCORE_MISMATCH/);
});

test('dealer repeat is a new hand even with unchanged round/dealer counters',()=>{
  const p=base(),done=end(p,'ActionLiuJu',{type:1,seat:0});
  done.pendingMode='llm';
  const opening={chang:0,ju:0,ben:1,liqibang:0,left_tile_count:69,scores:[25000,25000,25000,25000],
    tiles:initialView().ownConcealed.map(t=>t.code.endsWith('r')?`0${t.code[1]}`:t.code),doras:['4z'],opens:[]};
  const events=normalizeNewRound(opening,{...context(done,0),sourceStream:'next-hand',ownSeat:0,gameHandKey:'different-commitment',handOrdinal:2});
  const next=events.reduce(reduceObservation,done);
  assert.equal(next.handOrdinal,2);assert.equal(next.state!.honba,1);assert.equal(next.activeMode,'llm');
  assert.notEqual(next.state!.handId,done.state!.handId);assert.equal(next.state!.operationWindow,undefined);
  assert.equal(next.handResult,undefined);assert.equal(next.state!.latestAction,undefined);
});

test('terminal marker closes future rounds while final Notify supplies explicit seat-ordered standings',()=>{
  const p=base(),done=end(p,'ActionHule',{...hule,gameend:{scores:hule.scores}});
  assert.equal(done.matchEndPending,true);assert.equal(done.matchStatus,'playing');
  const nextOpening={...restoreSetup().opening,scores:hule.scores};
  assert.throws(()=>normalizeNewRound(nextOpening,{...context(done,0),sourceStream:'forbidden-next-hand',ownSeat:0,gameHandKey:'forbidden-hand',handOrdinal:2}),/HAND_BOUNDARY_INVALID/);
  const event=normalizeMatchEnd(standings,{projection:done,receivedAt:at,connectionEpoch:0})[0]!;
  assert.equal(event.sourceCursor,undefined);
  const finished=reduceObservation(done,event);
  assert.equal(finished.matchStatus,'finished');assert.equal(finished.matchEndPending,undefined);
  assert.deepEqual(finished.matchResult!.ranks,{0:1,1:4,2:2,3:3});
  assert.equal(finished.matchResult!.scores[0],29000);
  assert.deepEqual(normalizeMatchEnd(standings,{projection:finished,receivedAt:at,connectionEpoch:0}),[]);
  const conflicting=structuredClone(standings);conflicting.result.players[0]!.part_point_1++;
  assert.throws(()=>normalizeMatchEnd(conflicting,{projection:finished,receivedAt:at,connectionEpoch:0}),/MATCH_RESULT_CONFLICT/);
  const duplicate=structuredClone(standings);duplicate.result.players[3]!.seat=0;
  assert.throws(()=>normalizeMatchEnd(duplicate,{projection:done,receivedAt:at,connectionEpoch:0}),/INVALID_FINAL_STANDINGS/);
  assert.throws(()=>normalizeMatchEnd(standings,{projection:p,receivedAt:at,connectionEpoch:0}),/MATCH_RESULT_WITHOUT_HAND_END/);
});

test('complete terminal sync restores a finished hand, permits reconnection and never revives its window',()=>{
  const {raw,c}=restoreSetup(),sync=normalizeSyncGame(raw,c);
  assert.ok(sync.terminal);assert.equal(sync.currentView!.operationWindow,undefined);
  const restored=reduceSync(initialProjection(c.sessionId),sync);
  assert.equal(restored.handOrdinal,7);assert.equal(restored.handStatus,'finished');assert.equal(restored.matchStatus,'playing');
  const next=normalizeSyncGame(raw,{...c,syncId:'s2',connectionEpoch:2});
  assert.equal(reduceSync(restored,next).handStatus,'finished');
  const playing=restoreSetup(false),old=normalizeSyncGame(playing.raw,{...c,syncId:'stale',connectionEpoch:3});
  assert.throws(()=>reduceSync(restored,old),/SYNC_HAND_ALREADY_FINISHED/);
  const missingTerminal=structuredClone(next);delete missingTerminal.terminal;
  assert.throws(()=>reduceSync(initialProjection(c.sessionId),missingTerminal),/SYNC_TERMINAL_STATE_REQUIRED/);
  const changed=structuredClone(next);changed.terminal!.hand.winners=[1];
  assert.throws(()=>reduceSync(restored,changed),/SYNC_HAND_RESULT_CONFLICT/);
  const wrongScore=structuredClone(next);wrongScore.currentView!.players[0].score++;
  assert.throws(()=>reduceSync(restored,wrongScore),/SYNC_TERMINAL_SCORES_MISMATCH/);
  const offered=structuredClone(next);offered.currentView!.operationWindow=structuredClone(base().state!.operationWindow!);
  assert.throws(()=>reduceSync(restored,offered),/SYNC_TERMINAL_WINDOW/);
});

test('full match terminal sync preserves final standings and rejects retracted terminal evidence',()=>{
  const {raw,c}=restoreSetup(true,true),sync=normalizeSyncGame(raw,c),done=reduceSync(initialProjection(c.sessionId),sync);
  assert.equal(done.matchStatus,'finished');assert.equal(done.handStatus,'finished');assert.deepEqual(done.matchResult!.ranks,{0:1,1:4,2:2,3:3});
  const reconnect=normalizeSyncGame(raw,{...c,syncId:'s2',connectionEpoch:2});
  assert.deepEqual(reduceSync(done,reconnect).matchResult,done.matchResult);
  const disconnected=reduceObservation(done,{schemaVersion:1,observationId:'disconnect-final',connectionEpoch:1,source:'majsoul-network',sourceDedupKey:'disconnect-final',
    receivedAt:at,type:'Disconnected',payload:{code:'SOCKET_CLOSED',recoverable:true}});
  assert.equal(disconnected.matchStatus,'finished');assert.deepEqual(reduceSync(disconnected,reconnect).matchResult,done.matchResult);
  const withoutRanks=structuredClone(raw);delete withoutRanks.matchResult;
  const pending=normalizeSyncGame(withoutRanks,{...c,syncId:'s3',connectionEpoch:3});
  assert.equal(reduceSync(initialProjection(c.sessionId),pending).matchEndPending,true);
  assert.throws(()=>reduceSync(done,pending),/SYNC_MATCH_ALREADY_FINISHED/);
  assert.throws(()=>normalizeSyncGame({is_end:true,step:0},c),/SYNC_TERMINAL_EVIDENCE_REQUIRED/);
  const incomplete=structuredClone(sync);incomplete.historyCoverage='none';incomplete.handHistory=[];
  assert.throws(()=>parseSync(incomplete),/SYNC_TERMINAL_HISTORY_REQUIRED/);
});
