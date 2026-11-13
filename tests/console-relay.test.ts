import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LiveRelay } from '../src/app/console/relay.ts';
import { ConsoleRuntime } from '../src/app/console/runtime.ts';
import { createConsoleServer } from '../src/app/console/server.ts';
import { StorageClient } from '../src/adapters/storage/client.ts';
import type { AutomationPort } from '../src/app/console/automation.ts';
import { startRelay, type RelayStats } from '../scripts/ego-obs-relay/server.mjs';
import { capture } from '../scripts/ego-obs-relay/capture.mjs';

function captureService() {
  const stats: RelayStats = { space: 0, page: 'p1', sequence: 0, bytes: 0, fps: 0, frameAgeMs: null,
    dimensions: null, clients: 0, workerExit: null, running: true };
  let starts = 0, closes = 0;
  const launch: typeof startRelay = async options => {
    starts++;
    assert.equal(options.space, 0);
    assert.equal(options.page, 'p1');
    stats.running = true; stats.workerExit = null;
    return { address: 'http://127.0.0.1:17362', token: 'private-upload-token',
      stats: () => stats, close: async () => { closes++; stats.running = false; } };
  };
  return { stats, launch, starts: () => starts, closes: () => closes };
}

test('capture acknowledges frames and stops its screencast before finishing a cooperative stop', async t => {
  const methods: string[] = [];
  let checks = 0, uploads = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/capture-control')) return Response.json({ enabled: ++checks === 1 });
    uploads++;
    return new Response(null, { status: 204 });
  });
  const page = {
    async cdp(method: string) { methods.push(method); },
    async events() { return [{ method: 'Page.screencastFrame', params: { sessionId: 1, data: 'YWJj' } }]; },
  };
  await capture({ taskSpace: async () => ({ page: () => page }), space: 0, page: 'p1',
    endpoint: 'http://127.0.0.1:17362', token: 'private', fps: 30, width: 1920, quality: 80 });
  assert.ok(uploads > 0);
  assert.equal(methods[0], 'Page.startScreencast');
  assert.ok(methods.includes('Page.screencastFrameAck'));
  assert.equal(methods.at(-1), 'Page.stopScreencast');
  assert.ok(methods.every(method => method.startsWith('Page.')));
});

test('a single static frame has its complete multipart delimiter without waiting for a second frame', async () => {
  const relay = await startRelay({ space: 0, page: 'p1', port: 0, fps: 30, width: 1920, quality: 80, capture: false });
  try {
    // Minimal JPEG frame header suffices to exercise the transport framing.
    const image = Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,0,1,0,1,3,1,17,0,2,17,0,3,17,0,0xff,0xd9]);
    const uploaded = await fetch(relay.address + '/frame', { method: 'POST',
      headers: { Authorization: `Bearer ${relay.token}` }, body: image });
    assert.equal(uploaded.status, 204);
    const response = await fetch(relay.address + '/stream.mjpeg', { signal: AbortSignal.timeout(2000) });
    const reader = response.body!.getReader();
    let data = Buffer.alloc(0);
    try {
      do { data = Buffer.concat([data, (await reader.read()).value!]); }
      while (!data.includes(image) || !data.subarray(-11).equals(Buffer.from('\r\n--frame\r\n')));
      assert.ok(data.subarray(-11).equals(Buffer.from('\r\n--frame\r\n')));
      assert.ok(data.includes(image));
    } finally { await reader.cancel(); }
    assert.equal(relay.stats().sequence, 1);
  } finally { await relay.close(); }
});

