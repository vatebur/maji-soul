import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildPhase1Fixture, initialView } from '../scripts/build-phase1-fixtures.ts';
import { createOperationRules, legalOperationActions, mapActionToRequest } from '../src/adapters/majsoul/actions.ts';
import { normalizeAction } from '../src/adapters/majsoul/normalize.ts';
import { normalizeSyncGame } from '../src/adapters/majsoul/sync.ts';
import { StorageClient } from '../src/adapters/storage/client.ts';
import { GameActor } from '../src/application/game/actor.ts';
import { ActionExecutor } from '../src/application/game/executor.ts';
import { ReplayClock } from '../src/application/game/clock.ts';
import { assertWindow, initialProjection, known, reduceObservation, reduceSync } from '../src/domain/game/reducer.ts';
import type { GameProjection, Meld, Seat, TileCode } from '../src/domain/game/types.ts';

const at = '2026-11-05T00:00:20.000Z';
const filler: TileCode[] = ['1p','2p','3p','4p','5p','6p','7p','8p','9p','1s','2s','3s'];
function seed(tiles: TileCode[], dealer: Seat = 0) {
  const events = structuredClone(buildPhase1Fixture().events.slice(0, 3));
  const event = events[2]!; assert.equal(event.type, 'HandStarted');
  if (event.type === 'HandStarted') {
    const view = initialView(); view.dealer = dealer; view.handNumber = dealer + 1; view.seatWind = `${(4 - dealer) % 4 + 1}z` as TileCode;
    view.ownConcealed = tiles.map((code,i) => ({ instanceId: `seed-${i}`, code })); view.currentActor = known(dealer);
    view.drawnTileRef = known(dealer === 0 ? 'seed-13' : null);
    for (const seat of [0,1,2,3] as const) view.players[seat].concealedCount = known(seat === dealer ? 14 : 13);
    event.payload.initialView = view;
  }
  const projection = events.reduce(reduceObservation, initialProjection(events[0]!.observationId.split(':')[0] ?? 'seed'));
  return { events, projection };
}
function normalize(p: GameProjection, name: string, payload: unknown, step = 2, akagi = false) {
  return normalizeAction(name,payload,{ projection:p,sourceStream:'fixture-hand-1',step,receivedAt:at,connectionEpoch:0,akagi,
    timing: { source:'client-countdown', step, sampledAt:at, remainingMs:60000, uncertaintyMs:1000 } });
}
const offer = (type: number, combination?: string[]) => ({ seat:0,operation_list:[{type,...(combination ? {combination} : {})}],time_fixed:60000,time_add:0 });

test('chi, pon and open kan bind the exact red-aware combination index and physical consumed tiles', () => {
  for (const [type, owned, called, combinations] of [
    [2,['3m','4m','5mr'] as TileCode[],'2m',['3m|4m']],
    [3,['5m','5mr','5m'] as TileCode[],'5m',['5m|5m','5m|0m']],
    [5,['5m','5m','5mr'] as TileCode[],'5m',['5m|5m|0m']],
  ] as const) {
    const s = seed([...owned,...filler.slice(0,13-owned.length)],3);
    const events = normalize(s.projection,'ActionDiscardTile',{seat:3,tile:called,moqie:true,is_liqi:false,is_wliqi:false,operation:offer(type,[...combinations])});
    const p=events.reduce(reduceObservation,s.projection), w=p.state!.operationWindow!; assertWindow(p.state!,w);
    assert.equal(w.candidates.length,combinations.length);
    for (const [index,c] of w.candidates.entries()) {
      assert.ok('consumed' in c.action); assert.equal(new Set(c.action.consumed).size,c.action.consumed.length);
      assert.equal(c.action.operation.index,index); assert.equal(c.action.operation.combination,combinations[index]);
      assert.deepEqual(mapActionToRequest(c.action,p.state!,offer(type,[...combinations])),{method:'.lq.FastTest.inputChiPengGang',params:{type,index,timeuse:0}});
    }
    const selected=w.candidates.at(-1)!; assert.ok('consumed' in selected.action);
    const tampered=structuredClone(selected.action); tampered.operation.index=99;
    assert.throws(()=>mapActionToRequest(tampered,p.state!,offer(type,[...combinations])),/ACTION_NOT_LEGAL/);
  }
});

