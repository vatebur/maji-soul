import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodeScreenshotPng, decodeScreenshotPngRegions, type PixelBox } from '../src/adapters/browser/png.ts';

const signature = Buffer.from([137,80,78,71,13,10,26,10]);
function chunk(type: string, body: Buffer) {
  const result = Buffer.alloc(body.length + 12);
  result.writeUInt32BE(body.length); result.write(type, 4); result.set(body, 8);
  let crc = 0xffffffff;
  for (const value of result.subarray(4, -4)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function header(width: number, height: number, channels = 4) {
  const result = Buffer.alloc(13);
  result.writeUInt32BE(width); result.writeUInt32BE(height, 4); result[8] = 8; result[9] = channels === 4 ? 6 : 2;
  return result;
}
function image(body: Buffer, raw: Buffer, end = true) {
  const compressed = deflateSync(raw), split = Math.floor(compressed.length / 2);
  return Buffer.concat([signature, chunk('IHDR', body), chunk('IDAT', compressed.subarray(0, split)),
    chunk('IDAT', compressed.subarray(split)), ...(end ? [chunk('IEND', Buffer.alloc(0))] : [])]);
}
function encode(width: number, height: number, channels: 3 | 4, rowFilters: number[]) {
  const stride = width * channels;
  // Deliberately includes wraparound, transparent alpha, and unequal neighbours.
  const source = Uint8Array.from({ length: stride * height }, (_, index) => (index * 197 + (index % 11) * 29) % 256);
  const raw = Buffer.alloc((stride + 1) * height), expected = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = rowFilters[y % rowFilters.length]!; raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x < channels ? 0 : source[at - channels]!;
      const up = y === 0 ? 0 : source[at - stride]!;
      const upperLeft = y === 0 || x < channels ? 0 : source[at - stride - channels]!;
      // Independent encoder selects the nearest predictor, in PNG tie order.
      const prediction = left + up - upperLeft;
      const paeth = [left, up, upperLeft].sort((a, b) => Math.abs(prediction - a) - Math.abs(prediction - b))[0]!;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][filter]!;
      raw[y * (stride + 1) + 1 + x] = (source[at]! - predictor + 256) % 256;
    }
  }
  for (let index = 0; index < width * height; index++) {
    expected.set(source.subarray(index * channels, index * channels + 3), index * 4);
    expected[index * 4 + 3] = channels === 4 ? source[index * channels + 3]! : 255;
  }
  return { png: image(header(width, height, channels), raw), expected };
}

test('screenshot PNG preserves every pixel for RGB/RGBA and all PNG row filters', () => {
  for (const channels of [3, 4] as const) for (const width of [1, 2, 17]) {
    for (const filters of [[0], [1], [2], [3], [4], [4, 3, 2, 1, 0]]) {
      const fixture = encode(width, 7, channels, filters), input = Buffer.from(fixture.png);
      const decoded = decodeScreenshotPng(input);
      assert.equal(decoded.width, width); assert.equal(decoded.height, 7);
      assert.deepEqual(decoded.rgba, fixture.expected, `channels=${channels}, width=${width}, filters=${filters}`);
      assert.deepEqual(input, fixture.png, 'decoding must not mutate input');
    }
  }
});

test('screenshot PNG retains byte, chunk, terminal and inflate bounds', () => {
  const fixture = encode(2, 2, 4, [0]).png;
  for (const input of [Buffer.alloc(32), Buffer.alloc(8 * 1024 * 1024 + 1), fixture.subarray(0, -1),
    image(header(2, 2), Buffer.alloc(18), false), image(header(2, 2), Buffer.alloc(17)),
    Buffer.concat([signature, chunk('IHDR', header(2, 2)), chunk('IEND', Buffer.alloc(0))])]) {
    assert.throws(() => decodeScreenshotPng(input), /^Error: AUTO_WIN_SCREENSHOT_INVALID$/);
  }
  const badLength = Buffer.from(fixture); badLength.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => decodeScreenshotPng(badLength), /AUTO_WIN_SCREENSHOT_INVALID/);
  assert.throws(() => decodeScreenshotPng(image(header(2, 2), Buffer.alloc(19))), { code: 'ERR_BUFFER_TOO_LARGE' });
});

