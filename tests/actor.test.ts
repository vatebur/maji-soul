import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameActor } from '../src/application/game/actor.ts';
import { digest } from '../src/domain/game/value.ts';
import { FIXTURE_SESSION } from '../scripts/build-phase1-fixtures.ts';
import { actorHarness, AdjustableClock, holdMethod, makeSync, redCandidate } from './helpers.ts';

test('actor publishes only committed events; pause closes immediately while commit response is held', async () => {
  const h = await actorHarness(3);
  try {
    await h.actor.resume();
    const before = h.actor.projection, held = holdMethod(h.hooks, 'commitGameEvent');
    const pending = h.ingest(h.fixture.events[3]!); await held.entered;
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).projection.sequence, 4);
    assert.equal(h.actor.projection.sequence, 3);
    await assert.rejects(h.actor.freezeDecision(), /INGRESS_PENDING/);
    const epoch = h.actor.control.controlEpoch; h.actor.pause();
    assert.ok(h.actor.control.controlEpoch > epoch); assert.equal(h.actor.control.paused, true);
    held.release(); await pending;
    assert.equal(h.actor.projection.sequence, 4); assert.equal(before.sequence, 3);
    await assert.rejects(h.actor.freezeDecision(), /EXECUTION_PAUSED/);
    await assert.rejects(h.actor.resume(), /SYNC_REQUIRED/);
  } finally { await h.cleanup(); }
});

test('source duplicates do not advance state or outbox; semantic conflicts close the gate', async () => {
  const h = await actorHarness(5);
  try {
    const original = h.fixture.events[4]!, before = h.actor.projection;
    await h.actor.ingest({ ...original, observationId: 'receive-duplicate', receivedAt: '2026-11-05T00:00:05.000Z' });
    assert.equal(digest(h.actor.projection), digest(before));
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.outbox, 1);
    const conflict = structuredClone(original); assert.ok(conflict.type === 'TileDiscarded'); conflict.payload.tile = '5m';
    await assert.rejects(h.actor.ingest(conflict), /SOURCE_DEDUP_CONFLICT/);
    assert.equal(h.actor.control.paused, true); assert.equal(h.actor.control.needsSync, true);
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.events, 5);
  } finally { await h.cleanup(); }
});

test('source gap or mailbox overflow cannot silently advance a trusted projection', async () => {
  const h = await actorHarness();
  try {
    const missing = { ...h.fixture.events[4]!, sourceCursor: 'fixture-hand-1:3' };
    await assert.rejects(h.actor.ingest(missing), /SOURCE_GAP/);
    assert.equal(h.actor.projection.sequence, 4); assert.notEqual(h.actor.projection.state?.trust, 'trusted');
    await assert.rejects(h.actor.ingest(h.fixture.events[4]!), /SYNC_REQUIRED/);
  } finally { await h.cleanup(); }
  const limited = await actorHarness(4, { mailboxCapacity: 1 });
  try {
    const held = holdMethod(limited.hooks, 'findObservation', 'before');
    const pending = limited.actor.ingest(limited.fixture.events[4]!); await held.entered;
    await assert.rejects(limited.actor.ingest(limited.fixture.events[5]!), /MAILBOX_OVERFLOW/);
    held.release(); await pending;
    assert.equal(limited.actor.control.paused, true); assert.equal(limited.actor.control.needsSync, true);
  } finally { await limited.cleanup(); }
});

test('frozen snapshots are detached and immutable; pause during persistence invalidates the result', async () => {
  const h = await actorHarness();
  try {
    await h.actor.resume(); const snapshot = await h.actor.freezeDecision();
    const hash = digest(snapshot); assert.ok(Object.isFrozen(snapshot.state.ownConcealed[0]));
    assert.throws(() => { snapshot.state.ownConcealed[0]!.code = '9m'; }, TypeError);
    assert.equal(digest(snapshot), hash);
    const held = holdMethod(h.hooks, 'saveDecision'), pending = h.actor.freezeDecision();
    const rejected = assert.rejects(pending, /EXECUTION_PAUSED|FENCE_STALE/);
    await held.entered; h.actor.pause(); held.release(); await rejected;
    assert.throws(() => h.actor.issuePermit(snapshot.id, redCandidate(snapshot).id, 'stale-attempt'), /DECISION_STALE/);
  } finally { await h.cleanup(); }
});