test('ambiguous indexes, wrong chi source, nonexistent red tiles and unsupported opcodes close mapping', () => {
  const s=seed(['3m','4m','5m',...filler.slice(0,10)],3);
  const e=normalize(s.projection,'ActionDiscardTile',{seat:3,tile:'2m',moqie:true,is_liqi:false,is_wliqi:false});
  const state=e.reduce(reduceObservation,s.projection).state!;
  assert.throws(()=>legalOperationActions(state,offer(2,['3m|4m','4m|3m']),'w','e'),/AMBIGUOUS_COMBINATION_INDEX/);
  assert.throws(()=>legalOperationActions(state,offer(2,['3m|0m']),'w','e'),/INVALID_CHI|COMBINATION_TILE_MISSING/);
  const bad=structuredClone(state); bad.latestAction!.actor=2;
  assert.throws(()=>legalOperationActions(bad,offer(2,['3m|4m']),'w','e'),/INVALID_CALL_COMBINATION|INVALID_CHI/);
  assert.throws(()=>legalOperationActions(state,offer(11),'w','e'),/UNSUPPORTED_OPERATION/);
});

test('kuikae bans all physical variants of a forbidden rank while riichi only permits exact listed discards', () => {
  const state=seed(['5m','5mr',...filler]).projection.state!;
  const offered={seat:0,operation_list:[{type:1,combination:['5m']},{type:7,combination:['0m','9p']}]};
  const candidates=legalOperationActions(state,offered,'w','e');
  const ordinary=candidates.filter(c=>c.action.kind==='discard');
  assert.equal(ordinary.length,12);
  assert.ok(ordinary.every(c=>{const action=c.action;return action.kind==='discard'&&!state.ownConcealed.find(t=>t.instanceId===action.tile)!.code.startsWith('5m');}));
  const reach=candidates.filter(c=>c.action.kind==='riichi-discard'); assert.equal(reach.length,2);
  for(const c of reach) { assert.equal(mapActionToRequest(c.action,state,offered).params.type,7); }
});

test('observed duplicate riichi tiles bind each physical copy once and retain the first raw index', () => {
  const page=(0,eval)(`(${createOperationRules.toString()})`)() as ReturnType<typeof createOperationRules>;
  for(const drawn of ['5s','2p'] as const) {
    const tiles:TileCode[]=drawn==='5s'?['2p','2p',...filler.filter(t=>t!=='2p')]:['2p',...filler.filter(t=>t!=='2p'),'4s'];
    const s=seed(tiles,3);
    const before=normalize(s.projection,'ActionDiscardTile',{seat:3,tile:'9m',moqie:true,is_liqi:false,is_wliqi:false}).reduce(reduceObservation,s.projection);
    // The real failing offer was type 1 [] plus type 7 ['2p','2p'].
    const offered={seat:0,time_fixed:60000,time_add:0,operation_list:[{type:1,combination:[]},{type:7,combination:['2p','2p']}]};
    const original=structuredClone(offered);
    const p=normalize(before,'ActionDealTile',{seat:0,tile:drawn,left_tile_count:68,operation:offered},3).reduce(reduceObservation,before);
    const window=p.state!.operationWindow!;assertWindow(p.state!,window);
    const reach=window.candidates.filter(c=>c.action.kind==='riichi-discard');assert.equal(reach.length,2);
    assert.equal(new Set(reach.map(c=>c.id)).size,2);assert.equal(new Set(reach.map(c=>c.action.kind==='riichi-discard'&&c.action.tile)).size,2);
    assert.deepEqual(page.legalOperationActions(p.state!,offered,'w','e').map(c=>c.action),window.candidates.map(c=>c.action));
    assert.equal(reach.filter(c=>c.action.kind==='riichi-discard'&&c.action.tsumogiri).length,drawn==='2p'?1:0);
    for(const candidate of reach) {
      const action=candidate.action;assert.equal(action.kind,'riichi-discard');if(action.kind!=='riichi-discard')throw Error('WRONG_KIND');
      assert.deepEqual(action.operation,{type:7,index:0,combination:'2p'});
      const expected={method:'.lq.FastTest.inputOperation',params:{type:7,tile:'2p',moqie:action.tsumogiri,timeuse:0}};
      assert.deepEqual(mapActionToRequest(action,p.state!,offered),expected);assert.deepEqual(page.mapActionToRequest(action,p.state!,offered),expected);
      const forged={...action,operation:{...action.operation,index:1}};
      assert.throws(()=>mapActionToRequest(forged,p.state!,offered),/ACTION_NOT_LEGAL/);
      assert.throws(()=>page.mapActionToRequest(forged,p.state!,offered),/ACTION_NOT_LEGAL/);
    }
    assert.deepEqual(offered,original);
  }
});

