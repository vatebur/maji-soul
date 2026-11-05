import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActionAttempt, AuthoritativeSync, CallReceipt, DecisionMode, DecisionSnapshot, GameObservation, GameProjection, ObservedAction } from '../../domain/game/types.ts';
import { eventIdFor, initialProjection, reduceObservation, reduceSync } from '../../domain/game/reducer.ts';
import { canonical, cursorParts, digest, nextCursor, observationFingerprint, requireThat } from '../../domain/game/value.ts';
import { array, integer, object, oneOf, parseObservation, parseSync, string, timestamp, validateView, validateWindow } from '../../schemas/game.ts';
import { expectedActionFor } from '../majsoul/actions.ts';
import type { CommitResult, ReserveActionInput, StorageInspection } from '../../ports/storage.ts';

const APP_ID = 0x4d414a49;
const parse = <T>(value: unknown): T => { requireThat(typeof value === 'string', 'STORAGE_DATA_INVALID'); return JSON.parse(value) as T; };

function validateSnapshot(value: unknown): asserts value is DecisionSnapshot {
  const s = object(value, ['schemaVersion', 'id', 'scope', 'windowId', 'stateVersion', 'connectionEpoch', 'controlEpoch', 'createdAt', 'actionDeadline', 'activeMode', 'state', 'legalActions', 'unknownFields', 'contextEventIds', 'sourceCursor']);
  oneOf(s.schemaVersion, [1]); string(s.id); string(s.windowId); integer(s.stateVersion); integer(s.connectionEpoch); integer(s.controlEpoch);
  timestamp(s.createdAt); timestamp(s.actionDeadline); oneOf(s.activeMode, ['engine', 'llm']); string(s.sourceCursor); cursorParts(s.sourceCursor);
  const scope = object(s.scope, ['sessionId', 'matchId', 'handId', 'decisionId']); Object.values(scope).forEach(v => string(v));
  requireThat(scope.decisionId === s.id, 'DECISION_SCOPE_MISMATCH');
  const state = object(s.state, ['sessionId', 'matchId', 'handId', 'connectionEpoch', 'stateVersion', 'trust', 'trustIssues', 'ownSeat', 'players', 'ownConcealed', 'drawnTileRef', 'dealer', 'roundWind', 'seatWind', 'handNumber', 'honba', 'riichiSticks', 'doraIndicators', 'doraTiles', 'tilesRemaining', 'currentActor', 'unknownFields'], ['latestAction', 'operationWindow']);
  const { sessionId, matchId, handId, connectionEpoch, stateVersion, trust, trustIssues, latestAction, ...view } = state;
  validateView(view, true); string(sessionId); string(matchId); string(handId); integer(connectionEpoch); integer(stateVersion);
  oneOf(trust, ['trusted']); array(trustIssues, v => string(v), 64);
  // latestAction is compared byte-for-byte to the reducer checkpoint below, so cannot inject extra fields.
  if (latestAction !== undefined) requireThat(latestAction && typeof latestAction === 'object', 'INVALID_LATEST_ACTION');
  requireThat(stateVersion === s.stateVersion && connectionEpoch === s.connectionEpoch && sessionId === scope.sessionId && matchId === scope.matchId && handId === scope.handId, 'DECISION_SCOPE_MISMATCH');
  requireThat(state.operationWindow !== undefined, 'WINDOW_CLOSED'); validateWindow(state.operationWindow);
  array(s.legalActions, () => {}, 64); array(s.unknownFields, v => string(v), 64); array(s.contextEventIds, v => string(v), 32);
}
function validateReceipt(value: unknown): asserts value is CallReceipt {
  const r = object(value, ['callId', 'delivery', 'observedAt']); string(r.callId); timestamp(r.observedAt); oneOf(r.delivery, ['not-sent', 'sent', 'accepted', 'rejected', 'unknown']);
}

