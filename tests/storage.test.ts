import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { StorageClient } from '../src/adapters/storage/client.ts';
import { StorageDatabase } from '../src/adapters/storage/database.ts';
import { buildPhase1Fixture, FIXTURE_SESSION, VIRTUAL_NOW } from '../scripts/build-phase1-fixtures.ts';
import type { AuthoritativeSync, DecisionSnapshot, GameProjection, HandInitialView } from '../src/domain/game/types.ts';
import { reduceObservation } from '../src/domain/game/reducer.ts';
import { digest } from '../src/domain/game/value.ts';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'maji-storage-test-')), path = join(directory, 'state.sqlite');
  const clients: StorageClient[] = [], create = (options: { capacity?: number; readOnly?: boolean } = {}) => { const c = new StorageClient(path, options); clients.push(c); return c; };
  const store = create(), fixture = buildPhase1Fixture();
  let projection = await store.openSession(FIXTURE_SESSION, 'process-1', VIRTUAL_NOW);
  for (const observation of fixture.events.slice(0, 4)) projection = (await store.commitGameEvent(FIXTURE_SESSION, projection.sequence, observation)).projection;
  return { path, store, fixture, projection, create, cleanup: async () => { await Promise.all(clients.map(c => c.close())); await rm(directory, { recursive: true, force: true }); } };
}
function snapshot(p: GameProjection, id = 'decision-test'): DecisionSnapshot {
  const state = structuredClone(p.state!); const window = state.operationWindow!; assert.ok(window.deadline.known); assert.ok(p.sourceCursor);
  return { schemaVersion: 1, id, scope: { sessionId: p.sessionId, matchId: state.matchId, handId: state.handId, decisionId: id },
    windowId: window.id, stateVersion: state.stateVersion, connectionEpoch: p.connectionEpoch, controlEpoch: 1,
    createdAt: window.openedAt, actionDeadline: window.deadline.value.at, activeMode: p.activeMode, state,
    legalActions: window.candidates.filter(c => c.authority === 'executor').map(c => ({ ...c, id: `${id}/${c.id}` })), unknownFields: [], contextEventIds: p.contextEventIds, sourceCursor: p.sourceCursor };
}
async function prepare(store: StorageClient, p: GameProjection, executionMode: 'contract-test' | 'dry-run' | 'live' = 'contract-test') {
  const s = snapshot(p); await store.saveDecision(s, digest(s));
  const red = s.legalActions.find(a => { const action = a.action; return action.kind === 'discard' && s.state.ownConcealed.find(t => t.instanceId === action.tile)?.code === '5mr'; }); assert.ok(red);
  const input = { attemptId: 'attempt-test', decisionId: s.id, actionId: red.id, processInstanceId: 'process-1', executionMode, preparedAt: s.createdAt };
  return { input, snapshot: s, ...(await store.reserveAction(input)) };
}
function syncFor(p: GameProjection, connectionEpoch: number, observedActions: AuthoritativeSync['observedActions'] = []): AuthoritativeSync {
  const { sessionId: _s, matchId: _m, handId: _h, connectionEpoch: _e, stateVersion: _v, trust: _t, trustIssues: _i, latestAction: _a, operationWindow, ...view } = structuredClone(p.state!);
  const currentView: HandInitialView & { operationWindow?: typeof operationWindow } = view;
  // Sync adapter provides stable source references; local reducer event IDs are not source evidence.
  for (const action of observedActions) if (action.type === 'TileDiscarded') {
    const river = currentView.players[action.payload.actor].river;
    const entry = river.find(r => r.tile === action.payload.tile);
    assert.ok(entry); entry.eventId = action.sourceDedupKey;
  }
  if (operationWindow?.status === 'open') currentView.operationWindow = { ...operationWindow, id: `sync-window-${connectionEpoch}`, connectionEpoch };
  return { syncId: `sync-${connectionEpoch}`, connectionEpoch, receivedAt: VIRTUAL_NOW, coverage: 'complete-current-state', room: p.room!,
    gameMatchKey: p.gameMatchKey!, gameHandKey: p.gameHandKey!, handOrdinal: p.handOrdinal, currentView,
    missingFields: [], historyCoverage: 'partial', handHistory: [], observedActions, sourceCursor: p.sourceCursor! };
}

