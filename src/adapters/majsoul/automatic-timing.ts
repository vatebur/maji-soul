import { bridgeCall, type EgoPagePort } from './ego-transport.ts';
import { sampleSyncOperationTiming, validateCountdownCalibration, validateCountdownUnitPair,
  type AutomaticCountdownSample, type CountdownCalibrationScope, type SyncCountdownEvidence } from './operation-timing.ts';
import { inspectClientCountdown } from './countdown.ts';
import { canonical, digest, requireThat } from '../../domain/game/value.ts';

// A page-owned cache is not exposed through the bridge API. It contains only
// numeric evidence for the elapsed unit, never a prepared timing or deadline.
const calibrations = new WeakMap<EgoPagePort, AutomaticCountdownSample[]>();

function scopeFromReads(raw: any, before: any, after: any, clientProfile: string): CountdownCalibrationScope | undefined {
  // Old replay/test ports may provide only the original pair contract. They
  // remain usable, but cannot create or reuse a unit calibration.
  const keys = ['nativeRestoreRevision','sourceStream','gameUuid','authSummary'];
  if (keys.every(key => !Object.hasOwn(before, key) && !Object.hasOwn(after, key))) return undefined;
  requireThat(keys.every(key => Object.hasOwn(before, key) && Object.hasOwn(after, key)), 'COUNTDOWN_SAMPLE_STALE');
  const opening = raw.game_restore?.actions?.find((action: any) => action.name === 'ActionNewRound');
  const handKey = (opening?.payload ?? opening?.data)?.sha256;
  for (const state of [before, after]) {
    requireThat(state.pageEpoch === raw.pageEpoch && state.generation === raw.generation && state.lastStep === raw.step - 1 &&
      state.gameUuid === raw.gameUuid && state.connected === true && state.freshConnection === true && !state.reason && !state.overflow &&
      state.authSummary?.roomId === raw.authSummary?.roomId && state.authSummary?.gameConfig && raw.authSummary?.gameConfig &&
      canonical(state.authSummary.gameConfig) === canonical(raw.authSummary.gameConfig), 'COUNTDOWN_SAMPLE_STALE');
  }
  requireThat(before.nativeRestoreRevision === after.nativeRestoreRevision && before.sourceStream === after.sourceStream,
    'COUNTDOWN_SAMPLE_STALE');
  return { pageEpoch: raw.pageEpoch, nativeRestoreRevision: after.nativeRestoreRevision, sourceStream: after.sourceStream,
    gameUuid: raw.gameUuid, roomId: raw.authSummary.roomId, rulesSha256: digest(raw.authSummary.gameConfig), handKey, clientProfile };
}

/** Every window gets a fresh wire response and real pixels. A measured unit
 * pair can be reused only in its original page/restore/game/room/rules/hand,
 * with the same wall-to-monotonic offset and at most five minutes of age. */
async function collect(page: EgoPagePort) {
  const samples: AutomaticCountdownSample[] = [];
  let raw = await bridgeCall(page, 'sync');
  const current = raw.game_restore?.actions?.at(-1)?.payload;
  if (raw.is_end || ['ActionHule','ActionNoTile','ActionLiuJu'].includes(raw.game_restore?.actions?.at(-1)?.name) || !current?.operation?.operation_list?.length) {
    // A terminal/empty restore cannot carry a calibration into a later hand.
    calibrations.delete(page);
    return { raw, evidence: null };
  }
  for (let i = 0; i < 2; i++) {
    if (i) {
      // A bounded wait establishes the elapsed unit through a measured difference.
      const now = await page.evaluate(() => performance.now());
      const delay = Math.max(0, 2_100 - (now - samples[0]!.receivedMonoMs));
      requireThat(delay <= 2_100, 'TIMING_CLOCK_REVERSED');
      await new Promise(resolve => setTimeout(resolve, delay));
      raw = await bridgeCall(page, 'sync');
    }
    let display, before;
    const settleMs = i === 0 ? current.operation.time_fixed === 8000 ? 1800 : 2500 : 1000;
    // Long-clock windows use the same entrance animation as short clocks.
    // Wait only for visible digits, retaining the same window and generation.
    const until = performance.now() + settleMs;
    for (;;) {
      const operation = raw.game_restore?.actions?.at(-1)?.payload?.operation;
      before = await bridgeCall(page, 'read');
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
    const after = await bridgeCall(page, 'read');
    const scope = scopeFromReads(raw, before, after, display.profileVersion);
    if (scope) raw = { ...raw, timingScope: scope };
    const sample = sampleSyncOperationTiming(raw, display);
    samples.push(sample);
    if (i === 0) {
      const cached = calibrations.get(page);
      if (cached && sample.scope) {
        try {
          validateCountdownCalibration(sample, cached);
          const evidence: SyncCountdownEvidence = { source: 'automatic-client-countdown', samples,
            calibration: { source: 'observed-unit-pair-v1', samples: structuredClone(cached) } };
          return { raw, evidence };
        } catch (error) {
          // A changed scope/clock/lifetime needs a new unit measurement. Other
          // errors (such as disagreement with current pixels) remain failures.
          const invalidated = error instanceof Error && ['TIMING_CALIBRATION_SCOPE_MISMATCH','TIMING_CALIBRATION_EXPIRED',
            'TIMING_WALL_CLOCK_CHANGED','TIMING_CLOCK_REVERSED'].includes(error.message);
          if (!invalidated) throw error;
        }
      }
      calibrations.delete(page);
    }
  }
  const evidence: SyncCountdownEvidence = { source: 'automatic-client-countdown', samples };
  // Validate the whole original pair before caching. This deliberately does
  // not turn an expired current action budget into a valid deadline: the child
  // still derives that separately and can only report COUNTDOWN_EXPIRED.
  validateCountdownUnitPair(samples);
  if (samples.every(sample => sample.scope)) calibrations.set(page, structuredClone(samples));
  return { raw, evidence };
}

export async function collectAutomaticTiming(page: EgoPagePort) {
  try { return await collect(page); }
  catch (error) { calibrations.delete(page); throw error; }
}
