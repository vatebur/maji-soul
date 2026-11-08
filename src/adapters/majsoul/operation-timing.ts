import { requireThat } from '../../domain/game/value.ts';
import { integer, timestamp } from '../../schemas/game.ts';

export interface ClientCountdownTiming {
  source: 'client-countdown'; step: number; sampledAt: string; remainingMs: number; uncertaintyMs: number;
}

/** A protocol estimate remains tied to the browser generation that measured it. */
export interface ProtocolOperationTiming {
  source: 'protocol-operation'; origin: 'sync-game';
  step: number; connectionEpoch: number; pageEpoch: number;
  sampledAt: string; sampledMonoMs: number; remainingMs: number; uncertaintyMs: number;
  fixedMs: number; addMs: number; elapsedMs: number;
  networkAllowanceMs: number; quantizationAllowanceMs: number;
}
export type VerifiedOperationTiming = ClientCountdownTiming | ProtocolOperationTiming;

/** The protocol sample and a machine-read client countdown must come from one page. */
export interface AutomaticCountdownSample {
  pageEpoch: number; step: number; handKey: string;
  requestedMonoMs: number; receivedMonoMs: number; sampledAt: string;
  passedWaitingTime: number; fixedMs: number; addMs: number;
  displayedRemainingMs: number; displaySampledMonoMs: number;
  displayedBankMs?: number;
}
export interface SyncCountdownEvidence {
  source: 'automatic-client-countdown'; samples: AutomaticCountdownSample[];
}

function record(value: unknown): Record<string, any> {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_TIMING_SAMPLE');
  return value as Record<string, any>;
}
function mono(value: unknown): asserts value is number {
  requireThat(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'INVALID_MONOTONIC_TIME');
}

/** Extract only the final current operation. Restored historical offers never get a fresh clock. */
function protocolSample(rawValue: unknown) {
  const raw = record(rawValue), restore = record(raw.game_restore);
  integer(raw.pageEpoch, 1); integer(raw.step, 1, 999_999_999); timestamp(raw.receivedAt);
  mono(raw.requestedMonoMs); mono(raw.receivedMonoMs);
  requireThat(raw.receivedMonoMs >= raw.requestedMonoMs, 'TIMING_CLOCK_REVERSED');
  requireThat(raw.receivedMonoMs - raw.requestedMonoMs <= 30_000, 'TIMING_NETWORK_UNBOUNDED');
  // Paused or inter-round restores have different clock semantics and need their own proof.
  requireThat(raw.is_end === false && restore.game_state === 1 && restore.last_pause_time_ms === 0, 'TIMING_GAME_NOT_RUNNING');
  integer(restore.passed_waiting_time, 0, 1_200);
  requireThat(Array.isArray(restore.actions) && restore.actions.length > 0, 'SYNC_ACTIONS_REQUIRED');
  const last = record(restore.actions.at(-1));
  requireThat(last.step === raw.step - 1, 'TIMING_SCOPE_MISMATCH');
  const payload = record(last.payload ?? last.data), operation = record(payload.operation);
  integer(operation.time_fixed, 1, 600_000); integer(operation.time_add, 0, 600_000);
  requireThat(operation.time_add === 0 || [5000,8000].includes(operation.time_fixed) &&
    operation.time_add <= 20000 && raw.authSummary?.gameConfig?.mode?.detail_rule?.time_fixed === 5 &&
    raw.authSummary?.gameConfig?.mode?.detail_rule?.time_add === 20, 'TIMING_ADD_SEMANTICS_UNVERIFIED');
  const opening = restore.actions.find((a: any) => a.name === 'ActionNewRound');
  const handKey = opening && (opening.payload ?? opening.data)?.sha256;
  requireThat(typeof handKey === 'string' && /^[0-9a-f]{64}$/.test(handKey), 'HAND_IDENTITY_UNVERIFIED');
  return { pageEpoch: raw.pageEpoch as number, step: raw.step as number, handKey,
    requestedMonoMs: raw.requestedMonoMs as number, receivedMonoMs: raw.receivedMonoMs as number,
    sampledAt: raw.receivedAt as string, passedWaitingTime: restore.passed_waiting_time as number,
    fixedMs: operation.time_fixed as number, addMs: operation.time_add as number };
}

/** Call after automatically reading the current client's numeric countdown. */
export function sampleSyncOperationTiming(raw: unknown, display: { remainingMs: number; sampledMonoMs: number; bankRemainingMs?: number }): AutomaticCountdownSample {
  const sample = protocolSample(raw);
  integer(display.remainingMs, 0, 600_000); mono(display.sampledMonoMs);
  requireThat(display.sampledMonoMs >= sample.receivedMonoMs && display.sampledMonoMs - sample.receivedMonoMs <= 5_000, 'COUNTDOWN_SAMPLE_STALE');
  return { ...sample, displayedRemainingMs: display.remainingMs, displaySampledMonoMs: display.sampledMonoMs,
    ...(display.bankRemainingMs === undefined ? {} : { displayedBankMs: display.bankRemainingMs }) };
}

