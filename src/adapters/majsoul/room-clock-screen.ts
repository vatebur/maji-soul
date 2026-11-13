import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { RoomTimeSetting } from '../../domain/game/types.ts';
import { requireThat } from '../../domain/game/value.ts';
import { decodeScreenshotPng, type PixelImage } from './auto-win.ts';
import { bridgeCall, type EgoPagePort } from './ego-transport.ts';
import { clickLobbyScreen, identifyLobbyScreen } from './lobby-screen.ts';

type CreationClock = '5+20' | '60+0';
interface ClockOption {
  click: { x: number; y: number };
  label: { x: number; y: number; width: number; height: number; cols: number; rows: number };
  selectedMask: string; unselectedMask: string; background: { x: number; y: number }[];
}
const profile = JSON.parse(readFileSync(new URL('./room-clock-profile.json', import.meta.url), 'utf8')) as {
  options: Record<CreationClock, ClockOption>;
};
const frame = (image: PixelImage) => {
  const scale = Math.min(image.width / 16, image.height / 9), width = scale * 16, height = scale * 9;
  return { width, height, left: (image.width - width) / 2, top: (image.height - height) / 2 };
};
function optionMatches(image: PixelImage, option: ClockOption, selected: boolean): boolean {
  const box = frame(image), region = option.label;
  const pixel = (x: number, y: number) => {
    const at = (Math.round(box.top + y * box.height) * image.width + Math.round(box.left + x * box.width)) * 4;
    return image.rgba.subarray(at, at + 4);
  };
  if (!option.background.every(point => {
    const [r, g, b, a] = pixel(point.x, point.y);
    return a === 255 && (selected ? r! > 210 && g! > 135 && b! < 125 && r! - b! > 100
      : r! < 100 && g! > r! + 10 && b! > g! + 10 && b! < 150);
  })) return false;
  const mask = Buffer.from(selected ? option.selectedMask : option.unselectedMask, 'base64');
  let expected = 0, actual = 0, intersection = 0;
  for (let y = 0; y < region.rows; y++) for (let x = 0; x < region.cols; x++) {
    const [r, g, b, a] = pixel(region.x + x / region.cols * region.width, region.y + y / region.rows * region.height);
    const observed = Number(a === 255 && (selected ? r! < 150 && g! < 115 && b! < 115 : r! > 180 && r! + g! + b! > 540));
    const bit = mask[y * region.cols + x]!;
    expected += bit; actual += observed; intersection += bit * observed;
  }
  return expected > 20 && 2 * intersection / (expected + actual) >= 0.88;
}

/** Both labels and their mutually exclusive native selection colors are required. */
export function identifyCreationClock(image: PixelImage): CreationClock | 'unknown' {
  if (identifyLobbyScreen(image) !== 'create') return 'unknown';
  for (const setting of ['5+20', '60+0'] as const) {
    const other = setting === '5+20' ? '60+0' : '5+20';
    if (optionMatches(image, profile.options[setting], true) && optionMatches(image, profile.options[other], false)) return setting;
  }
  return 'unknown';
}

function requireScope(current: any, expected?: any, afterOwnPress = false) {
  requireThat(current?.paused === true && current.executorActive === false && current.controlEpoch === 0 &&
    Number.isSafeInteger(current.pageEpoch) && current.pageEpoch > 0 && Number.isSafeInteger(current.generation) && current.generation >= 0 &&
    Number.isSafeInteger(current.sourceStream) && current.sourceStream >= 0 &&
    (current.gameUuid === null || typeof current.gameUuid === 'string' && current.gameUuid.length > 0), 'ROOM_SCOPE_CHANGED');
  if (expected) requireThat(current.pageEpoch === expected.pageEpoch && current.sourceStream === expected.sourceStream &&
    current.gameUuid === expected.gameUuid && current.generation === expected.generation + (afterOwnPress ? 1 : 0),
  'ROOM_SCOPE_CHANGED');
}

async function capture(page: EgoPagePort, signal: AbortSignal) {
  signal.throwIfAborted(); requireThat(page.cdp, 'ROOM_SCREEN_CDP_REQUIRED');
  const shot = await page.cdp('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  signal.throwIfAborted();
  requireThat(typeof shot?.data === 'string' && shot.data.length <= 12 * 1024 * 1024, 'ROOM_CLOCK_SCREENSHOT_INVALID');
  const image = decodeScreenshotPng(Buffer.from(shot.data, 'base64'));
  return { image, setting: identifyCreationClock(image) };
}

/** Select an evidenced native clock, verify it again, then use the native Create button. */
export async function createAudienceRoom(page: EgoPagePort, setting: RoomTimeSetting, signal: AbortSignal): Promise<void> {
  requireThat(setting === '5+20' || setting === '60+0', 'FRIEND_ROOM_CLOCK_UNSUPPORTED');
  signal.throwIfAborted();
  const before = await bridgeCall(page, 'read'); signal.throwIfAborted(); requireScope(before);
  const first = await capture(page, signal);
  requireThat(first.setting !== 'unknown', 'ROOM_CLOCK_UNVERIFIED');
  let ready = before;
  if (first.setting !== setting) {
    const box = frame(first.image), click = profile.options[setting as CreationClock].click;
    const point = { x: box.left + click.x * box.width, y: box.top + click.y * box.height };
    await page.cdp!('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    const second = await capture(page, signal);
    requireThat(second.setting === first.setting && second.image.width === first.image.width && second.image.height === first.image.height, 'ROOM_CLOCK_CHANGED');
    const current = await bridgeCall(page, 'read'); signal.throwIfAborted(); requireScope(current, before);
    await page.cdp!('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await page.cdp!('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
    const until = performance.now() + 3_000;
    while (true) {
      const selected = await capture(page, signal);
      requireThat(selected.image.width === first.image.width && selected.image.height === first.image.height, 'ROOM_CLOCK_CHANGED');
      ready = await bridgeCall(page, 'read'); signal.throwIfAborted(); requireScope(ready, before, true);
      if (selected.setting === setting) break;
      requireThat(performance.now() < until, 'ROOM_CLOCK_NOT_SELECTED');
      await delay(100, undefined, { signal });
    }
  }
  await clickLobbyScreen(page, 'create', async () => {
    const confirmed = await capture(page, signal);
    requireThat(confirmed.setting === setting && confirmed.image.width === first.image.width && confirmed.image.height === first.image.height, 'ROOM_CLOCK_CHANGED');
    const current = await bridgeCall(page, 'read'); signal.throwIfAborted(); requireScope(current, ready);
  });
}
