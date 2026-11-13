import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { verifyAutoWin, DEFAULT_AUTO_WIN_PROFILE as profile, type AutoWinReadback } from '../src/adapters/majsoul/auto-win.ts';
import type { BrowserPagePort } from '../src/ports/browser.ts';

const region = { x: 211, y: 464, width: 58, height: 266 };
const fixture = JSON.parse(readFileSync('tests/fixtures/auto-win/glyphs.json', 'utf8')).samples[0];

function regionPng(missingAnchor?: number): string {
  const rgba = Buffer.alloc(region.width * region.height * 4);
  for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255;
  const glyph = Buffer.from(fixture.rgba, 'base64');
  for (let y = 0; y < profile.glyph.height; y++) rgba.set(
    glyph.subarray(y * profile.glyph.width * 4, (y + 1) * profile.glyph.width * 4),
    ((profile.glyph.y - region.y + y) * region.width + profile.glyph.x - region.x) * 4);
  profile.anchors.forEach((anchor, index) => {
    if (index !== missingAnchor) rgba.set(fixture.anchors[index], ((anchor.y - region.y) * region.width + anchor.x - region.x) * 4);
  });
  const stride = region.width * 4, raw = Buffer.alloc((stride + 1) * region.height);
  for (let y = 0; y < region.height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const chunk = (name: string, bytes: Buffer) => {
    const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); result.write(name, 4); bytes.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, result.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(region.width); header.writeUInt32BE(region.height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

class RegionPage implements BrowserPagePort {
  state: Record<string, any> = { pageEpoch: 1, generation: 2, lastStep: 8, nativeRestoreRevision: 3, sourceStream: 4,
    gameUuid: 'game', handSha256: 'a'.repeat(64), controlEpoch: 5, paused: false, connected: true, freshConnection: true,
    handEnded: false, matchEnded: false, reason: null, overflow: false };
  layout: Record<string, number> = { innerWidth: 2036, innerHeight: 918, devicePixelRatio: 1, scrollX: 0, scrollY: 0 };
  captures = 0;
  data = regionPng();
  onCapture?: () => void;
  attempted: AutoWinReadback[] = [];
  acknowledged: AutoWinReadback[] = [];
  async evaluate(source: any, argument?: any): Promise<any> {
    return await runInNewContext(`(${source.toString()})(argument)`, { argument, Error, Date, ...this.layout,
      document: { scripts: [{ src: 'https://example.invalid/WebGL-release-4.0.51(test).js' }] },
      window: { __majiBridge: {
        read: () => ({ ...this.state }),
        ackAutoWin: (readback: AutoWinReadback) => {
          this.attempted.push(readback);
          const age = Date.now() - Date.parse(readback.observedAt);
          if (!Number.isFinite(age) || age < 0 || age >= 1000) throw Error('AUTO_WIN_READBACK_STALE');
          this.acknowledged.push(readback); return { state: readback.state };
        },
      } },
    });
  }
  async cdp(): Promise<any> { throw Error('UNEXPECTED_FULL_CAPTURE'); }
  async captureViewportPngRegion(box: typeof region): Promise<{ data: string }> {
    assert.deepEqual(box, region); this.captures++; this.onCapture?.(); return { data: this.data };
  }
}

test('production region verification retains the real enabled glyph hash and original capture timestamp', async () => {
  const page = new RegionPage(); let captureStarted = 0;
  page.onCapture = () => { captureStarted = Date.now(); };
  const readback = await verifyAutoWin(page, undefined, { atomicAck: true });
  assert.equal(readback.state, 'enabled'); assert.equal(readback.rgbaSha256, fixture.rgbaSha256);
  assert.equal(page.captures, 1); assert.equal(page.acknowledged.length, 1);
  assert.equal(page.acknowledged[0]!.observedAt, readback.observedAt);
  assert.ok(Date.parse(readback.observedAt) <= captureStarted);
});

test('region verification rejects changed full viewport or scrolling even without a scope event', async () => {
  for (const [key, value] of Object.entries({ innerWidth: 2035, innerHeight: 917, devicePixelRatio: 2, scrollX: 1, scrollY: 1 })) {
    const page = new RegionPage(); const originalScope = { ...page.state };
    page.onCapture = () => { page.layout[key] = value; };
    await assert.rejects(verifyAutoWin(page, undefined, { atomicAck: true }), /AUTO_WIN_(VIEWPORT_MISMATCH|READBACK_STALE)/, key);
    assert.deepEqual(page.state, originalScope); assert.equal(page.captures, 1); assert.equal(page.attempted.length, 0, key);
  }
});

test('region verification rejects every changed page, hand, ingress and control scope before ACK', async () => {
  for (const key of ['pageEpoch', 'generation', 'lastStep', 'nativeRestoreRevision', 'sourceStream', 'gameUuid', 'handSha256', 'controlEpoch', 'paused']) {
    const page = new RegionPage();
    page.onCapture = () => { const original = page.state[key]; page.state[key] = typeof original === 'number' ? original + 1 : typeof original === 'boolean' ? !original : `${original}-changed`; };
    await assert.rejects(verifyAutoWin(page, undefined, { atomicAck: true }), /AUTO_WIN_READBACK_STALE/, key);
    assert.equal(page.captures, 1); assert.equal(page.attempted.length, 0, key);
  }
});

test('region verification cannot acknowledge a disconnected, terminal or untrusted page', async () => {
  for (const [key, value] of Object.entries({ connected: false, freshConnection: false, handEnded: true, matchEnded: true, reason: 'PAUSED', overflow: true })) {
    const page = new RegionPage(); page.onCapture = () => { page.state[key] = value; };
    await assert.rejects(verifyAutoWin(page, undefined, { atomicAck: true }), /AUTO_WIN_READBACK_STALE/, key);
    assert.equal(page.captures, 1); assert.equal(page.attempted.length, 0, key);
  }
});

test('every toolbar anchor remains required by region verification', async () => {
  for (let missing = 0; missing < profile.anchors.length; missing++) {
    const page = new RegionPage(); page.data = regionPng(missing);
    await assert.rejects(verifyAutoWin(page, undefined, { atomicAck: true }), /AUTO_WIN_UNVERIFIED/, `anchor ${missing}`);
    assert.equal(page.captures, 1); assert.equal(page.acknowledged.some(readback => readback.state === 'enabled'), false);
  }
});

test('region verification never retimestamps expired pixels and the bounded second sample also needs fresh evidence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const page = new RegionPage(); const captureTimes: number[] = [];
  page.onCapture = () => { captureTimes.push(Date.now()); t.mock.timers.tick(1000); };
  await assert.rejects(verifyAutoWin(page, undefined, { atomicAck: true }), /AUTO_WIN_READBACK_STALE/);
  assert.equal(page.captures, 2); assert.equal(page.acknowledged.length, 0);
  assert.deepEqual(page.attempted.map(readback => Date.parse(readback.observedAt)), captureTimes);
});