test('screenshot PNG rejects unsupported formats, dimensions and filters', () => {
  for (const [offset, value] of [[8, 16], [9, 0], [9, 3], [10, 1], [11, 1], [12, 1]]) {
    const body = header(2, 2); body[offset!] = value!;
    assert.throws(() => decodeScreenshotPng(image(body, Buffer.alloc(18))), /AUTO_WIN_SCREENSHOT_FORMAT/);
  }
  for (const [width, height] of [[0, 2], [2, 0], [2001, 2000]]) {
    assert.throws(() => decodeScreenshotPng(image(header(width!, height!), Buffer.alloc(0))), /AUTO_WIN_SCREENSHOT_LIMIT/);
  }
  const raw = Buffer.alloc(18); raw[9] = 5;
  assert.throws(() => decodeScreenshotPng(image(header(2, 2), raw)), /AUTO_WIN_SCREENSHOT_FORMAT/);
});

test('explicit PNG regions equal full pixels for all filters and both colour layouts', () => {
  const requests: PixelBox[][] = [
    [{ x: 0, y: 0, width: 1, height: 1 }],
    [{ x: 3, y: 2, width: 5, height: 3 }],
    [{ x: 16, y: 6, width: 1, height: 1 }],
    [{ x: 1, y: 1, width: 2, height: 1 }, { x: 6, y: 4, width: 1, height: 1 }],
  ];
  for (const channels of [3, 4] as const) for (const filters of [[0], [1], [2], [3], [4], [4, 3, 2, 1, 0]]) {
    const fixture = encode(17, 7, channels, filters), input = Buffer.from(fixture.png);
    for (const boxes of requests) {
      const result = decodeScreenshotPngRegions(input, boxes);
      assert.equal(result.kind, 'regions'); assert.equal(result.width, 17); assert.equal(result.height, 7);
      assert.equal('rgba' in result, false, 'unrequested pixels must not appear as a fabricated full image');
      assert.equal(result.regions.length, boxes.length);
      for (let index = 0; index < boxes.length; index++) {
        const box = boxes[index]!, region = result.regions[index]!;
        assert.deepEqual({ x: region.x, y: region.y, width: region.width, height: region.height }, box);
        assert.equal(region.rgba.length, box.width * box.height * 4);
        for (let y = 0; y < box.height; y++) {
          const source = ((box.y + y) * 17 + box.x) * 4;
          assert.deepEqual(region.rgba.subarray(y * box.width * 4, (y + 1) * box.width * 4),
            fixture.expected.subarray(source, source + box.width * 4));
        }
      }
    }
    assert.deepEqual(input, fixture.png);
  }
});

test('partial PNG decoding still validates rows, inflated length and chunks outside requested pixels', () => {
  const boxes = [{ x: 0, y: 0, width: 1, height: 1 }], raw = Buffer.alloc(18);
  raw[9] = 5; // The malformed second row lies below the requested first pixel.
  assert.throws(() => decodeScreenshotPngRegions(image(header(2, 2), raw), boxes), /AUTO_WIN_SCREENSHOT_FORMAT/);
  assert.throws(() => decodeScreenshotPngRegions(image(header(2, 2), Buffer.alloc(17)), boxes), /AUTO_WIN_SCREENSHOT_INVALID/);
  assert.throws(() => decodeScreenshotPngRegions(image(header(2, 2), Buffer.alloc(19)), boxes), { code: 'ERR_BUFFER_TOO_LARGE' });
  assert.throws(() => decodeScreenshotPngRegions(image(header(2, 2), Buffer.alloc(18), false), boxes), /AUTO_WIN_SCREENSHOT_INVALID/);
});

test('partial PNG decoding rejects missing, excessive, fractional and out-of-viewport regions', () => {
  const fixture = encode(2, 2, 4, [0]).png;
  for (const boxes of [[], Array.from({ length: 65 }, () => ({ x: 0, y: 0, width: 1, height: 1 })),
    [{ x: 0, y: 0, width: 0, height: 1 }], [{ x: -1, y: 0, width: 1, height: 1 }],
    [{ x: 1.5, y: 0, width: 1, height: 1 }], [{ x: 1, y: 1, width: 2, height: 1 }],
    [{ x: 1, y: 1, width: 1, height: 2 }], [{ x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 }],
  ]) assert.throws(() => decodeScreenshotPngRegions(fixture, boxes), /AUTO_WIN_SCREENSHOT_REGION_INVALID/);
});