test('worker migration, strict ingress, atomic deduplication and rollback preserve checkpoint/outbox', async () => {
  const env = await setup();
  try {
    const first = env.fixture.events[0]!;
    const duplicate = await env.store.commitGameEvent(FIXTURE_SESSION, 0, { ...first, observationId: 'duplicate-receive', receivedAt: '2026-11-05T00:01:00.000Z' });
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.projection.sequence, 4);
    const conflicting = structuredClone(first); assert.equal(conflicting.type, 'RoomVerified');
    if (conflicting.type === 'RoomVerified') conflicting.payload.room.autoWin = 'verified-off';
    await assert.rejects(env.store.commitGameEvent(FIXTURE_SESSION, 4, conflicting), /SOURCE_DEDUP_CONFLICT/);
    const missing = { ...env.fixture.events[4]!, sourceCursor: 'fixture-hand-1:3' };
    await assert.rejects(env.store.commitGameEvent(FIXTURE_SESSION, 4, missing), /SOURCE_GAP/);
    await assert.rejects(env.store.commitGameEvent(FIXTURE_SESSION, 4, { ...first, cookie: 'never-persist' } as unknown as typeof first), /INVALID_FIELDS/);
    const inspection = await env.store.inspect(FIXTURE_SESSION);
    assert.equal(inspection.counts.events, 4); assert.equal(inspection.counts.outbox, 0); assert.deepEqual(inspection.projection, env.projection);
    assert.equal((await stat(env.path)).mode & 0o777, 0o600);
    const raw = new DatabaseSync(env.path, { readOnly: true });
    try { assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 2); assert.equal(raw.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal'); }
    finally { raw.close(); }
  } finally { await env.cleanup(); }
});

test('immutable decisions, competing reservations and exact authoritative discard confirmation', async () => {
  const env = await setup();
  try {
    const s = snapshot(env.projection);
    await assert.rejects(env.store.saveDecision(s, '0'.repeat(64)), /SNAPSHOT_HASH_MISMATCH/);
    await env.store.saveDecision(s, digest(s));
    const changed = { ...s, createdAt: '2026-11-05T00:00:09.000Z' };
    await assert.rejects(env.store.saveDecision(changed, digest(changed)), /DECISION_IMMUTABLE/);
    const prepared = await prepare(env.store, env.projection), second = env.create();
    await second.openSession(FIXTURE_SESSION, 'process-1', VIRTUAL_NOW);
    assert.equal((await second.reserveAction(prepared.input)).created, false);
    const retried = await second.reserveAction({ ...prepared.input, preparedAt: '2026-11-05T00:01:00.000Z' });
    assert.equal(retried.created, false); assert.equal(retried.attempt.preparedAt, prepared.input.preparedAt);
    await assert.rejects(second.reserveAction({ ...prepared.input, attemptId: 'attempt-competitor' }), /ACTION_RECONCILIATION_REQUIRED/);
    const transitions = await Promise.all([env.store.markDispatching(prepared.attempt.id), second.markDispatching(prepared.attempt.id)]);
    assert.equal(transitions.filter(r => r.transitioned).length, 1);
    assert.equal((await env.store.recordReceipt(prepared.attempt.id, { callId: 'call-1', delivery: 'accepted', observedAt: VIRTUAL_NOW })).status, 'awaiting-confirmation');
    await env.store.commitGameEvent(FIXTURE_SESSION, 4, env.fixture.events[4]!);
    assert.equal((await env.store.getAttempt(prepared.attempt.id))?.status, 'confirmed');
    await env.store.recordReceipt(prepared.attempt.id, { callId: 'late-call', delivery: 'unknown', observedAt: VIRTUAL_NOW });
    assert.equal((await env.store.getAttempt(prepared.attempt.id))?.status, 'confirmed');
    await env.store.commitGameEvent(FIXTURE_SESSION, 4, env.fixture.events[4]!);
    const inspection = await env.store.inspect(FIXTURE_SESSION);
    assert.equal(inspection.counts.outbox, 1); assert.equal(inspection.counts.confirmations, 1); assert.equal(inspection.counts.events, 5);
  } finally { await env.cleanup(); }
});

