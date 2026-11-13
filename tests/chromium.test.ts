import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChromiumPage, browserEndpoint } from '../src/adapters/browser/chromium.ts';

class Socket extends EventTarget {
  static OPEN = 1;
  static current: Socket;
  readyState = 1;
  sent: any[] = [];
  reply = true;
  constructor(_url: string | URL) {
    super(); Socket.current = this;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(text: string) {
    const request = JSON.parse(text); this.sent.push(request);
    if (this.reply) queueMicrotask(() => {
      this.receive({ id: request.id, result: request.method === 'Runtime.evaluate' ? { result: { value: 42 } } : {} });
      if (request.method === 'Page.reload') this.receive({ method: 'Page.loadEventFired', params: {} });
    });
  }
  receive(value: any) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { if (!this.readyState) return; this.readyState = 0; this.dispatchEvent(new Event('close')); }
}
const target = { type: 'page', url: 'https://game.maj-soul.com/1/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/test' };
function mocks(t: TestContext, targets = [target]) {
  t.mock.method(globalThis, 'fetch', async () => Response.json(targets));
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as any;
  t.after(() => { globalThis.WebSocket = original; });
}

test('browser endpoint rejects remote/debug credentials and extraneous paths', () => {
  assert.equal(browserEndpoint('http://127.0.0.1:9222'), 'http://127.0.0.1:9222');
  for (const url of ['http://192.168.1.2:9222', 'https://localhost:9222', 'http://u:p@localhost:9222', 'http://localhost:9222/json', 'http://localhost:9222/?token=a'])
    assert.throws(() => browserEndpoint(url), /INVALID_BROWSER_ENDPOINT/);
});

test('only one explicitly configured game page may be selected', async t => {
  mocks(t, []);
  await assert.rejects(ChromiumPage.connect('http://127.0.0.1:9222'), /GAME_PAGE_NOT_FOUND/);
  t.mock.method(globalThis, 'fetch', async () => Response.json([target, target]));
  await assert.rejects(ChromiumPage.connect('http://127.0.0.1:9222'), /GAME_PAGE_AMBIGUOUS/);
  t.mock.method(globalThis, 'fetch', async () => Response.json([{ ...target, webSocketDebuggerUrl: 'ws://example.com/devtools/page/test' }]));
  await assert.rejects(ChromiumPage.connect('http://127.0.0.1:9222'), /INVALID_BROWSER_ENDPOINT/);
});

test('CDP evaluation serializes arguments and reload waits for the new document', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222');
  try {
    assert.equal(await page.evaluate(arg => arg.value, { value: '"\\\n' }), 42);
    const request = Socket.current.sent.at(-1);
    assert.equal(request.params.returnByValue, true);
    assert.equal(request.params.awaitPromise, true);
    assert.equal(request.params.timeout, 12_000);
    assert.equal(Function(`return ${request.params.expression}`)(), '"\\\n');
    await page.reload();
  } finally { page.close(); }
});

test('lossless Linux screenshot optimization preserves geometry and explicit capture preferences', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222'), socket = Socket.current;
  try {
    const input = { format: 'png', fromSurface: true, captureBeyondViewport: false };
    await page.cdp('Page.captureScreenshot', input);
    assert.deepEqual(socket.sent.at(-1).params, { ...input, optimizeForSpeed: true });
    assert.equal('optimizeForSpeed' in input, false);
    await page.cdp('Page.captureScreenshot', { ...input, optimizeForSpeed: false });
    assert.equal(socket.sent.at(-1).params.optimizeForSpeed, false);
    await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    assert.deepEqual(socket.sent.at(-1).params, { format: 'jpeg', quality: 60 });
    await page.captureViewportPng();
    assert.deepEqual(socket.sent.at(-1).params, { format: 'png', fromSurface: false,
      captureBeyondViewport: false, optimizeForSpeed: true });
  } finally { page.close(); }
});

