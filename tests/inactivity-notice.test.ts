import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isInactivityNotice, inspectInactivityNotice, dismissInactivityNotice } from '../src/adapters/majsoul/inactivity-notice.ts';
import { decodeScreenshotPng } from '../src/adapters/browser/png.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import { png } from './countdown-helpers.ts';

// Raw crops from the independently inspected Linux client screenshot. Names,
// hands and every other background pixel have been removed from this fixture.
const native = decodeScreenshotPng(readFileSync(new URL('./fixtures/inactivity/native-notice.png', import.meta.url)));
const evidence = JSON.parse(readFileSync(new URL('../src/adapters/majsoul/inactivity-notice-profile.json', import.meta.url), 'utf8'));
function picture(kind: 'both' | 'message' | 'button' | 'neither' | 'partial-message' | 'wrong-button' = 'both') {
  const image = { ...native, rgba: new Uint8Array(native.rgba) };
  const erase = (x: number, y: number, width: number, height: number) => {
    for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++)
      image.rgba.set([28, 39, 64, 255], (yy * image.width + xx) * 4);
  };
  if (['message', 'neither', 'partial-message'].includes(kind)) erase(964, 570, 112, 42);
  if (['button', 'neither', 'wrong-button'].includes(kind)) erase(718, 394, 558, 71);
  if (kind === 'partial-message') erase(718, 432, 56, 33);
  if (kind === 'wrong-button') erase(1045, 570, 31, 42);
  return image;
}
const scope = { paused: true, executorActive: false, controlEpoch: 0, connected: true,
  pageEpoch: 2, generation: 3, gameUuid: 'game', matchEnded: false, overflow: false, reason: null };
function harness(first = picture(), second = first, persistent = false) {
  const state: Record<string, unknown> = { ...scope }, commands: { method: string; params?: any }[] = [];
  const frames = [png(first), png(second)], absent = png(picture('neither'));
  let captures = 0, released = false;
  const hooks = { moved: () => {}, pressed: () => {} };
  const page: EgoPagePort = {
    evaluate: async (_source, input) => { assert.equal(input.method, 'read'); return { ...state }; },
    cdp: async (method, params) => {
      commands.push({ method, params });
      if (method === 'Page.captureScreenshot') return { data: released && !persistent ? absent : frames[Math.min(captures++, 1)] };
      assert.equal(method, 'Input.dispatchMouseEvent');
      if (params.type === 'mouseMoved') hooks.moved();
      if (params.type === 'mousePressed') hooks.pressed();
      if (params.type === 'mouseReleased') released = true;
      return {};
    },
  };
  return { page, state, commands, hooks };
}

test('native full message OR 我回了 is sufficient; partial messages and other buttons are not', () => {
  assert.equal(evidence.evidenceKind, 'native-client-redacted-glyph-masks');
  assert.deepEqual(evidence.regions.map((r: any) => r.text), ['檢測到您處於離開狀態，已切換成自動摸', '切。', '我回了']);
  for (const kind of ['both', 'message', 'button'] as const) assert.equal(isInactivityNotice(picture(kind)), true, kind);
  for (const kind of ['neither', 'partial-message', 'wrong-button'] as const) assert.equal(isInactivityNotice(picture(kind)), false, kind);
  assert.equal(isInactivityNotice({ ...native, rgba: new Uint8Array(1) }), false);
});

test('inspection is read only, and either match path clicks once then verifies disappearance', async () => {
  for (const kind of ['message', 'button'] as const) {
    const h = harness(picture(kind));
    assert.equal((await inspectInactivityNotice(h.page)).visible, true);
    assert.deepEqual(h.commands.map(c => c.method), ['Page.captureScreenshot']);
    h.commands.length = 0;
    assert.equal(await dismissInactivityNotice(h.page), true);
    const pressed = h.commands.filter(c => c.params?.type === 'mousePressed');
    assert.equal(pressed.length, 1); assert.equal(pressed[0]!.params.buttons, 1);
    assert.ok(Math.abs(pressed[0]!.params.x - 1020) < 1 && Math.abs(pressed[0]!.params.y - 592) < 1);
    assert.equal(h.commands.filter(c => c.params?.type === 'mouseReleased').length, 1);
  }
});

test('active executors, stale game/documents, changed pixels and resized views prevent pressing', async () => {
  for (const patch of [{ paused: false }, { executorActive: true }, { executorActive: undefined }, { controlEpoch: 1 },
    { connected: false }, { matchEnded: true }, { reason: 'DISCONNECTED' }, { gameUuid: null }]) {
    const h = harness(); Object.assign(h.state, patch);
    await assert.rejects(dismissInactivityNotice(h.page), /INACTIVITY_NOTICE_SCOPE_CHANGED/);
    assert.equal(h.commands.length, 0);
  }
  for (const patch of [{ pageEpoch: 3 }, { gameUuid: 'other' }, { executorActive: true }, { paused: false }]) {
    const h = harness(); h.hooks.moved = () => Object.assign(h.state, patch);
    await assert.rejects(dismissInactivityNotice(h.page), /INACTIVITY_NOTICE_SCOPE_CHANGED/);
    assert.equal(h.commands.some(c => c.params?.type === 'mousePressed'), false);
  }
  const h = harness(picture(), picture('neither'));
  await assert.rejects(dismissInactivityNotice(h.page), /INACTIVITY_NOTICE_CHANGED/);
  assert.equal(h.commands.some(c => c.params?.type === 'mousePressed'), false);
});

test('ordinary native steps behind the same modal do not require a stale action permit', async () => {
  const h = harness(); h.hooks.moved = () => { h.state.generation = 5; h.state.lastStep = 99; };
  assert.equal(await dismissInactivityNotice(h.page), true);
});

test('operator cancellation prevents input, and a cancelled or uncertain press is always released', async () => {
  for (const at of ['before', 'moved', 'pressed', 'uncertain'] as const) {
    const h = harness(), controller = new AbortController();
    if (at === 'before') controller.abort();
    else if (at === 'uncertain') h.hooks.pressed = () => { throw Error('BROWSER_COMMAND_TIMEOUT'); };
    else h.hooks[at] = () => controller.abort();
    await assert.rejects(dismissInactivityNotice(h.page, controller.signal));
    const presses = h.commands.filter(c => c.params?.type === 'mousePressed').length;
    assert.equal(presses, at === 'pressed' || at === 'uncertain' ? 1 : 0);
    assert.equal(h.commands.filter(c => c.params?.type === 'mouseReleased').length, presses);
  }
});

test('a persistent modal receives no duplicate press, even across game generations', async () => {
  const h = harness(picture(), picture(), true);
  await assert.rejects(dismissInactivityNotice(h.page), /INACTIVITY_NOTICE_NOT_DISMISSED/);
  h.state.generation = 4;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 80);
  try { await assert.rejects(dismissInactivityNotice(h.page, controller.signal)); }
  finally { clearTimeout(timer); }
  assert.equal(h.commands.filter(c => c.params?.type === 'mousePressed').length, 1);
});
