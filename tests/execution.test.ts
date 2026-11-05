import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor, type ContractTestTransport, type ProductionTransport } from '../src/application/game/executor.ts';
import { FIXTURE_SESSION } from '../scripts/build-phase1-fixtures.ts';
import { reduceObservation } from '../src/domain/game/reducer.ts';
import type { CallReceipt, FencedActionCommand, LegalAction } from '../src/domain/game/types.ts';
import { actorHarness, AdjustableClock, deferred, holdMethod, makeSync, redCandidate } from './helpers.ts';

const receipt = (delivery: CallReceipt['delivery'] = 'accepted'): CallReceipt => ({ callId: 'contract-call', delivery, observedAt: '2026-11-05T00:00:04.000Z' });
function controlledTransport() {
  const preparing = deferred<FencedActionCommand>(), ready = deferred<(action: LegalAction) => Promise<CallReceipt>>();
  let sends = 0;
  const transport: ContractTestTransport = { kind: 'contract-test', prepare: async command => { preparing.resolve(command); return ready.promise; } };
  return { transport, preparing: preparing.promise, get sends() { return sends; },
    release: (result: () => Promise<CallReceipt> = async () => receipt()) => ready.resolve(async _action => { sends++; return result(); }) };
}

test('pause during reservation or dispatch-intent persistence prevents the sole send path', async t => {
  for (const method of ['reserveAction', 'markDispatching'] as const) await t.test(method, async () => {
    const h = await actorHarness();
    try {
      await h.actor.resume(); const snapshot = await h.actor.freezeDecision(), candidate = redCandidate(snapshot), transport = controlledTransport();
      const executor = new ActionExecutor(h.actor, { transport: transport.transport }), held = holdMethod(h.hooks, method);
      const pending = executor.executeContract(snapshot.id, candidate.id); await held.entered;
      h.actor.pause(); held.release(); const result = await pending;
      assert.equal(result.status, 'not-dispatched'); assert.equal(transport.sends, 0);
      assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.confirmations, 0);
    } finally { await h.cleanup(); }
  });
});

test('pause and permit expiry while the bridge prepares both reject at the final send boundary', async t => {
  for (const cause of ['pause', 'expired'] as const) await t.test(cause, async () => {
    const clock = new AdjustableClock(), h = await actorHarness(4, { clock });
    try {
      await h.actor.resume(); const snapshot = await h.actor.freezeDecision(), transport = controlledTransport();
      const executor = new ActionExecutor(h.actor, { transport: transport.transport });
      const pending = executor.executeContract(snapshot.id, redCandidate(snapshot).id); await transport.preparing;
      if (cause === 'pause') h.actor.pause(); else clock.mono += 1_001;
      transport.release(); const result = await pending;
      assert.equal(result.status, 'not-dispatched'); assert.equal(transport.sends, 0);
    } finally { await h.cleanup(); }
  });
});

test('pending ingress blocks send even before the updated state has reached the actor', async () => {
  const h = await actorHarness();
  try {
    await h.actor.resume(); const snapshot = await h.actor.freezeDecision(), transport = controlledTransport();
    const executor = new ActionExecutor(h.actor, { transport: transport.transport });
    const execution = executor.executeContract(snapshot.id, redCandidate(snapshot).id); await transport.preparing;
    const held = holdMethod(h.hooks, 'commitGameEvent'), offer = h.fixture.events[3]!; assert.ok(offer.type === 'OperationOffered');
    const event = { ...offer, observationId: 'window-closed-observation', sourceDedupKey: 'window-closed-key', type: 'OperationClosed' as const,
      payload: { windowId: snapshot.windowId, reason: 'completed' as const } };
    const incoming = h.actor.ingest(event); await held.entered;
    assert.equal(h.actor.projection.sequence, 4); assert.equal(h.actor.control.pendingIngress, 1);
    transport.release(); const result = await execution;
    assert.equal(result.status, 'not-dispatched'); assert.equal(transport.sends, 0);
    held.release(); await incoming;
  } finally { await h.cleanup(); }
});

test('matching manual discard during preparation is archived without confirming an unsent attempt', async () => {
  const h = await actorHarness();
  try {
    await h.actor.resume(); const snapshot = await h.actor.freezeDecision(), transport = controlledTransport();
    const executor = new ActionExecutor(h.actor, { transport: transport.transport });
    const execution = executor.executeContract(snapshot.id, redCandidate(snapshot).id); await transport.preparing;
    await h.ingest(h.fixture.events[4]!); transport.release(); const result = await execution;
    assert.equal(transport.sends, 0); assert.equal(result.status, 'not-dispatched');
    const inspection = await h.store.inspect(FIXTURE_SESSION);
    assert.equal(inspection.counts.confirmations, 0); assert.equal(inspection.counts.outbox, 1);
  } finally { await h.cleanup(); }
});

