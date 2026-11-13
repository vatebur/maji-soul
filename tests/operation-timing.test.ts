import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSyncOperationTiming, sampleSyncOperationTiming } from '../src/adapters/majsoul/operation-timing.ts';
import { normalizeSyncGame, type SyncGameContext } from '../src/adapters/majsoul/sync.ts';
import { buildPhase1Fixture, initialView } from '../scripts/build-phase1-fixtures.ts';
import { ReplayClock } from '../src/application/game/clock.ts';
import { actorHarness } from './helpers.ts';
import { digest } from '../src/domain/game/value.ts';
import type { SyncCountdownEvidence } from '../src/adapters/majsoul/operation-timing.ts';

function rawAt(passed = 22, receivedMonoMs = 22_500, rtt = 100) {
  const discard = (seat: number, tile: string) => ({ seat, tile, moqie: false, is_liqi: false, is_wliqi: false });
  return { pageEpoch: 3, step: 10, is_end: false,
    requestedMonoMs: receivedMonoMs - rtt, receivedMonoMs,
    receivedAt: new Date(Date.parse('2026-11-05T00:00:00.000Z') + receivedMonoMs).toISOString(),
    game_restore: { passed_waiting_time: passed, game_state: 1, last_pause_time_ms: 0, actions: [
      { name: 'ActionMJStart', step: 0, payload: {} },
      { name: 'ActionNewRound', step: 1, payload: { chang: 0, ju: 0, ben: 0, liqibang: 0, left_tile_count: 69,
        sha256: 'a'.repeat(64), tiles: initialView().ownConcealed.map(t => t.code.endsWith('r') ? `0${t.code[1]}` : t.code),
        scores: [25000,25000,25000,25000], doras: ['4z'], opens: [] } },
      { name: 'ActionDiscardTile', step: 2, payload: discard(0, '0m') },
      { name: 'ActionDealTile', step: 3, payload: { seat: 1, tile: '', left_tile_count: 68 } },
      { name: 'ActionDiscardTile', step: 4, payload: discard(1, '9s') },
      { name: 'ActionDealTile', step: 5, payload: { seat: 2, tile: '', left_tile_count: 67 } },
      { name: 'ActionDiscardTile', step: 6, payload: discard(2, '2z') },
      { name: 'ActionDealTile', step: 7, payload: { seat: 3, tile: '', left_tile_count: 66 } },
      { name: 'ActionDiscardTile', step: 8, payload: discard(3, '4p') },
      { name: 'ActionDealTile', step: 9, payload: { seat: 0, tile: '5m', left_tile_count: 65,
        operation: { seat: 0, operation_list: [{ type: 1 }], time_fixed: 300000, time_add: 0 } } },
    ] } };
}

function evidenceFor(raw = rawAt()) {
  const earlier = rawAt(raw.game_restore.passed_waiting_time - 2, raw.receivedMonoMs - 2_400);
  return { source: 'automatic-client-countdown' as const, samples: [earlier, raw].map(value =>
    sampleSyncOperationTiming(value, { remainingMs: Math.max(0, 300000 - value.game_restore.passed_waiting_time * 1000), sampledMonoMs: value.receivedMonoMs })) };
}
function contextFor(raw: ReturnType<typeof rawAt>): SyncGameContext {
  return { sessionId: 'timing-test', room: buildPhase1Fixture().projection.room!, gameMatchKey: 'match', gameHandKey: 'hand', ownSeat: 0,
    handOrdinal: 1, syncId: 'sync-1', connectionEpoch: 2, receivedAt: raw.receivedAt };
}

test('automatic repeated sync and client countdown corroborate seconds without room-time assumptions', () => {
  const raw = rawAt(), timing = deriveSyncOperationTiming(raw, 2, evidenceFor(raw));
  assert.equal(timing.source, 'protocol-operation'); assert.equal(timing.remainingMs, 278000);
  assert.equal(timing.uncertaintyMs, 2100); assert.equal(timing.step, 9); assert.equal(timing.pageEpoch, 3);
  const sync = normalizeSyncGame(raw, { ...contextFor(raw), timing });
  const deadline = sync.currentView!.operationWindow!.deadline;
  assert.ok(deadline.known); assert.equal(deadline.value.at, '2026-11-05T00:05:00.500Z');
  assert.equal(deadline.value.uncertaintyMs, 2100);
  assert.throws(() => deriveSyncOperationTiming(raw, 2), /TIMING_EVIDENCE_REQUIRED/);
});

