import { setTimeout as delay } from 'node:timers/promises';
import { BilibiliDirect } from '../adapters/live/bilibili.ts';
import { loadBiliAuth } from '../adapters/live/bilibili-api.ts';
import { biliId } from '../adapters/live/bilibili-protocol.ts';
import { requireThat } from '../domain/game/value.ts';
import type { Evidence } from '../observability/evidence.ts';

/** Read-only integration probe: this assembly has no reply or speech path. */
export async function checkBili(roomId: string, seconds = 30, env = process.env): Promise<Evidence> {
  requireThat(biliId(roomId) && Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 300, 'INVALID_CLI_ARGUMENTS');
  requireThat(env.MAJI_BILI_COOKIE_FILE, 'BILI_COOKIE_NOT_CONFIGURED');
  const source = new BilibiliDirect(await loadBiliAuth(env.MAJI_BILI_COOKIE_FILE));
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const deadline = Date.now() + seconds * 1000;
  let cursor: string | null = null, connected = false, errorCode: string | null = null;
  try {
    while (Date.now() < deadline && !controller.signal.aborted) {
      const page = await source.read(roomId, cursor, AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]));
      cursor = page.cursor; connected = true;
      await delay(Math.min(500, Math.max(1, deadline - Date.now())), undefined, { signal: controller.signal }).catch(() => {});
    }
  } catch (error) {
    errorCode = error instanceof Error && /^BILI_[A-Z0-9_]+$/.test(error.message) ? error.message : 'BILI_CHECK_INTERRUPTED';
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  const status = source.status;
  source.disconnect();
  return { schemaVersion: 1, probe: 'bilibili-receive', observedAt: new Date().toISOString(), evidenceType: 'service-integration',
    status: connected && status.receivedCount > 0 && !errorCode && !status.gap ? 'passed' : connected ? 'partial' : 'blocked',
    details: { requestedRoomId: roomId, ...status, errorCode: errorCode ?? status.errorCode, durationSeconds: seconds,
      realMessagesReceived: status.receivedCount, realRepliesSent: 0, messageContentStored: false } };
}