function validateSample(sample: AutomaticCountdownSample): void {
  integer(sample.pageEpoch, 1); integer(sample.step, 1, 999_999_999); timestamp(sample.sampledAt);
  requireThat(/^[0-9a-f]{64}$/.test(sample.handKey), 'HAND_IDENTITY_UNVERIFIED');
  mono(sample.requestedMonoMs); mono(sample.receivedMonoMs); mono(sample.displaySampledMonoMs);
  integer(sample.passedWaitingTime, 0, 1_200); integer(sample.fixedMs, 1, 600_000); integer(sample.addMs, 0, 20000);
  integer(sample.displayedRemainingMs, 0, 600_000);
  const rtt = sample.receivedMonoMs - sample.requestedMonoMs;
  requireThat(rtt >= 0 && rtt <= 30_000, 'TIMING_NETWORK_UNBOUNDED');
  const displayAge = sample.displaySampledMonoMs - sample.receivedMonoMs;
  requireThat(displayAge >= 0 && displayAge <= 5_000, 'COUNTDOWN_SAMPLE_STALE');
  // Both wire elapsed time and the displayed integer seconds may be rounded.
  const elapsed = sample.passedWaitingTime * 1_000 + displayAge;
  const expected = Math.max(0, sample.fixedMs - elapsed);
  requireThat(Math.abs(sample.displayedRemainingMs - expected) <= 2_000 + rtt, 'COUNTDOWN_PROTOCOL_MISMATCH');
  if (sample.addMs > 0) {
    integer(sample.displayedBankMs, 0, 20000);
    const expectedBank = Math.max(0, sample.addMs - Math.max(0, elapsed - sample.fixedMs));
    requireThat(Math.abs(sample.displayedBankMs - expectedBank) <= 2_000 + rtt, 'COUNTDOWN_BANK_MISMATCH');
  }
}

/**
 * Confirm the elapsed unit by a measured difference and compare it with the
 * client display. A caller-supplied boolean or a room's 300s setting is no proof.
 * Evidence is scoped to this exact hand, step and page; reconnects recollect it.
 */
export function deriveSyncOperationTiming(raw: unknown, connectionEpoch: number, evidence?: SyncCountdownEvidence): ProtocolOperationTiming {
  integer(connectionEpoch, 1);
  requireThat(evidence?.source === 'automatic-client-countdown' && Array.isArray(evidence.samples) && evidence.samples.length >= 2 && evidence.samples.length <= 8, 'TIMING_EVIDENCE_REQUIRED');
  const samples = evidence.samples;
  samples.forEach(validateSample);
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1]!, current = samples[i]!;
    requireThat(current.pageEpoch === previous.pageEpoch && current.step === previous.step && current.handKey === previous.handKey && current.fixedMs === previous.fixedMs && current.addMs === previous.addMs, 'TIMING_SCOPE_MISMATCH');
    requireThat(current.requestedMonoMs >= previous.receivedMonoMs && Date.parse(current.sampledAt) >= Date.parse(previous.sampledAt), 'TIMING_CLOCK_REVERSED');
    const monotonicDelta = current.receivedMonoMs - previous.receivedMonoMs;
    requireThat(monotonicDelta >= 2_000 && monotonicDelta <= 30_000, 'TIMING_SAMPLE_INTERVAL_INVALID');
    const elapsedDelta = (current.passedWaitingTime - previous.passedWaitingTime) * 1_000;
    const earliest = current.requestedMonoMs - previous.receivedMonoMs - 1_000;
    const latest = current.receivedMonoMs - previous.requestedMonoMs + 1_000;
    requireThat(elapsedDelta > 0 && elapsedDelta >= earliest && elapsedDelta <= latest, 'TIMING_ELAPSED_UNIT_UNVERIFIED');
    requireThat(Math.abs((Date.parse(current.sampledAt) - Date.parse(previous.sampledAt)) - monotonicDelta) <= 250, 'TIMING_WALL_CLOCK_CHANGED');
  }
  const current = protocolSample(raw), last = samples.at(-1)!;
  for (const key of Object.keys(current) as (keyof typeof current)[]) requireThat(current[key] === last[key], 'TIMING_SCOPE_MISMATCH');
  const elapsedMs = current.passedWaitingTime * 1_000, remainingMs = current.fixedMs + current.addMs - elapsedMs;
  const networkAllowanceMs = Math.ceil(current.receivedMonoMs - current.requestedMonoMs);
  const quantizationAllowanceMs = 2_000;
  const uncertaintyMs = networkAllowanceMs + quantizationAllowanceMs;
  requireThat(remainingMs > uncertaintyMs + 250, 'COUNTDOWN_EXPIRED');
  return { source: 'protocol-operation', origin: 'sync-game', step: current.step - 1, connectionEpoch,
    pageEpoch: current.pageEpoch, sampledAt: current.sampledAt, sampledMonoMs: current.receivedMonoMs,
    remainingMs, uncertaintyMs, fixedMs: current.fixedMs, addMs: current.addMs, elapsedMs,
    networkAllowanceMs, quantizationAllowanceMs };
}
