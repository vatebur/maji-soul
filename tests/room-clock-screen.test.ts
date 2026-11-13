import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAudienceRoom, identifyCreationClock } from '../src/adapters/majsoul/room-clock-screen.ts';
import { decodeScreenshotPng } from '../src/adapters/majsoul/auto-win.ts';
import { identifyLobbyScreen } from '../src/adapters/majsoul/lobby-screen.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import { png } from './countdown-helpers.ts';

// These PNGs preserve only the observed native clock buttons and creation
// anchors; the rest of the original client screenshots has been blacked out.
const defaultPng = readFileSync(new URL('./fixtures/room-clock/default.png', import.meta.url)).toString('base64');
const sixtyPng = readFileSync(new URL('./fixtures/room-clock/sixty.png', import.meta.url)).toString('base64');
const image = (data: string) => decodeScreenshotPng(Buffer.from(data, 'base64'));
function harness(initial = defaultPng) {
  let current = initial, captures = 0;
  const scope = { paused: true, executorActive: false, controlEpoch: 0, pageEpoch: 1, generation: 3, sourceStream: 0, gameUuid: null as string | null };
  const events: any[] = [], controller = new AbortController();
  const hooks = { capture: (_count: number) => {}, moved: (_event: any) => {}, pressed: (_event: any) => {} };
  const page: EgoPagePort = {
    evaluate: async (_source, argument) => argument?.method === 'read' ? { ...scope } : { width: 1919, height: 992 },
    cdp: async (method, argument) => {
      if (method === 'Emulation.clearDeviceMetricsOverride') return {};
      if (method === 'Page.captureScreenshot') { hooks.capture(++captures); return { data: current }; }
      assert.equal(method, 'Input.dispatchMouseEvent'); events.push(argument);
      if (argument.type === 'mouseMoved') hooks.moved(argument);
      if (argument.type === 'mousePressed') {
        scope.generation++;
        if (argument.y < 700) current = argument.x > 1190 ? sixtyPng : defaultPng;
        hooks.pressed(argument);
      }
      return {};
    },
  };
  return { page, scope, events, controller, hooks, get captures() { return captures; }, set current(value: string) { current = value; } };
}

test('actual default and sixty-second native samples remain recognizable creation screens', () => {
  for (const [data, setting] of [[defaultPng, '5+20'], [sixtyPng, '60+0']] as const) {
    assert.equal(identifyLobbyScreen(image(data)), 'create');
    assert.equal(identifyCreationClock(image(data)), setting);
  }
  const changed = image(sixtyPng);
  // A selected color alone must not stand in for the actual 60+0 label.
  for (let y = 541; y < 585; y++) for (let x = 1238; x < 1364; x++) changed.rgba.set([255, 176, 71, 255], (y * changed.width + x) * 4);
  assert.equal(identifyCreationClock(changed), 'unknown');
  const twoSelected = image(sixtyPng), other = image(defaultPng);
  for (let y = 524; y < 604; y++) for (let x = 941; x < 1175; x++) {
    const at = (y * twoSelected.width + x) * 4; twoSelected.rgba.set(other.rgba.subarray(at, at + 4), at);
  }
  assert.equal(identifyCreationClock(twoSelected), 'unknown');
});

test('creation selects the observed sixty-second button once and rechecks before creating', async () => {
  const h = harness(); await createAudienceRoom(h.page, '60+0', h.controller.signal);
  const presses = h.events.filter(event => event.type === 'mousePressed');
  assert.equal(presses.length, 2); assert.equal(presses[0].x, 1300); assert.equal(presses[0].y, 563);
  assert.ok(presses[1].y > 800); assert.ok(h.captures >= 5);
  assert.equal(h.events.filter(event => event.type === 'mouseReleased').length, 2);
});

