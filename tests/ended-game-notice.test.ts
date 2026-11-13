import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isEndedGameNotice, inspectEndedGameNotice, dismissEndedGameNotice } from '../src/adapters/majsoul/ended-game-notice.ts';
import type { PixelImage } from '../src/adapters/majsoul/auto-win.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import { png } from './countdown-helpers.ts';

// These masks were extracted from the independently viewed native 1202 image.
// Only its three text crops survive; account, table and background pixels do not.
const evidence = JSON.parse(readFileSync(new URL('../src/adapters/majsoul/ended-game-notice-profile.json', import.meta.url), 'utf8'));
const baseScope = { paused: true, executorActive: false, controlEpoch: 0, pageEpoch: 2, generation: 3, gameUuid: null };
function image(variant: 'actual-masks' | 'wrong-code' | 'wrong-message' | 'wrong-button' | 'button-only' = 'actual-masks', width = 1919, height = 992): PixelImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const scale = Math.min(width / 16, height / 9), w = scale * 16, h = scale * 9, left = (width - w) / 2, top = (height - h) / 2;
  for (const region of evidence.regions) {
    if (variant === 'button-only' && region.kind !== 'confirm') continue;
    const source = Buffer.from(region.maskBase64, 'base64');
    const bits = Uint8Array.from({ length: region.cols * region.rows }, (_, i) => (source[i >> 3]! >> (i % 8)) & 1);
    if (variant === 'wrong-code' && region.kind === 'code' || variant === 'wrong-message' && region.kind === 'message' ||
        variant === 'wrong-button' && region.kind === 'confirm') {
      const from = region.cells[0], to = region.cells.at(-1);
      // Replace only the last glyph: 1202 becomes 1201, not an erased panel.
      for (let y = 0; y < region.rows; y++) for (let x = 0; x < to.width; x++)
        bits[y * region.cols + to.x + x] = bits[y * region.cols + from.x + Math.min(from.width - 1, Math.floor(x * from.width / to.width))]!;
    }
    for (let y = 0; y < region.rows; y++) for (let x = 0; x < region.cols; x++) {
      const xx = Math.round(left + (region.x + x / region.cols * region.width) * w);
      const yy = Math.round(top + (region.y + y / region.rows * region.height) * h);
      const foreground = bits[y * region.cols + x];
      const color = region.kind === 'confirm' ? foreground ? [109, 46, 58] : [251, 227, 122]
        : foreground ? [212, 207, 207] : [27, 38, 65];
      rgba.set([...color, 255], (yy * width + xx) * 4);
    }
  }
  return { width, height, rgba };
}
function harness(first = image(), second = first, persistent = false) {
  const scope: Record<string, unknown> = { ...baseScope }, commands: { method: string; params?: any }[] = [];
  const frames = [png(first), png(second)], absent = png(image('button-only')); let captures = 0, released = false;
  const hooks = { moved: () => {}, pressed: () => {} };
  const page: EgoPagePort = {
    evaluate: async (_source, input) => { assert.equal(input.method, 'read'); return { ...scope }; },
    cdp: async (method, params) => {
      commands.push({ method, params });
      if (method === 'Page.captureScreenshot') { const data = released && !persistent ? absent : frames[Math.min(captures, 1)]; captures++; return { data }; }
      assert.equal(method, 'Input.dispatchMouseEvent');
      if (params.type === 'mouseMoved') hooks.moved();
      if (params.type === 'mousePressed') hooks.pressed();
      if (params.type === 'mouseReleased') released = true;
      return {};
    },
  };
  return { page, scope, commands, hooks, get captures() { return captures; } };
}

