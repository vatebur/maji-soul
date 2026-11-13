import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ChromiumPage } from '../src/adapters/browser/chromium.ts';
import { chromiumRelay } from '../src/adapters/browser/chromium-relay.ts';

function jpeg(width: number, height: number) {
  const bytes = Buffer.from([0xff,0xd8,0xff,0xc0,0,17,8,0,1,0,1,3,1,17,0,2,17,0,3,17,0,0xff,0xd9]);
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9);
  return bytes;
}

async function until(check: () => boolean) {
  const deadline = performance.now() + 3000;
  while (!check()) {
    assert.ok(performance.now() < deadline, 'relay did not reach the expected state');
    await delay(10);
  }
}

async function fixture(t: TestContext, initial = { width: 2036, height: 918, dpr: 1 }, width = 1920) {
  let layout = { ...initial }, reads = 0, started = false;
  let heartbeat: Buffer = jpeg(Math.round(layout.width * layout.dpr), Math.round(layout.height * layout.dpr));
  const events = new Map<string, (event: any) => void>(), acknowledgements: number[] = [];
  const page = {
    async evaluate() { reads++; return { ...layout }; },
    async cdp(method: string, params: any) {
      if (method === 'Page.startScreencast') started = true;
      if (method === 'Page.captureScreenshot') return { data: heartbeat.toString('base64') };
      if (method === 'Page.screencastFrameAck') acknowledgements.push(params.sessionId);
      return {};
    },
    on(method: string, listener: (event: any) => void) { events.set(method, listener); return () => { events.delete(method); }; },
    close() {},
  };
  t.mock.method(ChromiumPage, 'connect', async () => page as unknown as ChromiumPage);
  const relay = await chromiumRelay('http://127.0.0.1:9222')({ space: 0, page: 'p1', port: 0, fps: 60, width, quality: 80 });
  t.after(() => relay.close());
  await until(() => started && relay.stats().sequence === 1);
  let session = 0;
  return {
    relay, reads: () => reads, acknowledgements,
    frame(w: number, h: number) { const id = ++session; events.get('Page.screencastFrame')!({ sessionId: id, data: jpeg(w,h).toString('base64') }); return id; },
    resize(value: typeof layout, notify = true) {
      layout = { ...value }; heartbeat = jpeg(Math.round(layout.width * layout.dpr), Math.round(layout.height * layout.dpr));
      if (notify) events.get('Page.frameResized')!({});
    },
    heartbeat(value: Buffer) { heartbeat = value; },
  };
}

test('Chromium relay accepts complete frames with width/height scaling, DPR and normal pixel rounding', async t => {
  for (const scenario of [
    { layout: { width: 2036, height: 918, dpr: 1 }, width: 1920, frame: [1920, 866] },
    { layout: { width: 1000, height: 2000, dpr: 2 }, width: 1920, frame: [1080, 2160] },
    { layout: { width: 800, height: 600, dpr: 1 }, width: 1920, frame: [800, 600] },
  ]) await t.test(JSON.stringify(scenario), async t => {
    const f = await fixture(t, scenario.layout, scenario.width);
    assert.deepEqual(f.relay.stats().dimensions, { width: scenario.layout.width * scenario.layout.dpr,
      height: scenario.layout.height * scenario.layout.dpr }, 'full-size heartbeat must remain valid');
    const sequence = f.relay.stats().sequence, [w,h] = scenario.frame as [number,number];
    const ack = f.frame(w,h);
    await until(() => f.relay.stats().sequence === sequence + 1);
    assert.deepEqual(f.relay.stats().dimensions, { width: w, height: h });
    f.frame(w - 2, h + 2);
    await until(() => f.relay.stats().sequence === sequence + 2);
    assert.ok(f.acknowledgements.includes(ack));
    assert.equal(f.reads(), 1, 'ordinary frames must not incur layout reads');
  });
});

test('cropped screencast and heartbeat frames are acknowledged but never replace the last complete image', async t => {
  const f = await fixture(t);
  const before = f.relay.stats(), image = Buffer.from(await (await fetch(f.relay.address + '/frame.jpg')).arrayBuffer());
  for (const [w,h] of [[58,30], [58,266], [1920,30], [1915,866]]) {
    const ack = f.frame(w!,h!);
    await delay(40);
    assert.ok(f.acknowledgements.includes(ack));
    assert.equal(f.relay.stats().sequence, before.sequence);
    assert.deepEqual(f.relay.stats().dimensions, before.dimensions);
  }
  assert.deepEqual(Buffer.from(await (await fetch(f.relay.address + '/frame.jpg')).arrayBuffer()), image);
  assert.equal(f.reads(), 1, 'a crop burst must not trigger per-frame CDP layout reads');
  f.heartbeat(jpeg(58,30));
  // Exercise the real heartbeat path without a two-second wall-clock wait.
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 2500);
  await until(() => f.reads() === 2);
  await delay(40);
  assert.equal(f.relay.stats().sequence, before.sequence);
  assert.deepEqual(f.relay.stats().dimensions, before.dimensions);
  f.frame(1920,866);
  await until(() => f.relay.stats().sequence === before.sequence + 1);
  assert.equal(f.relay.stats().running, true);
});

test('a genuine resize refreshes the expected viewport and keeps rejecting crops', async t => {
  const f = await fixture(t), before = f.relay.stats().sequence;
  f.resize({ width: 1600, height: 900, dpr: 1 });
  f.frame(1600,900);
  await until(() => f.relay.stats().sequence === before + 1);
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.relay.stats().dimensions, { width: 1600, height: 900 });
  const ack = f.frame(58,30);
  await delay(40);
  assert.ok(f.acknowledgements.includes(ack));
  assert.equal(f.relay.stats().sequence, before + 1);
});

test('missed resize events recover through a rate-limited layout reread', async t => {
  const f = await fixture(t), before = f.relay.stats().sequence;
  f.resize({ width: 1440, height: 810, dpr: 1 }, false);
  f.frame(1440,810);
  await delay(40);
  assert.equal(f.relay.stats().sequence, before);
  assert.equal(f.reads(), 1);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 1100);
  f.frame(1440,810);
  await until(() => f.relay.stats().sequence === before + 1);
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.relay.stats().dimensions, { width: 1440, height: 810 });
});
