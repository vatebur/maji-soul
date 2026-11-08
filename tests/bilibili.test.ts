import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, brotliCompressSync } from 'node:zlib';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Duplex } from 'node:stream';
import { BiliApi, parseBiliCookie, loadBiliAuth, signBiliQuery, type BiliAuth } from '../src/adapters/live/bilibili-api.ts';
import { BilibiliDirect, type BiliSocket } from '../src/adapters/live/bilibili.ts';
import { encodeBiliPacket, decodeBiliPackets, normalizeBiliMessage } from '../src/adapters/live/bilibili-protocol.ts';
import { Interaction } from '../src/application/live/interaction.ts';
import { defaultConfig } from '../src/application/live/config.ts';
import { actorHarness, deferred } from './helpers.ts';

const cookie = 'SESSDATA=fixture-session; bili_jct=0123456789abcdef0123456789abcdef; DedeUserID=123; buvid3=fixture-device';
const auth: BiliAuth = parseBiliCookie(cookie);
const identity = { userId: '123', buvid: 'fixture-device', mixin: 'a'.repeat(32) };
const room = { roomId: '1992099976', token: 'fixture-token', hosts: ['wss://first.chat.bilibili.com:443/sub','wss://second.chat.bilibili.com:443/sub'] };
const nav = { code: 0, data: { isLogin: true, mid: 123,
  wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png` } } };
function message(id = 'message-one', viewer = 456, text = '上一手为什么？') {
  const meta: unknown[] = Array(16).fill(0); meta[4] = Date.now(); meta[15] = { extra: JSON.stringify({ id_str: id }) };
  return { cmd: 'DANMU_MSG:4:0:2:2:2:0', info: [meta, text, [viewer, '访客']] };
}
async function eventually(condition: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!condition()) { assert.ok(Date.now() < end, 'timed out waiting for Bili stream'); await delay(5); }
}
function compressed(payload: Buffer, version: 2 | 3) {
  const zipped = version === 2 ? deflateSync(payload) : brotliCompressSync(payload), packet = Buffer.alloc(16 + zipped.length);
  packet.writeUInt32BE(packet.length, 0); packet.writeUInt16BE(16, 4); packet.writeUInt16BE(version, 6); packet.writeUInt32BE(5, 8);
  zipped.copy(packet, 16); return packet;
}
class FakeSocket extends EventTarget implements BiliSocket {
  binaryType = ''; readyState = 0; sent: Buffer[] = []; autoAuth: boolean;
  constructor(autoAuth = true) { super(); this.autoAuth = autoAuth; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  send(data: Uint8Array<ArrayBuffer>) {
    this.sent.push(Buffer.from(data));
    if (data[11] === 7 && this.autoAuth) this.push(encodeBiliPacket(8, { code: 0 }));
  }
  push(data: Buffer) { this.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from(data).buffer })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
function stream(autoAuth = true) {
  const sockets: FakeSocket[] = [], hosts: string[] = [];
  const source = new BilibiliDirect(auth, { api: { identity: async () => identity, room: async () => room,
    send: async (_room, _user, deliveryId) => ({ deliveryId, status: 'published', receipt: 'platform-message' }) },
    socketFactory: host => { hosts.push(host); const socket = new FakeSocket(autoAuth); sockets.push(socket); return socket; } });
  return { source, sockets, hosts };
}

test('Bili credentials are allowlisted and must come from a private regular file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maji-bili-auth-')), path = join(dir, 'cookies.txt');
  try {
    assert.deepEqual(parseBiliCookie(cookie + '; unrelated=private'), auth);
    for (const bad of [cookie + '; SESSDATA=duplicate', cookie.replace('123', '0'), cookie.replace('fixture-session', 'evil\r\nHeader:value'), 'SESSDATA=only'])
      assert.throws(() => parseBiliCookie(bad));
    await writeFile(path, cookie, { mode: 0o600 }); assert.deepEqual(await loadBiliAuth(path), auth);
    await chmod(path, 0o644); await assert.rejects(loadBiliAuth(path), /BILI_COOKIE_FILE_PERMISSIONS/);
    await chmod(path, 0o600); await symlink(path, join(dir, 'link'));
    await assert.rejects(loadBiliAuth(join(dir, 'link')), /BILI_COOKIE_FILE_UNAVAILABLE/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Bili packet batches decode zlib and brotli and reject malformed or oversized packets', async () => {
  const original = Buffer.concat([encodeBiliPacket(8, { code: 0 }), encodeBiliPacket(5, message())]);
  for (const input of [original, compressed(original, 2), compressed(original, 3), compressed(compressed(original, 2), 3)]) {
    const packets = await decodeBiliPackets(input);
    assert.deepEqual(packets.map(p => p.operation), [8,5]);
    assert.equal(normalizeBiliMessage(JSON.parse(packets[1]!.body.toString()), '7')?.messageId, 'message-one');
  }
  const invalidHeader = Buffer.from(original); invalidHeader.writeUInt16BE(8, 4);
  const invalidVersion = Buffer.from(original); invalidVersion.writeUInt16BE(4, 6);
  for (const input of [Buffer.alloc(0), original.subarray(0, -1), invalidHeader, invalidVersion, Buffer.alloc(1024 * 1024 + 1),
    compressed(Buffer.alloc(3 * 1024 * 1024), 2), compressed(compressed(compressed(compressed(original, 2), 2), 2), 2)])
    await assert.rejects(decodeBiliPackets(input));
  assert.throws(() => normalizeBiliMessage(message('masked', 0), '7'), /BILI_VIEWER_ID_MISSING/);
  const missing = message(); (missing.info[0] as unknown[])[15] = {};
  assert.throws(() => normalizeBiliMessage(missing, '7'), /BILI_MESSAGE_ID_MISSING/);
  assert.equal(normalizeBiliMessage({ cmd: 'SEND_GIFT', data: {} }, '7'), null);
});

test('Bili API verifies the account, resolves short rooms, and refuses unapproved socket hosts', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  let account = 123, host = 'broadcastlv.chat.bilibili.com', code = 0;
  const request: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init: init! });
    const payload = String(url).includes('/nav') ? { ...nav, data: { ...nav.data, mid: account } } :
      String(url).includes('/room_init') ? { code: 0, data: { room_id: 1992099976 } } :
        { code, data: { token: 'do-not-log', host_list: [{ host, wss_port: 443 }] } };
    return Response.json(payload);
  };
  const api = new BiliApi(auth, request), signal = new AbortController().signal;
  const session = await api.identity(signal), resolved = await api.room('7', session, signal);
  assert.equal(session.userId, '123'); assert.equal(resolved.roomId, '1992099976');
  assert.match(requests.at(-1)!.url, /id=1992099976/); assert.match(requests.at(-1)!.url, /w_rid=[a-f0-9]{32}/);
  assert.ok(requests.every(r => r.init.redirect === 'error'));
  assert.ok(requests.every(r => new Headers(r.init.headers).get('Cookie') === cookie));
  host = 'bilibili.com.attacker.invalid'; await assert.rejects(api.room('7', session, signal), /BILI_HOST_UNAVAILABLE/);
  code = -352; const before = requests.length;
  await assert.rejects(api.room('7', session, signal), /BILI_ACCESS_DENIED/);
  assert.equal(requests.length - before, 2, 'no legacy endpoint fallback after access denial');
  account = 999; await assert.rejects(api.identity(signal), /BILI_ACCOUNT_CHANGED/);
  const signed = signBiliQuery({ b: "a!'()*b", a: '中文' }, 'test', 1700000000000);
  assert.match(signed, /^a=%E4%B8%AD%E6%96%87&b=ab&wts=1700000000&w_rid=[a-f0-9]{32}$/);
});

test('Bili sends once and requires a platform message ID before publishing', async () => {
  let posts = 0, response: unknown = { code: 0, data: { mode_info: { extra: JSON.stringify({ id_str: 'platform-id' }) } } };
  const controller = new AbortController();
  let cancelAtNav = false;
  const api = new BiliApi(auth, async (url, init) => {
    if (String(url).endsWith('/nav')) { if (cancelAtNav) controller.abort(); return Response.json(nav); }
    posts++; assert.equal(init?.method, 'POST');
    assert.match(String(init?.body), /csrf=0123456789abcdef0123456789abcdef/);
    if (response instanceof Error) throw response;
    return Response.json(response);
  });
  const send = () => api.send('1992099976', '123', 'delivery', '测试', controller.signal);
  assert.deepEqual(await send(), { deliveryId: 'delivery', status: 'published', receipt: 'platform-id' });
  response = { code: 0, data: {} }; assert.equal((await send()).status, 'uncertain');
  response = { code: -403, message: 'private provider error' }; assert.equal((await send()).status, 'rejected'); assert.equal(posts, 3);
  response = Error('connection lost'); await assert.rejects(send()); assert.equal(posts, 4, 'unknown send is not retried');
  cancelAtNav = true; await assert.rejects(send()); assert.equal(posts, 4);
});

test('Bili connects only after auth acknowledgement and blocks rejected authentication', async () => {
  const h = stream(false);
  try {
    const read = h.source.read('7', null, new AbortController().signal);
    await eventually(() => h.sockets.length === 1 && h.sockets[0]!.sent.length > 0);
    assert.equal(h.source.status.connection, 'connecting');
    const payload = JSON.parse(h.sockets[0]!.sent[0]!.subarray(16).toString());
    assert.equal(payload.uid, 123); assert.equal(payload.roomid, 1992099976);
    h.sockets[0]!.push(encodeBiliPacket(8, { code: -101 }));
    await assert.rejects(read, /BILI_WS_AUTH_REJECTED/);
    await assert.rejects(h.source.read('7', null, new AbortController().signal), /BILI_WS_AUTH_REJECTED/);
    assert.equal(h.sockets.length, 1);
  } finally { h.source.disconnect(); }
});

test('Bili cursors survive reconnect, expose gaps and ignore old-room frames', async () => {
  const h = stream(); const signal = new AbortController().signal;
  try {
    const initial = await h.source.read('7', null, signal);
    const old = h.sockets[0]!;
    old.push(encodeBiliPacket(5, message())); old.push(encodeBiliPacket(5, message('masked', 0)));
    await eventually(() => h.source.status.receivedCount === 1 && h.source.status.droppedCount === 1);
    const page = await h.source.read('7', initial.cursor, signal);
    assert.equal(page.messages[0]!.roomId, '7'); assert.equal(page.gap, true);
    old.close(); await h.source.read('7', page.cursor, signal);
    assert.deepEqual(h.hosts, room.hosts); assert.equal(h.source.status.connection, 'connected');
    old.push(encodeBiliPacket(5, message('late')));
    assert.equal(h.source.status.receivedCount, 1);
    const replacement = await h.source.read('8', page.cursor, signal);
    old.push(encodeBiliPacket(5, message('wrong-room')));
    assert.equal(replacement.messages.length, 0); assert.equal(replacement.gap, true); assert.equal(h.source.status.receivedCount, 0);
    await assert.rejects(h.source.send('7', '123', 'old-delivery', '旧房间', signal), /BILI_CONNECTION_CHANGED/);
  } finally { h.source.disconnect(); }
});

test('Bili bounded stream buffer reports overflow instead of claiming continuous history', async () => {
  const h = stream(), signal = new AbortController().signal;
  try {
    const first = await h.source.read('7', null, signal);
    h.sockets[0]!.push(Buffer.concat(Array.from({ length: 270 }, (_, i) => encodeBiliPacket(5, message(`id-${i}`)))));
    await eventually(() => h.source.status.receivedCount === 270);
    const page = await h.source.read('7', first.cursor, signal);
    assert.equal(page.gap, true); assert.equal(page.messages.length, 50); assert.equal(page.messages[0]!.messageId, 'id-14');
    assert.equal((await h.source.read('7', page.cursor, signal)).messages[0]!.messageId, 'id-64');
  } finally { h.source.disconnect(); }
});

test('room change cancels a late identity lookup and cannot open the old socket', async () => {
  const held = deferred<typeof identity>(); let sockets = 0;
  const source = new BilibiliDirect(auth, { api: { identity: () => held.promise, room: async () => room,
    send: async () => { throw Error('unexpected'); } }, socketFactory: () => { sockets++; return new FakeSocket(); } });
  const reading = source.read('7', null, new AbortController().signal);
  source.disconnect(); held.resolve(identity);
  await assert.rejects(reading); assert.equal(sockets, 0); assert.equal(source.status.connection, 'disconnected');
});

test('connection loss revokes a reply still checking its sending identity', async () => {
  const entered = deferred<AbortSignal>(), release = deferred(); let socket: FakeSocket | undefined, posts = 0;
  const source = new BilibiliDirect(auth, { api: { identity: async () => identity, room: async () => room,
    send: async (_room, _user, _id, _text, signal) => {
      entered.resolve(signal); await release.promise; signal.throwIfAborted(); posts++;
      return { deliveryId: 'late', status: 'published', receipt: 'id' };
    } }, socketFactory: () => socket = new FakeSocket() });
  try {
    await source.read('7', null, new AbortController().signal);
    const sending = source.send('7', '123', 'late', '延迟回复', new AbortController().signal);
    const signal = await entered.promise; socket!.close();
    assert.equal(signal.aborted, true); release.resolve();
    await assert.rejects(sending); assert.equal(posts, 0);
  } finally { release.resolve(); source.disconnect(); }
});

test('Bili heartbeat silence invalidates the connection and exposes the missing interval', async t => {
  t.mock.timers.enable({ apis: ['Date','setInterval'], now: 1_800_000_000_000 });
  const h = stream();
  try {
    await h.source.read('7', null, new AbortController().signal);
    t.mock.timers.tick(30_000);
    assert.equal(h.sockets[0]!.sent.at(-1)!.readUInt32BE(8), 2);
    assert.equal(h.source.status.connection, 'connected');
    t.mock.timers.tick(60_000);
    assert.equal(h.source.status.connection, 'recovering');
    assert.equal(h.source.status.errorCode, 'BILI_HEARTBEAT_TIMEOUT');
    assert.equal(h.source.status.gap, true);
  } finally { h.source.disconnect(); t.mock.timers.reset(); }
});

test('native WebSocket receives binary authenticated packets through the production decoder', async () => {
  const sockets = new Set<Duplex>(); let authenticated: Record<string, unknown> | null = null;
  const server = createServer();
  const frame = (payload: Buffer) => {
    const head = Buffer.alloc(payload.length < 126 ? 2 : 4); head[0] = 0x82;
    if (head.length === 2) head[1] = payload.length; else { head[1] = 126; head.writeUInt16BE(payload.length, 2); }
    return Buffer.concat([head, payload]);
  };
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let received = Buffer.alloc(0);
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]); if (received.length < 6 || (received[0]! & 15) !== 2) return;
      let length = received[1]! & 127, offset = 2;
      if (length === 126) { if (received.length < 8) return; length = received.readUInt16BE(2); offset = 4; }
      if (received.length < offset + 4 + length) return;
      const mask = received.subarray(offset, offset + 4), payload = Buffer.from(received.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      if (payload.readUInt32BE(8) === 7) {
        authenticated = JSON.parse(payload.subarray(16).toString());
        socket.write(frame(encodeBiliPacket(8, { code: 0 })));
        socket.write(frame(compressed(encodeBiliPacket(5, message()), 3)));
      }
      received = Buffer.alloc(0);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const source = new BilibiliDirect(auth, { api: { identity: async () => identity, room: async () => room,
    send: async () => { throw Error('unexpected'); } }, socketFactory: () => new WebSocket(`ws://127.0.0.1:${address.port}/sub`) });
  try {
    const page = await source.read('7', null, AbortSignal.timeout(2000));
    await eventually(() => source.status.receivedCount === 1);
    assert.equal((authenticated as Record<string, unknown> | null)?.uid, 123);
    const next = await source.read('7', page.cursor, AbortSignal.timeout(2000));
    assert.equal([...page.messages, ...next.messages].length, 1); assert.equal(source.status.gap, false);
  } finally { source.disconnect(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('direct replies share dry-run, self-message suppression, deduplication and uncertain delivery', async () => {
  const h = await actorHarness(14), config = defaultConfig('Tingting');
  config.interaction.roomId = '7'; config.interaction.globalIntervalMs = 1000; config.interaction.replyMaxChars = 100;
  let batch = 0, sends = 0, cards = 0;
  const interaction = new Interaction({ mode: 'direct', read: async () => {
    batch++;
    const incoming = (id: string, viewerId: string) => ({ roomId: '7', messageId: id, viewerId, displayName: '访客', text: '上一手为什么？' });
    return { roomId: '7', senderId: '123', cursor: String(batch), gap: false,
      messages: batch === 1 ? [incoming('self', '123'), incoming('one', '456'), incoming('one', '456')] : [incoming('one', '456'), incoming('two', '789')] };
  }, send: async (_room, _sender, _id, text) => { sends++; assert.ok([...text].length <= 20); throw Error('lost receipt'); } },
  h.store, () => config, () => { cards++; });
  try {
    const archive = await h.store.readDiscards(h.actor.projection.sessionId);
    interaction.tick(archive); await eventually(() => interaction.lastDelivery?.status === 'simulated');
    assert.equal(sends, 0); assert.equal(cards, 1);
    config.interaction.dryRun = false; await delay(1050);
    interaction.tick(archive); await eventually(() => interaction.lastDelivery?.status === 'uncertain');
    assert.equal(sends, 1); assert.equal(cards, 2);
    assert.equal(await h.store.reserveDelivery(interaction.lastDelivery!.deliveryId, new Date().toISOString()), false);
  } finally { await interaction.stop(); await h.cleanup(); }
});
