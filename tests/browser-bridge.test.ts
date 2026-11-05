import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import protobuf from 'protobufjs';
import { createOperationRules, legalOperationActions, expectedActionFor, type OfferedOperations } from '../src/adapters/majsoul/actions.ts';
import { initialView } from '../scripts/build-phase1-fixtures.ts';
import type { GameState, TileCode } from '../src/domain/game/types.ts';

const proto = `syntax="proto3"; package lq;
message Wrapper { string name=1; bytes data=2; }
message Error { uint32 code=1; string message=2; }
message Empty {}
message ReqAuthGame { uint32 account_id=1; string token=2; string game_uuid=3; }
message ResAuthGame { repeated uint32 seat_list=1; Error error=2; string private_note=3; }
message ReqLifecycle { string token=1; string game_uuid=2; uint32 account_id=3; }
message ReqInputOperation { uint32 type=1; string tile=2; bool moqie=3; uint32 timeuse=4; uint32 index=5; }
message ReqInputChiPengGang { uint32 type=1; uint32 index=2; uint32 timeuse=3; }
message Response { Error error=1; string private_note=2; }
message ReqSyncGame { string round_id=1; uint32 step=2; }
message ResEnterGame { Error error=1; bool is_end=2; uint32 step=3; GameRestore game_restore=4; string private_note=5; }
message ResSyncGame { Error error=1; bool is_end=2; uint32 step=3; GameRestore game_restore=4; }
message GameRestore { repeated ActionPrototype actions=1; uint32 passed_waiting_time=2; uint32 game_state=3; uint32 last_pause_time_ms=4; }
message ActionPrototype { uint32 step=1; string name=2; bytes data=3; }
message ActionMJStart {}
message OptionalOperation { uint32 type=1; repeated string combination=2; }
message OptionalOperationList { uint32 seat=1; repeated OptionalOperation operation_list=2; uint32 time_fixed=3; uint32 time_add=4; }
message ActionNewRound { uint32 chang=1; uint32 ju=2; uint32 ben=3; repeated string tiles=4; repeated int32 scores=5; repeated string doras=6; uint32 left_tile_count=7; string md5=8; OptionalOperationList operation=9; string sha256=10; }
message ActionDealTile { uint32 seat=1; string tile=2; uint32 left_tile_count=3; OptionalOperationList operation=4; }
message ActionDiscardTile { uint32 seat=1; string tile=2; bool moqie=3; bool is_liqi=4; bool is_wliqi=5; OptionalOperationList operation=6; }
message HuleInfo { uint32 seat=1; bool zimo=2; }
message ActionHule { repeated HuleInfo hules=1; }
message EndPlayer { uint32 seat=1; int32 part_point_1=2; uint32 account_id=3; string nickname=4; }
message GameResult { repeated EndPlayer players=1; }
message NotifyGameEndResult { GameResult result=1; }
`;
const rpcMap: Record<string, { req: string; resp: string }> = {
  '.lq.FastTest.authGame': { req: 'lq.ReqAuthGame', resp: 'lq.ResAuthGame' },
  '.lq.FastTest.enterGame': { req: 'lq.ReqLifecycle', resp: 'lq.ResEnterGame' },
  '.lq.FastTest.finishSyncGame': { req: 'lq.ReqLifecycle', resp: 'lq.Response' },
  '.lq.FastTest.heartBeat': { req: 'lq.Empty', resp: 'lq.Response' },
  '.lq.FastTest.syncGame': { req: 'lq.ReqSyncGame', resp: 'lq.ResSyncGame' },
  '.lq.FastTest.inputOperation': { req: 'lq.ReqInputOperation', resp: 'lq.Response' },
  '.lq.FastTest.inputChiPengGang': { req: 'lq.ReqInputChiPengGang', resp: 'lq.Response' },
};
const schema = protobuf.parse(proto, { keepCase: true }).root;
const encode = (name: string, value: unknown) => schema.lookupType(name).encode(schema.lookupType(name).fromObject(value as object)).finish();
const responseFrame = (id: number, method: string, value = {}) => new Uint8Array([3, id & 255, id >> 8, ...encode('lq.Wrapper', { data: encode(rpcMap[method]!.resp, value) })]);
const requestFrame = (id: number, method: string, value = {}) => new Uint8Array([2, id & 255, id >> 8, ...encode('lq.Wrapper', { name: method, data: encode(rpcMap[method]!.req, value) })]);
const packetId = (packet: Uint8Array) => packet[1]! + packet[2]! * 256;
const notificationFrame = (name:string,value:unknown) => new Uint8Array([1,...encode('lq.Wrapper',{
  name:`.lq.${name}`,data:encode(`lq.${name}`,value),
})]);
const source = readFileSync('src/adapters/majsoul/browser-bridge.js', 'utf8').replace('export function', 'function');
const phase2Filler:TileCode[]=['1p','2p','3p','4p','5p','6p','7p','8p','9p','1s','2s','3s','4s','6s'];
function phase2State(owned:TileCode[],called?:TileCode):GameState {
  const view=initialView();view.ownConcealed=[...owned,...phase2Filler.slice(0,(called?13:14)-owned.length)].map((code,i)=>({instanceId:`physical-${i}`,code}));
  view.players[0].concealedCount={known:true,value:view.ownConcealed.length};
  view.currentActor=called?{known:false,reason:'awaiting-call'}:{known:true,value:0};
  view.drawnTileRef={known:true,value:called?null:view.ownConcealed.at(-1)!.instanceId};
  const state:GameState={...view,sessionId:'session',matchId:'match',handId:'hand',connectionEpoch:1,stateVersion:4,trust:'trusted',trustIssues:[]};
  if(called){
    state.players[3].river.push({tile:called,tsumogiri:true,riichiDeclaration:false,eventId:'offered-river'});
    state.latestAction={eventId:'offered-river',handId:'hand',actor:3,kind:'discard',tiles:[called],tsumogiri:{known:true,value:true},origin:'unknown',observedAt:new Date().toISOString()};
  }
  return state;
}
const phase2Offer=(type:number,combination:string[]):OfferedOperations=>({seat:0,operation_list:[{type,combination}]});
function fixture(capacity = 256, phase2ActionsEnabled = false) {
  class Socket extends EventTarget {
    readyState = 1;
    sent: Uint8Array[] = [];
    send(raw: Uint8Array) { this.sent.push(new Uint8Array(raw)); }
    receive(raw: Uint8Array) { this.dispatchEvent(new MessageEvent('message', { data: raw.buffer })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const window: Record<string, any> = Object.assign(new EventTarget(),{ WebSocket: Socket, protobuf });
  let monoOffset=0,wallOffset=0;
  class ContextDate extends Date { static now(){return Date.now()+wallOffset;} }
  const context = { window, WebSocket: Socket, Uint8Array, ArrayBuffer, TextDecoder, MessageEvent,
    performance:{ now:()=>performance.now()+monoOffset }, crypto: { randomUUID }, Date:ContextDate, setTimeout, clearTimeout, proto, rpcMap, capacity,
    operationRulesSource:createOperationRules.toString(),phase2ActionsEnabled };
  runInNewContext(source + '\ninstallBrowserBridge({proto,rpcMap,ownSeat:0,capacity,operationRulesSource,phase2ActionsEnabled});', context);
  const socket: Socket = new window.WebSocket('fixture');
  const bridge = window.__majiBridge;
  const autoWin = (state='enabled') => bridge.ackAutoWin({source:'unity-button-pixels-v1',state,
    observedAt:new Date().toISOString(),pageEpoch:bridge.read().pageEpoch,generation:bridge.read().generation,
    nativeRestoreRevision:bridge.read().nativeRestoreRevision,step:bridge.read().lastStep,rgbaSha256:'a'.repeat(64)});
  const start = () => { socket.send(requestFrame(80, '.lq.FastTest.heartBeat')); socket.receive(responseFrame(packetId(socket.sent.at(-1)!), '.lq.FastTest.heartBeat')); };
  function action(name: string, step: number, payload: object) {
    const data = new Uint8Array(encode(`lq.${name}`, payload));
    const keys = [0x84,0x5e,0x4e,0x42,0x39,0xa2,0x1f,0x60,0x1c], base = 23 ^ data.length;
    for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ ((base + 5 * i + keys[i % 9]!) & 255);
    socket.receive(new Uint8Array([1, ...encode('lq.Wrapper', { name: '.lq.ActionPrototype', data: encode('lq.ActionPrototype', { name, step, data }) })]));
  }
  async function opened() {
    start();
    action('ActionNewRound', 0, { tiles: ['1m'], md5: 'first-hand' });
    action('ActionDealTile', 1, { seat: 0, tile: '2m', left_tile_count: 68, operation: { seat: 0, operation_list: [{ type: 1 }], time_fixed: 300000 } });
    bridge.drain();
    const work=bridge.sync(),id=packetId(socket.sent.at(-1)!);
    socket.receive(responseFrame(id,'.lq.FastTest.syncGame',{step:2,game_restore:{game_state:1,last_pause_time_ms:0,passed_waiting_time:1,actions:[
      {name:'ActionNewRound',step:0,data:encode('lq.ActionNewRound',{tiles:['1m'],md5:'first-hand'})},
      {name:'ActionDealTile',step:1,data:encode('lq.ActionDealTile',{seat:0,tile:'2m',left_tile_count:68,operation:{seat:0,operation_list:[{type:1}],time_fixed:300000}})},
    ]}}));
    const raw=await work;bridge.ackSync({generation:raw.generation,step:1});
    const timing={source:'protocol-operation',origin:'sync-game',step:1,connectionEpoch:1,pageEpoch:raw.pageEpoch,
      sampledAt:raw.receivedAt,sampledMonoMs:raw.receivedMonoMs,remainingMs:299000,
      uncertaintyMs:Math.ceil(raw.receivedMonoMs-raw.requestedMonoMs)+2000,fixedMs:300000,addMs:0,elapsedMs:1000,
      networkAllowanceMs:Math.ceil(raw.receivedMonoMs-raw.requestedMonoMs),quantizationAllowanceMs:2000};
    bridge.ackTiming(timing);
    const drained = bridge.drain();
    const expected = { generation: drained.generation, pageEpoch: drained.pageEpoch, step: drained.lastStep };
    bridge.pause({ processInstanceId: 'process', controlEpoch: 3, paused: false });
    autoWin();
    const fence = { processInstanceId: 'process', sessionId: 'session', matchId: 'match', handId: 'hand', decisionId: 'decision', windowId: 'window', stateVersion: 4, connectionEpoch: 1, controlEpoch: 3 };
    const command = { attemptId: 'attempt', actionId: 'action', permitId: 'permit', fence, expiresAt: new Date(Date.now() + 1000).toISOString() };
    const selected = { id: 'action', action: { kind: 'discard', tile: 'instance', tsumogiri: true } };
    const input = { command, intent: { id: 'attempt', status: 'dispatching', ...fence, actionId: 'action', executionMode: 'live', actor: 0, tile: '2m', tsumogiri: true },
      snapshot: { scope: fence, ...fence, sourceCursor: 'verified-hand:1', actionDeadline: new Date(Date.now() + 30000).toISOString(),
        legalActions: [selected], state: { ownSeat: 0, ownConcealed: [{ instanceId: 'instance', code: '2m' }] } },
      action: selected, tile: '2m', expected,
      timing };
    return input;
  }
  async function openedCustom(state:GameState,offered:OfferedOperations,selectedIndex=0) {
    const input:any=await opened();
    const name=state.currentActor.known?'ActionDealTile':'ActionDiscardTile';
    const payload=name==='ActionDealTile'?{seat:0,tile:'2m',left_tile_count:68,operation:{...offered,time_fixed:300000,time_add:0}}:
      {seat:state.latestAction!.actor,tile:state.latestAction!.tiles[0],moqie:true,is_liqi:false,is_wliqi:false,operation:{...offered,time_fixed:300000,time_add:0}};
    const work=bridge.sync(),id=packetId(socket.sent.at(-1)!);
    socket.receive(responseFrame(id,'.lq.FastTest.syncGame',{step:2,game_restore:{game_state:1,last_pause_time_ms:0,passed_waiting_time:1,actions:[
      {name:'ActionNewRound',step:0,data:encode('lq.ActionNewRound',{tiles:['1m'],md5:'first-hand'})},
      {name,step:1,data:encode(`lq.${name}`,payload)},
    ]}}));
    const raw=await work;bridge.ackSync({generation:raw.generation,step:1});
    const rtt=Math.ceil(raw.receivedMonoMs-raw.requestedMonoMs);
    input.timing={...input.timing,sampledAt:raw.receivedAt,sampledMonoMs:raw.receivedMonoMs,pageEpoch:raw.pageEpoch,networkAllowanceMs:rtt,uncertaintyMs:rtt+2000};
    bridge.ackTiming(input.timing);
    const drained=bridge.drain();input.expected={generation:drained.generation,pageEpoch:drained.pageEpoch,step:drained.lastStep};
    bridge.pause({processInstanceId:'process',controlEpoch:3,paused:false});autoWin();
    const candidates=legalOperationActions(state,offered,'window','evidence'),selected=candidates[selectedIndex]!;
    input.action=selected;input.snapshot.legalActions=candidates;input.snapshot.state=state;
    input.command.actionId=selected.id;input.intent.actionId=selected.id;input.intent.actionSpec=structuredClone(selected.action);
    input.intent.expectedAction=expectedActionFor(selected.action,state);
    const spec=selected.action;
    if(spec.kind==='discard'||spec.kind==='riichi-discard'){
      const tile=state.ownConcealed.find(t=>t.instanceId===spec.tile)!;
      input.tile=tile.code.endsWith('r')?`0${tile.code[1]}`:tile.code;
      input.intent.tile=tile.code;input.intent.tsumogiri=spec.tsumogiri;
    } else {delete input.tile;delete input.intent.tile;delete input.intent.tsumogiri;}
    return input;
  }
  return { socket, bridge, window, Socket, action, opened, openedCustom,start, autoWin, advanceMono:(ms:number)=>{monoOffset+=ms;},advanceWall:(ms:number)=>{wallOffset+=ms;} };
}

test('mux shares one allocator, restores original client IDs and suppresses its own responses', async () => {
  const f = fixture(); f.start();
  const received: number[] = [];
  f.socket.addEventListener('message', event => received.push(packetId(new Uint8Array((event as MessageEvent).data))));
  f.socket.send(requestFrame(7, '.lq.FastTest.heartBeat'));
  const heartbeatId = packetId(f.socket.sent.at(-1)!);
  const sync = f.bridge.sync();
  const syncId = packetId(f.socket.sent.at(-1)!);
  assert.notEqual(syncId, heartbeatId);
  // Unity's original ID may equal a bridge wire ID; the shared allocator still isolates them.
  f.socket.send(requestFrame(syncId, '.lq.FastTest.heartBeat'));
  const collidingClientWireId = packetId(f.socket.sent.at(-1)!);
  assert.notEqual(collidingClientWireId, syncId);
  f.socket.receive(responseFrame(syncId, '.lq.FastTest.syncGame', { step: 1, game_restore: { actions: [{ name: 'ActionNewRound', step: 0, data: encode('lq.ActionNewRound', { tiles: ['1m'], md5: 'hand' }) }] } }));
  const result = await sync;
  assert.equal(result.game_restore.actions[0].payload.tiles[0], '1m');
  assert.equal(f.bridge.read().stats.clientRequests, 3);
  assert.equal(f.bridge.read().stats.bridgeSyncRequests, 1);
  assert.equal(f.bridge.read().stats.bridgeActionSends, 0);
  assert.deepEqual(received, []);
  f.socket.receive(responseFrame(heartbeatId, '.lq.FastTest.heartBeat'));
  assert.deepEqual(received, [7]);
  f.socket.receive(responseFrame(collidingClientWireId, '.lq.FastTest.heartBeat'));
  assert.deepEqual(received, [7, syncId]);
  f.bridge.ackSync({ generation: result.generation, step: 0 });
  assert.equal(f.bridge.read().lastStep, 0);
  f.bridge.restore();
  assert.equal(f.window.WebSocket, f.Socket);
});

test('legacy connection cannot send bridge RPC and teardown preserves pending client routes', async () => {
  const f = fixture();
  const legacy = new f.Socket(); legacy.send(requestFrame(123, '.lq.FastTest.heartBeat'));
  await assert.rejects(f.bridge.sync(), /CONNECTION_REATTACH_REQUIRED/);
  f.start();
  f.socket.send(requestFrame(4, '.lq.FastTest.heartBeat'));
  const id = packetId(f.socket.sent.at(-1)!);
  assert.throws(() => f.bridge.restore(), /BRIDGE_PENDING_REQUESTS/);
  const received: number[] = [];
  f.socket.addEventListener('message', event => received.push(packetId(new Uint8Array((event as MessageEvent).data))));
  f.socket.receive(responseFrame(id, '.lq.FastTest.heartBeat'));
  assert.deepEqual(received, [4]);
  f.bridge.restore();
});

test('an unrecognized client method cannot bypass the shared wire allocator', async () => {
  const f = fixture(); f.start();
  const sync = f.bridge.sync(), syncId = packetId(f.socket.sent.at(-1)!);
  const unknown = new Uint8Array([2, syncId & 255, syncId >> 8, ...encode('lq.Wrapper', { name: '.lq.FastTest.futureMethod', data: [] })]);
  const received: number[] = [];
  f.socket.addEventListener('message', e => received.push(packetId(new Uint8Array((e as MessageEvent).data))));
  f.socket.send(unknown); const wireId = packetId(f.socket.sent.at(-1)!);
  assert.notEqual(wireId, syncId);
  f.socket.receive(new Uint8Array([3, wireId & 255, wireId >> 8, ...encode('lq.Wrapper', { data: [] })]));
  assert.deepEqual(received, [syncId]);
  f.socket.receive(responseFrame(syncId, '.lq.FastTest.syncGame', { step: 1, game_restore: { actions: [
    { name: 'ActionNewRound', step: 0, data: encode('lq.ActionNewRound', { tiles: ['1m'] }) },
  ] } }));
  await sync; assert.deepEqual(received, [syncId]); f.bridge.restore();
});

test('sync permits one initial MJStart and uses NewRound fingerprint for subsequent deduplication', async () => {
  const f = fixture(); f.start();
  const sync = f.bridge.sync(), id = packetId(f.socket.sent.at(-1)!);
  const round = { tiles: ['1m'], md5: 'first-hand' };
  f.socket.receive(responseFrame(id, '.lq.FastTest.syncGame', { step: 2, game_restore: { actions: [
    { name: 'ActionMJStart', step: 0, data: encode('lq.ActionMJStart', {}) },
    { name: 'ActionNewRound', step: 1, data: encode('lq.ActionNewRound', round) },
  ] } }));
  const result = await sync; f.bridge.ackSync({ generation: result.generation, step: 1 });
  const before = f.bridge.read().generation;
  f.action('ActionNewRound', 1, round);
  assert.equal(f.bridge.read().generation, before);
  assert.equal(f.bridge.read().reason, null);
  assert.equal(f.bridge.reconnect().reconnectRequested, true);
  assert.equal(f.bridge.read().paused, true);
  f.bridge.restore();
});

test('capture drops hidden draws and identity fields; raw duplicates are idempotent and conflicts close gate', () => {
  const f = fixture(); f.start();
  f.action('ActionNewRound', 0, { tiles: ['1m'], md5: 'round' });
  f.action('ActionDealTile', 1, { seat: 1, tile: '9s', left_tile_count: 68 });
  const before = f.bridge.read().generation;
  f.action('ActionDealTile', 1, { seat: 1, tile: '9s', left_tile_count: 68 });
  assert.equal(f.bridge.read().generation, before);
  const capture = f.bridge.drain();
  assert.equal(JSON.stringify(capture).includes('9s'), false);
  f.action('ActionNewRound', 0, { tiles: ['1m'], md5: 'round' });
  assert.equal(f.bridge.read().generation, before);
  f.action('ActionDealTile', 1, { seat: 1, tile: '1s', left_tile_count: 68 });
  assert.equal(f.bridge.read().reason, 'SOURCE_DEDUP_CONFLICT');
  f.bridge.restore();
});

test('auth correlation exposes own seat and match UUID, removes accounts and tokens', () => {
  const f = fixture();
  f.socket.send(requestFrame(999, '.lq.FastTest.authGame', { account_id: 54321, token: 'sensitive-token', game_uuid: 'match-uuid' }));
  const id = packetId(f.socket.sent.at(-1)!);
  f.socket.receive(responseFrame(id, '.lq.FastTest.authGame', { seat_list: [10, 54321, 20, 30] }));
  const read = f.bridge.drain();
  assert.equal(read.ownSeat, 1);
  assert.equal(read.gameUuid, 'match-uuid');
  assert.equal(JSON.stringify(read).includes('54321'), false);
  assert.equal(JSON.stringify(read).includes('sensitive-token'), false);
  f.bridge.restore();
});

test('native lifecycle trace whitelists four methods and timestamps forwarding after client delivery without payloads', () => {
  const f=fixture();f.start();
  const atClient:any[]=[];
  f.socket.addEventListener('message',()=>{
    atClient.push(f.bridge.read().nativeLifecycleTrace.at(-1));
    f.advanceMono(20);
  });
  const methods=['authGame','enterGame','syncGame','finishSyncGame'];
  const privateInput={account_id:54321,token:'private-token',game_uuid:'private-game-uuid'};
  for(const [index,name] of methods.entries()){
    const method=`.lq.FastTest.${name}`;
    f.socket.send(requestFrame(700+index,method,name==='syncGame'?{round_id:'private-round'}:privateInput));
    const id=packetId(f.socket.sent.at(-1)!);
    const response=name==='authGame'?{seat_list:[54321,2,3,4],private_note:'private-auth-response'}:
      name==='enterGame'?{error:{code:7,message:'private-error'},private_note:'private-response'}:{};
    const before=f.bridge.read();
    f.socket.receive(name==='finishSyncGame'
      ?new Uint8Array([3,id&255,id>>8,...encode('lq.Wrapper',{data:new Uint8Array([255])})])
      :responseFrame(id,method,response));
    if(name==='finishSyncGame')for(const key of ['reason','pageEpoch','generation','queued'])assert.equal(f.bridge.read()[key],before[key]);
  }
  const trace=JSON.parse(JSON.stringify(f.bridge.read().nativeLifecycleTrace));
  assert.equal(trace.length,12);assert.equal(atClient.length,4);
  for(const [index,name] of methods.entries()){
    const rows=trace.slice(index*3,index*3+3),accepted=[true,false,true,'unknown'][index];
    assert.deepEqual(rows.map((r:any)=>r.phase),['request','response','response-forwarded']);
    assert.deepEqual(rows.map((r:any)=>r.accepted),['unknown',accepted,accepted]);
    assert.ok(rows.every((r:any)=>r.method===name&&r.owner==='client'&&r.pageEpoch===1));
    assert.equal(atClient[index].phase,'response');
    assert.ok(rows[2].observedMonoMs>=atClient[index].observedMonoMs+20);
  }
  for(const row of trace){
    const restoreResponse=['enterGame','syncGame'].includes(row.method)&&row.phase!=='request';
    assert.deepEqual(Object.keys(row).sort(),['accepted',...(restoreResponse?['hasRestore']:[]),'method','observedAt','observedMonoMs','owner','pageEpoch','phase']);
    if(restoreResponse)assert.equal(row.hasRestore,row.method==='enterGame'?'unknown':false);
    assert.ok(Number.isFinite(Date.parse(row.observedAt)));assert.ok(Number.isFinite(row.observedMonoMs));
  }
  assert.doesNotMatch(JSON.stringify(trace),/private-|54321|account|token|uuid|payload|requestId|clientId|error/i);
  const altered=f.bridge.read().nativeLifecycleTrace;altered[0].method='changed';altered.push({payload:'private'});
  assert.deepEqual(JSON.parse(JSON.stringify(f.bridge.read().nativeLifecycleTrace)),trace);
  assert.equal(f.bridge.read().stats.clientRequests,5);assert.equal(f.bridge.read().stats.bridgeActionSends,0);
  f.bridge.restore();
});

test('restore presence trace is three-state and never exposes the native restore payload',()=>{
  const f=fixture();f.start();
  for(const name of ['enterGame','syncGame'])for(const kind of ['present','absent','error','malformed']){
    const method=`.lq.FastTest.${name}`;
    f.socket.send(requestFrame(920,method));const id=packetId(f.socket.sent.at(-1)!);
    const privateRestore={actions:[{name:'private-native-action',step:123,data:new TextEncoder().encode('private-native-payload')}]};
    const value=kind==='present'?{game_restore:privateRestore}:kind==='error'?{error:{code:9,message:'private-error'},game_restore:privateRestore}:{};
    f.socket.receive(kind==='malformed'
      ?new Uint8Array([3,id&255,id>>8,...encode('lq.Wrapper',{data:new Uint8Array([255])})])
      :responseFrame(id,method,value));
    const rows=f.bridge.read().nativeLifecycleTrace.slice(-3),expected=kind==='present'?true:kind==='absent'?false:'unknown';
    assert.equal(Object.hasOwn(rows[0],'hasRestore'),false);
    assert.equal(rows[1].hasRestore,expected);assert.equal(rows[2].hasRestore,expected);
    assert.equal(f.bridge.read().generation,0);assert.equal(f.bridge.read().reason,null);assert.equal(f.bridge.read().queued,0);
  }
  assert.doesNotMatch(JSON.stringify(f.bridge.read().nativeLifecycleTrace),/private-|payload|game_restore|actions|account|token|uuid/i);
  f.bridge.restore();
});

test('new native restore requests revoke same-epoch enabled proof, timing and prepared permits',async()=>{
  for(const name of ['authGame','enterGame','syncGame']){
    const f=fixture(),input=await f.opened(),prepared=f.bridge.prepare(input),before=f.bridge.read();
    const oldReadback={source:'unity-button-pixels-v1',...before.lastAutoWinReadback};
    const method=`.lq.FastTest.${name}`;
    f.socket.send(requestFrame(930,method,name==='authGame'?{account_id:42,token:'private',game_uuid:'same-match'}:{}));
    const id=packetId(f.socket.sent.at(-1)!),after=f.bridge.read(),sent=f.socket.sent.length;
    assert.equal(after.pageEpoch,before.pageEpoch);assert.equal(after.generation,before.generation+1);
    assert.equal(after.nativeRestoreRevision,before.nativeRestoreRevision+1);
    assert.equal(after.autoWin,null);assert.equal(after.lastAutoWinReadback,null);
    assert.equal((await f.bridge.dispatch({command:input.command,token:prepared.token})).delivery,'not-sent');
    assert.equal(f.socket.sent.length,sent);assert.equal(after.stats.bridgeActionSends,0);
    assert.throws(()=>f.bridge.ackAutoWin(oldReadback),/AUTO_WIN_READBACK_STALE/);
    const currentInput=structuredClone(input);currentInput.expected.generation=after.generation;
    assert.throws(()=>f.bridge.prepare(currentInput),/AUTO_WIN_UNVERIFIED/);
    f.autoWin();assert.throws(()=>f.bridge.prepare(currentInput),/DEADLINE_PROVENANCE_UNVERIFIED/);
    f.socket.receive(responseFrame(id,method,name==='authGame'?{seat_list:[42,1,2,3]}:{}));
    f.bridge.restore();
  }
});

test('native restore clears prior winning-offer attribution while evidence-free restore progress keeps its generation',async()=>{
  const f=fixture();await f.opened();
  f.action('ActionDealTile',2,{seat:0,tile:'2m',left_tile_count:67,operation:{seat:0,operation_list:[{type:8}]}});
  const before=f.bridge.read();assert.ok(before.lastAutoWinReadback);
  f.socket.send(requestFrame(940,'.lq.FastTest.syncGame'));const restoreId=packetId(f.socket.sent.at(-1)!);
  assert.equal(f.bridge.read().generation,before.generation+1);assert.equal(f.bridge.read().lastAutoWinReadback,null);
  const emptyGeneration=f.bridge.read().generation;
  f.socket.send(requestFrame(941,'.lq.FastTest.enterGame'));const enterId=packetId(f.socket.sent.at(-1)!);
  assert.equal(f.bridge.read().generation,emptyGeneration);
  f.socket.send(requestFrame(942,'.lq.FastTest.inputOperation',{type:8}));const winId=packetId(f.socket.sent.at(-1)!);
  assert.equal(f.bridge.read().lastClientWin.priorAutoWinReadback,null);
  assert.equal(f.bridge.read().lastClientWin.autoWinVerifiedAtRequest,false);
  for(const [id,method] of [[restoreId,'.lq.FastTest.syncGame'],[enterId,'.lq.FastTest.enterGame'],[winId,'.lq.FastTest.inputOperation']] as const)
    f.socket.receive(responseFrame(id,method));
  f.bridge.restore();
});

test('an evidence-free native restore revision atomically rejects earlier or revisionless pixel readback',()=>{
  for(const name of ['authGame','enterGame','syncGame']){
    const f=fixture();f.start();const before=f.bridge.read();
    const readback={source:'unity-button-pixels-v1',state:'enabled',observedAt:new Date().toISOString(),
      pageEpoch:before.pageEpoch,generation:before.generation,step:before.lastStep,
      nativeRestoreRevision:before.nativeRestoreRevision,rgbaSha256:'a'.repeat(64)};
    const method=`.lq.FastTest.${name}`;
    f.socket.send(requestFrame(950,method,name==='authGame'?{account_id:42,token:'private',game_uuid:'same-match'}:{}));
    const id=packetId(f.socket.sent.at(-1)!),after=f.bridge.read();
    assert.equal(after.pageEpoch,before.pageEpoch);assert.equal(after.generation,before.generation);
    assert.equal(after.nativeRestoreRevision,before.nativeRestoreRevision+1);
    assert.equal(f.bridge.drain().nativeRestoreRevision,after.nativeRestoreRevision);
    for(const revision of [before.nativeRestoreRevision,undefined,-1,after.nativeRestoreRevision+0.5])
      assert.throws(()=>f.bridge.ackAutoWin({...readback,nativeRestoreRevision:revision}),/AUTO_WIN_READBACK_STALE/);
    assert.equal(f.bridge.read().autoWin,null);assert.equal(f.bridge.read().lastAutoWinReadback,null);
    f.socket.receive(responseFrame(id,method,name==='authGame'?{seat_list:[42,1,2,3]}:{}));
    f.autoWin();assert.equal(f.bridge.read().autoWin.nativeRestoreRevision,after.nativeRestoreRevision);
    f.bridge.restore();
  }
});

test('native restore revokes future execution without dropping a receipt for an already sent action',async()=>{
  const f=fixture(),input=await f.opened(),prepared=f.bridge.prepare(input);
  const dispatch=f.bridge.dispatch({command:input.command,token:prepared.token}),actionId=packetId(f.socket.sent.at(-1)!);
  assert.equal(f.bridge.read().stats.bridgeActionSends,1);
  f.socket.send(requestFrame(951,'.lq.FastTest.syncGame'));const restoreId=packetId(f.socket.sent.at(-1)!);
  assert.equal(f.bridge.read().autoWin,null);assert.equal(f.bridge.read().lastAutoWinReadback,null);
  f.socket.receive(responseFrame(actionId,'.lq.FastTest.inputOperation'));
  assert.equal((await dispatch).delivery,'accepted');assert.equal(f.bridge.read().stats.bridgeActionSends,1);
  f.socket.receive(responseFrame(restoreId,'.lq.FastTest.syncGame'));f.bridge.restore();
});

test('bridge-owned sync preserves historical enabled readback and does not impersonate native restore invalidation',async()=>{
  const f=fixture();await f.opened();const before=f.bridge.read();
  const sync=f.bridge.sync(),id=packetId(f.socket.sent.at(-1)!);
  assert.deepEqual(f.bridge.read().lastAutoWinReadback,before.lastAutoWinReadback);
  assert.equal(f.bridge.read().generation,before.generation);assert.equal(f.bridge.read().pageEpoch,before.pageEpoch);
  assert.equal(f.bridge.read().nativeRestoreRevision,before.nativeRestoreRevision);
  // Existing bridge sync still pauses and clears its executable proof/timing.
  assert.equal(f.bridge.read().autoWin,null);assert.equal(f.bridge.read().paused,true);
  f.socket.receive(responseFrame(id,'.lq.FastTest.syncGame',{step:2,game_restore:{actions:[
    {name:'ActionNewRound',step:0,data:encode('lq.ActionNewRound',{tiles:['1m'],md5:'first-hand'})},
    {name:'ActionDealTile',step:1,data:encode('lq.ActionDealTile',{seat:0,tile:'2m',left_tile_count:68,operation:{seat:0,operation_list:[{type:1}],time_fixed:300000}})},
  ]}}));
  await sync;assert.deepEqual(f.bridge.read().lastAutoWinReadback,before.lastAutoWinReadback);
  assert.equal(f.bridge.read().generation,before.generation);
  assert.equal(f.bridge.read().nativeRestoreRevision,before.nativeRestoreRevision);
  assert.equal(f.bridge.read().nativeLifecycleTrace.at(-1).owner,'bridge');
  assert.equal(f.bridge.read().nativeLifecycleTrace.at(-1).hasRestore,true);
  f.bridge.restore();
});

test('bridge sync trace has bridge ownership without a native forwarded stage or gate changes',async()=>{
  const f=fixture();f.start();const before=f.bridge.read();
  const delivered:number[]=[];f.socket.addEventListener('message',e=>delivered.push(packetId(new Uint8Array((e as MessageEvent).data))));
  const sync=f.bridge.sync(),id=packetId(f.socket.sent.at(-1)!);
  f.socket.receive(responseFrame(id,'.lq.FastTest.syncGame',{step:1,game_restore:{actions:[
    {name:'ActionNewRound',step:0,data:encode('lq.ActionNewRound',{tiles:['1m'],md5:'private-round'})},
  ]}}));
  await sync;const after=f.bridge.read();
  assert.deepEqual(JSON.parse(JSON.stringify(after.nativeLifecycleTrace)).map((r:any)=>[r.method,r.owner,r.phase,r.accepted]),[
    ['syncGame','bridge','request','unknown'],['syncGame','bridge','response',true],
  ]);
  for(const key of ['pageEpoch','generation','queued','paused','reason','autoWin','lastStep'])assert.equal(after[key],before[key]);
  assert.deepEqual(delivered,[]);assert.equal(after.stats.bridgeSyncRequests,1);assert.equal(after.stats.bridgeActionSends,0);
  f.bridge.restore();
});

test('native lifecycle trace is bounded and retains request epoch across later page invalidation',()=>{
  const f=fixture(),requestTimes:number[]=[];f.start();
  for(let i=0;i<20;i++){
    f.advanceMono(100);
    f.socket.send(requestFrame(800+i,'.lq.FastTest.finishSyncGame'));
    requestTimes.push(f.bridge.read().nativeLifecycleTrace.at(-1).observedMonoMs);
    f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.finishSyncGame'));
  }
  assert.equal(f.bridge.read().nativeLifecycleTrace.length,48);
  assert.equal(f.bridge.read().nativeLifecycleTrace[0].observedMonoMs,requestTimes[4]);
  assert.equal(f.bridge.read().generation,0);assert.equal(f.bridge.read().queued,0);assert.equal(f.bridge.read().reason,null);
  const requestEpoch=f.bridge.read().pageEpoch;
  f.socket.send(requestFrame(900,'.lq.FastTest.finishSyncGame'));const id=packetId(f.socket.sent.at(-1)!);
  f.bridge.pause();assert.ok(f.bridge.read().pageEpoch>requestEpoch);
  f.socket.receive(responseFrame(id,'.lq.FastTest.finishSyncGame'));
  const rows=f.bridge.read().nativeLifecycleTrace.slice(-3);
  assert.ok(rows.every((r:any)=>r.pageEpoch===requestEpoch));assert.equal(f.bridge.read().nativeLifecycleTrace.length,48);
  f.bridge.restore();
});

test('client forwarding records after nested lifecycle requests and keeps the original request epoch',()=>{
  const f=fixture();f.start();const epoch=f.bridge.read().pageEpoch;
  f.socket.addEventListener('message',e=>{
    if(packetId(new Uint8Array((e as MessageEvent).data))!==910)return;
    assert.equal(f.bridge.read().nativeLifecycleTrace.at(-1).phase,'response');
    f.bridge.pause();
    f.socket.send(requestFrame(911,'.lq.FastTest.finishSyncGame'));
  });
  f.socket.send(requestFrame(910,'.lq.FastTest.enterGame'));
  f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.enterGame'));
  const trace=JSON.parse(JSON.stringify(f.bridge.read().nativeLifecycleTrace));
  assert.deepEqual(trace.map((r:any)=>[r.method,r.phase,r.pageEpoch]),[
    ['enterGame','request',epoch],['enterGame','response',epoch],
    ['finishSyncGame','request',epoch+1],['enterGame','response-forwarded',epoch],
  ]);
  f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.finishSyncGame'));
  assert.equal(f.bridge.read().nativeLifecycleTrace.at(-1).pageEpoch,epoch+1);
  assert.equal(f.bridge.read().reason,null);assert.equal(f.bridge.read().generation,0);assert.equal(f.bridge.read().queued,0);
  f.bridge.restore();
});

test('retired socket responses remain routable but cannot append lifecycle trace in the current epoch',()=>{
  const f=fixture(),auth={account_id:42,token:'private-token',game_uuid:'same-private-match'};
  f.socket.send(requestFrame(90,'.lq.FastTest.authGame',auth));
  f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.authGame',{seat_list:[42,1,2,3]}));
  f.socket.send(requestFrame(91,'.lq.FastTest.finishSyncGame'));const oldId=packetId(f.socket.sent.at(-1)!);
  const replacement=new f.window.WebSocket('replacement');replacement.send(requestFrame(80,'.lq.FastTest.authGame',auth));
  replacement.receive(responseFrame(packetId(replacement.sent.at(-1)),'.lq.FastTest.authGame',{seat_list:[42,1,2,3]}));
  const before=JSON.stringify(f.bridge.read().nativeLifecycleTrace),revision=f.bridge.read().nativeRestoreRevision,delivered:number[]=[];
  f.socket.addEventListener('message',e=>delivered.push(packetId(new Uint8Array((e as MessageEvent).data))));
  f.socket.receive(responseFrame(oldId,'.lq.FastTest.finishSyncGame'));
  assert.deepEqual(delivered,[91]);assert.equal(JSON.stringify(f.bridge.read().nativeLifecycleTrace),before);
  f.socket.send(requestFrame(92,'.lq.FastTest.enterGame'));f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.enterGame'));
  assert.equal(JSON.stringify(f.bridge.read().nativeLifecycleTrace),before);
  assert.equal(f.bridge.read().nativeRestoreRevision,revision);
  f.bridge.restore();
});

test('durable intent and every fence field are checked before page preparation', async () => {
  const f = fixture(), input = await f.opened();
  for (const field of ['sessionId','matchId','handId','windowId','stateVersion','connectionEpoch','controlEpoch']) {
    const changed = structuredClone(input) as any;
    changed.intent[field] = `wrong-${field}`;
    assert.throws(() => f.bridge.prepare(changed), /FENCE_STALE/);
  }
  const changed = structuredClone(input); changed.intent.status = 'prepared';
  assert.throws(() => f.bridge.prepare(changed), /DURABLE_INTENT_REQUIRED/);
  f.bridge.restore();
});

test('page pause, ingress and monotonic expiry block previously prepared commands without sending', async t => {
  for (const scenario of ['pause', 'ingress', 'expiry']) await t.test(scenario, async () => {
    const f = fixture(), input = await f.opened();
    if (scenario === 'expiry') input.command.expiresAt = new Date(Date.now() + 20).toISOString();
    const prepared = f.bridge.prepare(input), count = f.socket.sent.length;
    if (scenario === 'pause') f.bridge.pause({ processInstanceId: 'process', controlEpoch: 4, paused: true });
    else if (scenario === 'ingress') f.action('ActionDiscardTile', 2, { seat: 0, tile: '2m', moqie: true });
    else await new Promise(resolve => setTimeout(resolve, 30));
    let result;
    try { result = await f.bridge.dispatch({ command: input.command, token: prepared.token }); } catch (error) { assert.match(String(error), /PERMIT_INVALID/); }
    if (result) assert.equal(result.delivery, 'not-sent');
    assert.equal(f.socket.sent.length, count);
    assert.equal(f.bridge.read().stats.bridgeActionSends, 0);
    f.bridge.restore();
  });
});

test('accepted RPC receipt remains distinct from action observation and a permit is used once', async () => {
  const f = fixture(), input = await f.opened();
  const prepared = f.bridge.prepare(input);
  const work = f.bridge.dispatch({ command: input.command, token: prepared.token });
  const id = packetId(f.socket.sent.at(-1)!);
  f.socket.receive(responseFrame(id, '.lq.FastTest.inputOperation'));
  const receipt = await work;
  assert.equal(receipt.delivery, 'accepted');
  assert.equal(f.bridge.read().stats.bridgeActionSends, 1);
  assert.equal(f.bridge.read().lastStep, 1);
  assert.equal((await f.bridge.dispatch({ command: input.command, token: prepared.token })).delivery, 'not-sent');
  assert.equal(f.bridge.read().stats.bridgeActionSends, 1);
  f.bridge.restore();
});

test('bounded queue closes execution on overflow', () => {
  const f = fixture(8); f.start();
  f.action('ActionNewRound', 0, { tiles: ['1m'] });
  for (let step = 1; step < 10; step++) f.action('ActionDiscardTile', step, { seat: 1, tile: '2m', moqie: true });
  assert.equal(f.bridge.read().overflow, true);
  assert.equal(f.bridge.read().queued, 8);
  assert.equal(f.bridge.read().reason, 'BRIDGE_QUEUE_OVERFLOW');
  f.bridge.restore();
});

test('automatic win proof expires monotonically and cannot survive a reconnect', async () => {
  const f=fixture(),input=await f.opened();
  f.autoWin('disabled');
  assert.throws(()=>f.bridge.prepare(input),/AUTO_WIN_UNVERIFIED/);
  f.autoWin();const prepared=f.bridge.prepare(input),before=f.socket.sent.length;
  f.advanceMono(1001);
  assert.equal((await f.bridge.dispatch({command:input.command,token:prepared.token})).delivery,'not-sent');
  assert.equal(f.socket.sent.length,before);
  f.autoWin();f.bridge.reconnect();
  assert.equal(f.bridge.read().autoWin,null);
  assert.throws(()=>f.autoWin(),/BRIDGE_UNTRUSTED/);
  f.bridge.restore();
});

test('client win requests revoke a prepared discard and are counted separately', async () => {
  for (const type of [8,9]) {
    const f=fixture(),input=await f.opened(),prepared=f.bridge.prepare(input);
    f.socket.send(requestFrame(18,'.lq.FastTest.inputOperation',{type}));
    const wire=packetId(f.socket.sent.at(-1)!);f.socket.receive(responseFrame(wire,'.lq.FastTest.inputOperation'));
    const before=f.socket.sent.length;
    assert.equal((await f.bridge.dispatch({command:input.command,token:prepared.token})).delivery,'not-sent');
    assert.equal(f.socket.sent.length,before);
    assert.equal(f.bridge.read().stats.clientWinRequests,1);
    assert.equal(f.bridge.read().stats.bridgeActionSends,0);
    f.bridge.restore();
  }
});

test('a win offer reserves the complete operation window for the client', async () => {
  for (const type of [8,9]) {
    const f=fixture(),input=await f.opened();
    f.action('ActionDealTile',2,{seat:0,tile:'2m',left_tile_count:67,
      operation:{seat:0,operation_list:[{type:1},{type}],time_fixed:300000}});
    const read=f.bridge.drain();input.expected={generation:read.generation,pageEpoch:read.pageEpoch,step:read.lastStep};
    input.snapshot.sourceCursor='verified-hand:2';f.autoWin();
    assert.throws(()=>f.bridge.prepare(input),/CLIENT_AUTO_WIN_WINDOW/);
    assert.equal(f.bridge.read().stats.bridgeActionSends,0);f.bridge.restore();
  }
});

test('win diagnostics correlate offered client request, receipt and authoritative own win', async () => {
  const f=fixture();await f.opened();
  f.action('ActionDealTile',2,{seat:0,tile:'2m',left_tile_count:67,
    operation:{seat:0,operation_list:[{type:8}],time_fixed:300000}});
  f.bridge.drain();f.autoWin();
  f.socket.send(requestFrame(19,'.lq.FastTest.inputOperation',{type:8}));
  const id=packetId(f.socket.sent.at(-1)!);
  assert.equal(f.bridge.read().lastClientWin.delivery,'pending');
  f.socket.receive(responseFrame(id,'.lq.FastTest.inputOperation'));
  f.action('ActionHule',3,{hules:[{seat:0,zimo:true}]});
  const read=f.bridge.read();
  assert.equal(read.lastClientWin.offered,true);assert.equal(read.lastClientWin.autoWinVerifiedAtRequest,true);
  assert.equal(read.lastClientWin.delivery,'accepted');assert.equal(read.lastClientWin.step,2);
  assert.equal(read.lastOwnWin.clientWinRequestId,id);assert.equal(read.lastOwnWin.step,3);
  assert.equal(read.lastOwnWin.kind,'tsumo');assert.equal(read.lastOwnWin.pageEpoch,read.pageEpoch);
  assert.equal(read.stats.authoritativeOwnWins,1);assert.equal(read.stats.bridgeActionSends,0);
  f.bridge.restore();
});

test('automatic timing rejects manual provenance, forged samples and wrong protocol steps', async () => {
  for(const field of ['source','step','sampledMonoMs','remainingMs','fixedMs','networkAllowanceMs']) {
    const f=fixture(),input=await f.opened(),timing:any={...input.timing};
    if(field==='source')timing.source='manual-client-countdown';else timing[field]+=1;
    assert.throws(()=>f.bridge.ackTiming(timing),/TIMING_SCOPE_MISMATCH|COUNTDOWN_READBACK_MISMATCH/);
    assert.throws(()=>f.bridge.prepare(input),/DEADLINE_PROVENANCE_UNVERIFIED/);
    assert.equal(f.bridge.read().stats.bridgeActionSends,0);f.bridge.restore();
  }
});

test('near-deadline budget and backward wall-clock jumps cannot revive a permit', async () => {
  const f=fixture(),input=await f.opened();
  f.advanceMono(input.timing.remainingMs-input.timing.uncertaintyMs-100);f.autoWin();
  assert.throws(()=>f.bridge.prepare(input),/DEADLINE_EXCEEDED/);
  assert.equal(f.bridge.read().stats.bridgeActionSends,0);f.bridge.restore();
  const second=fixture(),selected=await second.opened(),permit=second.bridge.prepare(selected),before=second.socket.sent.length;
  second.advanceMono(1100);second.advanceWall(-60000);
  assert.equal((await second.bridge.dispatch({command:selected.command,token:permit.token})).delivery,'not-sent');
  assert.equal(second.socket.sent.length,before);second.bridge.restore();
});

test('live offers require a fresh synchronization before automatic timing can be acknowledged', async () => {
  const f=fixture(),input=await f.opened();
  f.action('ActionDealTile',2,{seat:0,tile:'2m',left_tile_count:67,
    operation:{seat:0,operation_list:[{type:1}],time_fixed:300000}});
  assert.throws(()=>f.bridge.ackTiming({...input.timing,step:2}),/DEADLINE_PROVENANCE_UNVERIFIED/);
  assert.equal(f.bridge.read().stats.bridgeActionSends,0);f.bridge.restore();
});

test('the phase 2 Page gate rejects a legal call before allocating any game send',async()=>{
  const f=fixture(),state=phase2State(['3m','4m'],'2m'),input=await f.openedCustom(state,phase2Offer(2,['3m|4m']));
  const before=f.socket.sent.length;
  assert.throws(()=>f.bridge.prepare(input),/PHASE2_ACTIONS_DISABLED/);
  assert.equal(f.socket.sent.length,before);assert.equal(f.bridge.read().stats.bridgeActionSends,0);f.bridge.restore();
});

test('phase 2 final sends select exact call, kan and riichi protocol candidates',async t=>{
  const added=phase2State(['5mr']);added.ownConcealed=added.ownConcealed.slice(0,11);added.players[0].concealedCount={known:true,value:11};
  added.drawnTileRef={known:true,value:added.ownConcealed.at(-1)!.instanceId};
  added.players[0].melds=[{id:'prior-pon',actor:0,kind:'pon',tiles:['5m','5m','5m'],fromSeat:2,calledTileIndex:1}];
  added.players[2].river=[{tile:'5m',tsumogiri:true,riichiDeclaration:false,calledBy:0,eventId:'pon-source'}];
  const cases=[
    {name:'chi',state:phase2State(['3m','4m'],'2m'),offered:phase2Offer(2,['3m|4m']),selected:0,method:'.lq.FastTest.inputChiPengGang',params:{type:2,index:0,timeuse:0}},
    {name:'pon-red-index-1',state:phase2State(['5m','5mr','5m'],'5m'),offered:phase2Offer(3,['5m|5m','5m|0m']),selected:1,method:'.lq.FastTest.inputChiPengGang',params:{type:3,index:1,timeuse:0}},
    {name:'open-kan-red',state:phase2State(['5m','5m','5mr'],'5m'),offered:phase2Offer(5,['5m|5m|0m']),selected:0,method:'.lq.FastTest.inputChiPengGang',params:{type:5,index:0,timeuse:0}},
    {name:'closed-kan-index-1',state:phase2State(['5m','5mr','5m','5m','7s','7s','7s','7s']),offered:phase2Offer(4,['7s|7s|7s|7s','5m|0m|5m|5m']),selected:1,method:'.lq.FastTest.inputOperation',params:{type:4,index:1,timeuse:0}},
    {name:'added-kan-red',state:added,offered:phase2Offer(6,['5m|5m|5m']),selected:0,method:'.lq.FastTest.inputOperation',params:{type:6,index:0,timeuse:0}},
    {name:'riichi-red-physical',state:phase2State(['5mr']),offered:phase2Offer(7,['0m','9p']),selected:0,method:'.lq.FastTest.inputOperation',params:{type:7,tile:'0m',moqie:false,timeuse:0}},
  ];
  for(const c of cases)await t.test(c.name,async()=>{
    const f=fixture(256,true),input=await f.openedCustom(c.state,c.offered,c.selected),prepared=f.bridge.prepare(input),before=f.socket.sent.length;
    if('consumed' in input.action.action && c.name.includes('red'))assert.ok(input.action.action.consumed.some((id:string)=>c.state.ownConcealed.find(tile=>tile.instanceId===id)?.code==='5mr'));
    const work=f.bridge.dispatch({command:input.command,token:prepared.token});
    assert.equal(f.socket.sent.length,before+1);
    const packet=f.socket.sent.at(-1)!,envelope=schema.lookupType('lq.Wrapper').decode(packet.subarray(3)) as unknown as {name:string;data:Uint8Array};
    assert.equal(envelope.name,c.method);
    const type=schema.lookupType(rpcMap[c.method]!.req),params=type.toObject(type.decode(envelope.data));
    assert.deepEqual(params,c.params);
    f.socket.receive(responseFrame(packetId(packet),c.method));assert.equal((await work).delivery,'accepted');
    assert.equal(f.bridge.read().stats.bridgeActionSends,1);f.bridge.restore();
  });
});

test('phase 2 preparation rederives combination, consumed references and durable actionSpec',async()=>{
  for(const tamper of ['index','combination','consumed','actionSpec']){
    const f=fixture(256,true),input=await f.openedCustom(phase2State(['5m','5mr','5m'],'5m'),phase2Offer(3,['5m|5m','5m|0m']),1);
    const before=f.socket.sent.length;
    if(tamper==='actionSpec')input.intent.actionSpec.consumed[0]='old-physical';
    else {
      if(tamper==='index')input.action.action.operation.index=0;
      if(tamper==='combination')input.action.action.operation.combination='5m|5m';
      if(tamper==='consumed')input.action.action.consumed[0]='old-physical';
      // Simulate a malicious candidate that also appears in the immutable input list:
      // the Page must still compare its complete action against the current wire offer.
      input.snapshot.legalActions=[input.action];input.intent.actionSpec=structuredClone(input.action.action);
    }
    assert.throws(()=>f.bridge.prepare(input),/ACTION_NOT_LEGAL|DURABLE_INTENT_REQUIRED/);
    assert.equal(f.socket.sent.length,before);assert.equal(f.bridge.read().stats.bridgeActionSends,0);f.bridge.restore();
  }
});

test('phase 2 permits are revoked by client winning, ingress and reconnect',async()=>{
  for(const revoke of ['client-win','ingress','reconnect']){
    const f=fixture(256,true),input=await f.openedCustom(phase2State(['3m','4m'],'2m'),phase2Offer(2,['3m|4m'])),prepared=f.bridge.prepare(input);
    if(revoke==='client-win'){
      f.socket.send(requestFrame(20,'.lq.FastTest.inputOperation',{type:9}));
      f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.inputOperation'));
    } else if(revoke==='ingress')f.action('ActionDiscardTile',2,{seat:1,tile:'9s',moqie:true});
    else f.bridge.reconnect();
    const before=f.socket.sent.length,result=await f.bridge.dispatch({command:input.command,token:prepared.token});
    assert.equal(result.delivery,'not-sent');assert.equal(f.socket.sent.length,before);assert.equal(f.bridge.read().stats.bridgeActionSends,0);f.bridge.restore();
  }
});

test('an immediate client win retains the preceding switch readback without weakening send fences',async()=>{
  const f=fixture();await f.opened();
  f.action('ActionDealTile',2,{seat:0,tile:'2m',left_tile_count:67,operation:{seat:0,operation_list:[{type:8}],time_fixed:300000}});
  // Unity handles the offer immediately, before an asynchronous screenshot could run.
  f.socket.send(requestFrame(22,'.lq.FastTest.inputOperation',{type:8}));
  const id=packetId(f.socket.sent.at(-1)!);f.socket.receive(responseFrame(id,'.lq.FastTest.inputOperation'));
  f.action('ActionHule',3,{hules:[{seat:0,zimo:true}]});
  const result=f.bridge.read();
  assert.equal(result.lastClientWin.autoWinVerifiedAtRequest,false);
  assert.equal(result.lastClientWin.priorAutoWinReadback.state,'enabled');
  assert.equal(result.lastClientWin.priorAutoWinReadback.step,1);
  assert.equal(result.lastClientWin.step,2);assert.equal(result.lastOwnWin.clientWinRequestId,id);
  assert.ok(result.lastClientWin.priorAutoWinReadback.ageAtRequestMs>=result.lastClientWin.priorAutoWinReadback.ageAtOfferMs);
  f.action('ActionNewRound',0,{tiles:['1m'],md5:'next-hand'});
  assert.equal(f.bridge.read().lastAutoWinReadback,null);assert.equal(f.bridge.read().lastClientWin,null);
  f.bridge.restore();
});

test('local toolbar input, keys, resizing and scrolling revoke final sends and listeners are removed',async()=>{
  for(const name of ['pointerdown','keydown','resize','scroll']){
    const f=fixture(256,true),input=await f.openedCustom(phase2State(['3m','4m'],'2m'),phase2Offer(2,['3m|4m'])),prepared=f.bridge.prepare(input);
    const before=f.socket.sent.length,generation=f.bridge.read().generation;
    f.window.dispatchEvent(new Event(name));
    assert.equal(f.bridge.read().generation,generation+1);assert.equal(f.bridge.read().autoWin,null);assert.equal(f.bridge.read().lastAutoWinReadback,null);
    const result=await f.bridge.dispatch({command:input.command,token:prepared.token});
    assert.equal(result.delivery,'not-sent');assert.equal(f.socket.sent.length,before);assert.equal(f.bridge.read().stats.bridgeActionSends,0);
    f.bridge.restore();const after=f.bridge.read().generation;f.window.dispatchEvent(new Event(name));assert.equal(f.bridge.read().generation,after);
  }
});

test('an unknown switch readback revokes the previous enabled proof and trigger attribution',async()=>{
  const f=fixture(),input=await f.opened();f.autoWin('unknown');
  assert.equal(f.bridge.read().lastAutoWinReadback.state,'unknown');
  assert.throws(()=>f.bridge.prepare(input),/AUTO_WIN_UNVERIFIED/);
  f.action('ActionDealTile',2,{seat:0,tile:'2m',left_tile_count:67,operation:{seat:0,operation_list:[{type:8}],time_fixed:300000}});
  f.socket.send(requestFrame(23,'.lq.FastTest.inputOperation',{type:8}));
  f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.inputOperation'));
  assert.equal(f.bridge.read().lastClientWin.priorAutoWinReadback,null);f.bridge.restore();
});

test('hand settlement revokes prepared sends and distinct commitments separate dealer repeats with reset or continuous steps',async()=>{
  for (const nextStep of [0,3]) {
    const f=fixture(),input=await f.opened(),prepared=f.bridge.prepare(input);
    const before=f.socket.sent.length,stream=f.bridge.read().sourceStream;
    f.action('ActionHule',2,{hules:[{seat:1,zimo:true}]});
    assert.equal(f.bridge.read().handEnded,true);assert.equal(f.bridge.read().paused,true);
    assert.equal(f.bridge.read().operation,null);assert.equal(f.bridge.read().autoWin,null);
    const next={tiles:['1m'],md5:'next-hand',sha256:'b'.repeat(64),chang:0,ju:0,ben:1};
    f.action('ActionNewRound',nextStep,next);
    const read=f.bridge.read();assert.equal(read.reason,null);assert.equal(read.handEnded,false);
    assert.equal(read.sourceStream,stream+1);assert.equal(read.handSha256,next.sha256);assert.equal(read.paused,true);
    f.action('ActionNewRound',nextStep,next);assert.equal(f.bridge.read().generation,read.generation);
    assert.equal((await f.bridge.dispatch({command:input.command,token:prepared.token})).delivery,'not-sent');
    assert.equal(f.socket.sent.length,before);
    f.action('ActionHule',nextStep+1,{hules:[{seat:2,zimo:true}]});
    f.action('ActionNewRound',0,{tiles:['1m'],md5:'first-hand'});
    assert.equal(f.bridge.read().reason,'STALE_HAND_HISTORY');f.bridge.restore();
  }
});

const openingHistory=()=>[
  {name:'ActionNewRound',step:0,data:encode('lq.ActionNewRound',{tiles:['1m'],md5:'first-hand'})},
  {name:'ActionDealTile',step:1,data:encode('lq.ActionDealTile',{seat:0,tile:'2m',left_tile_count:68,
    operation:{seat:0,operation_list:[{type:1}],time_fixed:300000}})},
];

test('terminal sync preserves the closed hand and refuses an older playing restore',async()=>{
  const f=fixture();await f.opened();
  f.action('ActionHule',2,{hules:[{seat:1,zimo:true}]});
  const stale=f.bridge.sync();
  f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.syncGame',{
    step:2,game_restore:{actions:openingHistory()},
  }));
  await assert.rejects(stale,/SYNC_HISTORY_REGRESSION/);
  const sync=f.bridge.sync();
  f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.syncGame',{
    step:3,game_restore:{actions:[...openingHistory(),{name:'ActionHule',step:2,
      data:encode('lq.ActionHule',{hules:[{seat:1,zimo:true}]})}]},
  }));
  const raw=await sync;f.bridge.ackSync({generation:raw.generation,step:2});
  assert.equal(f.bridge.read().handEnded,true);assert.equal(f.bridge.read().operation,null);
  f.action('ActionNewRound',3,{tiles:['1m'],sha256:'b'.repeat(64)});
  assert.equal(f.bridge.read().reason,null);assert.equal(f.bridge.read().sourceStream,1);f.bridge.restore();
});