test('duplicate riichi allowlists preserve red identity without relaxing indexed operations or discard restrictions', () => {
  const state=seed(['5mr','5m',...filler]).projection.state!,offered=offer(7,['0m','0m','5m','5m']);
  const candidates=legalOperationActions(state,offered,'w','e');assert.equal(candidates.length,2);
  assert.deepEqual(candidates.map(c=>mapActionToRequest(c.action,state,offered).params.tile),['0m','5m']);
  assert.deepEqual(candidates.map(c=>'operation'in c.action&&c.action.operation.index),[0,2]);
  for(const [type,combination] of [[1,'2p'],[2,'3m|4m'],[3,'5m|5m'],[4,'5m|0m|5m|5m'],[5,'5m|5m|0m'],[6,'5m|5m|5m']] as const)
    assert.throws(()=>legalOperationActions(state,offer(type,[combination,combination]),'w','e'),/AMBIGUOUS_COMBINATION_INDEX/);
  assert.throws(()=>legalOperationActions(state,offer(7,['2p|2p','2p|2p']),'w','e'),/INVALID_PROTOCOL_COMBINATION/);
});

test('closed kan binds all four physical tiles and normalizes authority before the replacement draw', () => {
  const s=seed(['5m','5mr','5m','5m',...filler.slice(0,10)]),state=s.projection.state!;
  const c=legalOperationActions(state,offer(4,['5m|0m|5m|5m']),'w','e')[0]!;
  assert.ok('consumed' in c.action); assert.equal(c.action.consumed.length,4);
  assert.deepEqual(mapActionToRequest(c.action,state,offer(4,['5m|0m|5m|5m'])),{method:'.lq.FastTest.inputOperation',params:{type:4,index:0,timeuse:0}});
  const p=normalize(s.projection,'ActionAnGangAddGang',{seat:0,type:3,tiles:'5m',doras:[]}).reduce(reduceObservation,s.projection);
  assert.equal(p.state!.ownConcealed.length,10); assert.equal(p.state!.players[0].melds[0]!.kind,'closed-kan');
  const drawn=normalize(p,'ActionDealTile',{seat:0,tile:'4s',left_tile_count:68,operation:offer(1)},3).reduce(reduceObservation,p);
  assert.equal(drawn.state!.ownConcealed.length,11); assertWindow(drawn.state!,drawn.state!.operationWindow!);
});

test('opponent closed five kan restores its red tile under the verified three-red room rule', () => {
  const {projection} = seed(['1m','2m',...filler.slice(0,11)], 3);
  const payload = {seat:3,type:3,tiles:'5m',doras:[]};
  projection.room!.rules.verifiedOptions.redFives = 3;
  const events = normalize(projection,'ActionAnGangAddGang',payload);
  const meld = events.find(event=>event.type==='MeldDeclared');
  assert.deepEqual(meld?.payload.meld.tiles,['5mr','5m','5m','5m']);
  projection.room!.rules.verifiedOptions.redFives = 2;
  assert.throws(()=>normalize(projection,'ActionAnGangAddGang',payload),/RED_FIVE_RULE_UNVERIFIED/);
});

