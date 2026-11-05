import { randomUUID } from 'node:crypto';
import type { AuthoritativeSync, DecisionMode, DecisionSnapshot, ExecutionFence, FencedActionCommand, GameObservation, GameProjection, LegalAction, OperationWindow } from '../../domain/game/types.ts';
import { reduceObservation, reduceSync } from '../../domain/game/reducer.ts';
import { canonical, digest, immutable, observationFingerprint, requireThat } from '../../domain/game/value.ts';
import { parseObservation, parseSync } from '../../schemas/game.ts';
import type { StoragePort } from '../../ports/storage.ts';
import { isoNow, systemClock, type Clock } from './clock.ts';

interface Permit { command: FencedActionCommand; deadlineMono: number; used: boolean }
export interface ActorControl { processInstanceId: string; controlEpoch: number; paused: boolean; reason: string | null }
export type ControlSink = (control: ActorControl) => void | Promise<void>;
export interface ActorOptions { clock?: Clock; mailboxCapacity?: number; safetyMarginMs?: number; permitTtlMs?: number; controlTimeoutMs?: number }
export class GameActor {
  readonly processInstanceId: string;
  readonly storage: StoragePort;
  readonly clock: Clock;
  #projection: GameProjection;
  #tail: Promise<unknown> = Promise.resolve();
  #pendingIngress = 0;
  #queued = 0;
  #capacity: number;
  #margin: number;
  #permitTtl: number;
  #controlEpoch = 0;
  #paused = true;
  #needsSync = false;
  #invalidated: string | null = null;
  #sync: { syncId: string; connectionEpoch: number } | null = null;
  #nextConnectionEpoch: number;
  #budgets = new Map<string, number>();
  #decisions = new Map<string, { snapshot: DecisionSnapshot; hash: string }>();
  #permits = new Map<string, Permit>();
  #controlSink: ControlSink | undefined;
  #controlBarrier: Promise<void> = Promise.resolve();
  #controlPending = 0;
  #controlFailed = false;
  #controlTimeout: number;

