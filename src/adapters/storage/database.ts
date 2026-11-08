import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActionAttempt, AuthoritativeSync, CallReceipt, DecisionMode, DecisionSnapshot, GameObservation, GameProjection, ObservedAction } from '../../domain/game/types.ts';
import { eventIdFor, initialProjection, reduceObservation, reduceSync } from '../../domain/game/reducer.ts';
import { canonical, cursorParts, digest, nextCursor, observationFingerprint, requireThat } from '../../domain/game/value.ts';
import { array, integer, object, oneOf, parseObservation, parseSync, string, timestamp, validateView, validateWindow } from '../../schemas/game.ts';
import { commentaryContext, renderCommentary, validateCommentary, type CommentaryRecord } from '../../application/live/commentary-contract.ts';
import { discardText, type DiscardArchive } from '../../application/live/explanation.ts';
import { expectedActionFor } from '../majsoul/actions.ts';
import type { CommitResult, DispatchIntentResult, MatchInspection, ReserveActionInput, StorageInspection, ConsoleWrite, DeliveryStatus, ReplayFence, StorageResults, StorageRequests } from '../../ports/storage.ts';

const APP_ID = 0x4d414a49;
const parse = <T>(value: unknown): T => { requireThat(typeof value === 'string', 'STORAGE_DATA_INVALID'); return JSON.parse(value) as T; };
const handSettlement = (result: NonNullable<GameProjection['handResult']>): string => {
  const { matchEnded: _terminal, ...settlement } = result;
  return canonical(settlement);
};

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
      } else requireThat((version === 1 || version === 2 || version === 3 || version === 4) && appId === APP_ID, 'STORAGE_VERSION_UNSUPPORTED');
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
      if (!readOnly && this.#db.prepare('PRAGMA user_version').get()?.user_version === 2) {
        this.#transaction(() => {
          if (this.#db.prepare('PRAGMA user_version').get()?.user_version !== 2) return;
          this.#db.exec(readFileSync(new URL('./migrations/003-live-output.sql', import.meta.url), 'utf8'));
          const insert = this.#db.prepare('INSERT INTO discard_explanations (outbox_id, fact_text) VALUES (?, ?)');
          for (const row of this.#db.prepare('SELECT outbox_id, payload FROM outbox').iterate()) {
            insert.run(String(row.outbox_id), discardText(parse<ObservedAction>(row.payload)));
          }
          this.#db.exec('PRAGMA user_version=3;');
        });
      }
      if (!readOnly && this.#db.prepare('PRAGMA user_version').get()?.user_version === 3) {
        this.#transaction(() => {
          if (this.#db.prepare('PRAGMA user_version').get()?.user_version !== 3) return;
          this.#db.exec(readFileSync(new URL('./migrations/004-commentary.sql', import.meta.url), 'utf8'));
          this.#db.exec('PRAGMA user_version=4;');
        });
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
  openSession(sessionId: string, processInstanceId: string, startedAt: string, replayRunId?: string): GameProjection {
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT process_instance_id FROM sessions WHERE session_id=?').get(sessionId);
      if (replayRunId) {
        const marker = this.#db.prepare('SELECT run_id FROM console_replays WHERE session_id=?').get(sessionId);
        requireThat(!existing || marker?.run_id === replayRunId && existing.process_instance_id === processInstanceId, 'REPLAY_SESSION_CONFLICT');
      }
      if (!existing) {
        const p = initialProjection(sessionId);
        this.#db.prepare('INSERT INTO sessions VALUES (?, ?, ?, 0)').run(sessionId, processInstanceId, startedAt);
        this.#db.prepare('INSERT INTO checkpoints VALUES (?, 0, ?)').run(sessionId, canonical(p));
        if (replayRunId) this.#db.prepare('INSERT INTO console_replays VALUES (?, ?, ?)').run(sessionId, replayRunId, new Date().toISOString());
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
  commitGameEvent(sessionId: string, expectedSequence: number, observation: GameObservation, replay?: ReplayFence): CommitResult {
    return this.#transaction(() => {
      this.#owned(sessionId);
      const fingerprint = observationFingerprint(observation), existing = this.findObservation(sessionId, observation.connectionEpoch, observation.sourceDedupKey);
      if (existing) { requireThat(existing.fingerprint === fingerprint, 'SOURCE_DEDUP_CONFLICT'); return { projection: this.#projection(sessionId), duplicate: true }; }
      const current = this.#projection(sessionId); requireThat(current.sequence === expectedSequence, 'VERSION_CONFLICT');
      if (replay) {
        requireThat(this.readConsole().revision === replay.revision, 'CONSOLE_STATE_CONFLICT');
        requireThat(this.#db.prepare('SELECT session_id FROM console_replays WHERE session_id=?').get(sessionId), 'REPLAY_SESSION_CONFLICT');
        if (replay.mode !== null) current.pendingMode = replay.mode;
        this.#db.prepare('UPDATE console_replays SET last_used_at=? WHERE session_id=?').run(new Date().toISOString(), sessionId);
      }
      const projection = reduceObservation(current, observation);
      if (['HandStarted', 'HandEnded', 'MatchEnded'].includes(observation.type)) this.#assertLedgerProgress(projection);
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
      this.#assertLedgerProgress(projection);
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
      if (fact.actor === p.state.ownSeat && fact.kind === 'discard') {
        const id = `discard-${factKey}`;
        this.#db.prepare('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?)').run(id, p.sessionId, factKey, p.sequence, 'OwnDiscardObserved', canonical(fact));
        this.#db.prepare('INSERT INTO discard_explanations (outbox_id, fact_text) VALUES (?, ?)').run(id, discardText(fact));
      }
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
    if (expected.kind === 'pass' || fact.kind !== 'meld' || !fact.meld) return false;
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
      this.#assertLedgerProgress(p);
      requireThat(p.sequence === row.sequence && p.state && canonical(p.state) === canonical(snapshot.state), 'VERSION_CONFLICT');
      requireThat(this.#db.prepare('SELECT recovery_required FROM sessions WHERE session_id=?').get(p.sessionId)?.recovery_required === 0, 'RECOVERY_SYNC_REQUIRED');
      const candidate = snapshot.legalActions.find(a => a.id === input.actionId);
      requireThat(candidate?.authority === 'executor' && candidate.action.kind !== 'tsumo' && candidate.action.kind !== 'ron', 'ACTION_NOT_LEGAL');
      const action = candidate.action, expectedAction = expectedActionFor(action, p.state);
      const representative = expectedAction.kind === 'discard' ? expectedAction.tile : expectedAction.kind === 'meld' ? expectedAction.meld.tiles[0]! : null;
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
  markDispatching(attemptId: string): DispatchIntentResult {
    return this.#transaction(() => {
      const attempt = this.#getAttempt(attemptId); requireThat(attempt, 'ATTEMPT_NOT_FOUND'); this.#owned(attempt.sessionId);
      requireThat(attempt.processInstanceId === this.#owners.get(attempt.sessionId), 'STALE_PROCESS');
      if (attempt.status !== 'prepared') return { attempt, transitioned: false };
      requireThat(attempt.executionMode !== 'dry-run', 'DRY_RUN_CANNOT_DISPATCH');
      try { this.#assertAttemptCurrent(attempt); }
      catch (error) {
        // This transition has not granted dispatch intent, so an already stale
        // reservation is provably unsent. Preserve its slots and cancellation.
        const code=error instanceof Error ? error.message : '';
        if (!['HAND_LEDGER_STALE','HAND_LEDGER_TERMINAL','MATCH_LEDGER_TERMINAL','ATTEMPT_SCOPE_STALE','RECOVERY_SYNC_REQUIRED'].includes(code)) throw error;
        attempt.status='not-dispatched';
        attempt.receipt={callId:`ledger-fence:${attempt.id}`,delivery:'not-sent',observedAt:new Date().toISOString()};
        this.#putAttempt(attempt); return {attempt,transitioned:false,rejectionCode:code};
      }
      attempt.status = 'dispatching'; this.#putAttempt(attempt); return { attempt, transitioned: true };
    });
  }
  #assertAttemptCurrent(attempt: ActionAttempt): void {
    const p=this.#projection(attempt.sessionId);
    this.#assertLedgerProgress(p);
    requireThat(p.gameMatchKey===attempt.gameMatchKey && p.gameHandKey===attempt.gameHandKey && p.state?.handId===attempt.handId &&
      p.state.stateVersion===attempt.stateVersion && p.connectionEpoch===attempt.connectionEpoch &&
      p.state.operationWindow?.id===attempt.windowId && p.state.operationWindow.status==='open' &&
      p.handStatus==='playing' && p.matchStatus==='playing' && !p.matchEndPending, 'ATTEMPT_SCOPE_STALE');
    requireThat(this.#db.prepare('SELECT recovery_required FROM sessions WHERE session_id=?').get(attempt.sessionId)?.recovery_required===0,'RECOVERY_SYNC_REQUIRED');
    const pending=this.#db.prepare("SELECT attempt_id FROM action_attempts WHERE game_match_key=? AND attempt_id<>? AND execution_mode IN ('contract-test','live') AND status IN ('prepared','dispatching','awaiting-confirmation','uncertain') LIMIT 1").get(attempt.gameMatchKey,attempt.id);
    requireThat(!pending,'ACTION_RECONCILIATION_REQUIRED');
  }
  assertDispatchCurrent(attemptId: string): void {
    this.#transaction(()=>{
      const attempt=this.#getAttempt(attemptId);requireThat(attempt,'ATTEMPT_NOT_FOUND');this.#owned(attempt.sessionId);
      requireThat(attempt.processInstanceId===this.#owners.get(attempt.sessionId),'STALE_PROCESS');
      requireThat(attempt.status==='dispatching','DISPATCH_INTENT_REQUIRED');
      this.#assertAttemptCurrent(attempt);
    });
  }
  recordReceipt(attemptId: string, receipt: CallReceipt): ActionAttempt {
    return this.#transaction(() => {
      const attempt = this.#getAttempt(attemptId); requireThat(attempt, 'ATTEMPT_NOT_FOUND'); this.#owned(attempt.sessionId);
      requireThat(attempt.status !== 'simulated', 'SIMULATED_ATTEMPT');
      if (attempt.status === 'confirmed') return attempt;
      // Passing has no public action fact. Its accepted RPC settles only the
      // cancellation request. Discards and melds still require authoritative facts.
      if (attempt.status === 'prepared') requireThat(receipt.delivery === 'not-sent', 'DISPATCH_INTENT_REQUIRED');
      if (attempt.status === 'not-dispatched' || attempt.status === 'rejected') return attempt;
      attempt.receipt = receipt;
      if (attempt.expectedAction?.kind === 'pass' && receipt.delivery === 'accepted') attempt.status = 'confirmed';
      else if (attempt.status !== 'uncertain') attempt.status = receipt.delivery === 'not-sent' ? 'not-dispatched' : receipt.delivery === 'rejected' ? 'rejected' : receipt.delivery === 'unknown' ? 'uncertain' : 'awaiting-confirmation';
      this.#putAttempt(attempt);
      // Preserve a fact that beat the transport acknowledgement, but never attach it to
      // a command rejected by the final fence or explicitly rejected by the transport.
      if (attempt.status !== 'confirmed' && ['sent', 'accepted', 'unknown'].includes(receipt.delivery)) this.#reconcileArchivedFact(attempt);
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
  /** Read the original authoritative event ledger across sessions. No new database
   * or caller-supplied hand counter can erase an earlier hand or unresolved send. */
  inspectMatch(gameMatchKey: string): MatchInspection {
    const contexts = new Map<string, { match: string; hand: string | null }>();
    const hands = new Map<string, MatchInspection['hands'][number]>();
    let matchStatus: MatchInspection['matchStatus'] = 'unknown';
    let matchResult: MatchInspection['matchResult'];
    const remember = (key: string, ordinal: number, result?: NonNullable<GameProjection['handResult']>) => {
      const previous = hands.get(key);
      requireThat(!previous || previous.ordinal === ordinal, 'HAND_LEDGER_CONFLICT');
      requireThat(![...hands.values()].some(h => h.gameHandKey !== key && h.ordinal === ordinal), 'HAND_LEDGER_CONFLICT');
      requireThat(!previous?.result || !result || handSettlement(previous.result)===handSettlement(result), 'HAND_LEDGER_RESULT_CONFLICT');
      const settlement=result ?? previous?.result;
      hands.set(key, { gameHandKey:key, ordinal, status:settlement ? 'finished' : 'playing',
        ...(settlement ? {result:{...settlement,...(previous?.result?.matchEnded ? {matchEnded:true as const} : {})}} : {}) });
      if (matchStatus === 'unknown') matchStatus = 'playing';
    };
    const rememberMatchResult = (result: NonNullable<GameProjection['matchResult']>) => {
      requireThat(!matchResult || canonical(matchResult)===canonical(result),'MATCH_LEDGER_RESULT_CONFLICT');
      matchResult=result; matchStatus='finished';
    };
    // Lifecycle rows are small compared with full action history and retain the
    // hand identities even when a session's checkpoint has advanced to another game.
    const rows = this.#db.prepare("SELECT session_id,type,payload FROM game_events WHERE type IN ('MatchStarted','HandStarted','HandEnded','MatchEnded','SyncApplied') ORDER BY rowid").all();
    for (const row of rows) {
      const session = String(row.session_id), type = String(row.type);
      if (type === 'SyncApplied') {
        const sync = parse<AuthoritativeSync>(row.payload);
        contexts.set(session,{match:sync.gameMatchKey,hand:sync.gameHandKey});
        if (sync.gameMatchKey !== gameMatchKey) continue;
        const terminal = sync.terminal;
        remember(sync.gameHandKey,sync.handOrdinal,terminal?.hand);
        if (terminal?.match) rememberMatchResult(terminal.match);
        else if (terminal?.hand.matchEnded && !matchResult) matchStatus = 'pending-result';
        continue;
      }
      const observation = parse<GameObservation>(row.payload);
      if (observation.type === 'MatchStarted') {
        contexts.set(session,{match:observation.payload.gameMatchKey,hand:null});
        if (observation.payload.gameMatchKey === gameMatchKey && matchStatus === 'unknown') matchStatus='playing';
      } else {
        const context=contexts.get(session);
        if (observation.type === 'HandStarted' && context) context.hand=observation.payload.gameHandKey;
        if (context?.match !== gameMatchKey) continue;
        if (observation.type === 'HandStarted') remember(observation.payload.gameHandKey,observation.payload.ordinal);
        else if (observation.type === 'HandEnded') {
          const hand=context.hand && hands.get(context.hand); requireThat(hand,'HAND_LEDGER_CONTEXT_MISSING');
          remember(hand.gameHandKey,hand.ordinal,observation.payload);
          if (observation.payload.matchEnded && !matchResult) matchStatus='pending-result';
        } else if (observation.type === 'MatchEnded') rememberMatchResult(observation.payload);
      }
    }
    const unresolvedAttempts=this.#db.prepare("SELECT body FROM action_attempts WHERE game_match_key=? AND execution_mode IN ('contract-test','live') AND status IN ('prepared','dispatching','awaiting-confirmation','uncertain') ORDER BY rowid").all(gameMatchKey).map(row=>parse<ActionAttempt>(row.body));
    return {gameMatchKey,hands:[...hands.values()].sort((a,b)=>a.ordinal-b.ordinal),matchStatus,...(matchResult ? {matchResult} : {}),unresolvedAttempts};
  }
  #assertLedgerProgress(projection: GameProjection): void {
    if (!projection.gameMatchKey || !projection.gameHandKey) return;
    const ledger=this.inspectMatch(projection.gameMatchKey), existing=ledger.hands.find(h=>h.gameHandKey===projection.gameHandKey), latest=ledger.hands.at(-1);
    if (existing) {
      requireThat(existing.ordinal===projection.handOrdinal && (!latest || existing.ordinal===latest.ordinal), 'HAND_LEDGER_STALE');
      requireThat(existing.status!=='finished' || projection.handStatus==='finished', 'HAND_LEDGER_TERMINAL');
      requireThat(!existing.result || !!projection.handResult && handSettlement(existing.result)===handSettlement(projection.handResult), 'HAND_LEDGER_RESULT_CONFLICT');
    } else requireThat(projection.handOrdinal===(latest?.ordinal ?? 0)+1, 'HAND_LEDGER_ORDINAL');
    requireThat(ledger.matchStatus!=='finished' || projection.matchStatus==='finished','MATCH_LEDGER_TERMINAL');
    requireThat(ledger.matchStatus!=='pending-result' || projection.matchEndPending || projection.matchStatus==='finished','MATCH_LEDGER_TERMINAL');
    requireThat(!ledger.matchResult || canonical(ledger.matchResult)===canonical(projection.matchResult),'MATCH_LEDGER_RESULT_CONFLICT');
  }
  readDiscards(sessionId: string, limit: number): DiscardArchive[] {
    return this.#db.prepare(`SELECT o.outbox_id, o.payload, x.fact_text, x.commentary, a.decision_id,
      f.game_match_key FROM outbox o JOIN discard_explanations x USING(outbox_id)
      JOIN observed_actions f USING(fact_key)
      LEFT JOIN action_confirmations c USING(fact_key)
      LEFT JOIN action_attempts a ON a.attempt_id=c.attempt_id
      WHERE o.session_id=? ORDER BY MIN(o.sequence) OVER (PARTITION BY f.game_match_key, f.game_hand_key) DESC,
        CAST(substr(f.source_cursor, instr(f.source_cursor, ':') + 1) AS INTEGER) DESC, o.rowid DESC LIMIT ?`).all(sessionId, limit).map(row => {
      const fact = parse<ObservedAction>(row.payload);
      const decisionId = row.decision_id === null ? null : String(row.decision_id);
      const saved = row.commentary === null ? null : parse<CommentaryRecord>(row.commentary);
      const commentary = saved?.decisionId === decisionId ? saved : null;
      return { id: String(row.outbox_id), eventId: fact.eventId, sessionId, matchId: String(row.game_match_key),
        handId: fact.handId, fact, recovered: fact.eventId.startsWith('sync-fact-'), factText: String(row.fact_text), decisionId, commentary };
    });
  }
  readCommentaryContext(id: string) {
    const row = this.#db.prepare(`SELECT o.payload, d.snapshot FROM outbox o
      LEFT JOIN action_confirmations c USING(fact_key)
      LEFT JOIN action_attempts a USING(attempt_id)
      LEFT JOIN decisions d ON d.decision_id=a.decision_id
      WHERE o.outbox_id=?`).get(id);
    if (!row) return null;
    return commentaryContext(id, parse<ObservedAction>(row.payload), row.snapshot === null ? null : parse<DecisionSnapshot>(row.snapshot));
  }
  saveCommentary(input: StorageRequests['saveCommentary']): CommentaryRecord {
    return this.#transaction(() => {
      const context = this.readCommentaryContext(input.id);
      requireThat(context && context.contextHash === input.contextHash, 'COMMENTARY_CONTEXT_CHANGED');
      const selection = validateCommentary(input.selection, context, input.personaChoices);
      const row = this.#db.prepare('SELECT commentary FROM discard_explanations WHERE outbox_id=?').get(input.id)!;
      const saved = row.commentary === null ? null : parse<CommentaryRecord>(row.commentary);
      if (saved?.contextHash === context.contextHash) return saved;
      const record: CommentaryRecord = { ...renderCommentary(context, selection), source: 'llm', claims: selection.claims,
        contextHash: context.contextHash, decisionId: context.decision?.id ?? null,
        createdAt: input.at, configRevision: input.configRevision, profileId: 'local' };
      this.#db.prepare('UPDATE discard_explanations SET commentary=? WHERE outbox_id=?').run(canonical(record), input.id);
      return record;
    });
  }
  readProjection(sessionId: string) {
    const row = this.#db.prepare(`SELECT p.projection, s.started_at, s.recovery_required,
      (SELECT payload FROM game_events e WHERE e.session_id=s.session_id ORDER BY sequence DESC LIMIT 1) AS last_event
      FROM sessions s JOIN checkpoints p USING(session_id) WHERE s.session_id=?`).get(sessionId);
    if (!row) return null;
    const event = row.last_event === null ? null : parse<GameObservation>(row.last_event);
    return { projection: parse<GameProjection>(row.projection), observedAt: event?.receivedAt ?? String(row.started_at),
      recoveryRequired: row.recovery_required === 1 };
  }
  readDecisions(sessionId: string, matchId: string | null, handId: string | null, after: number, limit: number): StorageResults['readDecisions'] {
    return this.#db.prepare(`SELECT rowid, snapshot,
      (SELECT status FROM action_attempts a WHERE a.decision_id=d.decision_id AND a.execution_mode<>'dry-run'
       ORDER BY rowid DESC LIMIT 1) AS status
      FROM decisions d WHERE session_id=? AND rowid<? AND (? IS NULL OR json_extract(snapshot,'$.scope.matchId')=?)
      AND (? IS NULL OR json_extract(snapshot,'$.scope.handId')=?) ORDER BY rowid DESC LIMIT ?`)
      .all(sessionId, after, matchId, matchId, handId, handId, limit).map(row => {
        const snapshot = parse<DecisionSnapshot>(row.snapshot);
        return { key: Number(row.rowid), scope: snapshot.scope, createdAt: snapshot.createdAt,
          activeMode: snapshot.activeMode, status: this.#decisionStatus(row.status) };
      });
  }
  #decisionStatus(status: unknown) {
    if (status === 'confirmed' || status === 'uncertain') return status;
    if (status === 'rejected' || status === 'not-dispatched') return 'failed';
    return status ? 'executing' : 'pending';
  }
  readDecision(id: string): StorageResults['readDecision'] {
    const row = this.#db.prepare('SELECT snapshot FROM decisions WHERE decision_id=?').get(id);
    if (!row) return null;
    const snapshot = parse<DecisionSnapshot>(row.snapshot);
    const attempts = this.#db.prepare("SELECT body FROM action_attempts WHERE decision_id=? AND execution_mode<>'dry-run' ORDER BY rowid DESC LIMIT 100")
      .all(id).map(r => parse<ActionAttempt>(r.body));
    const confirmations = this.#db.prepare(`SELECT a.body AS attempt, f.body AS fact, c.matched_by
      FROM action_confirmations c JOIN action_attempts a USING(attempt_id) JOIN observed_actions f USING(fact_key)
      WHERE a.decision_id=? LIMIT 100`).all(id).map(r => ({
        attempt: parse<ActionAttempt>(r.attempt), fact: parse<ObservedAction>(r.fact), matchedBy: r.matched_by === 'authoritative-sync' ? 'authoritative-sync' as const : 'authoritative-event' as const,
      }));
    return { snapshot, attempts, status: this.#decisionStatus(attempts[0]?.status), confirmations };
  }
  readConsole() {
    const row = this.#db.prepare('SELECT revision, body FROM console_state WHERE singleton=1').get();
    return row ? { revision: Number(row.revision), body: parse<unknown>(row.body) } : { revision: 0, body: null };
  }
  readCommand(id: string) {
    const row = this.#db.prepare('SELECT fingerprint, body FROM console_commands WHERE command_id=?').get(id);
    return row ? { fingerprint: String(row.fingerprint), body: parse<unknown>(row.body) } : null;
  }
  recentCommands(): unknown[] {
    return this.#db.prepare('SELECT body FROM console_commands ORDER BY rowid DESC LIMIT 20').all().map(r => parse(r.body));
  }
  saveConsole(revision: number, body: unknown, command: ConsoleWrite | null) {
    return this.#transaction(() => {
      requireThat(this.readConsole().revision === revision, 'CONSOLE_STATE_CONFLICT');
      if (command) this.#db.prepare('INSERT INTO console_commands VALUES (?, ?, ?, ?)').run(
        command.id, command.fingerprint, command.at, canonical(command.body));
      this.#db.prepare(`INSERT INTO console_state VALUES (1, ?, ?) ON CONFLICT(singleton)
        DO UPDATE SET revision=excluded.revision, body=excluded.body`).run(revision + 1, canonical(body));
      return revision + 1;
    });
  }
  markViewerSeen(id: string, at: string) {
    return this.#db.prepare('INSERT OR IGNORE INTO viewer_seen VALUES (?, ?)').run(id, at).changes === 1;
  }
  reserveDelivery(id: string, at: string) {
    return this.#db.prepare("INSERT OR IGNORE INTO viewer_deliveries VALUES (?, ?, 'dispatching')").run(id, at).changes === 1;
  }
  finishDelivery(id: string, status: DeliveryStatus) {
    this.#db.prepare("UPDATE viewer_deliveries SET status=? WHERE delivery_id=? AND status='dispatching'").run(status, id);
  }
  cleanupOutput(cutoff: string) {
    return this.#transaction(() => {
      // Only this service's replay sessions have a retention marker. Preserve
      // every session in an active run and any row linked to an execution ledger.
      const expired = this.#db.prepare(`SELECT r.session_id FROM console_replays r WHERE last_used_at<?
        AND NOT EXISTS (SELECT 1 FROM console_state c WHERE json_extract(c.body,'$.run.id')=r.run_id
          AND json_extract(c.body,'$.run.status')<>'stopped')
        AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.session_id=r.session_id)
        AND NOT EXISTS (SELECT 1 FROM action_attempts a WHERE a.session_id=r.session_id)
        AND NOT EXISTS (SELECT 1 FROM action_confirmations c JOIN observed_actions f USING(fact_key) WHERE f.session_id=r.session_id)
        ORDER BY last_used_at LIMIT 25`).all(cutoff);
      for (const row of expired) {
        const id = String(row.session_id);
        this.#db.prepare('DELETE FROM discard_explanations WHERE outbox_id IN (SELECT outbox_id FROM outbox WHERE session_id=?)').run(id);
        for (const table of ['outbox','observed_actions','storage_faults','game_events','checkpoints','console_replays','sessions'])
          this.#db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(id);
        this.#owners.delete(id);
      }
      return {
        replays: expired.length,
        messages: Number(this.#db.prepare('DELETE FROM viewer_seen WHERE received_at<?').run(cutoff).changes),
        commands: Number(this.#db.prepare('DELETE FROM console_commands WHERE accepted_at<?').run(cutoff).changes),
        deliveries: Number(this.#db.prepare("DELETE FROM viewer_deliveries WHERE created_at<? AND status NOT IN ('dispatching','uncertain')").run(cutoff).changes),
      };
    });
  }
  recordFault(sessionId: string, code: string, at: string): void {
    this.#transaction(() => { this.#owned(sessionId); this.#db.prepare('INSERT INTO storage_faults (session_id, code, occurred_at) VALUES (?, ?, ?)').run(sessionId, code, at); this.#db.prepare('UPDATE sessions SET recovery_required=1 WHERE session_id=?').run(sessionId); });
  }
  close(): void { this.#db.close(); }

  dispatch(method: unknown, payload: unknown): unknown {
    requireThat(!this.#readOnly || ['findObservation', 'getAttempt', 'inspect', 'inspectMatch', 'close'].includes(String(method)), 'STORAGE_READ_ONLY');
    switch (method) {
      case 'openReplaySession': {
        const p = object(payload, ['sessionId', 'runId', 'startedAt']); string(p.sessionId); string(p.runId); timestamp(p.startedAt);
        return this.openSession(p.sessionId, p.sessionId, p.startedAt, p.runId);
      }
      case 'commitReplayEvent': {
        const p = object(payload, ['sessionId', 'expectedSequence', 'observation', 'revision', 'mode']);
        string(p.sessionId); integer(p.expectedSequence); integer(p.revision, 0, Number.MAX_SAFE_INTEGER); oneOf(p.mode, [null, 'engine', 'llm']);
        return this.commitGameEvent(p.sessionId, p.expectedSequence, parseObservation(p.observation), { revision: p.revision, mode: p.mode as DecisionMode | null });
      }
      case 'openSession': { const p = object(payload, ['sessionId', 'processInstanceId', 'startedAt']); string(p.sessionId); string(p.processInstanceId); timestamp(p.startedAt); return this.openSession(p.sessionId, p.processInstanceId, p.startedAt); }
      case 'findObservation': { const p = object(payload, ['sessionId', 'epoch', 'dedupKey']); string(p.sessionId); integer(p.epoch); string(p.dedupKey, 256); return this.findObservation(p.sessionId, p.epoch, p.dedupKey); }
      case 'commitGameEvent': { const p = object(payload, ['sessionId', 'expectedSequence', 'observation']); string(p.sessionId); integer(p.expectedSequence); return this.commitGameEvent(p.sessionId, p.expectedSequence, parseObservation(p.observation)); }
      case 'commitSync': { const p = object(payload, ['sessionId', 'expectedSequence', 'sync']); string(p.sessionId); integer(p.expectedSequence); return this.commitSync(p.sessionId, p.expectedSequence, parseSync(p.sync)); }
      case 'setPendingMode': { const p = object(payload, ['sessionId', 'mode']); string(p.sessionId); oneOf(p.mode, ['engine', 'llm']); return this.setPendingMode(p.sessionId, p.mode as DecisionMode); }
      case 'saveDecision': { const p = object(payload, ['snapshot', 'hash']); string(p.hash, 64); validateSnapshot(p.snapshot); this.saveDecision(p.snapshot, p.hash); return null; }
      case 'reserveAction': { const p = object(payload, ['attemptId', 'decisionId', 'actionId', 'processInstanceId', 'executionMode', 'preparedAt']); for (const key of ['attemptId', 'decisionId', 'processInstanceId']) string(p[key]); string(p.actionId, 512); oneOf(p.executionMode, ['dry-run', 'contract-test', 'live']); timestamp(p.preparedAt); return this.reserveAction(p as unknown as ReserveActionInput); }
      case 'markDispatching': case 'markSimulated': case 'getAttempt': { const p = object(payload, ['attemptId']); string(p.attemptId); return this[method](p.attemptId); }
      case 'assertDispatchCurrent': { const p=object(payload,['attemptId']); string(p.attemptId);this.assertDispatchCurrent(p.attemptId);return null; }
      case 'recordReceipt': { const p = object(payload, ['attemptId', 'receipt']); string(p.attemptId); validateReceipt(p.receipt); return this.recordReceipt(p.attemptId, p.receipt); }
      case 'inspect': { const p = object(payload, ['sessionId']); string(p.sessionId); return this.inspect(p.sessionId); }
      case 'inspectMatch': { const p = object(payload, ['gameMatchKey']); string(p.gameMatchKey); return this.inspectMatch(p.gameMatchKey); }
      case 'recordFault': { const p = object(payload, ['sessionId', 'code', 'at']); string(p.sessionId); string(p.code, 80); requireThat(/^[A-Z][A-Z0-9_]*$/.test(p.code), 'INVALID_FAULT_CODE'); timestamp(p.at); this.recordFault(p.sessionId, p.code, p.at); return null; }
      case 'readCommentaryContext': { const p = object(payload, ['id']); string(p.id); return this.readCommentaryContext(p.id); }
      case 'saveCommentary': {
        const p = object(payload, ['id', 'contextHash', 'selection', 'personaChoices', 'configRevision', 'at']);
        string(p.id); string(p.contextHash, 64); timestamp(p.at); integer(p.configRevision, 0, Number.MAX_SAFE_INTEGER);
        array(p.personaChoices, phrase => string(phrase, 100), 20);
        return this.saveCommentary(p as unknown as StorageRequests['saveCommentary']);
      }
      case 'readDiscards': { const p = object(payload, ['sessionId', 'limit']); string(p.sessionId); integer(p.limit, 1, 100); return this.readDiscards(p.sessionId, p.limit); }
      case 'readProjection': { const p = object(payload, ['sessionId']); string(p.sessionId); return this.readProjection(p.sessionId); }
      case 'readDecisions': {
        const p = object(payload, ['sessionId', 'matchId', 'handId', 'after', 'limit']);
        string(p.sessionId); if (p.matchId !== null) string(p.matchId); if (p.handId !== null) string(p.handId);
        integer(p.after, 1, Number.MAX_SAFE_INTEGER); integer(p.limit, 1, 101);
        return this.readDecisions(p.sessionId, p.matchId, p.handId, p.after, p.limit);
      }
      case 'readDecision': case 'readCommand': { const p = object(payload, ['id']); string(p.id); return this[method](p.id); }
      case 'readConsole': case 'recentCommands': object(payload, []); return this[method]();
      case 'saveConsole': {
        const p = object(payload, ['revision', 'body', 'command']); integer(p.revision, 0, Number.MAX_SAFE_INTEGER);
        if (p.command !== null) { const c = object(p.command, ['id', 'at', 'fingerprint', 'body']); string(c.id, 128); timestamp(c.at); string(c.fingerprint, 64); }
        return this.saveConsole(p.revision, p.body, p.command as ConsoleWrite | null);
      }
      case 'markViewerSeen': case 'reserveDelivery': { const p = object(payload, ['id', 'at']); string(p.id); timestamp(p.at); return this[method](p.id, p.at); }
      case 'finishDelivery': { const p = object(payload, ['id', 'status']); string(p.id); oneOf(p.status, ['simulated','published','blocked','expired','uncertain','failed']); this.finishDelivery(p.id, p.status as DeliveryStatus); return null; }
      case 'cleanupOutput': { const p = object(payload, ['cutoff']); timestamp(p.cutoff); return this.cleanupOutput(p.cutoff); }
      case 'close': object(payload, []); this.close(); return null;
      default: throw new Error('STORAGE_METHOD_UNSUPPORTED');
    }
  }
}
