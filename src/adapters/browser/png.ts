import { inflateSync } from 'node:zlib';
import { requireThat } from '../../domain/game/value.ts';

export interface PixelImage { width: number; height: number; rgba: Uint8Array }
export interface PixelBox { x: number; y: number; width: number; height: number }
export interface PixelRegion extends PixelBox { rgba: Uint8Array }
export interface ScreenshotRegions { kind: 'regions'; width: number; height: number; regions: PixelRegion[] }
export type ScreenshotPixels = PixelImage | ScreenshotRegions;

/** Return only an actually observed, contiguous row. Sparse screenshots never
 * manufacture pixels outside their explicit absolute-coordinate regions. */
export function screenshotPixelRow(image:ScreenshotPixels,x:number,y:number,width:number):Uint8Array {
  requireThat([x,y,width].every(Number.isSafeInteger) && x>=0 && y>=0 && width>0 &&
    x+width<=image.width && y<image.height,'SCREENSHOT_PIXEL_UNAVAILABLE');
  if('rgba' in image) {
    requireThat(image.rgba.length===image.width*image.height*4,'SCREENSHOT_PIXEL_UNAVAILABLE');
    const at=(y*image.width+x)*4;
    return image.rgba.subarray(at,at+width*4);
  }
  const region=image.regions.find(region=>x>=region.x && x+width<=region.x+region.width &&
    y>=region.y && y<region.y+region.height);
  requireThat(region && [region.x,region.y,region.width,region.height].every(Number.isSafeInteger) &&
    region.x>=0 && region.y>=0 && region.width>0 && region.height>0 &&
    region.x+region.width<=image.width && region.y+region.height<=image.height &&
    region.rgba.length===region.width*region.height*4,'SCREENSHOT_PIXEL_UNAVAILABLE');
  const at=((y-region.y)*region.width+x-region.x)*4;
  return region.rgba.subarray(at,at+width*4);
}

function readScreenshotPng(input: Uint8Array) {
  const data = Buffer.from(input);
  requireThat(data.length >= 33 && data.length <= 8 * 1024 * 1024 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'AUTO_WIN_SCREENSHOT_INVALID');
  let width = 0, height = 0, channels = 0, ended = false;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < data.length;) {
    requireThat(offset + 12 <= data.length, 'AUTO_WIN_SCREENSHOT_INVALID');
    const length = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8);
    requireThat(offset + length + 12 <= data.length, 'AUTO_WIN_SCREENSHOT_INVALID');
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      requireThat(offset === 8 && length === 13 && body[8] === 8 && [2,6].includes(body[9]!) && body[10] === 0 && body[11] === 0 && body[12] === 0, 'AUTO_WIN_SCREENSHOT_FORMAT');
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); channels = body[9] === 6 ? 4 : 3;
      requireThat(width > 0 && height > 0 && width * height <= 4_000_000, 'AUTO_WIN_SCREENSHOT_LIMIT');
    } else if (type === 'IDAT') chunks.push(body);
    else if (type === 'IEND') { ended = true; break; }
    offset += length + 12;
  }
  requireThat(width && height && ended && chunks.length > 0, 'AUTO_WIN_SCREENSHOT_INVALID');
  const stride = width * channels, expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected });
  requireThat(raw.length === expected, 'AUTO_WIN_SCREENSHOT_INVALID');
  return { width, height, channels, raw };
}

/** PNG filters depend only on this row's left prefix and the previous row's
 * same prefix. Right/bottom pixels cannot influence a requested top-left prefix. */