test('native region capture requires this session to own an unscaled viewport and validates its bounds', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222'), socket = Socket.current;
  const region = { x: 211, y: 464, width: 58, height: 266 };
  try {
    await assert.rejects(page.captureViewportPngRegion(region), /BROWSER_REGION_CAPTURE_UNAVAILABLE/);
    assert.equal(socket.sent.some(request => request.method === 'Page.captureScreenshot'), false);
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 2036, height: 918, deviceScaleFactor: 1, mobile: false });
    await page.captureViewportPngRegion(region);
    assert.deepEqual(socket.sent.at(-1).params, { format: 'png', fromSurface: true, captureBeyondViewport: false,
      optimizeForSpeed: true, clip: { ...region, scale: 1 } });
    const sent = socket.sent.length;
    for (const bad of [{ ...region, width: 0 }, { ...region, x: -1 }, { ...region, y: 0.5 }, { ...region, width: 2036 }])
      await assert.rejects(page.captureViewportPngRegion(bad), /BROWSER_SCREENSHOT_REGION_INVALID/);
    assert.equal(socket.sent.length, sent);
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 2036, height: 918, deviceScaleFactor: 2, mobile: false });
    await assert.rejects(page.captureViewportPngRegion(region), /BROWSER_REGION_CAPTURE_UNAVAILABLE/);
    await page.cdp('Emulation.clearDeviceMetricsOverride');
    await assert.rejects(page.captureViewportPngRegion(region), /BROWSER_REGION_CAPTURE_UNAVAILABLE/);
  } finally { page.close(); }
});

test('full, native region, direct screenshots and viewport changes serialize and a failure releases the queue', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222'), socket = Socket.current;
  try {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 2036, height: 918, deviceScaleFactor: 1, mobile: false });
    socket.reply = false;
    const baseline = socket.sent.length, full = page.captureViewportPng();
    const region = { x: 211, y: 464, width: 58, height: 266 }, cropped = page.captureViewportPngRegion(region);
    const refused = assert.rejects(cropped, /BROWSER_COMMAND_FAILED/);
    region.width = 999;
    const direct = page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    const cleared = page.cdp('Emulation.clearDeviceMetricsOverride');
    assert.equal(socket.sent.length, baseline + 1);
    const read = page.evaluate('42');
    assert.equal(socket.sent.at(-1).method, 'Runtime.evaluate');
    socket.receive({ id: socket.sent.at(-1).id, result: { result: { value: 42 } } });
    await read;
    socket.receive({ id: socket.sent[baseline].id, result: { data: 'whole' } });
    assert.deepEqual(await full, { data: 'whole' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(socket.sent.at(-1).params.clip, { x: 211, y: 464, width: 58, height: 266, scale: 1 });
    socket.receive({ id: socket.sent.at(-1).id, error: { message: 'private' } });
    await refused; await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(socket.sent.at(-1).params, { format: 'jpeg', quality: 60 });
    socket.receive({ id: socket.sent.at(-1).id, result: { data: 'jpeg' } });
    await direct; await new Promise(resolve => setImmediate(resolve));
    assert.equal(socket.sent.at(-1).method, 'Emulation.clearDeviceMetricsOverride');
    socket.receive({ id: socket.sent.at(-1).id, result: {} }); await cleared;
    await assert.rejects(page.captureViewportPngRegion({ x: 211, y: 464, width: 58, height: 266 }), /BROWSER_REGION_CAPTURE_UNAVAILABLE/);
  } finally { page.close(); }
});

test('closing a page rejects both its active screenshot and queued captures without another CDP request', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222'), socket = Socket.current;
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 2036, height: 918, deviceScaleFactor: 1, mobile: false });
  socket.reply = false;
  const first = assert.rejects(page.captureViewportPng(), /BROWSER_DISCONNECTED/);
  const second = assert.rejects(page.captureViewportPngRegion({ x: 211, y: 464, width: 58, height: 266 }), /BROWSER_DISCONNECTED/);
  const count = socket.sent.length;
  page.close(); await Promise.all([first, second]);
  assert.equal(socket.sent.length, count);
});