test('end-only sync closes execution without fabricating a missing hand history',async()=>{
  const f=fixture(),input=await f.opened(),prepared=f.bridge.prepare(input),sync=f.bridge.sync();
  f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.syncGame',{is_end:true,step:0}));
  const raw=await sync;
  assert.equal(raw.is_end,true);assert.equal(raw.game_restore,null);assert.equal(f.bridge.read().matchEnded,true);
  assert.throws(()=>f.bridge.ackSync({generation:raw.generation,step:-1}),/SYNC_STALE/);
  assert.equal((await f.bridge.dispatch({command:input.command,token:prepared.token})).delivery,'not-sent');
  f.action('ActionNewRound',0,{tiles:['1m'],sha256:'b'.repeat(64)});
  assert.equal(f.bridge.read().reason,'HAND_BOUNDARY_UNVERIFIED');f.bridge.restore();
});

test('a late acknowledgement cannot erase a page fault that occurred after its sync response',async()=>{
  const f=fixture();await f.opened();
  const sync=f.bridge.sync();
  f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.syncGame',{
    step:2,game_restore:{actions:openingHistory()},
  }));
  const raw=await sync;
  f.socket.receive(new Uint8Array([3,0,0,0xff]));
  const fault=f.bridge.read();
  assert.equal(fault.generation,raw.generation);assert.ok(fault.pageEpoch>raw.pageEpoch);
  assert.equal(fault.reason,'FRAME_DECODE_FAILED');
  assert.throws(()=>f.bridge.ackSync({generation:raw.generation,step:1}),/SYNC_STALE/);
  assert.equal(f.bridge.read().reason,'FRAME_DECODE_FAILED');assert.equal(f.bridge.read().paused,true);
  assert.equal(f.bridge.read().stats.bridgeActionSends,0);
  f.bridge.restore();
});

