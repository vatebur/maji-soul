import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageClient } from '../src/adapters/storage/client.ts';
import { GameActor, type ActorOptions } from '../src/application/game/actor.ts';
import { ReplayClock, type Clock } from '../src/application/game/clock.ts';
import { buildPhase1Fixture, FIXTURE_SESSION, VIRTUAL_NOW } from '../scripts/build-phase1-fixtures.ts';
import type { AuthoritativeSync, DecisionSnapshot, GameObservation, GameProjection, HandInitialView, OperationWindow } from '../src/domain/game/types.ts';
import type { StoragePort } from '../src/ports/storage.ts';

type Hook = (proceed: () => Promise<unknown>, args: unknown[]) => Promise<unknown>;
export type StorageHooks = Map<keyof StoragePort, Hook>;
export function deferred<T = void>() { return Promise.withResolvers<T>(); }

/** Delays one storage response after the real worker has committed, or one invocation before it starts. */
export function holdMethod(hooks: StorageHooks, method: keyof StoragePort, phase: 'before' | 'after' = 'after') {
  const entered = deferred<unknown[]>(), release = deferred();
  hooks.set(method, async (proceed, args) => {
    hooks.delete(method);
    if (phase === 'before') { entered.resolve(args); await release.promise; return proceed(); }
    const result = await proceed(); entered.resolve(args); await release.promise; return result;
  });
  return { entered: entered.promise, release: () => release.resolve() };
}
export async function actorHarness(count = 4, options: ActorOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'maji-actor-test-')), path = join(directory, 'state.sqlite');
  const clients: StorageClient[] = [], createStore = () => { const store = new StorageClient(path); clients.push(store); return store; };
  const store = createStore(), hooks: StorageHooks = new Map();
  const port = new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const proceed = () => Reflect.apply(value, target, args) as Promise<unknown>;
        return hooks.get(property as keyof StoragePort)?.(proceed, args) ?? proceed();
      };
    },
  }) as StoragePort;
  const fixture = buildPhase1Fixture(), clock = options.clock ?? new ReplayClock(VIRTUAL_NOW);
  const actor = await GameActor.open(port, FIXTURE_SESSION, 'actor-process-1', { ...options, clock });
  const ingest = async (event: GameObservation) => {
    if (clock instanceof ReplayClock) clock.advanceTo(event.receivedAt);
    return actor.ingest(event);
  };
  try { for (const event of fixture.events.slice(0, count)) await ingest(event); }
  catch (error) { await Promise.all(clients.map(c => c.close())); await rm(directory, { recursive: true, force: true }); throw error; }
  return { actor, store, port, hooks, path, fixture, clock, ingest, createStore,
    cleanup: async () => { await actor.idle(); await Promise.all(clients.map(c => c.close())); await rm(directory, { recursive: true, force: true }); } };
}
export function redCandidate(snapshot: DecisionSnapshot) {
  const candidate = snapshot.legalActions.find(c => {
    const action = c.action;
    return action.kind === 'discard' && snapshot.state.ownConcealed.find(t => t.instanceId === action.tile)?.code === '5mr';
  });
  assert.ok(candidate); return candidate;
}
export function makeSync(actor: GameActor, projection: GameProjection, token = actor.beginSync(), observedActions: GameObservation[] = []): AuthoritativeSync {
  assert.ok(projection.state && projection.room && projection.gameMatchKey && projection.gameHandKey && projection.sourceCursor);
  const { sessionId: _session, matchId: _match, handId: _hand, connectionEpoch: _epoch, stateVersion: _version,
    trust: _trust, trustIssues: _issues, latestAction: _action, operationWindow, ...view } = structuredClone(projection.state);
  const currentView: HandInitialView & { operationWindow?: OperationWindow } = view;
  if (operationWindow?.status === 'open') currentView.operationWindow = { ...operationWindow, id: `sync-window-${token.connectionEpoch}`, connectionEpoch: token.connectionEpoch };
  const actions = observedActions.map(o => ({ ...structuredClone(o), source: 'majsoul-sync' as const, connectionEpoch: token.connectionEpoch }));
  for (const action of actions) if (action.type === 'TileDiscarded') {
    const entry = currentView.players[action.payload.actor].river.find(r => r.tile === action.payload.tile);
    assert.ok(entry); entry.eventId = action.sourceDedupKey;
  }
  return { ...token, receivedAt: new Date(actor.clock.wallTimeMs()).toISOString(), coverage: 'complete-current-state', room: projection.room,
    gameMatchKey: projection.gameMatchKey, gameHandKey: projection.gameHandKey, handOrdinal: projection.handOrdinal,
    currentView, missingFields: [], historyCoverage: 'none', handHistory: [], observedActions: actions, sourceCursor: projection.sourceCursor };
}
export class AdjustableClock implements Clock {
  wall = Date.parse(VIRTUAL_NOW); mono = 0;
  wallTimeMs() { return this.wall; }
  monotonicMs() { return this.mono; }
}