function unfilter(raw: Buffer, width: number, channels: number, decodedWidth: number, decodedHeight: number) {
  const stride = decodedWidth * channels, sourceStride = width * channels;
  const pixels = new Uint8Array(decodedWidth * decodedHeight * channels);
  for (let y = 0; y < decodedHeight; y++) {
    const source = y * (sourceStride + 1) + 1, row = y * stride, previous = row - stride;
    const filter = raw[source - 1]!;
    requireThat(filter <= 4, 'AUTO_WIN_SCREENSHOT_FORMAT');
    if (filter === 0) {
      pixels.set(raw.subarray(source, source + stride), row);
    } else if (filter === 1) {
      pixels.set(raw.subarray(source, source + channels), row);
      for (let x = channels; x < stride; x++) pixels[row + x] = raw[source + x]! + pixels[row + x - channels]!;
    } else if (filter === 2) {
      if (y === 0) pixels.set(raw.subarray(source, source + stride), row);
      else for (let x = 0; x < stride; x++) pixels[row + x] = raw[source + x]! + pixels[previous + x]!;
    } else if (filter === 3) {
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? pixels[row + x - channels]! : 0;
        const up = y ? pixels[previous + x]! : 0;
        pixels[row + x] = raw[source + x]! + ((left + up) >> 1);
      }
    } else {
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? pixels[row + x - channels]! : 0;
        const up = y ? pixels[previous + x]! : 0;
        const before = y && x >= channels ? pixels[previous + x - channels]! : 0;
        const p = left + up - before;
        const leftDistance = Math.abs(p - left), upDistance = Math.abs(p - up), beforeDistance = Math.abs(p - before);
        const predictor = leftDistance <= upDistance && leftDistance <= beforeDistance ? left : upDistance <= beforeDistance ? up : before;
        pixels[row + x] = raw[source + x]! + predictor;
      }
    }
  }
  return pixels;
}

/** Bounded CDP PNG reader. Only noninterlaced 8-bit RGB/RGBA is supported.
 * Select a filter once per row, avoiding allocations and unused predictors
 * for each of the several million channels in a full viewport screenshot. */
export function decodeScreenshotPng(input: Uint8Array): PixelImage {
  const { width, height, channels, raw } = readScreenshotPng(input);
  const pixels = unfilter(raw, width, channels, width, height);
  // RGBA already has the required layout; copying it costs another full frame.
  if (channels === 4) return { width, height, rgba: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < pixels.length; source += 3, target += 4) {
    rgba[target] = pixels[source]!; rgba[target + 1] = pixels[source + 1]!;
    rgba[target + 2] = pixels[source + 2]!; rgba[target + 3] = 255;
  }
  return { width, height, rgba };
}

/** Decode explicit areas from a full PNG without changing browser capture.
 * Every row's filter and the entire inflated length remain checked. The result
 * deliberately has no full-image rgba field: unrequested pixels are absent,
 * never zero-filled placeholders that might be mistaken for observations. */
export function decodeScreenshotPngRegions(input: Uint8Array, boxes: readonly PixelBox[]): ScreenshotRegions {
  const { width, height, channels, raw } = readScreenshotPng(input);
  requireThat(Array.isArray(boxes) && boxes.length > 0 && boxes.length <= 64, 'AUTO_WIN_SCREENSHOT_REGION_INVALID');
  let decodedWidth = 0, decodedHeight = 0, area = 0;
  for (const box of boxes) {
    requireThat(box && [box.x, box.y, box.width, box.height].every(Number.isSafeInteger) && box.x >= 0 && box.y >= 0 &&
      box.width > 0 && box.height > 0 && box.x + box.width <= width && box.y + box.height <= height, 'AUTO_WIN_SCREENSHOT_REGION_INVALID');
    decodedWidth = Math.max(decodedWidth, box.x + box.width); decodedHeight = Math.max(decodedHeight, box.y + box.height);
    area += box.width * box.height;
  }
  requireThat(area <= 4_000_000, 'AUTO_WIN_SCREENSHOT_REGION_INVALID');
  const sourceStride = width * channels;
  for (let y = 0; y < height; y++) requireThat(raw[y * (sourceStride + 1)]! <= 4, 'AUTO_WIN_SCREENSHOT_FORMAT');
  const pixels = unfilter(raw, width, channels, decodedWidth, decodedHeight);
  const regions = boxes.map(box => {
    const rgba = new Uint8Array(box.width * box.height * 4);
    for (let y = 0; y < box.height; y++) {
      const source = ((box.y + y) * decodedWidth + box.x) * channels, target = y * box.width * 4;
      if (channels === 4) rgba.set(pixels.subarray(source, source + box.width * 4), target);
      else for (let x = 0; x < box.width; x++) {
        rgba[target + x * 4] = pixels[source + x * 3]!;
        rgba[target + x * 4 + 1] = pixels[source + x * 3 + 1]!;
        rgba[target + x * 4 + 2] = pixels[source + x * 3 + 2]!;
        rgba[target + x * 4 + 3] = 255;
      }
    }
    return { x: box.x, y: box.y, width: box.width, height: box.height, rgba };
  });
  return { kind: 'regions', width, height, regions };
}
