import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSyncOperationTiming, sampleSyncOperationTiming } from '../src/adapters/majsoul/operation-timing.ts';
import { normalizeSyncGame, type SyncGameContext } from '../src/adapters/majsoul/sync.ts';
import { buildPhase1Fixture, initialView } from '../scripts/build-phase1-fixtures.ts';
import { ReplayClock } from '../src/application/game/clock.ts';
import { actorHarness } from './helpers.ts';

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