test('accepted is not confirmation; a matching authoritative discard confirms exactly once', async () => {
  const h = await actorHarness();
  try {
    await h.actor.resume(); const snapshot = await h.actor.freezeDecision(), transport = controlledTransport();
    const executor = new ActionExecutor(h.actor, { transport: transport.transport });
    const execution = executor.executeContract(snapshot.id, redCandidate(snapshot).id); await transport.preparing;
    transport.release(); const accepted = await execution;
    assert.equal(accepted.status, 'awaiting-confirmation'); assert.equal(transport.sends, 1);
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.confirmations, 0);
    // Repeated coordination for the same durable claim never resends.
    assert.equal((await executor.executeContract(snapshot.id, redCandidate(snapshot).id)).id, accepted.id); assert.equal(transport.sends, 1);
    await h.ingest(h.fixture.events[4]!);
    assert.equal((await h.store.getAttempt(accepted.id))?.status, 'confirmed');
    await h.actor.ingest({ ...h.fixture.events[4]!, observationId: 'duplicate-confirmation' });
    const inspection = await h.store.inspect(FIXTURE_SESSION);
    assert.equal(inspection.counts.confirmations, 1); assert.equal(inspection.counts.outbox, 1);
    await h.store.recordReceipt(accepted.id, receipt('unknown'));
    assert.equal((await h.store.getAttempt(accepted.id))?.status, 'confirmed');
  } finally { await h.cleanup(); }
});

test('authority arriving before the transport receipt is retained and reconciled after acceptance', async () => {
  const h = await actorHarness();
  try {
    await h.actor.resume(); const snapshot = await h.actor.freezeDecision(), transport = controlledTransport(), sent = deferred(), response = deferred<CallReceipt>();
    const executor = new ActionExecutor(h.actor, { transport: transport.transport });
    const execution = executor.executeContract(snapshot.id, redCandidate(snapshot).id); await transport.preparing;
    transport.release(async () => { sent.resolve(); return response.promise; }); await sent.promise;
    await h.ingest(h.fixture.events[4]!);
    response.resolve(receipt()); const confirmed = await execution;
    assert.equal(transport.sends, 1); assert.equal(confirmed.status, 'confirmed');
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.confirmations, 1);
  } finally { await h.cleanup(); }
});

test('send failure or bounded receipt timeout remains uncertain; a state-only sync cannot authorize retry', async t => {
  for (const cause of ['send-throws', 'receipt-timeout'] as const) await t.test(cause, async () => {
    const h = await actorHarness();
    try {
      await h.actor.resume(); const before = h.actor.projection, snapshot = await h.actor.freezeDecision(), transport = controlledTransport();
      const late = deferred<CallReceipt>(), executor = new ActionExecutor(h.actor, { transport: transport.transport, receiptTimeoutMs: 30 });
      const pending = executor.executeContract(snapshot.id, redCandidate(snapshot).id); await transport.preparing;
      transport.release(async () => { if (cause === 'send-throws') throw new Error('injected-transport-failure'); return late.promise; });
      const uncertain = await pending; assert.equal(uncertain.status, 'uncertain'); assert.equal(transport.sends, 1);
      assert.equal(h.actor.control.needsSync, true); assert.equal(h.actor.control.paused, true);
      late.resolve(receipt());
      await assert.rejects(executor.executeContract(snapshot.id, redCandidate(snapshot).id), /DECISION_STALE|EXECUTION_PAUSED/);
      const stateOnly = makeSync(h.actor, before); await h.actor.applySync(stateOnly);
      assert.equal((await h.store.getAttempt(uncertain.id))?.status, 'uncertain');
      await assert.rejects(h.actor.resume(), /ACTION_RECONCILIATION_REQUIRED/);
      assert.equal(transport.sends, 1);
      // A later exact authoritative action, with consistent river evidence, resolves the same attempt.
      const afterDiscard = reduceObservation(before, h.fixture.events[4]!);
      const proven = makeSync(h.actor, afterDiscard, h.actor.beginSync(), [h.fixture.events[4]!]);
      await h.actor.applySync(proven); assert.equal((await h.store.getAttempt(uncertain.id))?.status, 'confirmed');
      await h.actor.resume(); assert.equal(h.actor.control.paused, false);
      assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.confirmations, 1);
    } finally { await h.cleanup(); }
  });
});