test('relay tracks the capture process, restarts after failure, and releases its own service', async () => {
  let now = Date.now();
  const service = captureService(), relay = new LiveRelay('0', 'p1', 17362, service.launch, () => now);
  await relay.start();
  await relay.start();
  assert.equal(service.starts(), 1);
  assert.equal(relay.view.status, 'starting');
  Object.assign(service.stats, { sequence: 30, fps: 29.8, dimensions: { width: 1920, height: 866 } });
  await relay.refresh();
  assert.equal(relay.view.status, 'live');
  assert.equal(relay.view.fps, 29.8);
  assert.deepEqual(relay.view.dimensions, { width: 1920, height: 866 });
  assert.ok(!JSON.stringify(relay.view).includes('private-upload-token'));
  Object.assign(service.stats, { running: false, workerExit: { code: 1, signal: null } });
  await relay.refresh();
  assert.equal(relay.view.enabled, true);
  assert.equal(relay.view.status, 'recovering');
  assert.equal(relay.view.errorCode, 'RELAY_CAPTURE_FAILED');
  await relay.refresh();
  assert.equal(service.starts(), 1);
  now += 2000;
  await relay.refresh();
  assert.equal(service.starts(), 2);
  assert.equal(service.closes(), 1);
  await relay.stop();
  now += 60_000;
  await relay.refresh();
  await relay.close();
  assert.equal(service.closes(), 2);
  assert.equal(relay.view.obsUrl, null);
  assert.equal(relay.view.status, 'stopped');
});

test('an occupied relay port is reported without attaching to or stopping the other service', async () => {
  const relay = new LiveRelay('0', 'p1', 17362, async () => { throw Object.assign(Error('occupied'), { code: 'EADDRINUSE' }); });
  await relay.start();
  assert.equal(relay.view.enabled, true);
  assert.equal(relay.view.status, 'recovering');
  assert.equal(relay.view.errorCode, 'RELAY_PORT_IN_USE');
  await relay.close();
});

test('console relay writes are idempotent, validated, origin checked, and independent of automatic play', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'maji-relay-test-'));
  const store = new StorageClient(join(directory, 'state.sqlite'));
  const service = captureService(), relay = new LiveRelay('0', 'p1', 17362, service.launch);
  let gameStarts = 0, gameStops = 0;
  const automation: AutomationPort = {
    view: { available: true, enabled: true, status: 'playing', completedMatches: 0, sessionId: null },
    async start() { gameStarts++; }, async stop() { gameStops++; }, async refresh() {}, async close() {},
  };
  const runtime = await ConsoleRuntime.open({ store, source: { kind: 'follow', sessionId: 'idle' },
    voices: [], voiceId: 'test', relay, automation });
  const server = createConsoleServer(runtime, 0, 17364);
  try {
    let origin: string;
    try { ({ origin } = await server.listen()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('loopback unavailable'); return; } throw error; }
    const command = { commandId: randomUUID(), issuedAt: new Date().toISOString(), sessionId: null, enabled: true };
    const send = (body = command, from = origin) => fetch(origin + '/api/relay/set', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: from }, body: JSON.stringify(body),
    });
    assert.equal((await send(command, 'https://example.com')).status, 403);
    assert.equal((await send({ ...command, enabled: 'true' as any })).status, 422);
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal(service.starts(), 1);
    Object.assign(service.stats, { sequence: 20, fps: 30, dimensions: { width: 1920, height: 934 } });
    await runtime.tick();
    const state = await fetch(origin + '/api/console/snapshot').then(r => r.json());
    assert.equal(state.data.state.relay.status, 'live');
    assert.equal(state.data.state.relay.obsUrl, 'http://127.0.0.1:17362/obs');
    assert.ok(!JSON.stringify(state).includes('private-upload-token'));
    const page = await fetch(origin + '/');
    assert.match(page.headers.get('content-security-policy')!, /img-src 'self' http:\/\/127.0.0.1:17364/);
    assert.match(await page.text(), /id="relay-toggle"/);
    assert.equal((await send({ ...command, commandId: randomUUID(), enabled: false })).status, 200);
    assert.equal(service.closes(), 1);
    assert.equal(gameStarts, 0);
    assert.equal(gameStops, 0);
    assert.equal(runtime.projections.console.automation.enabled, true);
  } finally { await server.close(); await runtime.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});