test('a fact arriving during dispatch preparation is confirmed only after a possible-send receipt', async t => {
  for (const delivery of ['sent', 'accepted', 'unknown', 'not-sent', 'rejected'] as const) await t.test(delivery, async () => {
    const env = await setup();
    try {
      const { attempt } = await prepare(env.store, env.projection); await env.store.markDispatching(attempt.id);
      await env.store.commitGameEvent(FIXTURE_SESSION, 4, env.fixture.events[4]!);
      assert.equal((await env.store.getAttempt(attempt.id))?.status, 'dispatching');
      assert.equal((await env.store.inspect(FIXTURE_SESSION)).counts.confirmations, 0);
      const result = await env.store.recordReceipt(attempt.id, { callId: 'receipt-after-fact', delivery, observedAt: VIRTUAL_NOW });
      const possibleSend = delivery === 'sent' || delivery === 'accepted' || delivery === 'unknown';
      assert.equal(result.status, possibleSend ? 'confirmed' : delivery === 'not-sent' ? 'not-dispatched' : 'rejected');
      const inspection = await env.store.inspect(FIXTURE_SESSION);
      assert.equal(inspection.counts.confirmations, possibleSend ? 1 : 0); assert.equal(inspection.counts.outbox, 1);
    } finally { await env.cleanup(); }
  });
});

test('restart fences old writers, keeps unresolved intent, and requires precise sync evidence', async () => {
  const env = await setup();
  try {
    const { attempt } = await prepare(env.store, env.projection);
    await env.store.markDispatching(attempt.id);
    const recovered = env.create(); await recovered.openSession(FIXTURE_SESSION, 'process-2', VIRTUAL_NOW);
    assert.equal((await recovered.getAttempt(attempt.id))?.status, 'uncertain');
    await assert.rejects(env.store.recordFault(FIXTURE_SESSION, 'TEST_STALE_WRITER', VIRTUAL_NOW), /SESSION_TAKEN_OVER/);
    assert.equal((await recovered.inspect(FIXTURE_SESSION)).recoveryRequired, true);
    const partial = { ...syncFor(env.projection, 1), coverage: 'partial' as const, missingFields: ['drawnTileRef'] };
    await assert.rejects(recovered.commitSync(FIXTURE_SESSION, 4, partial), /SYNC_INCOMPLETE/);
    const applied = await recovered.commitSync(FIXTURE_SESSION, 4, syncFor(env.projection, 1));
    assert.equal((await recovered.getAttempt(attempt.id))?.status, 'uncertain');
    const afterDiscard = reduceObservation(env.projection, env.fixture.events[4]!);
    const syncAction = { ...env.fixture.events[4]!, source: 'majsoul-sync' as const, connectionEpoch: 2 };
    await recovered.commitSync(FIXTURE_SESSION, applied.projection.sequence, syncFor(afterDiscard, 2, [syncAction]));
    assert.equal((await recovered.getAttempt(attempt.id))?.status, 'confirmed');
    const inspection = await recovered.inspect(FIXTURE_SESSION);
    assert.equal(inspection.counts.confirmations, 1); assert.equal(inspection.counts.outbox, 1); assert.equal(inspection.recoveryRequired, false);
  } finally { await env.cleanup(); }
});

test('a restored prepared intent stays unsent even when sync observes the same manual discard', async () => {
  const env = await setup();
  try {
    const { attempt } = await prepare(env.store, env.projection), restored = env.create();
    await restored.openSession(FIXTURE_SESSION, 'process-after-prepared-crash', VIRTUAL_NOW);
    assert.equal((await restored.getAttempt(attempt.id))?.status, 'not-dispatched');
    assert.equal((await restored.inspect(FIXTURE_SESSION)).recoveryRequired, true);
    const unchanged = await restored.commitSync(FIXTURE_SESSION, 4, syncFor(env.projection, 1));
    const decision = snapshot(unchanged.projection, 'decision-after-prepared-crash'); await restored.saveDecision(decision, digest(decision));
    await assert.rejects(restored.reserveAction({ attemptId: 'retry-after-prepared-crash', decisionId: decision.id,
      actionId: decision.legalActions[0]!.id, processInstanceId: 'process-after-prepared-crash', executionMode: 'contract-test', preparedAt: decision.createdAt }), /ACTION_SLOT_TAKEN/);
    const afterDiscard = reduceObservation(env.projection, env.fixture.events[4]!);
    const manual = { ...env.fixture.events[4]!, source: 'majsoul-sync' as const, connectionEpoch: 2 };
    await restored.commitSync(FIXTURE_SESSION, unchanged.projection.sequence, syncFor(afterDiscard, 2, [manual]));
    const inspection = await restored.inspect(FIXTURE_SESSION);
    assert.equal(inspection.attempts[0]?.status, 'not-dispatched'); assert.equal(inspection.counts.confirmations, 0);
    assert.equal(inspection.counts.outbox, 1); assert.equal(inspection.recoveryRequired, false);
  } finally { await env.cleanup(); }
});