test('an already selected clock is never toggled and both evidenced settings are supported', async () => {
  const h = harness(sixtyPng); await createAudienceRoom(h.page, '60+0', h.controller.signal);
  assert.deepEqual(h.events.filter(event => event.type === 'mousePressed').map(event => event.y > 800), [true]);
  const back = harness(sixtyPng); await createAudienceRoom(back.page, '5+20', back.controller.signal);
  assert.equal(back.events.filter(event => event.type === 'mousePressed')[0].x, 1055);
});

test('unknown clock pixels or missing paused scope never authorize a clock press', async () => {
  const blank = image(defaultPng); blank.rgba.fill(0);
  const absent = harness(png(blank));
  await assert.rejects(createAudienceRoom(absent.page, '60+0', absent.controller.signal), /ROOM_CLOCK_UNVERIFIED/);
  assert.equal(absent.events.length, 0);
  for (const patch of [{ paused: false }, { executorActive: true }, { controlEpoch: 1 }, { sourceStream: -1 }]) {
    const h = harness(); Object.assign(h.scope, patch);
    await assert.rejects(createAudienceRoom(h.page, '60+0', h.controller.signal), /ROOM_SCOPE_CHANGED/);
    assert.equal(h.events.length, 0);
  }
  const unsupported = harness();
  await assert.rejects(createAudienceRoom(unsupported.page, '300+0', unsupported.controller.signal), /FRIEND_ROOM_CLOCK_UNSUPPORTED/);
  assert.equal(unsupported.events.length, 0);
});

test('scope or image changes before a press prevent selecting the clock', async () => {
  for (const mode of ['generation', 'page', 'stream', 'image'] as const) {
    const h = harness(); h.hooks.moved = () => {
      if (mode === 'image') h.current = sixtyPng;
      else if (mode === 'generation') h.scope.generation++;
      else if (mode === 'page') h.scope.pageEpoch++;
      else h.scope.sourceStream++;
    };
    await assert.rejects(createAudienceRoom(h.page, '60+0', h.controller.signal), /ROOM_(CLOCK_CHANGED|SCOPE_CHANGED)/);
    assert.equal(h.events.some(event => event.type === 'mousePressed'), false);
  }
});

test('a changed selection or scope before Create cannot create a wrongly configured room', async () => {
  for (const mode of ['selection', 'scope'] as const) {
    const h = harness(); h.hooks.moved = event => {
      if (event.y < 700) return;
      if (mode === 'selection') h.current = defaultPng; else h.scope.gameUuid = 'replacement';
    };
    await assert.rejects(createAudienceRoom(h.page, '60+0', h.controller.signal), /ROOM_(CLOCK_CHANGED|SCOPE_CHANGED)/);
    assert.equal(h.events.filter(event => event.type === 'mousePressed').length, 1);
  }
});

test('only the clock button pointerdown may advance generation before Create', async () => {
  for (const extra of [1, 2]) {
    const h = harness();
    h.hooks.pressed = () => { h.scope.generation += extra; };
    await assert.rejects(createAudienceRoom(h.page, '60+0', h.controller.signal), /ROOM_SCOPE_CHANGED/);
    const presses = h.events.filter(event => event.type === 'mousePressed');
    assert.equal(presses.length, 1);
    assert.equal(presses[0].y, 563);
    assert.equal(h.events.filter(event => event.type === 'mouseReleased').length, 1);
  }
});

test('cancellation prevents a new press and still releases an acknowledged clock press', async () => {
  for (const at of ['before', 'moved', 'pressed'] as const) {
    const h = harness();
    if (at === 'before') h.controller.abort();
    else h.hooks[at] = () => h.controller.abort();
    await assert.rejects(createAudienceRoom(h.page, '60+0', h.controller.signal), { name: 'AbortError' });
    const count = at === 'pressed' ? 1 : 0;
    assert.equal(h.events.filter(event => event.type === 'mousePressed').length, count);
    assert.equal(h.events.filter(event => event.type === 'mouseReleased').length, count);
  }
});