test('final result is redacted, idempotent and immediately closes permits before settlement arrives',async()=>{
  const f=fixture(),input=await f.opened(),prepared=f.bridge.prepare(input);
  const result={result:{players:[0,1,2,3].map(seat=>({seat,part_point_1:25000,account_id:100+seat,nickname:'DO_NOT_RETAIN'}))}};
  f.socket.receive(notificationFrame('NotifyGameEndResult',result));
  const first=f.bridge.read();assert.equal(first.matchEnded,true);assert.equal(first.handEnded,false);assert.equal(first.paused,true);
  assert.equal(JSON.stringify(first).includes('DO_NOT_RETAIN'),false);assert.equal(JSON.stringify(first).includes('account_id'),false);
  f.socket.receive(notificationFrame('NotifyGameEndResult',result));assert.equal(f.bridge.read().generation,first.generation);
  assert.equal((await f.bridge.dispatch({command:input.command,token:prepared.token})).delivery,'not-sent');
  f.action('ActionHule',2,{hules:[{seat:1,zimo:true}]});
  assert.equal(f.bridge.read().reason,null);assert.equal(f.bridge.read().handEnded,true);
  result.result.players[0]!.part_point_1=26000;f.socket.receive(notificationFrame('NotifyGameEndResult',result));
  assert.equal(f.bridge.read().reason,'MATCH_RESULT_CONFLICT');assert.equal(f.bridge.read().stats.bridgeActionSends,0);f.bridge.restore();
});