test('added kan identifies one existing pon and the exact fourth tile including red identity', () => {
  const state=seed(['5mr',...filler.slice(0,10),'4s','6s','7s']).projection.state!;
  state.ownConcealed=state.ownConcealed.slice(0,11); state.players[0].concealedCount=known(11); state.drawnTileRef=known(state.ownConcealed[0]!.instanceId);
  const pon: Meld={id:'existing-pon',actor:0,kind:'pon',tiles:['5m','5m','5m'],fromSeat:2,calledTileIndex:1}; state.players[0].melds=[pon];
  const c=legalOperationActions(state,offer(6,['5m|5m|5m']),'w','e')[0]!; assert.ok('consumed' in c.action);
  assert.equal(c.action.kind,'added-kan'); assert.equal(c.action.upgradedFrom,pon.id); assert.deepEqual(c.action.tiles,['5m','5m','5m','5mr']);
  assert.equal(c.action.consumed[0],state.ownConcealed[0]!.instanceId);
  assert.deepEqual(mapActionToRequest(c.action,state,offer(6,['5m|5m|5m'])),{method:'.lq.FastTest.inputOperation',params:{type:6,index:0,timeuse:0}});
  const current=legalOperationActions(state,offer(6,['5m|5m|5m|0m']),'current','e')[0]!;
  assert.deepEqual(current.action,{...c.action,operation:{type:6,index:0,combination:'5m|5m|5m|0m'}});
  assert.deepEqual(mapActionToRequest(current.action,state,offer(6,['5m|5m|5m|0m'])),{method:'.lq.FastTest.inputOperation',params:{type:6,index:0,timeuse:0}});
  assert.throws(()=>legalOperationActions(state,offer(6,['5m|5m|5m|5m']),'invalid','e'),/INVALID_ADDED_KAN_TILES/);
});

test('a client winning offer suppresses every program candidate including reach and kan', () => {
  const state=seed(['5m','5mr','5m','5m',...filler.slice(0,10)]).projection.state!;
  const candidates=legalOperationActions(state,{seat:0,operation_list:[{type:1},{type:4,combination:['5m|0m|5m|5m']},{type:8}]},'w','e');
  assert.deepEqual(candidates.map(c=>c.action),[{kind:'tsumo'}]); assert.equal(candidates[0]!.authority,'client-auto-win');
  assert.throws(()=>mapActionToRequest(candidates[0]!.action,state,offer(8)),/CLIENT_AUTO_WIN_WINDOW/);
});

test('serialized Page rules use the same candidate validation and request selection as Node', () => {
  const factory=(0,eval)(`(${createOperationRules.toString()})`) as typeof createOperationRules;
  const page=factory(), state=seed(['5m','5mr','5m','5m',...filler.slice(0,10)]).projection.state!, offered=offer(4,['5m|0m|5m|5m']);
  const action=legalOperationActions(state,offered,'w','e')[0]!.action;
  assert.deepEqual(page.mapActionToRequest(action,state,offered),mapActionToRequest(action,state,offered));
  const tampered=structuredClone(action); assert.ok('consumed' in tampered); tampered.consumed[0]='old-generation';
  assert.throws(()=>page.mapActionToRequest(tampered,state,offered),/ACTION_NOT_LEGAL/);
});