test('sync requires complete state; same hand retains mode and rebuilds tile references', async () => {
  const h = await actorHarness();
  try {
    await h.actor.setPendingMode('llm'); const before = h.actor.projection;
    const partial = makeSync(h.actor, before); partial.coverage = 'partial'; partial.missingFields = ['drawnTileRef'];
    await assert.rejects(h.actor.applySync(partial), /SYNC_INCOMPLETE/);
    await assert.rejects(h.actor.resume(), /SYNC_REQUIRED/);
    const full = makeSync(h.actor, before); await h.actor.applySync(full);
    assert.equal(h.actor.projection.activeMode, 'engine'); assert.equal(h.actor.projection.pendingMode, 'llm');
    assert.equal(h.actor.projection.state?.handId, before.state?.handId);
    assert.notEqual(h.actor.projection.state?.ownConcealed[0]?.instanceId, before.state?.ownConcealed[0]?.instanceId);
    assert.equal(h.actor.control.paused, true); await h.actor.resume();
    const snapshot = await h.actor.freezeDecision(); assert.equal(snapshot.connectionEpoch, full.connectionEpoch);
    // A late pre-sync event cannot replay an old physical tile selection into the new epoch.
    const sequence = h.actor.projection.sequence; await h.actor.ingest(h.fixture.events[4]!);
    assert.equal(h.actor.projection.sequence, sequence);
  } finally { await h.cleanup(); }
});

test('pause during an applied-sync response cannot be undone by that late response', async () => {
  const h = await actorHarness();
  try {
    const sync = makeSync(h.actor, h.actor.projection), held = holdMethod(h.hooks, 'commitSync');
    const pending = h.actor.applySync(sync); await held.entered; h.actor.pause(); held.release(); await pending;
    assert.equal(h.actor.control.paused, true); assert.equal(h.actor.control.needsSync, true);
    await assert.rejects(h.actor.resume(), /SYNC_REQUIRED/);
  } finally { await h.cleanup(); }
});

test('restart treats stored checkpoints as needing sync and rejects old decisions', async () => {
  const h = await actorHarness();
  try {
    await h.actor.resume(); const snapshot = await h.actor.freezeDecision();
    const recovered = await GameActor.open(h.createStore(), FIXTURE_SESSION, 'actor-process-2', { clock: h.clock });
    assert.equal(recovered.projection.sequence, 4); assert.equal(recovered.control.needsSync, true);
    assert.equal(recovered.projection.state?.trust, 'syncing');
    await assert.rejects(recovered.resume(), /SYNC_REQUIRED/);
    assert.throws(() => recovered.issuePermit(snapshot.id, redCandidate(snapshot).id, 'old-attempt'), /DECISION_STALE/);
    const sync = makeSync(recovered, h.actor.projection); await recovered.applySync(sync); await recovered.resume();
    assert.equal(recovered.control.paused, false);
  } finally { await h.cleanup(); }
});

test('unknown deadlines and elapsed monotonic deadlines cannot be extended by wall clock rollback', async () => {
  const h = await actorHarness(3);
  try {
    const offer = structuredClone(h.fixture.events[3]!); assert.ok(offer.type === 'OperationOffered');
    offer.payload.window.deadline = { known: false, reason: 'PROVENANCE_UNVERIFIED' };
    await h.ingest(offer); await h.actor.resume();
    await assert.rejects(h.actor.freezeDecision(), /DEADLINE_UNKNOWN/);
  } finally { await h.cleanup(); }
  const clock = new AdjustableClock(), elapsed = await actorHarness(4, { clock });
  try {
    await elapsed.actor.resume(); const snapshot = await elapsed.actor.freezeDecision();
    const permit = elapsed.actor.issuePermit(snapshot.id, redCandidate(snapshot).id, 'expiring-attempt');
    clock.wall -= 3_600_000; clock.mono += 70_000;
    assert.throws(() => elapsed.actor.consumePermit(permit), /PERMIT_EXPIRED/);
    await assert.rejects(elapsed.actor.freezeDecision(), /DEADLINE_EXCEEDED/);
  } finally { await elapsed.cleanup(); }
});

test('a window received behind another pending event retains its original monotonic budget', async () => {
  const h = await actorHarness(2);
  try {
    const start = h.actor.ingest(h.fixture.events[2]!), offered = h.actor.ingest(h.fixture.events[3]!);
    await Promise.all([start, offered]); await h.actor.resume();
    assert.equal((await h.actor.freezeDecision()).stateVersion, h.actor.projection.state?.stateVersion);
  } finally { await h.cleanup(); }
});