test('out-of-order replies are matched and disconnect rejects all outstanding work', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222');
  const socket = Socket.current; socket.reply = false;
  const first = page.cdp('Page.first'), second = page.cdp('Page.second');
  socket.receive({ id: socket.sent.at(-1).id, result: { second: true } });
  socket.receive({ id: socket.sent.at(-2).id, result: { first: true } });
  assert.deepEqual(await first, { first: true }); assert.deepEqual(await second, { second: true });
  const pending = page.cdp('Page.pending');
  const rejected = assert.rejects(pending, /BROWSER_DISCONNECTED/);
  page.close(); await rejected;
  await assert.rejects(page.cdp('Page.afterClose'), /BROWSER_DISCONNECTED/);
});

test('page exceptions and protocol errors are sanitized', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222');
  const socket = Socket.current; socket.reply = false;
  const evaluation = page.evaluate('secret');
  socket.receive({ id: socket.sent.at(-1).id, result: { exceptionDetails: { text: 'private' } } });
  await assert.rejects(evaluation, /^Error: BROWSER_EVALUATION_FAILED$/);
  const command = page.cdp('Page.test');
  socket.receive({ id: socket.sent.at(-1).id, error: { message: 'private' } });
  await assert.rejects(command, /^Error: BROWSER_COMMAND_FAILED$/);
  page.close();
});

test('disconnect after reload acknowledgement rejects the pending load immediately', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222');
  const socket = Socket.current; socket.reply = false;
  const reloading = page.reload();
  const rejected = assert.rejects(reloading, /BROWSER_DISCONNECTED/);
  socket.receive({ id: socket.sent.at(-1).id, result: {} });
  await new Promise(resolve => setImmediate(resolve));
  page.close();
  await rejected;
});

test('a failed frame consumer closes its browser session without crashing the process', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222');
  page.on('Page.screencastFrame', () => { throw Error('consumer fault'); });
  Socket.current.receive({ method: 'Page.screencastFrame', params: {} });
  await assert.rejects(page.cdp('Page.afterFailure'), /BROWSER_DISCONNECTED/);
});

test('native clicks hold across frames without delaying press or unrelated CDP reads', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222'), socket = Socket.current;
  const times = new Map<string, number>(), original = socket.send.bind(socket);
  t.mock.method(socket, 'send', (text: string) => {
    const request = JSON.parse(text); times.set(request.params?.type ?? request.method, performance.now()); original(text);
  });
  try {
    const down = page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 3, button: 'left' });
    assert.equal(socket.sent.at(-1).params.type, 'mousePressed', 'final fence must be followed by immediate press dispatch');
    await down;
    const released = page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 3, button: 'left' });
    await page.cdp('Page.captureScreenshot');
    assert.equal(socket.sent.at(-1).method, 'Page.captureScreenshot');
    await released;
    assert.ok(times.get('mouseReleased')! - times.get('mousePressed')! >= 95);
    assert.equal(socket.sent.filter(request => request.params?.type === 'mouseReleased').length, 1);
  } finally { page.close(); }
});

test('pointer movement settles before the final fence while other reads remain available', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222'), socket = Socket.current;
  try {
    const started = performance.now();
    let settled = false;
    const moved = page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 3 })
      .then(result => { settled = true; return result; });
    assert.equal(socket.sent.at(-1).params.type, 'mouseMoved');
    await page.evaluate('42');
    assert.equal(settled, false, 'movement must yield for the native render loop');
    assert.deepEqual(await moved, {});
    assert.ok(performance.now() - started >= 95);
    await page.evaluate('42'); // caller rechecks its operation fence after movement
    const pressed = page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 3, button: 'left' });
    assert.equal(socket.sent.at(-1).params.type, 'mousePressed', 'no delay after the final fence');
    await pressed;
  } finally { page.close(); }
});