test('reconnect, another step or hand, and reusing an earlier sample cannot open a current deadline', () => {
  const raw = rawAt(), evidence = evidenceFor(raw);
  assert.throws(() => deriveSyncOperationTiming({ ...raw, pageEpoch: 4 }, 2, evidence), /TIMING_SCOPE_MISMATCH/);
  assert.throws(() => deriveSyncOperationTiming({ ...raw, receivedAt: '2026-11-05T00:00:23.000Z' }, 2, evidence), /TIMING_SCOPE_MISMATCH/);
  const changedHand = structuredClone(raw); (changedHand.game_restore.actions[1]!.payload as any).sha256 = 'b'.repeat(64);
  assert.throws(() => deriveSyncOperationTiming(changedHand, 2, evidence), /TIMING_SCOPE_MISMATCH/);
  const changedStep = structuredClone(evidence); changedStep.samples[0]!.step--;
  assert.throws(() => deriveSyncOperationTiming(raw, 2, changedStep), /TIMING_SCOPE_MISMATCH/);
  const timing = deriveSyncOperationTiming(raw, 2, evidence);
  assert.throws(() => normalizeSyncGame(raw, { ...contextFor(raw), connectionEpoch: 3, timing }), /TIMING_SCOPE_MISMATCH/);
});

test('network delay is charged in full and near-deadline samples close before any actor permit', () => {
  const delayed = rawAt(22, 22_500, 1_800), timing = deriveSyncOperationTiming(delayed, 2, evidenceFor(delayed));
  assert.equal(timing.uncertaintyMs, 3800);
  const near = rawAt(298, 298_500);
  assert.throws(() => deriveSyncOperationTiming(near, 2, evidenceFor(near)), /COUNTDOWN_EXPIRED/);
  const expired = rawAt(301, 301_500);
  assert.throws(() => deriveSyncOperationTiming(expired, 2, evidenceFor(expired)), /COUNTDOWN_EXPIRED/);
  assert.throws(() => sampleSyncOperationTiming(rawAt(22, 40_000, 31_000), { remainingMs: 278000, sampledMonoMs: 40_000 }), /TIMING_NETWORK_UNBOUNDED/);
});

test('elapsed units, client disagreement, stale screenshot and wall-clock jumps fail closed', () => {
  const raw = rawAt();
  const wrongUnit = evidenceFor(raw); wrongUnit.samples[0]!.passedWaitingTime = 21;
  // A one-second counter increment over 2.4 seconds cannot establish this unit.
  wrongUnit.samples[0]!.requestedMonoMs -= 2_000; wrongUnit.samples[0]!.receivedMonoMs -= 2_000;
  wrongUnit.samples[0]!.displaySampledMonoMs -= 2_000;
  assert.throws(() => deriveSyncOperationTiming(raw, 2, wrongUnit), /TIMING_ELAPSED_UNIT_UNVERIFIED/);
  const disagrees = evidenceFor(raw); disagrees.samples[1]!.displayedRemainingMs -= 10_000;
  assert.throws(() => deriveSyncOperationTiming(raw, 2, disagrees), /COUNTDOWN_PROTOCOL_MISMATCH/);
  assert.throws(() => sampleSyncOperationTiming(raw, { remainingMs: 278000, sampledMonoMs: raw.receivedMonoMs + 5_001 }), /COUNTDOWN_SAMPLE_STALE/);
  const wallJump = evidenceFor(raw); wallJump.samples[0]!.sampledAt = '2026-11-05T00:00:10.000Z';
  assert.throws(() => deriveSyncOperationTiming(raw, 2, wallJump), /TIMING_WALL_CLOCK_CHANGED/);
});

test('pause state, time banks and a forged elapsed budget cannot refresh a restored operation', () => {
  const raw = rawAt(), timing = deriveSyncOperationTiming(raw, 2, evidenceFor(raw));
  const paused = structuredClone(raw); paused.game_restore.last_pause_time_ms = 1;
  assert.throws(() => deriveSyncOperationTiming(paused, 2, evidenceFor(raw)), /TIMING_GAME_NOT_RUNNING/);
  const bank = structuredClone(raw); (bank.game_restore.actions.at(-1)!.payload as any).operation.time_add = 20000;
  assert.throws(() => sampleSyncOperationTiming(bank, { remainingMs: 298000, sampledMonoMs: bank.receivedMonoMs }), /TIMING_ADD_SEMANTICS_UNVERIFIED/);
  assert.throws(() => normalizeSyncGame(raw, { ...contextFor(raw), timing: { ...timing, elapsedMs: 0, remainingMs: 300000 } }), /TIMING_SCOPE_MISMATCH/);
  assert.throws(() => normalizeSyncGame(raw, { ...contextFor(raw), timing: { ...timing, uncertaintyMs: 1 } }), /COUNTDOWN_READBACK_MISMATCH/);
});