test('new socket authentication clears the old proof and retired traffic cannot corrupt the recovered connection',async()=>{
  const f=fixture();
  const auth={account_id:42,game_uuid:'same-match'};
  f.socket.send(requestFrame(90,'.lq.FastTest.authGame',auth));
  f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.authGame',{seat_list:[42,1,2,3]}));
  await f.opened();assert.ok(f.bridge.read().authSummary);
  const oldSync=f.bridge.sync(),oldSyncId=packetId(f.socket.sent.at(-1)!);
  const replacement=new f.window.WebSocket('replacement');replacement.send(requestFrame(80,'.lq.FastTest.authGame',auth));
  assert.equal(f.bridge.read().connected,true);assert.equal(f.bridge.read().authSummary,null);
  assert.equal(f.bridge.read().reason,'CONNECTION_CHANGED');
  f.socket.receive(responseFrame(oldSyncId,'.lq.FastTest.syncGame',{step:2,game_restore:{actions:openingHistory()}}));
  await assert.rejects(oldSync,/SYNC_CONNECTION_CHANGED/);
  replacement.receive(responseFrame(packetId(replacement.sent.at(-1)),'.lq.FastTest.authGame',{seat_list:[42,1,2,3]}));
  const current=f.bridge.read();assert.ok(current.authSummary);
  f.action('ActionHule',2,{hules:[{seat:1,zimo:true}]});
  f.socket.receive(new Uint8Array([3,0,0,0xff]));
  f.socket.receive(responseFrame(65000,'.lq.FastTest.heartBeat'));
  f.socket.send(requestFrame(91,'.lq.FastTest.inputOperation',{type:8}));
  f.socket.receive(responseFrame(packetId(f.socket.sent.at(-1)!),'.lq.FastTest.inputOperation'));
  const after=f.bridge.read();assert.equal(after.generation,current.generation);assert.equal(after.pageEpoch,current.pageEpoch);
  assert.equal(after.handEnded,false);assert.equal(after.stats.clientWinRequests,0);
  const sync=f.bridge.sync();replacement.receive(responseFrame(packetId(replacement.sent.at(-1)),'.lq.FastTest.syncGame',{
    step:2,game_restore:{actions:openingHistory()},
  }));
  const raw=await sync;f.bridge.ackSync({generation:raw.generation,step:1});
  assert.equal(f.bridge.read().reason,null);assert.equal(f.bridge.read().gameUuid,'same-match');f.bridge.restore();
});