test('a slow press acknowledgement cannot consume the native button hold interval', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222'), socket = Socket.current;
  try {
    socket.reply = false;
    const down = page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 3, button: 'left' });
    const downId = socket.sent.at(-1).id;
    const up = page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 3, button: 'left' });
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(socket.sent.some(request => request.params?.type === 'mouseReleased'), false);
    const acknowledgedAt = performance.now();
    socket.reply = true;
    socket.receive({ id: downId, result: {} });
    await down;
    await page.cdp('Page.captureScreenshot');
    assert.equal(socket.sent.some(request => request.params?.type === 'mouseReleased'), false);
    await up;
    assert.ok(performance.now() - acknowledgedAt >= 95);
    assert.equal(socket.sent.filter(request => request.params?.type === 'mouseReleased').length, 1);
  } finally { page.close(); }
});

test('movement settling rejects instead of permitting a click in a replacement document', async t => {
  for (const mode of ['disconnect', 'navigation-event', 'navigate', 'reload'] as const) await t.test(mode, async t => {
    mocks(t);
    const page = await ChromiumPage.connect('http://127.0.0.1:9222'), socket = Socket.current;
    try {
      const gesture = (async () => {
        await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 3 });
        await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 3, button: 'left' });
      })();
      const rejected = assert.rejects(gesture, mode === 'disconnect' ? /BROWSER_DISCONNECTED/ : /BROWSER_INPUT_SCOPE_CHANGED/);
      await new Promise(resolve => setImmediate(resolve));
      if (mode === 'disconnect') page.close();
      else if (mode === 'reload') await page.reload();
      else if (mode === 'navigate') await page.cdp('Page.navigate', { url: target.url });
      else socket.receive({ method: 'Page.frameNavigated', params: { frame: { id: 'new-main-frame' } } });
      await rejected;
      assert.equal(socket.sent.some(request => request.params?.type === 'mousePressed'), false);
    } finally { page.close(); }
  });
});

test('delayed mouse release is cancelled by disconnect or a replacement document', async t => {
  for (const mode of ['disconnect', 'navigate', 'reload'] as const) await t.test(mode, async t => {
    mocks(t);
    const page = await ChromiumPage.connect('http://127.0.0.1:9222'), socket = Socket.current;
    try {
      await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 3, button: 'left' });
      const released = page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 3, button: 'left' });
      const rejected = assert.rejects(released, /BROWSER_DISCONNECTED|BROWSER_INPUT_SCOPE_CHANGED/);
      if (mode === 'disconnect') page.close();
      else if (mode === 'reload') await page.reload();
      else socket.receive({ method: 'Page.frameNavigated', params: { frame: { id: 'new-main-frame' } } });
      await rejected;
      assert.equal(socket.sent.some(request => request.params?.type === 'mouseReleased'), false);
    } finally { page.close(); }
  });
});

test('native mouse events supply Unity held-button masks without changing explicit caller state', async t => {
  mocks(t);
  const page = await ChromiumPage.connect('http://127.0.0.1:9222'), socket = Socket.current;
  try {
    for (const [button, mask] of [['left', 1], ['right', 2], ['middle', 4]] as const) {
      const input = { type: 'mousePressed', x: 2, y: 3, button };
      await page.cdp('Input.dispatchMouseEvent', input);
      assert.equal(socket.sent.at(-1).params.buttons, mask);
      assert.equal('buttons' in input, false, 'adapter must not mutate caller inputs');
      await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 3, button });
      assert.equal(socket.sent.at(-1).params.buttons, 0);
    }
    await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 3, button: 'left', buttons: 3 });
    assert.equal(socket.sent.at(-1).params.buttons, 3);
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 3, button: 'left', buttons: 2 });
    assert.equal(socket.sent.at(-1).params.buttons, 2);
  } finally { page.close(); }
});
