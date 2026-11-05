import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import protobuf from 'protobufjs';

const proto = `syntax="proto3"; package lq;
message Wrapper { string name=1; bytes data=2; }
message Error { uint32 code=1; }
message Empty {}
message ReqAuthGame { uint32 account_id=1; string token=2; string game_uuid=3; }
message ResAuthGame { repeated uint32 seat_list=1; }
message ReqInputOperation { uint32 type=1; string tile=2; bool moqie=3; uint32 timeuse=4; }
message Response { Error error=1; }
message ReqSyncGame { string round_id=1; uint32 step=2; }
message ResSyncGame { Error error=1; bool is_end=2; uint32 step=3; GameRestore game_restore=4; }
message GameRestore { repeated ActionPrototype actions=1; uint32 passed_waiting_time=2; }
message ActionPrototype { uint32 step=1; string name=2; bytes data=3; }
message ActionMJStart {}
message OptionalOperation { uint32 type=1; repeated string combination=2; }
message OptionalOperationList { uint32 seat=1; repeated OptionalOperation operation_list=2; uint32 time_fixed=3; uint32 time_add=4; }
message ActionNewRound { uint32 chang=1; uint32 ju=2; uint32 ben=3; repeated string tiles=4; repeated int32 scores=5; repeated string doras=6; uint32 left_tile_count=7; string md5=8; OptionalOperationList operation=9; }
message ActionDealTile { uint32 seat=1; string tile=2; uint32 left_tile_count=3; OptionalOperationList operation=4; }
message ActionDiscardTile { uint32 seat=1; string tile=2; bool moqie=3; bool is_liqi=4; bool is_wliqi=5; }
`;
const rpcMap: Record<string, { req: string; resp: string }> = {
  '.lq.FastTest.authGame': { req: 'lq.ReqAuthGame', resp: 'lq.ResAuthGame' },
  '.lq.FastTest.heartBeat': { req: 'lq.Empty', resp: 'lq.Response' },
  '.lq.FastTest.syncGame': { req: 'lq.ReqSyncGame', resp: 'lq.ResSyncGame' },
  '.lq.FastTest.inputOperation': { req: 'lq.ReqInputOperation', resp: 'lq.Response' },
};
const schema = protobuf.parse(proto, { keepCase: true }).root;
const encode = (name: string, value: unknown) => schema.lookupType(name).encode(schema.lookupType(name).fromObject(value as object)).finish();
const responseFrame = (id: number, method: string, value = {}) => new Uint8Array([3, id & 255, id >> 8, ...encode('lq.Wrapper', { data: encode(rpcMap[method]!.resp, value) })]);
const requestFrame = (id: number, method: string, value = {}) => new Uint8Array([2, id & 255, id >> 8, ...encode('lq.Wrapper', { name: method, data: encode(rpcMap[method]!.req, value) })]);
const packetId = (packet: Uint8Array) => packet[1]! + packet[2]! * 256;
const source = readFileSync('src/adapters/majsoul/browser-bridge.js', 'utf8').replace('export function', 'function');
function fixture(capacity = 256) {
  class Socket extends EventTarget {
    readyState = 1;
    sent: Uint8Array[] = [];
    send(raw: Uint8Array) { this.sent.push(new Uint8Array(raw)); }
    receive(raw: Uint8Array) { this.dispatchEvent(new MessageEvent('message', { data: raw.buffer })); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const window: Record<string, any> = { WebSocket: Socket, protobuf };
  const context = { window, WebSocket: Socket, Uint8Array, ArrayBuffer, TextDecoder, MessageEvent,
    performance, crypto: { randomUUID }, Date, setTimeout, clearTimeout, proto, rpcMap, capacity };
  runInNewContext(source + '\ninstallBrowserBridge({proto,rpcMap,ownSeat:0,capacity});', context);
  const socket: Socket = new window.WebSocket('fixture');
  const bridge = window.__majiBridge;
  const start = () => { socket.send(requestFrame(80, '.lq.FastTest.heartBeat')); socket.receive(responseFrame(packetId(socket.sent.at(-1)!), '.lq.FastTest.heartBeat')); };
  function action(name: string, step: number, payload: object) {
    const data = new Uint8Array(encode(`lq.${name}`, payload));
    const keys = [0x84,0x5e,0x4e,0x42,0x39,0xa2,0x1f,0x60,0x1c], base = 23 ^ data.length;
    for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ ((base + 5 * i + keys[i % 9]!) & 255);
    socket.receive(new Uint8Array([1, ...encode('lq.Wrapper', { name: '.lq.ActionPrototype', data: encode('lq.ActionPrototype', { name, step, data }) })]));
  }
  function opened() {
    start();
    action('ActionNewRound', 0, { tiles: ['1m'], md5: 'first-hand' });
    action('ActionDealTile', 1, { seat: 0, tile: '2m', left_tile_count: 68, operation: { seat: 0, operation_list: [{ type: 1 }], time_fixed: 300000 } });
    const drained = bridge.drain();
    const expected = { generation: drained.generation, pageEpoch: drained.pageEpoch, step: drained.lastStep };
    bridge.pause({ processInstanceId: 'process', controlEpoch: 3, paused: false });
    const fence = { processInstanceId: 'process', sessionId: 'session', matchId: 'match', handId: 'hand', decisionId: 'decision', windowId: 'window', stateVersion: 4, connectionEpoch: 1, controlEpoch: 3 };
    const command = { attemptId: 'attempt', actionId: 'action', permitId: 'permit', fence, expiresAt: new Date(Date.now() + 1000).toISOString() };
    const selected = { id: 'action', action: { kind: 'discard', tile: 'instance', tsumogiri: true } };
    const input = { command, intent: { id: 'attempt', status: 'dispatching', ...fence, actionId: 'action', executionMode: 'live', actor: 0, tile: '2m', tsumogiri: true },
      snapshot: { scope: fence, ...fence, sourceCursor: 'verified-hand:1', actionDeadline: new Date(Date.now() + 30000).toISOString(),
        legalActions: [selected], state: { ownSeat: 0, ownConcealed: [{ instanceId: 'instance', code: '2m' }] } },
      action: selected, tile: '2m', expected,
      timing: { source: 'manual-client-countdown', budgetMs: 30000, observedAt: new Date().toISOString() } };
    return input;
  }
  return { socket, bridge, window, Socket, action, opened, start };
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

test('durable intent and every fence field are checked before page preparation', () => {
  const f = fixture(), input = f.opened();
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
    const f = fixture(), input = f.opened();
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
  const f = fixture(), input = f.opened();
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