test('dry run never dispatches or confirms; pre-send cancellation is durably not-dispatched', async () => {
  const env = await setup();
  try {
    const { attempt } = await prepare(env.store, env.projection, 'dry-run');
    await assert.rejects(env.store.markDispatching(attempt.id), /DRY_RUN_CANNOT_DISPATCH/);
    assert.equal((await env.store.markSimulated(attempt.id)).status, 'simulated');
    await env.store.commitGameEvent(FIXTURE_SESSION, 4, env.fixture.events[4]!);
    const inspected = await env.store.inspect(FIXTURE_SESSION); assert.equal(inspected.counts.confirmations, 0); assert.equal(inspected.counts.outbox, 1);
    assert.equal(inspected.attempts[0]?.status, 'simulated');
  } finally { await env.cleanup(); }
  const env2 = await setup();
  try {
    const { attempt } = await prepare(env2.store, env2.projection);
    assert.equal((await env2.store.recordReceipt(attempt.id, { callId: 'cancelled', delivery: 'not-sent', observedAt: VIRTUAL_NOW })).status, 'not-dispatched');
    assert.equal((await env2.store.markDispatching(attempt.id)).transitioned, false);
  } finally { await env2.cleanup(); }
  const env3 = await setup();
  try {
    const { attempt } = await prepare(env3.store, env3.projection, 'dry-run');
    const restored = env3.create(); await restored.openSession(FIXTURE_SESSION, 'process-after-preview-crash', VIRTUAL_NOW);
    assert.equal((await restored.getAttempt(attempt.id))?.status, 'not-dispatched');
    assert.equal((await restored.inspect(FIXTURE_SESSION)).counts.confirmations, 0);
  } finally { await env3.cleanup(); }
  const env4 = await setup();
  try {
    const preview = await prepare(env4.store, env4.projection, 'dry-run'); await env4.store.markSimulated(preview.attempt.id);
    const execution = await env4.store.reserveAction({ ...preview.input, attemptId: 'independent-program-attempt', executionMode: 'contract-test' });
    assert.equal(execution.created, true); assert.equal((await env4.store.markDispatching(execution.attempt.id)).transitioned, true);
  } finally { await env4.cleanup(); }
});

test('bounded client admission and worker method whitelist reject unsupported requests', async () => {
  const env = await setup();
  try {
    const bounded = env.create({ capacity: 1 });
    const first = bounded.inspect(FIXTURE_SESSION);
    await assert.rejects(bounded.inspect(FIXTURE_SESSION), /STORAGE_QUEUE_FULL/); await first;
    const db = new StorageDatabase(env.path);
    try { assert.throws(() => db.dispatch('exec', { sql: 'DELETE FROM sessions' }), /STORAGE_METHOD_UNSUPPORTED/); }
    finally { db.close(); }
  } finally { await env.cleanup(); }
});

test('read-only inspection neither takes over the owner nor alters pending attempts', async () => {
  const env = await setup();
  try {
    const { attempt } = await prepare(env.store, env.projection), reader = env.create({ readOnly: true });
    assert.equal((await reader.inspect(FIXTURE_SESSION)).attempts[0]?.status, 'prepared');
    await assert.rejects(reader.openSession(FIXTURE_SESSION, 'reader', VIRTUAL_NOW), /STORAGE_READ_ONLY/);
    assert.equal((await env.store.markDispatching(attempt.id)).transitioned, true);
    const inspected = await reader.inspect(FIXTURE_SESSION);
    assert.equal(inspected.attempts[0]?.status, 'dispatching'); assert.equal(inspected.recoveryRequired, false);
  } finally { await env.cleanup(); }
});