test('added-kan authority upgrades the recorded pon without losing its called tile', () => {
  const s=seed(['5mr',...filler.slice(0,10),'4s','6s','7s']), state=s.projection.state!;
  state.ownConcealed=state.ownConcealed.slice(0,11); state.players[0].concealedCount=known(11); state.drawnTileRef=known(state.ownConcealed[0]!.instanceId);
  state.players[2].river=[{tile:'5m',tsumogiri:true,riichiDeclaration:false,calledBy:0,eventId:'called-five'}];
  state.players[0].melds=[{id:'pon-before',actor:0,kind:'pon',tiles:['5m','5m','5m'],fromSeat:2,calledTileIndex:1}];
  const events=normalize(s.projection,'ActionAnGangAddGang',{seat:0,type:2,tiles:'0m',doras:[]});
  const p=events.reduce(reduceObservation,s.projection), meld=p.state!.players[0].melds[0]!;
  assert.equal(meld.kind,'added-kan'); assert.equal(meld.upgradedFrom,'pon-before'); assert.equal(meld.tiles[3],'5mr');
  assert.equal(p.state!.ownConcealed.length,10); assert.equal(p.state!.players[0].melds.length,1);
});

test('complete reconnect history rebuilds the current call source and rekeys consumed references', () => {
  const room=buildPhase1Fixture().projection.room!, raw={step:3,is_end:false,game_restore:{actions:[
    {name:'ActionNewRound',step:1,payload:{chang:0,ju:3,ben:0,liqibang:0,tiles:['3m','4m',...filler.slice(0,11)],doras:['4z'],scores:[25000,25000,25000,25000],left_tile_count:69,opens:[]}},
    {name:'ActionDiscardTile',step:2,payload:{seat:3,tile:'2m',moqie:true,is_liqi:false,is_wliqi:false,operation:offer(2,['3m|4m'])}},
  ]}};
  const sync=normalizeSyncGame(raw,{sessionId:'sync-reaction',room,gameMatchKey:'game',gameHandKey:'hand',ownSeat:0,handOrdinal:1,syncId:'sync',connectionEpoch:1,receivedAt:at,
    timing:{source:'client-countdown',step:2,sampledAt:at,remainingMs:60000,uncertaintyMs:1000}});
  const p=reduceSync(initialProjection('sync-reaction'),sync),state=p.state!,candidate=state.operationWindow!.candidates[0]!;
  assertWindow(state,state.operationWindow!); assert.ok('consumed' in candidate.action);
  assert.ok(candidate.action.consumed.every(id=>state.ownConcealed.some(t=>t.instanceId===id)));
  assert.equal(state.latestAction?.actor,3); assert.equal(state.latestAction?.tiles[0],'2m');
  assert.equal(state.latestAction?.eventId,state.players[3].river.at(-1)!.eventId);
  assert.equal(p.sequence,1);
});

test('restored pon keeps the same duplicate-tile binding after current-view rekeying', () => {
  const operation = offer(3, ['5m|5m']);
  const discard = (step: number, seat: Seat, tile: TileCode, moqie: boolean) => ({
    name: 'ActionDiscardTile', step, payload: { seat, tile, moqie, is_liqi: false, is_wliqi: false },
  });
  const draw = (step: number, seat: Seat, left_tile_count: number, tile?: TileCode) => ({
    name: 'ActionDealTile', step, payload: { seat, left_tile_count, ...(tile ? { tile } : {}) },
  });
  const called = discard(9, 1, '5m', true);
  const actions = [
    { name: 'ActionNewRound', step: 0, payload: { chang: 0, ju: 1, ben: 0, liqibang: 0,
      tiles: ['5m', ...filler.slice(0, 11), '9s'], doras: ['4z'], scores: [25000, 25000, 25000, 25000],
      left_tile_count: 69, opens: [] } },
    discard(1, 1, '1z', false),
    draw(2, 2, 68), discard(3, 2, '2z', true),
    draw(4, 3, 67), discard(5, 3, '3z', true),
    draw(6, 0, 66, '5m'), discard(7, 0, '9s', false),
    draw(8, 1, 65), { ...called, payload: { ...called.payload, operation } },
  ];
  const sessionId = 'sync-duplicate-pon', room = buildPhase1Fixture().projection.room!;
  const sync = normalizeSyncGame({ step: 10, is_end: false, game_restore: { actions } }, {
    sessionId, room, gameMatchKey: 'game', gameHandKey: 'hand', ownSeat: 0, handOrdinal: 1,
    syncId: 'sync', connectionEpoch: 1, receivedAt: at,
  });
  const state = reduceSync(initialProjection(sessionId), sync).state!;
  const action = state.operationWindow!.candidates[0]!.action;
  assert.deepEqual(mapActionToRequest(action, state, operation), {
    method: '.lq.FastTest.inputChiPengGang', params: { type: 3, index: 0, timeuse: 0 },
  });
});