test('child and persistence delays consume the original deadline instead of restarting its budget', async () => {
  const raw = rawAt(275, 275_500), clock = new ReplayClock(raw.receivedAt);
  const h = await actorHarness(0, { clock });
  try {
    const token = h.actor.beginSync();
    const timing = deriveSyncOperationTiming(raw, token.connectionEpoch, evidenceFor(raw));
    const sync = normalizeSyncGame(raw, { ...contextFor(raw), ...token, sessionId: h.actor.projection.sessionId, timing });
    // The protocol report crosses the parent/child channel and storage before use.
    clock.advanceBy(5_000); await h.actor.applySync(sync); await h.actor.resume();
    const snapshot = await h.actor.freezeDecision();
    assert.equal(snapshot.actionDeadline, '2026-11-05T00:05:00.500Z');
    clock.advanceBy(timing.remainingMs - timing.uncertaintyMs - 250 - 5_000);
    await assert.rejects(h.actor.freezeDecision(), /DEADLINE_EXCEEDED/);
    assert.throws(() => h.actor.decision(snapshot.id), /DEADLINE_EXCEEDED/);
  } finally { await h.cleanup(); }
});

test('5+20 verifies the fixed clock and the separately displayed bank across depletion', () => {
  const short = (elapsed: number, mono: number) => {
    const raw = rawAt(elapsed, mono);
    const operation = (raw.game_restore.actions.at(-1)!.payload as { operation: { time_fixed: number; time_add: number } }).operation;
    operation.time_fixed = 5000;
    operation.time_add = 20000;
    return { ...raw, authSummary: { gameConfig: { mode: { detail_rule: { time_fixed: 5, time_add: 20 } } } } };
  };
  const before = short(4, 4500), after = short(6, 6900);
  const evidence = { source: 'automatic-client-countdown' as const, samples: [
    sampleSyncOperationTiming(before, { remainingMs: 1000, bankRemainingMs: 20000, sampledMonoMs: 4500 }),
    sampleSyncOperationTiming(after, { remainingMs: 0, bankRemainingMs: 19000, sampledMonoMs: 6900 }),
  ] };
  assert.equal(deriveSyncOperationTiming(after, 2, evidence).remainingMs, 19000);
  const missing = structuredClone(evidence);
  delete missing.samples[1]!.displayedBankMs;
  assert.throws(() => deriveSyncOperationTiming(after, 2, missing), /INVALID_INTEGER/);
  const mismatch = structuredClone(evidence);
  mismatch.samples[1]!.displayedBankMs = 15000;
  assert.throws(() => deriveSyncOperationTiming(after, 2, mismatch), /COUNTDOWN_BANK_MISMATCH/);
});

function scopedRaw(passed: number, mono: number, step = 10, generation = 2) {
  const raw = rawAt(passed, mono);
  raw.step = step; raw.game_restore.actions.at(-1)!.step = step - 1;
  (raw.game_restore.actions.at(-1)!.payload as any).operation.time_fixed = 5000;
  const gameConfig = { category: 1, mode: { mode: 2, detail_rule: { time_fixed: 5, time_add: 20 } } };
  return { ...raw, generation, gameUuid: 'game-a', authSummary: { roomId: '12345', gameConfig },
    timingScope: { pageEpoch: 3, nativeRestoreRevision: 4, sourceStream: 0, gameUuid: 'game-a', roomId: '12345',
      handKey: 'a'.repeat(64), rulesSha256: digest(gameConfig), clientProfile: 'unity-4.0.51/2036x918/linux' } };
}
function scopedSample(raw: ReturnType<typeof scopedRaw>) {
  return sampleSyncOperationTiming(raw, { remainingMs: Math.max(0, 5000 - raw.game_restore.passed_waiting_time * 1000), sampledMonoMs: raw.receivedMonoMs });
}
function cachedEvidence(current = scopedRaw(0, 20_000, 12, 3)): SyncCountdownEvidence {
  return { source: 'automatic-client-countdown', samples: [scopedSample(current)],
    calibration: { source: 'observed-unit-pair-v1', samples: [scopedRaw(2, 2000), scopedRaw(4, 4400)].map(scopedSample) } };
}