test('a new session cannot bypass an unresolved attempt in the same authoritative match', async () => {
  const env = await setup();
  try {
    await prepare(env.store, env.projection);
    const newcomer = env.create(), sessionId = 'new-session-same-match';
    let p = await newcomer.openSession(sessionId, 'process-new', VIRTUAL_NOW);
    for (const event of env.fixture.events.slice(0, 3)) p = (await newcomer.commitGameEvent(sessionId, p.sequence, event)).projection;
    const offer = structuredClone(env.fixture.events[3]!); assert.ok(offer.type === 'OperationOffered');
    for (const [i, candidate] of offer.payload.window.candidates.entries()) if (candidate.action.kind === 'discard') candidate.action.tile = p.state!.ownConcealed[i]!.instanceId;
    p = (await newcomer.commitGameEvent(sessionId, p.sequence, offer)).projection;
    const decision = snapshot(p, 'decision-new-session'); await newcomer.saveDecision(decision, digest(decision));
    await assert.rejects(newcomer.reserveAction({ attemptId: 'attempt-new-session', decisionId: decision.id, actionId: decision.legalActions[0]!.id,
      processInstanceId: 'process-new', executionMode: 'contract-test', preparedAt: decision.createdAt }), /ACTION_RECONCILIATION_REQUIRED/);
  } finally { await env.cleanup(); }
});

test('live claims share program slots and confirmations retain their evidence kind', async () => {
  const env = await setup();
  try {
    const { attempt, input } = await prepare(env.store, env.projection, 'live');
    await assert.rejects(env.store.reserveAction({ ...input, attemptId: 'contract-must-not-bypass-live', executionMode: 'contract-test' }), /ACTION_RECONCILIATION_REQUIRED/);
    await env.store.markDispatching(attempt.id);
    await env.store.recordReceipt(attempt.id, { callId: 'native-client-request-42', delivery: 'accepted', observedAt: VIRTUAL_NOW });
    await env.store.commitGameEvent(FIXTURE_SESSION, 4, env.fixture.events[4]!);
    assert.equal((await env.store.getAttempt(attempt.id))?.status, 'confirmed');
    const raw = new DatabaseSync(env.path, { readOnly: true });
    try { assert.equal(raw.prepare('SELECT evidence_kind FROM action_confirmations WHERE attempt_id=?').get(attempt.id)?.evidence_kind, 'live'); }
    finally { raw.close(); }
  } finally { await env.cleanup(); }
});

test('v1 migration preserves populated claims, references and contract evidence', async () => {
  const env = await setup(), directory = await mkdtemp(join(tmpdir(), 'maji-legacy-storage-'));
  const legacyPath = join(directory, 'legacy.sqlite');
  try {
    const { attempt } = await prepare(env.store, env.projection);
    await env.store.markDispatching(attempt.id);
    await env.store.recordReceipt(attempt.id, { callId: 'legacy-call', delivery: 'accepted', observedAt: VIRTUAL_NOW });
    await env.store.commitGameEvent(FIXTURE_SESSION, 4, env.fixture.events[4]!);
    const raw = new DatabaseSync(legacyPath);
    try {
      raw.exec(readFileSync(new URL('../src/adapters/storage/migrations/001-state.sql', import.meta.url), 'utf8'));
      raw.exec('PRAGMA application_id=1296124489; PRAGMA user_version=1;');
      raw.prepare('ATTACH DATABASE ? AS previous').run(env.path);
      for (const table of ['sessions', 'checkpoints', 'game_events', 'decisions', 'action_attempts', 'action_slots', 'source_action_slots', 'observed_actions', 'action_confirmations', 'outbox', 'storage_faults']) {
        raw.exec(`INSERT INTO main.${table} SELECT * FROM previous.${table}`);
      }
    } finally { raw.close(); }
    const migrated = new StorageDatabase(legacyPath);
    try {
      const inspection = migrated.inspect(FIXTURE_SESSION);
      assert.equal(inspection.attempts[0]?.status, 'confirmed'); assert.equal(inspection.counts.confirmations, 1);
      assert.equal(inspection.counts.outbox, 1); assert.equal(inspection.projection.sequence, 5);
    } finally { migrated.close(); }
    const checked = new DatabaseSync(legacyPath, { readOnly: true });
    try {
      assert.equal(checked.prepare('PRAGMA user_version').get()?.user_version, 2);
      assert.deepEqual(checked.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(checked.prepare('SELECT evidence_kind FROM action_confirmations').get()?.evidence_kind, 'contract-test');
    } finally { checked.close(); }
  } finally { await env.cleanup(); await rm(directory, { recursive: true, force: true }); }
});