test('restored pon and added-kan identities stay stable across session and connection generations', () => {
  const actions: {name:string;step:number;payload:Record<string,unknown>}[]=[
    {name:'ActionNewRound',step:1,payload:{chang:0,ju:3,ben:0,liqibang:0,tiles:['5m','5m',...filler.slice(0,11)],doras:['4z'],scores:[25000,25000,25000,25000],left_tile_count:69,opens:[]}},
    {name:'ActionDiscardTile',step:2,payload:{seat:3,tile:'5m',moqie:true,is_liqi:false,is_wliqi:false}},
    {name:'ActionChiPengGang',step:3,payload:{seat:0,type:1,tiles:['5m','5m','5m'],froms:[0,0,3]}},
    {name:'ActionDiscardTile',step:4,payload:{seat:0,tile:'1p',moqie:false,is_liqi:false,is_wliqi:false}},
  ];
  for(const [seat,tile] of [[1,'9s'],[2,'2z'],[3,'3z']] as const) {
    actions.push({name:'ActionDealTile',step:actions.length+1,payload:{seat,left_tile_count:69-seat}});
    actions.push({name:'ActionDiscardTile',step:actions.length+1,payload:{seat,tile,moqie:true,is_liqi:false,is_wliqi:false}});
  }
  actions.push({name:'ActionDealTile',step:11,payload:{seat:0,tile:'0m',left_tile_count:65}});
  actions.push({name:'ActionAnGangAddGang',step:12,payload:{seat:0,type:2,tiles:'0m'}});
  const raw={step:13,is_end:false,game_restore:{actions}}, context={room:buildPhase1Fixture().projection.room!,gameMatchKey:'stable-game',gameHandKey:'stable-hand',ownSeat:0 as const,handOrdinal:1,receivedAt:at};
  const first=normalizeSyncGame(raw,{...context,sessionId:'old-session',connectionEpoch:1,syncId:'old-sync'});
  const second=normalizeSyncGame(raw,{...context,sessionId:'new-session',connectionEpoch:2,syncId:'new-sync'});
  const oldMelds=first.observedActions.filter(event=>event.type==='MeldDeclared'),newMelds=second.observedActions.filter(event=>event.type==='MeldDeclared');
  assert.equal(oldMelds.length,2);
  assert.deepEqual(oldMelds.map(event=>event.payload.meld),newMelds.map(event=>event.payload.meld));
  assert.notDeepEqual(oldMelds.map(event=>event.payload.consumed),newMelds.map(event=>event.payload.consumed));
  assert.equal(newMelds[1]!.payload.meld.upgradedFrom,newMelds[0]!.payload.meld.id);
});