/** Internal synchronous implementation. Only worker.ts owns it in application code. */
export class StorageDatabase {
  readonly #db: DatabaseSync;
  readonly #owners = new Map<string, string>();
  readonly #readOnly: boolean;
  constructor(path: string, readOnly = false) {
    requireThat(path !== ':memory:', 'PERSISTENT_STORAGE_REQUIRED');
    this.#readOnly = readOnly;
    if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path, { readOnly });
    try {
      this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
      if (!readOnly) { chmodSync(path, 0o600); this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'); }
      const version = this.#db.prepare('PRAGMA user_version').get()?.user_version;
      const appId = this.#db.prepare('PRAGMA application_id').get()?.application_id;
      if (version === 0) {
        requireThat(!readOnly, 'STORAGE_VERSION_UNSUPPORTED');
        const count = this.#db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()?.n;
        requireThat(count === 0 && appId === 0, 'STORAGE_NOT_EMPTY');
        this.#transaction(() => {
          this.#db.exec(readFileSync(new URL('./migrations/001-state.sql', import.meta.url), 'utf8'));
          this.#db.exec(`PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;`);
        });
      } else requireThat((version === 1 || version === 2) && appId === APP_ID, 'STORAGE_VERSION_UNSUPPORTED');
      if (!readOnly && this.#db.prepare('PRAGMA user_version').get()?.user_version === 1) {
        // Rebuild CHECK-constrained tables without changing the references from slot/fact tables.
        // Foreign keys must be disabled before opening the migration transaction.
        this.#db.exec('PRAGMA foreign_keys=OFF;');
        try {
          this.#transaction(() => {
            this.#db.exec(readFileSync(new URL('./migrations/002-live-execution.sql', import.meta.url), 'utf8'));
            requireThat(this.#db.prepare('PRAGMA foreign_key_check').all().length === 0, 'STORAGE_MIGRATION_REFERENCE_INVALID');
            this.#db.exec('PRAGMA user_version=2;');
          });
        } finally { this.#db.exec('PRAGMA foreign_keys=ON;'); }
      }
    } catch (error) { this.#db.close(); throw error; }
  }
  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #owned(sessionId: string): void {
    const process = this.#owners.get(sessionId), row = this.#db.prepare('SELECT process_instance_id FROM sessions WHERE session_id=?').get(sessionId);
    requireThat(process && row?.process_instance_id === process, 'SESSION_TAKEN_OVER');
  }
  #projection(sessionId: string): GameProjection {
    const row = this.#db.prepare('SELECT projection FROM checkpoints WHERE session_id=?').get(sessionId);
    requireThat(row, 'SESSION_NOT_FOUND'); return parse<GameProjection>(row.projection);
  }
  #putProjection(projection: GameProjection): void {
    this.#db.prepare('UPDATE checkpoints SET sequence=?, projection=? WHERE session_id=?').run(projection.sequence, canonical(projection), projection.sessionId);
  }
  openSession(sessionId: string, processInstanceId: string, startedAt: string): GameProjection {
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT process_instance_id FROM sessions WHERE session_id=?').get(sessionId);
      if (!existing) {
        const p = initialProjection(sessionId);
        this.#db.prepare('INSERT INTO sessions VALUES (?, ?, ?, 0)').run(sessionId, processInstanceId, startedAt);
        this.#db.prepare('INSERT INTO checkpoints VALUES (?, 0, ?)').run(sessionId, canonical(p));
      } else if (existing.process_instance_id !== processInstanceId) {
        this.#db.prepare('UPDATE sessions SET process_instance_id=?, recovery_required=1 WHERE session_id=?').run(processInstanceId, sessionId);
        const rows = this.#db.prepare("SELECT body FROM action_attempts WHERE session_id=? AND status IN ('prepared','dispatching','awaiting-confirmation')").all(sessionId);
        for (const row of rows) {
          const attempt = parse<ActionAttempt>(row.body);
          // No external send can precede durable dispatching. Restored prepared records are
          // provably unsent; the session still requires synchronization and keeps its slot.
          attempt.status = attempt.executionMode === 'dry-run' || attempt.status === 'prepared' ? 'not-dispatched' : 'uncertain';
          this.#putAttempt(attempt);
        }
      }
      this.#owners.set(sessionId, processInstanceId);
      return this.#projection(sessionId);
    });
  }
  findObservation(sessionId: string, epoch: number, dedupKey: string): { fingerprint: string; sequence: number } | null {
    const row = this.#db.prepare('SELECT fingerprint, sequence FROM game_events WHERE session_id=? AND connection_epoch=? AND dedup_key=?').get(sessionId, epoch, dedupKey);
    return row ? { fingerprint: String(row.fingerprint), sequence: Number(row.sequence) } : null;
  }
  #insertEvent(p: GameProjection, epoch: number, key: string, fingerprint: string, type: string, payload: unknown): void {
    this.#db.prepare('INSERT INTO game_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(eventIdFor(p.sessionId, p.sequence), p.sessionId, p.sequence, epoch, key, fingerprint, type, canonical(payload));
  }
  commitGameEvent(sessionId: string, expectedSequence: number, observation: GameObservation): CommitResult {
    return this.#transaction(() => {
      this.#owned(sessionId);
      const fingerprint = observationFingerprint(observation), existing = this.findObservation(sessionId, observation.connectionEpoch, observation.sourceDedupKey);
      if (existing) { requireThat(existing.fingerprint === fingerprint, 'SOURCE_DEDUP_CONFLICT'); return { projection: this.#projection(sessionId), duplicate: true }; }
      const current = this.#projection(sessionId); requireThat(current.sequence === expectedSequence, 'VERSION_CONFLICT');
      const projection = reduceObservation(current, observation);
      this.#insertEvent(projection, observation.connectionEpoch, observation.sourceDedupKey, fingerprint, observation.type, observation);
      this.#recordFact(projection, observation, 'authoritative-event');
      this.#putProjection(projection);
      return { projection, duplicate: false };
    });
  }
  commitSync(sessionId: string, expectedSequence: number, sync: AuthoritativeSync): CommitResult {
    return this.#transaction(() => {
      this.#owned(sessionId);
      const fingerprint = digest(sync), key = `sync:${sync.syncId}`, existing = this.findObservation(sessionId, sync.connectionEpoch, key);
      if (existing) { requireThat(existing.fingerprint === fingerprint, 'SYNC_ID_CONFLICT'); return { projection: this.#projection(sessionId), duplicate: true }; }
      const current = this.#projection(sessionId); requireThat(current.sequence === expectedSequence, 'VERSION_CONFLICT');
      const projection = reduceSync(current, sync);
      const limit = cursorParts(sync.sourceCursor);
      for (const action of sync.observedActions) {
        requireThat(action.connectionEpoch === sync.connectionEpoch && action.sourceCursor, 'SYNC_ACTION_SCOPE_MISMATCH');
        const cursor = cursorParts(action.sourceCursor); requireThat(cursor.stream === limit.stream && cursor.step <= limit.step, 'SYNC_ACTION_SCOPE_MISMATCH');
      }
      this.#insertEvent(projection, sync.connectionEpoch, key, fingerprint, 'SyncApplied', sync);
      for (const action of sync.observedActions) this.#recordFact(projection, action, 'authoritative-sync');
      this.#putProjection(projection);
      this.#db.prepare('UPDATE sessions SET recovery_required=0 WHERE session_id=?').run(sessionId);
      return { projection, duplicate: false };
    });
  }
  #recordFact(p: GameProjection, o: GameObservation, matchedBy: 'authoritative-event' | 'authoritative-sync'): void {
    if (o.type !== 'TileDiscarded' && o.type !== 'MeldDeclared') return;
    requireThat(p.gameMatchKey && p.gameHandKey && p.state && o.sourceCursor, 'FACT_SCOPE_MISSING');
    const kind = o.type === 'TileDiscarded' ? 'discard' : 'meld';
    const factKey = digest([p.gameMatchKey, p.gameHandKey, o.sourceCursor, kind]);
    // Physical references are local to an execution generation, not authoritative facts.
    const factHash = digest(o.type === 'MeldDeclared' ? o.payload.meld : o.payload), existing = this.#db.prepare('SELECT fact_hash, event_id FROM observed_actions WHERE fact_key=?').get(factKey);
    if (existing) requireThat(existing.fact_hash === factHash, 'AUTHORITATIVE_FACT_CONFLICT');
    const eventId = existing ? String(existing.event_id) : matchedBy === 'authoritative-event' ? eventIdFor(p.sessionId, p.sequence) : `sync-fact-${factKey.slice(0, 32)}`;
    const fact: ObservedAction = o.type === 'TileDiscarded'
      ? { eventId, handId: p.state.handId, actor: o.payload.actor, kind: 'discard', tiles: [o.payload.tile], tsumogiri: o.payload.tsumogiri, origin: 'unknown', observedAt: o.receivedAt, riichiDeclaration: o.payload.riichiDeclaration }
      : { eventId, handId: p.state.handId, actor: o.payload.meld.actor, kind: 'meld', tiles: o.payload.meld.tiles, tsumogiri: { known: false, reason: 'NOT_A_DISCARD' }, origin: 'unknown', observedAt: o.receivedAt, meld: o.payload.meld };
    if (!existing) {
      this.#db.prepare('INSERT INTO observed_actions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(factKey, eventId, p.sessionId, p.gameMatchKey, p.gameHandKey, o.sourceCursor, factHash, canonical(fact));
      if (fact.actor === p.state.ownSeat && fact.kind === 'discard') this.#db.prepare('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?)').run(`discard-${factKey}`, p.sessionId, factKey, p.sequence, 'OwnDiscardObserved', canonical(fact));
    }
    const rows = this.#db.prepare("SELECT body FROM action_attempts WHERE game_match_key=? AND game_hand_key=? AND expected_cursor=? AND execution_mode IN ('contract-test','live') AND status IN ('awaiting-confirmation','uncertain')").all(p.gameMatchKey, p.gameHandKey, o.sourceCursor);
    for (const row of rows) {
      const attempt = parse<ActionAttempt>(row.body);
      if (this.#matchesFact(attempt, fact)) this.#confirm(attempt, factKey, eventId, matchedBy);
    }
  }
  #matchesFact(attempt: ActionAttempt, fact: ObservedAction): boolean {
    if (fact.actor !== attempt.actor) return false;
    const expected = attempt.expectedAction;
    if (!expected || expected.kind === 'discard') return fact.kind === 'discard' && fact.tiles.length === 1 && fact.tiles[0] === (expected?.tile ?? attempt.tile) && fact.tsumogiri.known && fact.tsumogiri.value === (expected?.tsumogiri ?? attempt.tsumogiri) && (fact.riichiDeclaration ?? false) === (expected?.riichiDeclaration ?? false);
    if (fact.kind !== 'meld' || !fact.meld) return false;
    const a = expected.meld, b = fact.meld;
    return a.kind === b.kind && a.fromSeat === b.fromSeat && a.upgradedFrom === b.upgradedFrom &&
      canonical([...a.tiles].sort()) === canonical([...b.tiles].sort()) &&
      (a.calledTileIndex === undefined ? b.calledTileIndex === undefined : b.calledTileIndex !== undefined && a.tiles[a.calledTileIndex] === b.tiles[b.calledTileIndex]);
  }
  #confirm(attempt: ActionAttempt, factKey: string, eventId: string, matchedBy: 'authoritative-event' | 'authoritative-sync'): void {
    requireThat(attempt.executionMode !== 'dry-run' && (attempt.status === 'awaiting-confirmation' || attempt.status === 'uncertain'), 'CONFIRMATION_WITHOUT_POSSIBLE_SEND');
    requireThat(!this.#db.prepare('SELECT attempt_id FROM action_confirmations WHERE fact_key=?').get(factKey), 'FACT_ALREADY_CONFIRMED');
    attempt.status = 'confirmed'; attempt.confirmationEventId = eventId; this.#putAttempt(attempt);
    this.#db.prepare('INSERT INTO action_confirmations VALUES (?, ?, ?, ?, ?)').run(attempt.id, factKey, eventId, matchedBy, attempt.executionMode);
  }
  #reconcileArchivedFact(attempt: ActionAttempt): void {
    const row = this.#db.prepare('SELECT fact_key, event_id, body FROM observed_actions WHERE game_match_key=? AND game_hand_key=? AND source_cursor=?').get(attempt.gameMatchKey, attempt.gameHandKey, attempt.expectedCursor);
    if (!row) return;
    const fact = parse<ObservedAction>(row.body);
    if (!this.#matchesFact(attempt, fact)) return;
    // Live facts reference their committed game event; sync-only facts have a separate ID.
    const event = this.#db.prepare("SELECT event_id FROM game_events WHERE event_id=? AND type IN ('TileDiscarded','MeldDeclared')").get(row.event_id as string);
    this.#confirm(attempt, String(row.fact_key), String(row.event_id), event ? 'authoritative-event' : 'authoritative-sync');
  }
  setPendingMode(sessionId: string, mode: DecisionMode): GameProjection {
    return this.#transaction(() => { this.#owned(sessionId); const p = this.#projection(sessionId); p.pendingMode = mode; this.#putProjection(p); return p; });
  }
  saveDecision(snapshot: DecisionSnapshot, hash: string): void {
    this.#transaction(() => {
      this.#owned(snapshot.scope.sessionId); requireThat(digest(snapshot) === hash, 'SNAPSHOT_HASH_MISMATCH');
      const existing = this.#db.prepare('SELECT snapshot_hash FROM decisions WHERE decision_id=?').get(snapshot.id);
      if (existing) { requireThat(existing.snapshot_hash === hash, 'DECISION_IMMUTABLE'); return; }
      const p = this.#projection(snapshot.scope.sessionId), state = p.state;
      requireThat(p.matchStatus === 'playing' && p.handStatus === 'playing' && state?.trust === 'trusted' && p.gameMatchKey && p.gameHandKey, 'STATE_UNTRUSTED');
      requireThat(canonical(snapshot.state) === canonical(state) && snapshot.activeMode === p.activeMode && snapshot.sourceCursor === p.sourceCursor, 'VERSION_CONFLICT');
      const window = state.operationWindow;
      requireThat(window?.id === snapshot.windowId && window.status === 'open' && window.deadline.known, 'WINDOW_CLOSED');
      requireThat(!window.candidates.some(c => c.authority === 'client-auto-win'), 'CLIENT_AUTO_WIN_WINDOW');
      const decisionCandidates = window.candidates.filter(c => c.authority === 'executor').map(c => ({ ...c, id: `${snapshot.id}/${c.id}` }));
      requireThat(canonical(snapshot.legalActions) === canonical(decisionCandidates) && snapshot.legalActions.length > 0, 'CANDIDATES_MISMATCH');
      requireThat(snapshot.actionDeadline === window.deadline.value.at && snapshot.contextEventIds.every(id => p.contextEventIds.includes(id)) && canonical(snapshot.unknownFields) === canonical(state.unknownFields), 'SNAPSHOT_CONTEXT_MISMATCH');
      this.#db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?, ?)').run(snapshot.id, p.sessionId, p.sequence, p.gameMatchKey, p.gameHandKey, hash, canonical(snapshot));
    });
  }
  #getAttempt(attemptId: string): ActionAttempt | null {
    const row = this.#db.prepare('SELECT body FROM action_attempts WHERE attempt_id=?').get(attemptId); return row ? parse<ActionAttempt>(row.body) : null;
  }
  #putAttempt(attempt: ActionAttempt): void {
    this.#db.prepare('UPDATE action_attempts SET status=?, body=? WHERE attempt_id=?').run(attempt.status, canonical(attempt), attempt.id);
  }
  reserveAction(input: ReserveActionInput): { attempt: ActionAttempt; created: boolean } {
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM decisions WHERE decision_id=?').get(input.decisionId); requireThat(row, 'DECISION_NOT_FOUND');
      const snapshot = parse<DecisionSnapshot>(row.snapshot), p = this.#projection(snapshot.scope.sessionId);
      this.#owned(p.sessionId); requireThat(this.#owners.get(p.sessionId) === input.processInstanceId, 'STALE_PROCESS');
      const existing = this.#getAttempt(input.attemptId);
      if (existing) {
        requireThat(existing.decisionId === input.decisionId && existing.actionId === input.actionId && existing.processInstanceId === input.processInstanceId && existing.executionMode === input.executionMode, 'ATTEMPT_ID_CONFLICT');
        return { attempt: existing, created: false };
      }
      requireThat(p.sequence === row.sequence && p.state && canonical(p.state) === canonical(snapshot.state), 'VERSION_CONFLICT');
      requireThat(this.#db.prepare('SELECT recovery_required FROM sessions WHERE session_id=?').get(p.sessionId)?.recovery_required === 0, 'RECOVERY_SYNC_REQUIRED');
      const candidate = snapshot.legalActions.find(a => a.id === input.actionId);
      requireThat(candidate?.authority === 'executor' && candidate.action.kind !== 'tsumo' && candidate.action.kind !== 'ron', 'ACTION_NOT_LEGAL');
      const action = candidate.action, expectedAction = expectedActionFor(action, p.state);
      const representative = expectedAction.kind === 'discard' ? expectedAction.tile : expectedAction.meld.tiles[0]!;
      if (input.executionMode !== 'dry-run') {
        const pending = this.#db.prepare("SELECT attempt_id FROM action_attempts WHERE game_match_key=? AND execution_mode IN ('contract-test','live') AND status IN ('prepared','dispatching','awaiting-confirmation','uncertain') LIMIT 1").get(row.game_match_key as string);
        requireThat(!pending, 'ACTION_RECONCILIATION_REQUIRED');
        const slot = this.#db.prepare('SELECT attempt_id FROM action_slots WHERE session_id=? AND hand_id=? AND connection_epoch=? AND window_id=?').get(p.sessionId, snapshot.scope.handId, snapshot.connectionEpoch, snapshot.windowId);
        const sourceSlot = this.#db.prepare('SELECT attempt_id FROM source_action_slots WHERE game_match_key=? AND game_hand_key=? AND source_cursor=?').get(row.game_match_key as string, row.game_hand_key as string, snapshot.sourceCursor);
        requireThat(!slot && !sourceSlot, 'ACTION_SLOT_TAKEN');
      }
      const attempt: ActionAttempt = { id: input.attemptId, decisionId: input.decisionId, actionId: input.actionId,
        sessionId: p.sessionId, matchId: snapshot.scope.matchId, handId: snapshot.scope.handId,
        gameMatchKey: String(row.game_match_key), gameHandKey: String(row.game_hand_key), windowId: snapshot.windowId,
        stateVersion: snapshot.stateVersion, connectionEpoch: snapshot.connectionEpoch, controlEpoch: snapshot.controlEpoch,
        processInstanceId: input.processInstanceId, executionMode: input.executionMode, status: 'prepared', preparedAt: input.preparedAt,
        actor: p.state.ownSeat, tile: representative, tsumogiri: expectedAction.kind === 'discard' && expectedAction.tsumogiri, expectedCursor: nextCursor(snapshot.sourceCursor), actionSpec: structuredClone(action), expectedAction };
      this.#db.prepare('INSERT INTO action_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(attempt.id, p.sessionId, input.decisionId, attempt.gameMatchKey, attempt.gameHandKey, attempt.expectedCursor, attempt.status, attempt.executionMode, canonical(attempt));
      if (attempt.executionMode !== 'dry-run') {
        this.#db.prepare('INSERT INTO action_slots VALUES (?, ?, ?, ?, ?)').run(p.sessionId, attempt.handId, attempt.connectionEpoch, attempt.windowId, attempt.id);
        this.#db.prepare('INSERT INTO source_action_slots VALUES (?, ?, ?, ?)').run(attempt.gameMatchKey, attempt.gameHandKey, snapshot.sourceCursor, attempt.id);
      }
      return { attempt, created: true };
    });
  }
  markDispatching(attemptId: string): { attempt: ActionAttempt; transitioned: boolean } {
    return this.#transaction(() => {
      const attempt = this.#getAttempt(attemptId); requireThat(attempt, 'ATTEMPT_NOT_FOUND'); this.#owned(attempt.sessionId);
      requireThat(attempt.processInstanceId === this.#owners.get(attempt.sessionId), 'STALE_PROCESS');
      if (attempt.status !== 'prepared') return { attempt, transitioned: false };
      requireThat(attempt.executionMode !== 'dry-run', 'DRY_RUN_CANNOT_DISPATCH');
      attempt.status = 'dispatching'; this.#putAttempt(attempt); return { attempt, transitioned: true };
    });
  }
  recordReceipt(attemptId: string, receipt: CallReceipt): ActionAttempt {
    return this.#transaction(() => {
      const attempt = this.#getAttempt(attemptId); requireThat(attempt, 'ATTEMPT_NOT_FOUND'); this.#owned(attempt.sessionId);
      requireThat(attempt.status !== 'simulated', 'SIMULATED_ATTEMPT');
      if (attempt.status === 'confirmed') return attempt;
      // A known-not-sent failure is allowed before markDispatching. An accepted RPC never confirms a game action.
      if (attempt.status === 'prepared') requireThat(receipt.delivery === 'not-sent', 'DISPATCH_INTENT_REQUIRED');
      if (attempt.status === 'not-dispatched' || attempt.status === 'rejected') return attempt;
      attempt.receipt = receipt;
      if (attempt.status !== 'uncertain') attempt.status = receipt.delivery === 'not-sent' ? 'not-dispatched' : receipt.delivery === 'rejected' ? 'rejected' : receipt.delivery === 'unknown' ? 'uncertain' : 'awaiting-confirmation';
      this.#putAttempt(attempt);
      // Preserve a fact that beat the transport acknowledgement, but never attach it to
      // a command rejected by the final fence or explicitly rejected by the transport.
      if (['sent', 'accepted', 'unknown'].includes(receipt.delivery)) this.#reconcileArchivedFact(attempt);
      return attempt;
    });
  }
  markSimulated(attemptId: string): ActionAttempt {
    return this.#transaction(() => { const a = this.#getAttempt(attemptId); requireThat(a, 'ATTEMPT_NOT_FOUND'); this.#owned(a.sessionId); requireThat(a.executionMode === 'dry-run' && (a.status === 'prepared' || a.status === 'simulated'), 'SIMULATION_STATE_INVALID'); a.status = 'simulated'; this.#putAttempt(a); return a; });
  }
  getAttempt(attemptId: string): ActionAttempt | null { return this.#getAttempt(attemptId); }
  inspect(sessionId: string): StorageInspection {
    const projection = this.#projection(sessionId);
    const count = (sql: string) => Number(this.#db.prepare(sql).get(sessionId)?.n ?? 0);
    return { projection, attempts: this.#db.prepare('SELECT body FROM action_attempts WHERE session_id=? ORDER BY rowid').all(sessionId).map(r => parse<ActionAttempt>(r.body)),
      counts: { events: count('SELECT count(*) AS n FROM game_events WHERE session_id=?'), outbox: count('SELECT count(*) AS n FROM outbox WHERE session_id=?'),
        confirmations: count('SELECT count(*) AS n FROM action_confirmations c JOIN action_attempts a ON a.attempt_id=c.attempt_id WHERE a.session_id=?'), faults: count('SELECT count(*) AS n FROM storage_faults WHERE session_id=?') },
      recoveryRequired: this.#db.prepare('SELECT recovery_required FROM sessions WHERE session_id=?').get(sessionId)?.recovery_required === 1 };
  }
  recordFault(sessionId: string, code: string, at: string): void {
    this.#transaction(() => { this.#owned(sessionId); this.#db.prepare('INSERT INTO storage_faults (session_id, code, occurred_at) VALUES (?, ?, ?)').run(sessionId, code, at); this.#db.prepare('UPDATE sessions SET recovery_required=1 WHERE session_id=?').run(sessionId); });
  }
  close(): void { this.#db.close(); }

  dispatch(method: unknown, payload: unknown): unknown {
    requireThat(!this.#readOnly || ['findObservation', 'getAttempt', 'inspect', 'close'].includes(String(method)), 'STORAGE_READ_ONLY');
    switch (method) {
      case 'openSession': { const p = object(payload, ['sessionId', 'processInstanceId', 'startedAt']); string(p.sessionId); string(p.processInstanceId); timestamp(p.startedAt); return this.openSession(p.sessionId, p.processInstanceId, p.startedAt); }
      case 'findObservation': { const p = object(payload, ['sessionId', 'epoch', 'dedupKey']); string(p.sessionId); integer(p.epoch); string(p.dedupKey, 256); return this.findObservation(p.sessionId, p.epoch, p.dedupKey); }
      case 'commitGameEvent': { const p = object(payload, ['sessionId', 'expectedSequence', 'observation']); string(p.sessionId); integer(p.expectedSequence); return this.commitGameEvent(p.sessionId, p.expectedSequence, parseObservation(p.observation)); }
      case 'commitSync': { const p = object(payload, ['sessionId', 'expectedSequence', 'sync']); string(p.sessionId); integer(p.expectedSequence); return this.commitSync(p.sessionId, p.expectedSequence, parseSync(p.sync)); }
      case 'setPendingMode': { const p = object(payload, ['sessionId', 'mode']); string(p.sessionId); oneOf(p.mode, ['engine', 'llm']); return this.setPendingMode(p.sessionId, p.mode as DecisionMode); }
      case 'saveDecision': { const p = object(payload, ['snapshot', 'hash']); string(p.hash, 64); validateSnapshot(p.snapshot); this.saveDecision(p.snapshot, p.hash); return null; }
      case 'reserveAction': { const p = object(payload, ['attemptId', 'decisionId', 'actionId', 'processInstanceId', 'executionMode', 'preparedAt']); for (const key of ['attemptId', 'decisionId', 'processInstanceId']) string(p[key]); string(p.actionId, 512); oneOf(p.executionMode, ['dry-run', 'contract-test', 'live']); timestamp(p.preparedAt); return this.reserveAction(p as unknown as ReserveActionInput); }
      case 'markDispatching': case 'markSimulated': case 'getAttempt': { const p = object(payload, ['attemptId']); string(p.attemptId); return this[method](p.attemptId); }
      case 'recordReceipt': { const p = object(payload, ['attemptId', 'receipt']); string(p.attemptId); validateReceipt(p.receipt); return this.recordReceipt(p.attemptId, p.receipt); }
      case 'inspect': { const p = object(payload, ['sessionId']); string(p.sessionId); return this.inspect(p.sessionId); }
      case 'recordFault': { const p = object(payload, ['sessionId', 'code', 'at']); string(p.sessionId); string(p.code, 80); requireThat(/^[A-Z][A-Z0-9_]*$/.test(p.code), 'INVALID_FAULT_CODE'); timestamp(p.at); this.recordFault(p.sessionId, p.code, p.at); return null; }
      case 'close': object(payload, []); this.close(); return null;
      default: throw new Error('STORAGE_METHOD_UNSUPPORTED');
    }
  }
}
