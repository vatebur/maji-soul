import type { AuthoritativeSync, FriendRoom, GameObservation, HandInitialView, Meld, OperationWindow } from '../domain/game/types.ts';
import { cursorParts, requireThat } from '../domain/game/value.ts';

export function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  requireThat(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_OBJECT');
  const result = value as Record<string, unknown>;
  requireThat(required.every(key => Object.hasOwn(result, key)) && Object.keys(result).every(key => required.includes(key) || optional.includes(key)), 'INVALID_FIELDS');
  return result;
}
export function string(value: unknown, max = 160): asserts value is string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value), 'INVALID_STRING');
}
export function integer(value: unknown, min = 0, max = 1_000_000): asserts value is number {
  requireThat(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max, 'INVALID_INTEGER');
}
export function oneOf(value: unknown, options: readonly unknown[]): void { requireThat(options.includes(value), 'INVALID_ENUM'); }
export const boolean = (value: unknown) => oneOf(value, [true, false]);
export function array(value: unknown, check: (item: unknown) => void, max = 512): asserts value is unknown[] {
  requireThat(Array.isArray(value) && value.length <= max, 'INVALID_ARRAY'); value.forEach(check);
}
export function timestamp(value: unknown): asserts value is string {
  string(value, 24); requireThat(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'INVALID_TIMESTAMP');
}
export function tile(value: unknown): void {
  requireThat(typeof value === 'string' && /^(?:[1-9][mps]|[1-7]z|5[mps]r)$/.test(value), 'INVALID_TILE');
}
const seat = (value: unknown) => integer(value, 0, 3);
function knowledge(value: unknown, check: (item: unknown) => void): void {
  const flag = (value as { known?: unknown } | null)?.known;
  if (flag === true) { const k = object(value, ['known', 'value']); check(k.value); }
  else { const k = object(value, ['known', 'reason']); oneOf(k.known, [false]); string(k.reason); }
}
function scores(value: unknown): void {
  const s = object(value, ['0', '1', '2', '3']); Object.values(s).forEach(v => integer(v, -100_000, 1_000_000));
}
export function validateMeld(value: unknown): asserts value is Meld {
  const m = object(value, ['id', 'actor', 'kind', 'tiles'], ['fromSeat', 'calledTileIndex', 'upgradedFrom']);
  string(m.id); seat(m.actor); oneOf(m.kind, ['chi', 'pon', 'open-kan', 'closed-kan', 'added-kan']); array(m.tiles, tile, 4);
  if (m.fromSeat !== undefined) seat(m.fromSeat);
  if (m.calledTileIndex !== undefined) integer(m.calledTileIndex, 0, 3);
  if (m.upgradedFrom !== undefined) string(m.upgradedFrom);
}
export function validateRoom(value: unknown): asserts value is FriendRoom {
  const room = object(value, ['roomId', 'rules', 'autoWin']); string(room.roomId);
  oneOf(room.autoWin, ['verified-on', 'verified-off', 'unknown']);
  const rules = object(room.rules, ['players', 'length', 'displayTimeSetting', 'computerSeats', 'verifiedOptions', 'protocolVersion']);
  oneOf(rules.players, [4]); oneOf(rules.length, ['east']); oneOf(rules.displayTimeSetting, ['300+0']); oneOf(rules.computerSeats, [3]); string(rules.protocolVersion);
  requireThat(rules.verifiedOptions && typeof rules.verifiedOptions === 'object' && !Array.isArray(rules.verifiedOptions), 'INVALID_RULES');
  const entries = Object.entries(rules.verifiedOptions); requireThat(entries.length > 0 && entries.length <= 64, 'INVALID_RULES');
  for (const [key, v] of entries) { string(key, 64); if (typeof v === 'string') string(v); else if (typeof v === 'number') requireThat(Number.isFinite(v), 'INVALID_RULES'); else boolean(v); }
}
export function validateWindow(value: unknown): asserts value is OperationWindow {
  const w = object(value, ['id', 'connectionEpoch', 'openedAt', 'deadline', 'candidates', 'status']);
  string(w.id); integer(w.connectionEpoch); timestamp(w.openedAt); oneOf(w.status, ['open', 'claimed', 'submitted', 'closed', 'uncertain']);
  knowledge(w.deadline, d => { const k = object(d, ['at', 'sourceEventId', 'uncertaintyMs']); timestamp(k.at); string(k.sourceEventId); integer(k.uncertaintyMs, 0, 120_000); });
  array(w.candidates, c => {
    const a = object(c, ['id', 'action', 'authority', 'label', 'evidenceEventIds']); string(a.id); string(a.label);
    oneOf(a.authority, ['executor', 'client-auto-win']); array(a.evidenceEventIds, v => string(v), 32);
    const kind = (a.action as { kind?: unknown } | null)?.kind;
    if (kind === 'discard') {
      const action = object(a.action, ['kind', 'tile', 'tsumogiri']); string(action.tile); boolean(action.tsumogiri); oneOf(a.authority, ['executor']);
    } else { object(a.action, ['kind']); oneOf(kind, ['tsumo']); oneOf(a.authority, ['client-auto-win']); }
  }, 64);
  requireThat(new Set((value as OperationWindow).candidates.map(c => c.id)).size === (value as OperationWindow).candidates.length, 'DUPLICATE_CANDIDATE');
  const window = value as OperationWindow;
  if (window.deadline.known) requireThat(Date.parse(window.deadline.value.at) >= Date.parse(window.openedAt), 'INVALID_WINDOW_DEADLINE');
}
export function validateView(value: unknown, withWindow = false): asserts value is HandInitialView & { operationWindow?: OperationWindow } {
  const v = object(value, ['ownSeat', 'players', 'ownConcealed', 'drawnTileRef', 'dealer', 'roundWind', 'seatWind', 'handNumber', 'honba', 'riichiSticks', 'doraIndicators', 'doraTiles', 'tilesRemaining', 'currentActor', 'unknownFields'], withWindow ? ['operationWindow'] : []);
  seat(v.ownSeat); seat(v.dealer); oneOf(v.roundWind, ['1z', '2z', '3z', '4z']); oneOf(v.seatWind, ['1z', '2z', '3z', '4z']);
  integer(v.handNumber, 1, 4); integer(v.honba, 0, 100); integer(v.riichiSticks, 0, 100);
  array(v.ownConcealed, t => { const t1 = object(t, ['instanceId', 'code']); string(t1.instanceId); tile(t1.code); }, 14);
  knowledge(v.drawnTileRef, id => { if (id !== null) string(id); });
  const players = object(v.players, ['0', '1', '2', '3']);
  for (const [key, p] of Object.entries(players)) {
    const player = object(p, ['seat', 'score', 'river', 'melds', 'riichi', 'concealedCount']);
    oneOf(player.seat, [Number(key)]); integer(player.score, -100_000, 1_000_000); oneOf(player.riichi, ['none', 'declared', 'accepted']);
    knowledge(player.concealedCount, n => integer(n, 0, 14)); array(player.melds, validateMeld, 4);
    array(player.river, r => {
      const river = object(r, ['tile', 'tsumogiri', 'riichiDeclaration', 'eventId'], ['calledBy']);
      tile(river.tile); oneOf(river.tsumogiri, [true, false, null]); boolean(river.riichiDeclaration); string(river.eventId);
      if (river.calledBy !== undefined) seat(river.calledBy);
    }, 40);
  }
  array(v.doraIndicators, tile, 5); array(v.doraTiles, tile, 5); knowledge(v.tilesRemaining, n => integer(n, 0, 136)); knowledge(v.currentActor, seat);
  array(v.unknownFields, f => string(f), 64); if (v.operationWindow !== undefined) validateWindow(v.operationWindow);
}
export function parseObservation(value: unknown): GameObservation {
  const o = object(value, ['schemaVersion', 'observationId', 'connectionEpoch', 'source', 'sourceDedupKey', 'receivedAt', 'type', 'payload'], ['sourceCursor']);
  oneOf(o.schemaVersion, [1]); string(o.observationId); integer(o.connectionEpoch); oneOf(o.source, ['majsoul-network', 'majsoul-sync']); string(o.sourceDedupKey, 256); timestamp(o.receivedAt);
  if (o.sourceCursor !== undefined) { string(o.sourceCursor); cursorParts(o.sourceCursor); }
  let p: Record<string, unknown>;
  switch (o.type) {
    case 'RoomVerified':
      p = object(o.payload, ['room', 'verifiedAt', 'evidenceIds']); validateRoom(p.room); timestamp(p.verifiedAt); array(p.evidenceIds, v => string(v), 32); requireThat(p.evidenceIds.length, 'MISSING_ROOM_EVIDENCE'); break;
    case 'MatchStarted':
      p = object(o.payload, ['roomId', 'ownSeat', 'initialScores', 'gameMatchKey']); string(p.roomId); seat(p.ownSeat); scores(p.initialScores); string(p.gameMatchKey); break;
    case 'HandStarted':
      p = object(o.payload, ['ordinal', 'initialView', 'gameHandKey']); integer(p.ordinal, 1, 1000); validateView(p.initialView); string(p.gameHandKey); break;
    case 'TileDrawn':
      p = object(o.payload, ['actor', 'tile', 'tilesRemaining']); seat(p.actor); knowledge(p.tile, tile); knowledge(p.tilesRemaining, n => integer(n, 0, 136)); break;
    case 'TileDiscarded':
      p = object(o.payload, ['actor', 'tile', 'tsumogiri', 'riichiDeclaration']); seat(p.actor); tile(p.tile); knowledge(p.tsumogiri, boolean); boolean(p.riichiDeclaration); break;
    case 'MeldDeclared':
      p = object(o.payload, ['meld', 'consumed']); validateMeld(p.meld); array(p.consumed, v => string(v), 4); break;
    case 'RiichiDeclared': p = object(o.payload, ['actor']); seat(p.actor); break;
    case 'RiichiAccepted':
      p = object(o.payload, ['actor', 'scores', 'riichiSticks']); seat(p.actor); scores(p.scores); integer(p.riichiSticks, 0, 100); break;
    case 'DoraRevealed':
      p = object(o.payload, ['indicators', 'doraTiles']); array(p.indicators, tile, 5); array(p.doraTiles, tile, 5); break;
    case 'OperationOffered': p = object(o.payload, ['window']); validateWindow(p.window); break;
    case 'OperationClosed':
      p = object(o.payload, ['windowId', 'reason']); string(p.windowId); oneOf(p.reason, ['completed', 'superseded', 'expired', 'hand-ended']); break;
    case 'HandEnded':
      p = object(o.payload, ['scores', 'reason', 'winners', 'resultLabel']); scores(p.scores); oneOf(p.reason, ['win', 'draw', 'abortive-draw']); array(p.winners, seat, 3); string(p.resultLabel);
      requireThat(new Set(p.winners).size === p.winners.length && (p.reason === 'win' ? p.winners.length > 0 : p.winners.length === 0), 'INVALID_HAND_RESULT'); break;
    case 'MatchEnded': p = object(o.payload, ['scores', 'ranks']); scores(p.scores); scores(p.ranks); requireThat(new Set(Object.values(p.ranks as object)).size === 4 && Object.values(p.ranks as object).every(v => [1,2,3,4].includes(v)), 'INVALID_RANKS'); break;
    case 'Disconnected': p = object(o.payload, ['code', 'recoverable']); string(p.code); boolean(p.recoverable); break;
    default: throw new Error('UNSUPPORTED_OBSERVATION');
  }
  return structuredClone(value) as GameObservation;
}
export function parseSync(value: unknown): AuthoritativeSync {
  const s = object(value, ['syncId', 'connectionEpoch', 'receivedAt', 'coverage', 'room', 'gameMatchKey', 'gameHandKey', 'handOrdinal', 'missingFields', 'historyCoverage', 'handHistory', 'observedActions', 'sourceCursor'], ['currentView']);
  string(s.syncId); integer(s.connectionEpoch); timestamp(s.receivedAt); oneOf(s.coverage, ['complete-current-state', 'partial']); validateRoom(s.room);
  string(s.gameMatchKey); string(s.gameHandKey); integer(s.handOrdinal, 1, 1000); string(s.sourceCursor); cursorParts(s.sourceCursor);
  array(s.missingFields, v => string(v), 64); oneOf(s.historyCoverage, ['complete-hand', 'partial', 'none']);
  if (s.currentView !== undefined) validateView(s.currentView, true);
  array(s.handHistory, parseObservation, 1024); array(s.observedActions, v => { const o = parseObservation(v); requireThat(o.type === 'TileDiscarded' && o.sourceCursor, 'INVALID_SYNC_ACTION'); }, 256);
  const sync = value as AuthoritativeSync;
  for (const o of [...sync.handHistory, ...sync.observedActions]) {
    requireThat(o.source === 'majsoul-sync' && o.connectionEpoch === sync.connectionEpoch, 'SYNC_EVIDENCE_EPOCH_MISMATCH');
    if (o.type === 'TileDrawn' && o.payload.tile.known) requireThat(sync.currentView && o.payload.actor === sync.currentView.ownSeat, 'OPPONENT_HIDDEN_TILE');
    if (o.type === 'HandStarted') requireThat(sync.currentView && o.payload.initialView.ownSeat === sync.currentView.ownSeat && o.payload.gameHandKey === sync.gameHandKey && o.payload.ordinal === sync.handOrdinal, 'SYNC_HISTORY_HAND_MISMATCH');
  }
  return structuredClone(value) as AuthoritativeSync;
}