test('a scoped measured unit permits one fresh sample but never reuses its old deadline', () => {
  const raw = scopedRaw(0, 20_000, 12, 3), evidence = cachedEvidence(raw);
  const before = structuredClone(evidence), timing = deriveSyncOperationTiming(raw, 3, evidence);
  assert.equal(timing.remainingMs, 5000); assert.equal(timing.elapsedMs, 0); assert.equal(timing.step, 11);
  assert.equal(timing.sampledMonoMs, 20_000); assert.equal(timing.sampledAt, raw.receivedAt); assert.equal(timing.uncertaintyMs, 2100);
  assert.deepEqual(deriveSyncOperationTiming(raw, 4, evidence), { ...timing, connectionEpoch: 4 });
  assert.deepEqual(evidence, before, 'two pure derivations must not consume or mutate evidence');
  const expired = scopedRaw(4, 30_000, 14, 4);
  assert.throws(() => deriveSyncOperationTiming(expired, 3, cachedEvidence(expired)), /COUNTDOWN_EXPIRED/);
  assert.throws(() => deriveSyncOperationTiming(raw, 3, { source: 'automatic-client-countdown', samples: evidence.samples }), /TIMING_EVIDENCE_REQUIRED/);
});

test('calibration cannot cross page, native restore, game, room, rules, hand, stream or client profile', () => {
  const changes: ((raw: ReturnType<typeof scopedRaw>) => void)[] = [
    raw => { raw.pageEpoch++; raw.timingScope.pageEpoch++; },
    raw => { raw.timingScope.nativeRestoreRevision++; },
    raw => { raw.gameUuid = raw.timingScope.gameUuid = 'game-b'; },
    raw => { raw.authSummary.roomId = raw.timingScope.roomId = '54321'; },
    raw => { raw.authSummary.gameConfig.mode.mode = 1; raw.timingScope.rulesSha256 = digest(raw.authSummary.gameConfig); },
    raw => { (raw.game_restore.actions[1]!.payload as any).sha256 = raw.timingScope.handKey = 'b'.repeat(64); },
    raw => { raw.timingScope.sourceStream++; },
    raw => { raw.timingScope.clientProfile = 'unity-4.0.51/2036x918'; },
  ];
  for (const change of changes) {
    const raw = scopedRaw(0, 20_000, 12, 3); change(raw);
    assert.throws(() => deriveSyncOperationTiming(raw, 3, cachedEvidence(raw)), /TIMING_CALIBRATION_SCOPE_MISMATCH/);
  }
  const raw = scopedRaw(0, 20_000, 12, 3), evidence = cachedEvidence(raw);
  delete (evidence.samples[0]!.scope as any).nativeRestoreRevision;
  assert.throws(() => deriveSyncOperationTiming(raw, 3, evidence), /TIMING_CALIBRATION_SCOPE_MISMATCH/);
  delete (raw.timingScope as any).roomId;
  assert.throws(() => scopedSample(raw), /TIMING_CALIBRATION_SCOPE_MISMATCH/);
});

test('calibration has a fixed lifetime and cannot survive clock jumps or forged historical evidence', () => {
  const old = scopedRaw(0, 304_401, 12, 3);
  assert.throws(() => deriveSyncOperationTiming(old, 3, cachedEvidence(old)), /TIMING_CALIBRATION_EXPIRED/);
  const futurePair = scopedRaw(0, 3000, 12, 3);
  assert.throws(() => deriveSyncOperationTiming(futurePair, 3, cachedEvidence(futurePair)), /TIMING_CLOCK_REVERSED/);
  const jumped = scopedRaw(0, 20_000, 12, 3);
  jumped.receivedAt = new Date(Date.parse(jumped.receivedAt) + 251).toISOString();
  assert.throws(() => deriveSyncOperationTiming(jumped, 3, cachedEvidence(jumped)), /TIMING_WALL_CLOCK_CHANGED/);
  const raw = scopedRaw(0, 20_000, 12, 3);
  const wrongUnit = cachedEvidence(raw); wrongUnit.calibration!.samples[0]!.passedWaitingTime = 3;
  assert.throws(() => deriveSyncOperationTiming(raw, 3, wrongUnit), /TIMING_ELAPSED_UNIT_UNVERIFIED/);
  const wrongPixels = cachedEvidence(raw); wrongPixels.samples[0]!.displayedRemainingMs = 0;
  assert.throws(() => deriveSyncOperationTiming(raw, 3, wrongPixels), /COUNTDOWN_PROTOCOL_MISMATCH/);
  const oldCurrent = cachedEvidence(raw); oldCurrent.samples[0] = oldCurrent.calibration!.samples[1]!;
  assert.throws(() => deriveSyncOperationTiming(raw, 3, oldCurrent), /TIMING_CLOCK_REVERSED|TIMING_SCOPE_MISMATCH/);
  const unscoped = cachedEvidence(raw);
  for (const sample of unscoped.calibration!.samples) { delete sample.scope; delete sample.generation; }
  assert.throws(() => deriveSyncOperationTiming(raw, 3, unscoped), /TIMING_CALIBRATION_SCOPE_MISMATCH/);
});