  private constructor(storage: StoragePort, processInstanceId: string, projection: GameProjection, options: ActorOptions) {
    this.storage = storage; this.processInstanceId = processInstanceId; this.#projection = immutable(projection);
    this.clock = options.clock ?? systemClock; this.#capacity = options.mailboxCapacity ?? 64;
    this.#margin = options.safetyMarginMs ?? 250; this.#permitTtl = options.permitTtlMs ?? 1_000;
    this.#controlTimeout = options.controlTimeoutMs ?? 5_000;
    requireThat(Number.isInteger(this.#capacity) && this.#capacity > 0 && this.#capacity <= 1024, 'INVALID_MAILBOX_CAPACITY');
    requireThat(Number.isFinite(this.#margin) && this.#margin >= 0 && this.#permitTtl > 0 && this.#permitTtl <= 5_000, 'INVALID_EXECUTION_BUDGET');
    requireThat(Number.isInteger(this.#controlTimeout) && this.#controlTimeout > 0 && this.#controlTimeout <= 30_000, 'INVALID_CONTROL_TIMEOUT');
    this.#nextConnectionEpoch = projection.connectionEpoch;
    if (projection.sequence > 0) { this.#needsSync = true; this.#invalidated = 'RECOVERY_REQUIRES_SYNC'; }
  }
  static async open(storage: StoragePort, sessionId: string, processInstanceId: string, options: ActorOptions = {}) {
    const clock = options.clock ?? systemClock;
    const projection = await storage.openSession(sessionId, processInstanceId, isoNow(clock));
    return new GameActor(storage, processInstanceId, projection, options);
  }
  get projection(): GameProjection {
    const p = structuredClone(this.#projection);
    if (p.state && this.#invalidated) { p.state.trust = 'syncing'; p.state.trustIssues = [this.#invalidated]; }
    return immutable(p);
  }
  get control() { return { processInstanceId: this.processInstanceId, paused: this.#paused, controlEpoch: this.#controlEpoch, needsSync: this.#needsSync, pendingIngress: this.#pendingIngress, controlPending: this.#controlPending, reason: this.#invalidated }; }
  attachControlSink(sink: ControlSink): void {
    requireThat(!this.#controlSink, 'CONTROL_SINK_ALREADY_ATTACHED');
    this.#controlSink = sink; this.#publishControl();
  }
  async awaitControlBarrier(): Promise<void> {
    // A concurrent pause may append another remote invalidation while one is awaited.
    let current: Promise<void>;
    do { current = this.#controlBarrier; await current; } while (current !== this.#controlBarrier);
    requireThat(!this.#controlFailed, 'CONTROL_BARRIER_FAILED');
  }
  #publishControl(): void {
    if (!this.#controlSink) return;
    const control: ActorControl = { processInstanceId: this.processInstanceId, controlEpoch: this.#controlEpoch, paused: this.#paused, reason: this.#invalidated };
    this.#controlPending++;
    let work: void | Promise<void>;
    try { work = this.#controlSink(control); }
    catch { work = Promise.reject(new Error('CONTROL_BARRIER_FAILED')); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = Promise.race([Promise.resolve(work), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('CONTROL_BARRIER_FAILED')), this.#controlTimeout);
    })]);
    const settled = bounded.catch(() => {
      this.#controlFailed = true; this.#paused = true; this.#needsSync = true;
      this.#invalidated = 'CONTROL_BARRIER_FAILED'; this.#controlEpoch++;
      this.#permits.clear(); this.#decisions.clear();
      void this.storage.recordFault(this.#projection.sessionId, 'CONTROL_BARRIER_FAILED', isoNow(this.clock)).catch(() => {});
    }).finally(() => { if (timer) clearTimeout(timer); this.#controlPending--; });
    this.#controlBarrier = Promise.all([this.#controlBarrier, settled]).then(() => {});
  }
  pause(): void {
    this.#close('PAUSED'); this.#needsSync = true; this.#sync = null;
  }
  #close(reason: string): void {
    this.#paused = true; this.#controlEpoch++; this.#permits.clear(); this.#decisions.clear();
    if (reason !== 'PAUSED') this.#invalidated = reason;
    this.#publishControl();
  }
  failClosed(code: string): void {
    const safe = /^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'GAME_STATE_INVALID';
    this.#close(safe); this.#needsSync = true;
    // Best effort diagnostics only. Failure to log never reopens the execution gate.
    void this.storage.recordFault(this.#projection.sessionId, safe, isoNow(this.clock)).catch(() => {});
  }
  #enqueue<T>(task: () => Promise<T>, ingress = false): Promise<T> {
    if (this.#queued >= this.#capacity) { this.failClosed('MAILBOX_OVERFLOW'); return Promise.reject(new Error('MAILBOX_OVERFLOW')); }
    this.#queued++; if (ingress) this.#pendingIngress++;
    const result = this.#tail.then(task).finally(() => { this.#queued--; if (ingress) this.#pendingIngress--; });
    this.#tail = result.catch(() => {}); return result;
  }
  async idle(): Promise<void> { await this.#tail; }
  #anchor(window: OperationWindow): void {
    const key = `${window.connectionEpoch}/${window.id}`;
    if (window.deadline.known && !this.#budgets.has(key)) {
      for (const [id, expiry] of this.#budgets) if (expiry <= this.clock.monotonicMs()) this.#budgets.delete(id);
      requireThat(this.#budgets.size < 128, 'WINDOW_BUDGET_CAPACITY');
      this.#budgets.set(key, this.clock.monotonicMs() + Date.parse(window.deadline.value.at) - this.clock.wallTimeMs() - window.deadline.value.uncertaintyMs);
    }
  }
  #accept(projection: GameProjection): void {
    this.#projection = immutable(projection);
    // Old decisions are only kept while their exact version remains current. Persistent history stays in SQLite.
    for (const [id, d] of this.#decisions) if (d.snapshot.stateVersion !== projection.state?.stateVersion || d.snapshot.scope.handId !== projection.state?.handId) this.#decisions.delete(id);
    for (const [id, expiry] of this.#budgets) if (expiry <= this.clock.monotonicMs() || Number(id.split('/')[0]) < projection.connectionEpoch) this.#budgets.delete(id);
    if (projection.state?.trust !== 'trusted' && projection.state) this.failClosed('STATE_NOT_TRUSTED');
  }
  ingest(value: unknown): Promise<GameProjection> {
    let observation: GameObservation;
    try { observation = parseObservation(value); if (observation.type === 'OperationOffered') this.#anchor(observation.payload.window); }
    catch (error) { this.failClosed(error instanceof Error ? error.message : 'INVALID_OBSERVATION'); return Promise.reject(error); }
    if (observation.connectionEpoch < this.#projection.connectionEpoch) return Promise.resolve(this.projection);
    if (observation.type === 'Disconnected') { this.#close('DISCONNECTED'); this.#needsSync = true; }
    return this.#enqueue(async () => {
      try {
        requireThat(!this.#invalidated || observation.type === 'Disconnected', 'SYNC_REQUIRED');
        const previous = await this.storage.findObservation(this.#projection.sessionId, observation.connectionEpoch, observation.sourceDedupKey);
        if (previous) { requireThat(previous.fingerprint === observationFingerprint(observation), 'SOURCE_DEDUP_CONFLICT'); return this.projection; }
        const next = reduceObservation(this.#projection, observation);
        const committed = await this.storage.commitGameEvent(this.#projection.sessionId, this.#projection.sequence, observation);
        requireThat(!committed.duplicate && digest(committed.projection) === digest(next), 'STORAGE_PROJECTION_MISMATCH');
        this.#accept(committed.projection); return this.projection;
      } catch (error) { this.failClosed(error instanceof Error ? error.message : 'EVENT_COMMIT_FAILED'); throw error; }
    }, true);
  }
  beginSync(): { syncId: string; connectionEpoch: number } {
    this.#close('SYNC_REQUESTED'); this.#needsSync = true;
    this.#nextConnectionEpoch = Math.max(this.#nextConnectionEpoch, this.#projection.connectionEpoch) + 1;
    this.#sync = { syncId: randomUUID(), connectionEpoch: this.#nextConnectionEpoch };
    return { ...this.#sync };
  }
  applySync(value: unknown): Promise<GameProjection> {
    let sync: AuthoritativeSync;
    try { sync = parseSync(value); if (sync.currentView?.operationWindow) this.#anchor(sync.currentView.operationWindow); }
    catch (error) { this.failClosed(error instanceof Error ? error.message : 'INVALID_SYNC'); return Promise.reject(error); }
    const token = this.#sync;
    return this.#enqueue(async () => {
      requireThat(token && token === this.#sync && sync.syncId === token.syncId && sync.connectionEpoch === token.connectionEpoch, 'STALE_SYNC');
      try {
        const next = reduceSync(this.#projection, sync);
        const committed = await this.storage.commitSync(this.#projection.sessionId, this.#projection.sequence, sync);
        requireThat(digest(committed.projection) === digest(next), 'STORAGE_PROJECTION_MISMATCH'); this.#accept(committed.projection);
        if (this.#sync === token) { this.#invalidated = null; this.#needsSync = false; this.#sync = null; }
        return this.projection;
      } catch (error) { this.failClosed(error instanceof Error ? error.message : 'SYNC_COMMIT_FAILED'); throw error; }
    }, true);
  }
  setPendingMode(mode: DecisionMode): Promise<void> {
    return this.#enqueue(async () => {
      try { this.#projection = immutable(await this.storage.setPendingMode(this.#projection.sessionId, mode)); }
      catch (error) { this.failClosed('CONTROL_PERSIST_FAILED'); throw error; }
    });
  }
  async resume(): Promise<void> {
    await this.awaitControlBarrier();
    requireThat(!this.#needsSync && !this.#invalidated && this.#pendingIngress === 0 && this.#projection.state?.trust === 'trusted', 'SYNC_REQUIRED');
    const inspection = await this.storage.inspect(this.#projection.sessionId);
    requireThat(!inspection.recoveryRequired && !inspection.attempts.some(a => ['prepared', 'dispatching', 'awaiting-confirmation', 'uncertain'].includes(a.status)), 'ACTION_RECONCILIATION_REQUIRED');
    requireThat(!this.#needsSync && !this.#invalidated && this.#pendingIngress === 0, 'SYNC_REQUIRED');
    this.#controlEpoch++; this.#paused = false; this.#publishControl();
    await this.awaitControlBarrier();
    requireThat(!this.#paused && !this.#needsSync && !this.#invalidated, 'EXECUTION_PAUSED');
  }
  #checkState(): void {
    requireThat(!this.#paused && !this.#needsSync && !this.#invalidated, 'EXECUTION_PAUSED');
    requireThat(!this.#controlFailed && this.#controlPending === 0, 'CONTROL_BARRIER_PENDING');
    requireThat(this.#pendingIngress === 0, 'INGRESS_PENDING');
    requireThat(this.#projection.state?.trust === 'trusted' && this.#projection.handStatus === 'playing', 'STATE_NOT_TRUSTED');
    requireThat(this.#projection.room?.autoWin === 'verified-on', 'AUTO_WIN_UNVERIFIED');
  }
  #budget(window: OperationWindow): number {
    requireThat(window.deadline.known, 'DEADLINE_UNKNOWN');
    const expiry = this.#budgets.get(`${window.connectionEpoch}/${window.id}`);
    requireThat(expiry !== undefined && expiry - this.clock.monotonicMs() > this.#margin, 'DEADLINE_EXCEEDED');
    return expiry - this.#margin;
  }
  async freezeDecision(): Promise<DecisionSnapshot> {
    this.#checkState(); const p = this.#projection, state = p.state!, window = state.operationWindow;
    requireThat(this.#decisions.size < 64, 'DECISION_CAPACITY');
    requireThat(window?.status === 'open' && p.sourceCursor, 'WINDOW_CLOSED');
    requireThat(window.candidates.every(c => c.authority === 'executor'), 'CLIENT_AUTO_WIN_WINDOW'); this.#budget(window);
    requireThat(window.deadline.known, 'DEADLINE_UNKNOWN');
    const id = randomUUID();
    const snapshot = immutable<DecisionSnapshot>({ schemaVersion: 1, id,
      scope: { sessionId: state.sessionId, matchId: state.matchId, handId: state.handId, decisionId: id },
      windowId: window.id, stateVersion: state.stateVersion, connectionEpoch: state.connectionEpoch, controlEpoch: this.#controlEpoch,
      createdAt: isoNow(this.clock), actionDeadline: window.deadline.value.at, activeMode: p.activeMode,
      state, legalActions: window.candidates.map(c => ({ ...c, id: `${id}/${c.id}` })), unknownFields: [...state.unknownFields], contextEventIds: [...p.contextEventIds], sourceCursor: p.sourceCursor });
    const hash = digest(snapshot);
    try { await this.storage.saveDecision(snapshot, hash); }
    catch (error) { this.failClosed('DECISION_PERSIST_FAILED'); throw error; }
    this.#assertFresh(snapshot); this.#decisions.set(id, { snapshot, hash }); return snapshot;
  }
  decision(id: string): DecisionSnapshot {
    const record = this.#decisions.get(id); requireThat(record && digest(record.snapshot) === record.hash, 'DECISION_STALE');
    this.#assertFresh(record.snapshot); return record.snapshot;
  }
  #assertFresh(snapshot: DecisionSnapshot): void {
    this.#checkState(); const state = this.#projection.state!, window = state.operationWindow;
    requireThat(snapshot.controlEpoch === this.#controlEpoch && snapshot.stateVersion === state.stateVersion && snapshot.connectionEpoch === state.connectionEpoch && snapshot.scope.handId === state.handId && snapshot.scope.matchId === state.matchId && snapshot.scope.sessionId === state.sessionId, 'FENCE_STALE');
    requireThat(window?.id === snapshot.windowId && window.status === 'open', 'WINDOW_CLOSED'); this.#budget(window);
  }
  issuePermit(decisionId: string, actionId: string, attemptId: string): FencedActionCommand {
    const snapshot = this.decision(decisionId); requireThat(snapshot.legalActions.some(c => c.id === actionId && c.authority === 'executor'), 'ACTION_NOT_LEGAL');
    for (const [id, permit] of this.#permits) if (permit.used || permit.deadlineMono <= this.clock.monotonicMs()) this.#permits.delete(id);
    requireThat(this.#permits.size < 64, 'PERMIT_CAPACITY');
    const fence: ExecutionFence = { ...snapshot.scope, processInstanceId: this.processInstanceId, windowId: snapshot.windowId,
      stateVersion: snapshot.stateVersion, connectionEpoch: snapshot.connectionEpoch, controlEpoch: snapshot.controlEpoch };
    const expiresMono = Math.min(this.#budget(snapshot.state.operationWindow!), this.clock.monotonicMs() + this.#permitTtl);
    const command = immutable({ attemptId, actionId, fence, permitId: randomUUID(), expiresAt: new Date(this.clock.wallTimeMs() + expiresMono - this.clock.monotonicMs()).toISOString() });
    this.#permits.set(command.permitId, { command, deadlineMono: expiresMono, used: false }); return command;
  }
  consumePermit(command: FencedActionCommand): LegalAction {
    const permit = this.#permits.get(command.permitId);
    requireThat(permit && !permit.used && canonical(command) === canonical(permit.command), 'PERMIT_INVALID');
    permit.used = true;
    requireThat(this.clock.monotonicMs() < permit.deadlineMono, 'PERMIT_EXPIRED');
    requireThat(command.fence.processInstanceId === this.processInstanceId, 'FENCE_STALE');
    const snapshot = this.decision(command.fence.decisionId), action = snapshot.legalActions.find(c => c.id === command.actionId);
    requireThat(action?.authority === 'executor', 'ACTION_NOT_LEGAL'); return action;
  }
}