test('durable meld intent confirms only the matching authoritative event and survives restart', async () => {
  const directory=await mkdtemp(join(tmpdir(),'maji-phase2-ledger-')),store=new StorageClient(join(directory,'state.sqlite'));
  const session='phase2-ledger',clock=new ReplayClock(at),actor=await GameActor.open(store,session,'process', {clock});
  try {
    const s=seed(['3m','4m',...filler.slice(0,11)],3);
    for(const event of s.events) await actor.ingest(event);
    for(const event of normalize(actor.projection,'ActionDiscardTile',{seat:3,tile:'2m',moqie:true,is_liqi:false,is_wliqi:false,operation:offer(2,['3m|4m'])})) await actor.ingest(event);
    await actor.resume(); const snapshot=await actor.freezeDecision();
    const executor=new ActionExecutor(actor,{transport:{kind:'contract-test',prepare:async()=>async()=>({callId:'meld-receipt',delivery:'accepted',observedAt:at})}});
    const attempt=await executor.executeContract(snapshot.id,snapshot.legalActions[0]!.id);
    assert.equal(attempt.status,'awaiting-confirmation'); assert.equal(attempt.expectedAction?.kind,'meld'); assert.equal((await store.inspect(session)).counts.confirmations,0);
    // Wire orders the called tile first; confirmation matches its identity, not our synthetic array order.
    const ownMeldEvents=normalize(actor.projection,'ActionChiPengGang',{seat:0,type:0,tiles:['2m','3m','4m'],froms:[3,0,0]},3);
    for(const event of ownMeldEvents) await actor.ingest(event);
    const originalMeld=ownMeldEvents.find(event=>event.type==='MeldDeclared'); assert.ok(originalMeld?.type==='MeldDeclared');
    assert.equal((await store.getAttempt(attempt.id))?.status,'confirmed'); assert.equal((await store.inspect(session)).counts.confirmations,1);
    const replacement=new StorageClient(join(directory,'state.sqlite'));
    try {
      const resumed=await GameActor.open(replacement,'phase2-new-session','new-process',{clock:new ReplayClock(at)});
      const current=actor.projection,raw={step:4,is_end:false,game_restore:{actions:[
        {name:'ActionNewRound',step:1,payload:{chang:0,ju:3,ben:0,liqibang:0,tiles:['3m','4m',...filler.slice(0,11)],doras:['4z'],scores:[25000,25000,25000,25000],left_tile_count:69,opens:[]}},
        {name:'ActionDiscardTile',step:2,payload:{seat:3,tile:'2m',moqie:true,is_liqi:false,is_wliqi:false}},
        {name:'ActionChiPengGang',step:3,payload:{seat:0,type:0,tiles:['2m','3m','4m'],froms:[3,0,0]}},
      ]}};
      let previousRefs=originalMeld.payload.consumed;
      for(const epoch of [1,2]) {
        const token=resumed.beginSync(); assert.equal(token.connectionEpoch,epoch);
        const sync=normalizeSyncGame(raw,{...token,sessionId:'phase2-new-session',room:current.room!,gameMatchKey:current.gameMatchKey!,gameHandKey:current.gameHandKey!,ownSeat:0,handOrdinal:1,receivedAt:at,sourceStream:'fixture-hand-1'});
        const restored=sync.observedActions.find(event=>event.type==='MeldDeclared'); assert.ok(restored?.type==='MeldDeclared');
        assert.notDeepEqual(restored.payload.consumed,previousRefs);
        assert.deepEqual(restored.payload.meld,originalMeld.payload.meld);
        previousRefs=restored.payload.consumed;
        await resumed.applySync(sync);
        assert.equal((await replacement.getAttempt(attempt.id))?.status,'confirmed');
      }
      const db=new DatabaseSync(join(directory,'state.sqlite'),{readOnly:true});
      try {
        assert.equal(db.prepare('SELECT count(*) AS n FROM observed_actions').get()?.n,2);
        assert.equal(db.prepare('SELECT count(*) AS n FROM action_confirmations').get()?.n,1);
        assert.equal((await replacement.inspect(session)).counts.confirmations,1);
        assert.equal((await replacement.inspect('phase2-new-session')).counts.confirmations,0);
      } finally {db.close();}
    }
    finally { await replacement.close(); }
  } finally { await actor.idle(); await store.close(); await rm(directory,{recursive:true,force:true}); }
});

