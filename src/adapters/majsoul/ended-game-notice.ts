import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeScreenshotPng, type PixelImage } from './auto-win.ts';
import { bridgeCall, type EgoPagePort } from './ego-transport.ts';
import { requireThat } from '../../domain/game/value.ts';

interface Region {
  kind: 'code' | 'message' | 'confirm';
  x: number; y: number; width: number; height: number; cols: number; rows: number;
  maskBase64: string; cells: { x: number; width: number }[]; minScore: number;
}
const profile = JSON.parse(readFileSync(new URL('./ended-game-notice-profile.json', import.meta.url), 'utf8')) as {
  regions: Region[]; click: { x: number; y: number };
};
const glyphs = profile.regions.map(region => ({ ...region, mask: Buffer.from(region.maskBase64, 'base64') }));
const clickedDocuments = new WeakMap<EgoPagePort, number>();
const canvas = (width: number, height: number) => {
  const scale = Math.min(width / 16, height / 9), w = scale * 16, h = scale * 9;
  return { width: w, height: h, left: (width - w) / 2, top: (height - h) / 2 };
};

/** Only the captured 1202 notice is authorized: code, exact message and button
 * glyphs must all match, including each digit/character independently. No
 * generic modal or Confirm button recognition is used. */
export function isEndedGameNotice(image: PixelImage): boolean {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 320 || image.height < 180 ||
      image.rgba.length !== image.width * image.height * 4) return false;
  const frame = canvas(image.width, image.height);
  return glyphs.every(region => {
    const observed = new Uint8Array(region.cols * region.rows);
    for (let y = 0; y < region.rows; y++) for (let x = 0; x < region.cols; x++) {
      const xx = Math.round(frame.left + (region.x + x / region.cols * region.width) * frame.width);
      const yy = Math.round(frame.top + (region.y + y / region.rows * region.height) * frame.height);
      const at = (yy * image.width + xx) * 4, r = image.rgba[at]!, g = image.rgba[at + 1]!, b = image.rgba[at + 2]!;
      observed[y * region.cols + x] = Number(image.rgba[at + 3] === 255 && (region.kind === 'confirm'
        ? r < 160 && g < 120 && b < 120 : Math.min(r, g, b) >= 100 && Math.max(r, g, b) - Math.min(r, g, b) <= 45));
    }
    const matches = (start: number, width: number) => {
      let expected = 0, actual = 0, intersection = 0;
      for (let y = 0; y < region.rows; y++) for (let x = start; x < start + width; x++) {
        const at = y * region.cols + x, bit = (region.mask[at >> 3]! >> (at % 8)) & 1;
        expected += bit; actual += observed[at]!; intersection += bit * observed[at]!;
      }
      return expected >= 12 && 2 * intersection / (expected + actual) >= region.minScore;
    };
    return matches(0, region.cols) && region.cells.every(cell => matches(cell.x, cell.width));
  });
}

/** Read only; keep the viewport unchanged while another loop owns it. */
export async function inspectEndedGameNotice(page: EgoPagePort) {
  requireThat(page.cdp, 'ENDED_NOTICE_CDP_REQUIRED');
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  requireThat(typeof shot?.data === 'string' && shot.data.length <= 12 * 1024 * 1024, 'ENDED_NOTICE_SCREENSHOT_INVALID');
  const image = decodeScreenshotPng(Buffer.from(shot.data, 'base64'));
  return { visible: isEndedGameNotice(image), width: image.width, height: image.height };
}

export const hasEndedGameNoticeScope = (state: any): boolean => state?.paused === true && state.controlEpoch === 0 && state.executorActive === false &&
  Number.isSafeInteger(state.pageEpoch) && state.pageEpoch > 0 && Number.isSafeInteger(state.generation) && state.generation >= 0 &&
  (state.gameUuid === null || typeof state.gameUuid === 'string' && state.gameUuid.length > 0);

/** At most one native click per still-visible notice, after a second positive
 * image and a fresh paused, executor-free fence. Wait for it to disappear before
 * returning so the caller cannot click or prepare another room underneath it. */
export async function dismissEndedGameNotice(page: EgoPagePort, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const before = await bridgeCall(page, 'read');
  signal?.throwIfAborted();
  requireThat(hasEndedGameNoticeScope(before), 'ENDED_NOTICE_SCOPE_CHANGED');
  // A generation or game change can occur behind a still-visible modal. Only
  // an observed disappearance or replacement document may clear a sent click.
  if (clickedDocuments.get(page) !== before.pageEpoch) clickedDocuments.delete(page);
  const first = await inspectEndedGameNotice(page);
  signal?.throwIfAborted();
  if (!first.visible) { clickedDocuments.delete(page); return false; }
  if (!clickedDocuments.has(page)) {
    const frame = canvas(first.width, first.height);
    const point = { x: frame.left + profile.click.x * frame.width, y: frame.top + profile.click.y * frame.height };
    await page.cdp!('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    signal?.throwIfAborted();
    const currentImage = await inspectEndedGameNotice(page);
    signal?.throwIfAborted();
    requireThat(currentImage.visible && currentImage.width === first.width && currentImage.height === first.height, 'ENDED_NOTICE_CHANGED');
    const current = await bridgeCall(page, 'read');
    signal?.throwIfAborted();
    requireThat(hasEndedGameNoticeScope(current) && current.pageEpoch === before.pageEpoch && current.generation === before.generation &&
      current.gameUuid === before.gameUuid, 'ENDED_NOTICE_SCOPE_CHANGED');
    // Record before sending: an uncertain mouse receipt must never cause a
    // second press on the same modal. Always release a successfully sent press,
    // even if cancellation arrives during its minimum native hold interval.
    clickedDocuments.set(page, before.pageEpoch);
    await page.cdp!('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await page.cdp!('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
  }
  const until = performance.now() + 3_000;
  while (true) {
    signal?.throwIfAborted();
    const observed = await inspectEndedGameNotice(page);
    signal?.throwIfAborted();
    requireThat(observed.width === first.width && observed.height === first.height, 'ENDED_NOTICE_CHANGED');
    if (!observed.visible) { clickedDocuments.delete(page); return true; }
    requireThat(performance.now() < until, 'ENDED_NOTICE_NOT_DISMISSED');
    await delay(100, undefined, { signal });
  }
}
