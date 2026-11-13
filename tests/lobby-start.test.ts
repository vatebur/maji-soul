import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startAudienceRoom } from '../src/adapters/majsoul/lobby-screen.ts';
import type { EgoPagePort } from '../src/adapters/majsoul/ego-transport.ts';
import { png } from './countdown-helpers.ts';

function roomFrame(visible: boolean) {
  const width = 2036, height = 918, rgba = new Uint8Array(width * height * 4).fill(180);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const profile = JSON.parse(readFileSync('src/adapters/majsoul/lobby-screen-profiles.json', 'utf8')).room;
  if (visible) for (const region of profile.regions) {
    const mask = Buffer.from(region.mask, 'base64');
    for (let y = 0; y < region.rows; y++) for (let x = 0; x < region.cols; x++) {
      const xx = Math.round(202 + (region.x + x / region.cols * region.width) * 1632);
      const yy = Math.round((region.y + y / region.rows * region.height) * 918);
      const color = mask[y * region.cols + x] ? (region.white ? 240 : 0) : 180;
      rgba.set([color, color, color, 255], (yy * width + xx) * 4);
    }
  }
  return png({ width, height, rgba });
}

test('room start resamples a stale viewport frame before pressing and still rejects a changed scope', async t => {
  const blank = roomFrame(false), room = roomFrame(true);
  for (const changed of [false, true]) await t.test(String(changed), async () => {
    let samples = 0, pressed = 0;
    const page: EgoPagePort = {
      evaluate: async (_source, argument) => argument?.method === 'read'
        ? { paused: true, pageEpoch: 1, generation: changed ? 2 : 1, gameUuid: null }
        : { width: 2036, height: 918 },
      cdp: async (method, params) => {
        if (method === 'Page.captureScreenshot') return { data: ++samples === 1 ? blank : room };
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') pressed++;
        return {};
      },
    };
    const start = startAudienceRoom(page, { pageEpoch: 1, generation: 1, gameUuid: null });
    if (changed) await assert.rejects(start, /ROOM_SCOPE_CHANGED/);
    else assert.equal(await start, true);
    assert.equal(samples, 2);
    assert.equal(pressed, changed ? 0 : 1);
  });
});