test('redacted native 1202 code, exact message and confirmation glyphs identify together', () => {
  assert.equal(evidence.evidenceKind, 'native-client-redacted-glyph-masks');
  assert.match(evidence.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(evidence.regions.map((region: any) => region.text), ['錯誤碼：1202', '之前的對局已結束', '確認']);
  assert.equal(isEndedGameNotice(image()), true);
  // Changing only the side bars leaves the same active 16:9 canvas geometry.
  assert.equal(isEndedGameNotice(image('actual-masks', 2035, 992)), true);
  for (const variant of ['wrong-code', 'wrong-message', 'wrong-button', 'button-only'] as const)
    assert.equal(isEndedGameNotice(image(variant)), false, variant);
});

test('inspect is read only and dismissal rereads pixels before exactly one fenced click', async () => {
  const h = harness();
  assert.equal((await inspectEndedGameNotice(h.page)).visible, true);
  assert.deepEqual(h.commands.map(command => command.method), ['Page.captureScreenshot']);
  h.commands.length = 0;
  assert.equal(await dismissEndedGameNotice(h.page), true);
  assert.equal(h.commands.filter(command => command.method === 'Page.captureScreenshot').length, 3);
  const pressed = h.commands.filter(command => command.params?.type === 'mousePressed');
  assert.equal(pressed.length, 1); assert.equal(pressed[0]!.params.buttons, 1);
  assert.ok(Math.abs(pressed[0]!.params.x - 960) < 1 && Math.abs(pressed[0]!.params.y - 635) < 1);
  const released = h.commands.filter(command => command.params?.type === 'mouseReleased');
  assert.equal(released.length, 1); assert.equal(released[0]!.params.buttons, 0);
  assert.equal(h.commands.at(-1)!.method, 'Page.captureScreenshot');
});

test('wrong code, changed message and wrong confirmation button never authorize a click', async () => {
  for (const variant of ['wrong-code', 'wrong-message', 'wrong-button', 'button-only'] as const) {
    const absent = harness(image(variant));
    assert.equal(await dismissEndedGameNotice(absent.page), false);
    assert.equal(absent.commands.some(command => command.method === 'Input.dispatchMouseEvent'), false);
    const changed = harness(image(), image(variant));
    await assert.rejects(dismissEndedGameNotice(changed.page), /ENDED_NOTICE_CHANGED/);
    assert.equal(changed.commands.some(command => command.params?.type === 'mousePressed'), false);
  }
});

test('unpaused or unreleased execution and changed bridge scopes are rejected before pressing', async () => {
  for (const patch of [{ paused: false }, { executorActive: true }, { executorActive: undefined }, { controlEpoch: 1 }, { pageEpoch: undefined }]) {
    const h = harness(); Object.assign(h.scope, patch);
    await assert.rejects(dismissEndedGameNotice(h.page), /ENDED_NOTICE_SCOPE_CHANGED/);
    assert.equal(h.commands.length, 0);
  }
  for (const patch of [{ generation: 4 }, { pageEpoch: 3 }, { gameUuid: 'replacement' }, { executorActive: true }, { paused: false }]) {
    const h = harness(); h.hooks.moved = () => { Object.assign(h.scope, patch); };
    await assert.rejects(dismissEndedGameNotice(h.page), /ENDED_NOTICE_SCOPE_CHANGED/);
    assert.equal(h.commands.some(command => command.params?.type === 'mousePressed'), false);
  }
});

test('a changed viewport between positive samples cannot use the old confirmation coordinates', async () => {
  const h = harness(image(), image('actual-masks', 2036, 992));
  await assert.rejects(dismissEndedGameNotice(h.page), /ENDED_NOTICE_CHANGED/);
  assert.equal(h.commands.some(command => command.params?.type === 'mousePressed'), false);
});

test('cancellation before pressing performs no click and cancellation after pressing still releases', async () => {
  for (const at of ['before', 'moved', 'pressed'] as const) {
    const h = harness(), controller = new AbortController();
    if (at === 'before') controller.abort();
    else h.hooks[at] = () => controller.abort();
    await assert.rejects(dismissEndedGameNotice(h.page, controller.signal), { name: 'AbortError' });
    const pressed = h.commands.filter(command => command.params?.type === 'mousePressed');
    const released = h.commands.filter(command => command.params?.type === 'mouseReleased');
    assert.equal(pressed.length, at === 'pressed' ? 1 : 0);
    assert.equal(released.length, pressed.length);
  }
});

test('a notice that remains visible times out and cannot receive another press on retry', async () => {
  const h = harness(image(), image(), true), started = performance.now();
  await assert.rejects(dismissEndedGameNotice(h.page), /ENDED_NOTICE_NOT_DISMISSED/);
  assert.ok(performance.now() - started < 5_000);
  assert.equal(h.commands.filter(command => command.params?.type === 'mousePressed').length, 1);
  h.scope.generation = 4; h.scope.gameUuid = 'changed-behind-persistent-modal';
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(dismissEndedGameNotice(h.page, controller.signal), { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  assert.equal(h.commands.filter(command => command.params?.type === 'mousePressed').length, 1);
});