test('a riichi intent cannot be confirmed by an otherwise identical ordinary discard', async t => {
  for(const declaration of [false,true]) await t.test(String(declaration),async()=>{
    const directory=await mkdtemp(join(tmpdir(),'maji-riichi-ledger-')),store=new StorageClient(join(directory,'state.sqlite'));
    const actor=await GameActor.open(store,'riichi-ledger','process',{clock:new ReplayClock(at)});
    try {
      const s=seed(['5mr',...filler,'4s']);
      for(const event of s.events) await actor.ingest(event);
      const base=buildPhase1Fixture().events[3]!; assert.ok(base.type==='OperationOffered');
      const state=actor.projection.state!,candidates=legalOperationActions(state,offer(7,['0m']),'reach-window','reach-evidence');
      await actor.ingest({...base,observationId:'reach-offer',sourceDedupKey:'reach-offer',receivedAt:at,payload:{window:{id:'reach-window',connectionEpoch:0,openedAt:at,deadline:known({at:'2026-11-05T00:01:20.000Z',sourceEventId:'reach-evidence',uncertaintyMs:1000}),status:'open',candidates}}});
      await actor.resume(); const snapshot=await actor.freezeDecision();
      const executor=new ActionExecutor(actor,{transport:{kind:'contract-test',prepare:async()=>async()=>({callId:'reach-response',delivery:'accepted',observedAt:at})}});
      const intent=await executor.executeContract(snapshot.id,snapshot.legalActions[0]!.id);
      for(const event of normalize(actor.projection,'ActionDiscardTile',{seat:0,tile:'0m',moqie:false,is_liqi:declaration,is_wliqi:false})) await actor.ingest(event);
      assert.equal((await store.getAttempt(intent.id))?.status,declaration?'confirmed':'awaiting-confirmation');
      assert.equal((await store.inspect('riichi-ledger')).counts.confirmations,declaration?1:0);
    } finally {await actor.idle();await store.close();await rm(directory,{recursive:true,force:true});}
  });
});

test('Akagi pass is offered only for a skippable call and is fenced by the same live offer', () => {
  const s = seed(['3m','4m',...filler.slice(0,11)],3);
  const state = normalize(s.projection,'ActionDiscardTile',{seat:3,tile:'2m',moqie:true,is_liqi:false,is_wliqi:false})
    .reduce(reduceObservation,s.projection).state!;
  const offered = offer(2,['3m|4m']);
  const pass = legalOperationActions(state,offered,'w','e',true).find(candidate => candidate.action.kind === 'pass')!;
  assert.ok(pass);
  assert.throws(() => mapActionToRequest(pass.action,state,offered), /ACTION_NOT_LEGAL/);
  assert.deepEqual(mapActionToRequest(pass.action,state,offered,true), {
    method: '.lq.FastTest.inputChiPengGang', params: { type: 0, index: 0, cancel_operation: true, timeuse: 0 },
  });
  assert.ok(!legalOperationActions(state,offer(9),'w','e',true).some(candidate => candidate.action.kind === 'pass'));
});

test('accepted Akagi pass frees the ledger without creating a public action confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(),'maji-pass-ledger-'));
  const store = new StorageClient(join(directory,'state.sqlite'));
  const session = 'pass-ledger', actor = await GameActor.open(store,session,'process',{clock:new ReplayClock(at)});
  try {
    for (const event of seed(['3m','4m',...filler.slice(0,11)],3).events) await actor.ingest(event);
    for (const event of normalize(actor.projection,'ActionDiscardTile',{
      seat:3,tile:'2m',moqie:true,is_liqi:false,is_wliqi:false,operation:offer(2,['3m|4m']),
    },2,true)) await actor.ingest(event);
    await actor.resume();
    const snapshot = await actor.freezeDecision();
    const selected = snapshot.legalActions.find(candidate => candidate.action.kind === 'pass')!;
    const executor = new ActionExecutor(actor,{transport:{kind:'contract-test',
      prepare:async()=>async()=>({callId:'pass-ack',delivery:'accepted',observedAt:at})}});
    const attempt = await executor.executeContract(snapshot.id,selected.id);
    assert.equal(attempt.status,'confirmed');
    assert.equal(attempt.tile,null);
    assert.equal(attempt.confirmationEventId,undefined);
    assert.equal((await store.inspect(session)).counts.confirmations,0);
    assert.equal((await store.inspectMatch(actor.projection.gameMatchKey!)).unresolvedAttempts.length,0);
  } finally {
    await actor.idle();
    await store.close();
    await rm(directory,{recursive:true,force:true});
  }
});