test('one executor rejects overlapping submissions and dry-run cannot invoke even an injected transport', async () => {
  const h = await actorHarness();
  try {
    await h.actor.resume(); const snapshot = await h.actor.freezeDecision(), transport = controlledTransport();
    const executor = new ActionExecutor(h.actor, { transport: transport.transport });
    const first = executor.executeContract(snapshot.id, redCandidate(snapshot).id); await transport.preparing;
    await assert.rejects(executor.executeContract(snapshot.id, redCandidate(snapshot).id), /EXECUTOR_BUSY/);
    transport.release(); await first; assert.equal(transport.sends, 1);
  } finally { await h.cleanup(); }
  const dry = await actorHarness();
  try {
    await dry.actor.resume(); const snapshot = await dry.actor.freezeDecision(); let calls = 0;
    const executor = new ActionExecutor(dry.actor, { transport: { kind: 'contract-test', prepare: async () => { calls++; throw new Error('must-never-call'); } } });
    const result = await executor.dryRun(snapshot.id, redCandidate(snapshot).id);
    assert.equal(result.executionMode, 'dry-run'); assert.equal(result.status, 'simulated'); assert.equal(calls, 0);
    await dry.ingest(dry.fixture.events[4]!);
    const inspection = await dry.store.inspect(FIXTURE_SESSION);
    assert.equal(inspection.counts.confirmations, 0); assert.equal(inspection.attempts[0]?.status, 'simulated');
  } finally { await dry.cleanup(); }
});

test('an unknown storage reservation outcome closes execution without attempting a network call', async () => {
  const h = await actorHarness();
  try {
    await h.actor.resume(); const snapshot = await h.actor.freezeDecision(), transport = controlledTransport();
    const executor = new ActionExecutor(h.actor, { transport: transport.transport });
    h.hooks.set('reserveAction', async proceed => { h.hooks.delete('reserveAction'); await proceed(); throw new Error('STORAGE_OUTCOME_UNKNOWN'); });
    await assert.rejects(executor.executeContract(snapshot.id, redCandidate(snapshot).id), /STORAGE_OUTCOME_UNKNOWN/);
    assert.equal(transport.sends, 0); assert.equal(h.actor.control.paused, true); assert.equal(h.actor.control.needsSync, true);
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).attempts.length, 1);
  } finally { await h.cleanup(); }
});

test('live execution passes only durable dispatch intent and preserves live audit provenance', async () => {
  const h = await actorHarness();
  try {
    let sends = 0;
    const controls: number[] = [];
    const transport: ProductionTransport = { kind: 'live', invalidate: control => { controls.push(control.controlEpoch); },
      prepare: async (command, snapshot, intent) => {
        assert.equal(intent.executionMode, 'live'); assert.equal(intent.status, 'dispatching');
        assert.equal((await h.store.getAttempt(intent.id))?.status, 'dispatching');
        assert.equal(command.attemptId, intent.id); assert.equal(command.fence.decisionId, snapshot.id);
        assert.equal(command.fence.processInstanceId, intent.processInstanceId);
        return async action => { assert.equal(action.id, intent.actionId); sends++; return receipt(); };
      } };
    const executor = new ActionExecutor(h.actor, { transport });
    await h.actor.resume(); const snapshot = await h.actor.freezeDecision(), action = redCandidate(snapshot);
    assert.throws(() => executor.executeContract(snapshot.id, action.id), /CONTRACT_TRANSPORT_REQUIRED/);
    const result = await executor.executeLive(snapshot.id, action.id);
    assert.equal(result.executionMode, 'live'); assert.equal(result.status, 'awaiting-confirmation');
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.confirmations, 0);
    await h.ingest(h.fixture.events[4]!);
    assert.equal((await h.store.getAttempt(result.id))?.status, 'confirmed'); assert.equal(sends, 1);
    assert.deepEqual(controls, [0, 1]);
  } finally { await h.cleanup(); }
});

test('a page final fence can reject an already invoked cross-process dispatch after pause', async () => {
  const h = await actorHarness();
  try {
    const invoked = deferred(), finalSend = deferred(); let pagePaused = true, sends = 0;
    const transport: ProductionTransport = { kind: 'live', invalidate: control => { pagePaused = control.paused; },
      prepare: async () => async () => {
        invoked.resolve(); await finalSend.promise;
        if (pagePaused) return receipt('not-sent');
        sends++; return receipt();
      } };
    const executor = new ActionExecutor(h.actor, { transport }); await h.actor.resume();
    const snapshot = await h.actor.freezeDecision();
    const execution = executor.executeLive(snapshot.id, redCandidate(snapshot).id); await invoked.promise;
    h.actor.pause(); await h.actor.awaitControlBarrier(); finalSend.resolve();
    assert.equal((await execution).status, 'not-dispatched'); assert.equal(sends, 0);
    assert.equal((await h.store.inspect(FIXTURE_SESSION)).counts.confirmations, 0);
  } finally { await h.cleanup(); }
});
