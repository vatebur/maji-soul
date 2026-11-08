import { bridgeCall, type EgoPagePort } from './ego-transport.ts';
import { sampleSyncOperationTiming, type AutomaticCountdownSample, type SyncCountdownEvidence } from './operation-timing.ts';
import { inspectClientCountdown } from './countdown.ts';
import { requireThat } from '../../domain/game/value.ts';

/** A fresh pair is collected for every current window, including after reconnect.
 * Screenshots stay in memory and only numeric readback is returned to the child. */
export async function collectAutomaticTiming(page: EgoPagePort) {
  const samples: AutomaticCountdownSample[] = [];
  let raw = await bridgeCall(page, 'sync');
  const current = raw.game_restore?.actions?.at(-1)?.payload;
  if (raw.is_end || ['ActionHule','ActionNoTile','ActionLiuJu'].includes(raw.game_restore?.actions?.at(-1)?.name) || !current?.operation?.operation_list?.length) return { raw, evidence: null };
  for (let i = 0; i < 2; i++) {
    if (i) {
      // A bounded wait establishes the elapsed unit through a measured difference.
      const now = await page.evaluate(() => performance.now());
      const delay = Math.max(0, 2_100 - (now - samples[0]!.receivedMonoMs));
      requireThat(delay <= 2_100, 'TIMING_CLOCK_REVERSED');
      await new Promise(resolve => setTimeout(resolve, delay));
      raw = await bridgeCall(page, 'sync');
    }
    let display;
    const settleMs = i === 0 ? current.operation.time_fixed === 8000 ? 1800 : 2500 : 1000;
    // Long-clock windows use the same entrance animation as short clocks.
    // Wait only for visible digits, retaining the same window and generation.
    const until = performance.now() + settleMs;
    for (;;) {
      const operation = raw.game_restore?.actions?.at(-1)?.payload?.operation;
      try { display = await inspectClientCountdown(page, operation?.time_add > 0); break; }
      catch (error) {
        const timerNotVisible = error instanceof Error && ['COUNTDOWN_LAYOUT_UNVERIFIED', 'COUNTDOWN_DIGITS_UNREADABLE',
          'COUNTDOWN_GLYPH_UNVERIFIED', 'COUNTDOWN_BANK_UNREADABLE'].includes(error.message);
        if (!timerNotVisible || performance.now() >= until) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
        const next = await bridgeCall(page, 'sync');
        requireThat(next.pageEpoch === raw.pageEpoch && next.generation === raw.generation && next.step === raw.step, 'COUNTDOWN_SAMPLE_STALE');
        raw = next;
      }
    }
    requireThat(display.pageEpoch === raw.pageEpoch && display.generation === raw.generation, 'COUNTDOWN_SAMPLE_STALE');
    samples.push(sampleSyncOperationTiming(raw, display));
  }
  const evidence: SyncCountdownEvidence = { source: 'automatic-client-countdown', samples };
  return { raw, evidence };
}
