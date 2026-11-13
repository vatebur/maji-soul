import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeScreenshotPng, type PixelImage } from '../browser/png.ts';
import { bridgeCall, type EgoPagePort } from './ego-transport.ts';
import { requireThat } from '../../domain/game/value.ts';

interface Region {
  group: 'message' | 'button'; x: number; y: number; width: number; height: number;
  cols: number; rows: number; maskBase64: string; cells: { x: number; width: number }[]; minScore: number;
}
const profile = JSON.parse(readFileSync(new URL('./inactivity-notice-profile.json', import.meta.url), 'utf8')) as {
  regions: Region[]; click: { x: number; y: number };
};
const regions = profile.regions.map(region => ({ ...region, mask: Buffer.from(region.maskBase64, 'base64') }));
const clickedDocuments = new WeakMap<EgoPagePort, number>();
const canvas = (width: number, height: number) => {
  const scale = Math.min(width / 16, height / 9), w = scale * 16, h = scale * 9;
  return { width: w, height: h, left: (width - w) / 2, top: (height - h) / 2 };
};

/** Either the complete two-line inactivity message OR the exact 我回了 glyphs
 * identify this notice. This is not a generic confirmation-button detector. */
export function isInactivityNotice(image: PixelImage): boolean {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 320 || image.height < 180 ||
      image.rgba.length !== image.width * image.height * 4) return false;
  const frame = canvas(image.width, image.height);
  const matches = regions.map(region => {
    const observed = new Uint8Array(region.cols * region.rows);
    for (let y = 0; y < region.rows; y++) for (let x = 0; x < region.cols; x++) {
      const xx = Math.round(frame.left + (region.x + x / region.cols * region.width) * frame.width);
      const yy = Math.round(frame.top + (region.y + y / region.rows * region.height) * frame.height);
      const at = (yy * image.width + xx) * 4, r = image.rgba[at]!, g = image.rgba[at + 1]!, b = image.rgba[at + 2]!;
      observed[y * region.cols + x] = Number(image.rgba[at + 3] === 255 && (region.group === 'button'
        ? r < 160 && g < 120 && b < 120 : Math.min(r, g, b) >= 130 && Math.max(r, g, b) - Math.min(r, g, b) <= 45));
    }
    const score = (start: number, width: number) => {
      let expected = 0, actual = 0, intersection = 0;
      for (let y = 0; y < region.rows; y++) for (let x = start; x < start + width; x++) {
        const at = y * region.cols + x, bit = (region.mask[at >> 3]! >> (at % 8)) & 1;
        expected += bit; actual += observed[at]!; intersection += bit * observed[at]!;
      }
      return expected >= 8 && 2 * intersection / (expected + actual) >= region.minScore;
    };
    return score(0, region.cols) && region.cells.every(cell => score(cell.x, cell.width));
  });
  return (['message', 'button'] as const).some(group =>
    regions.every((region, index) => region.group !== group || matches[index]));
}

/** Read only, without resizing the game or changing the current actor's fence. */
export async function inspectInactivityNotice(page: EgoPagePort) {
  requireThat(page.cdp, 'INACTIVITY_NOTICE_CDP_REQUIRED');
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  requireThat(typeof shot?.data === 'string' && shot.data.length <= 12 * 1024 * 1024, 'INACTIVITY_NOTICE_SCREENSHOT_INVALID');
  const image = decodeScreenshotPng(Buffer.from(shot.data, 'base64'));
  const visible = isInactivityNotice(image);
  if (!visible) clickedDocuments.delete(page);
  return { visible, width: image.width, height: image.height };
}

export const hasInactivityNoticeScope = (state: any): boolean => state?.paused === true && state.controlEpoch === 0 &&
  state.executorActive === false && state.connected === true && !state.matchEnded && !state.overflow &&
  (!state.reason || ['MATCH_CHANGED', 'CONNECTION_CHANGED'].includes(state.reason)) &&
  Number.isSafeInteger(state.pageEpoch) && state.pageEpoch > 0 && Number.isSafeInteger(state.generation) && state.generation >= 0 &&
  typeof state.gameUuid === 'string' && state.gameUuid.length > 0;

/** Only the owner loop calls this after its old worker has fully drained.
 * Require fresh pixels and an unchanged game/document before exactly one press.
 * New protocol steps behind this modal do not reuse any old action permission. */
export async function dismissInactivityNotice(page: EgoPagePort, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const before = await bridgeCall(page, 'read');
  signal?.throwIfAborted();
  requireThat(hasInactivityNoticeScope(before), 'INACTIVITY_NOTICE_SCOPE_CHANGED');
  if (clickedDocuments.get(page) !== before.pageEpoch) clickedDocuments.delete(page);
  const first = await inspectInactivityNotice(page);
  signal?.throwIfAborted();
  if (!first.visible) return false;
  if (!clickedDocuments.has(page)) {
    const frame = canvas(first.width, first.height);
    const point = { x: frame.left + profile.click.x * frame.width, y: frame.top + profile.click.y * frame.height };
    await page.cdp!('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    signal?.throwIfAborted();
    const image = await inspectInactivityNotice(page);
    signal?.throwIfAborted();
    requireThat(image.visible && image.width === first.width && image.height === first.height, 'INACTIVITY_NOTICE_CHANGED');
    const current = await bridgeCall(page, 'read');
    signal?.throwIfAborted();
    requireThat(hasInactivityNoticeScope(current) && current.pageEpoch === before.pageEpoch &&
      current.gameUuid === before.gameUuid, 'INACTIVITY_NOTICE_SCOPE_CHANGED');
    clickedDocuments.set(page, before.pageEpoch);
    // Record before dispatch, and release even if cancellation arrives after
    // the press. An uncertain receipt must not authorize a duplicate click.
    try {
      await page.cdp!('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    } finally {
      await page.cdp!('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
    }
  }
  const until = performance.now() + 3_000;
  for (;;) {
    signal?.throwIfAborted();
    const observed = await inspectInactivityNotice(page);
    signal?.throwIfAborted();
    requireThat(observed.width === first.width && observed.height === first.height, 'INACTIVITY_NOTICE_CHANGED');
    if (!observed.visible) return true;
    requireThat(performance.now() < until, 'INACTIVITY_NOTICE_NOT_DISMISSED');
    await delay(100, undefined, { signal });
  }
}
