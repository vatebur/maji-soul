import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthoritativeSync, FriendRoom, GameObservation, GameProjection, GameState, HandInitialView, Meld, ObservationPayloads, OperationWindow, Seat, TileCode } from '../src/domain/game/types.ts';
import { assertView, assertWindow, doraFromIndicator, initialProjection, known, reduceObservation, reduceSync, seats, unknown } from '../src/domain/game/reducer.ts';
import { canonical } from '../src/domain/game/value.ts';
import { parseObservation, parseSync, validateWindow } from '../src/schemas/game.ts';

const at = '2026-11-05T08:00:00.000Z';
const room: FriendRoom = { roomId: 'synthetic-room', rules: { players: 4, length: 'east', displayTimeSetting: '300+0', computerSeats: 3,
  verifiedOptions: { doraRule: 'standard-riichi' }, protocolVersion: 'synthetic-v1' }, autoWin: 'verified-on' };
const ordinaryHand: TileCode[] = ['1m', '2m', '3m', '4m', '5m', '5m', '5mr', '7m', '8m', '9m', '1p', '2p', '3p'];
const scores = { 0: 25000, 1: 25000, 2: 25000, 3: 25000 };
let observationNumber = 0;
function observation<K extends keyof ObservationPayloads>(type: K, payload: ObservationPayloads[K], cursor?: string, epoch = 0): GameObservation {
  const n = ++observationNumber;
  return parseObservation({ schemaVersion: 1, observationId: `observation-${n}`, connectionEpoch: epoch,
    source: 'majsoul-network', sourceDedupKey: `synthetic-source-${n}`, receivedAt: at, type, payload,
    ...(cursor ? { sourceCursor: cursor } : {}) });
}
function view(tiles: TileCode[] = ordinaryHand, dealer: Seat = 2): HandInitialView {
  const ownSeat = 2 as const;
  const player = (s: Seat): HandInitialView['players'][Seat] => ({ seat: s, score: 25000, river: [], melds: [], riichi: 'none', concealedCount: known(s === ownSeat ? tiles.length : s === dealer ? 14 : 13) });
  return { ownSeat, players: { 0: player(0), 1: player(1), 2: player(2), 3: player(3) },
    ownConcealed: tiles.map((code, i) => ({ instanceId: `input-tile-${i}`, code })),
    drawnTileRef: known(tiles.length === 14 ? 'input-tile-13' : null), dealer, roundWind: '1z', seatWind: `${(ownSeat - dealer + 4) % 4 + 1}z` as TileCode,
    handNumber: 1, honba: 0, riichiSticks: 0, doraIndicators: ['9s'], doraTiles: ['1s'],
    tilesRemaining: known(70), currentActor: known(dealer), unknownFields: [] };
}
function start(input: HandInitialView | TileCode[] = view()): GameProjection {
  const initial = Array.isArray(input) ? view(input) : input;
  let p = initialProjection('synthetic-reducer-session');
  p = reduceObservation(p, observation('RoomVerified', { room, verifiedAt: at, evidenceIds: ['synthetic-room-evidence'] }));
  p = reduceObservation(p, observation('MatchStarted', { roomId: room.roomId, ownSeat: initial.ownSeat, initialScores: scores, gameMatchKey: 'synthetic-match' }));
  return reduceObservation(p, observation('HandStarted', { ordinal: 1, initialView: initial, gameHandKey: 'synthetic-hand-1' }, 'hand-1:0'));
}
function stateView(s: GameState): HandInitialView {
  const { sessionId: _session, matchId: _match, handId: _hand, connectionEpoch: _epoch, stateVersion: _version,
    trust: _trust, trustIssues: _issues, latestAction: _action, operationWindow: _window, ...visible } = structuredClone(s);
  return visible;
}
function windowFor(s: GameState, id = 'synthetic-window', epoch = s.connectionEpoch): OperationWindow {
  const drawn = s.drawnTileRef.known ? s.drawnTileRef.value : null;
  return { id, connectionEpoch: epoch, openedAt: at,
    deadline: known({ at: '2026-11-05T08:05:00.000Z', sourceEventId: 'synthetic-deadline-evidence', uncertaintyMs: 20 }),
    candidates: s.ownConcealed.map(t => ({ id: `${id}:${t.instanceId}`, action: { kind: 'discard', tile: t.instanceId, tsumogiri: t.instanceId === drawn }, authority: 'executor', label: t.code, evidenceEventIds: ['synthetic-operation-evidence'] })), status: 'open' };
}
function syncFor(p: GameProjection): AuthoritativeSync {
  return { syncId: 'synthetic-sync', connectionEpoch: p.connectionEpoch + 1, receivedAt: at, coverage: 'complete-current-state', room,
    gameMatchKey: p.gameMatchKey!, gameHandKey: p.gameHandKey!, handOrdinal: p.handOrdinal,
    currentView: stateView(p.state!), missingFields: [], historyCoverage: 'none', handHistory: [], observedActions: [], sourceCursor: p.sourceCursor! };
}

test('reducer preserves red fives and duplicate physical references without mutating prior projections', () => {
  const p = start(), before = canonical(p);
  const drawn = reduceObservation(p, observation('TileDrawn', { actor: 2, tile: known('5m'), tilesRemaining: known(69) }, 'hand-1:1'));
  assert.equal(canonical(p), before);
  const drawRef = drawn.state!.drawnTileRef;
  assert.ok(drawRef.known && drawRef.value);
  const window = windowFor(drawn.state!); assertWindow(drawn.state!, window);
  assert.equal(new Set(window.candidates.map(c => c.action.kind === 'discard' ? c.action.tile : '')).size, 14);
  const offered = reduceObservation(drawn, observation('OperationOffered', { window }));
  const discarded = reduceObservation(offered, observation('TileDiscarded', { actor: 2, tile: '5m', tsumogiri: known(false), riichiDeclaration: false }, 'hand-1:2'));
  assert.equal(discarded.state!.ownConcealed.filter(t => t.code === '5mr').length, 1);
  assert.equal(discarded.state!.ownConcealed.filter(t => t.code === '5m').length, 2);
  assert.ok(discarded.state!.ownConcealed.some(t => t.instanceId === drawRef.value));
  assert.deepEqual(discarded.state!.drawnTileRef, known(null));
  assert.equal(discarded.state!.players[2].river.at(-1)!.tile, '5m');
  assert.equal(discarded.state!.operationWindow!.status, 'closed');
  assert.throws(() => assertWindow(drawn.state!, { ...window, candidates: [{ ...window.candidates[0]!, action: { kind: 'discard', tile: 'not-owned', tsumogiri: false } }] }), /INVALID_DISCARD_CANDIDATE/);
});

test('source gaps, out-of-turn facts and opponent hidden draws cannot become trusted state', () => {
  const p = start();
  assert.throws(() => reduceObservation(p, observation('TileDrawn', { actor: 2, tile: known('5m'), tilesRemaining: known(69) }, 'hand-1:2')), /SOURCE_GAP/);
  assert.throws(() => reduceObservation(p, observation('TileDrawn', { actor: 1, tile: unknown('HIDDEN'), tilesRemaining: known(69) }, 'hand-1:1')), /DRAW_ACTOR_MISMATCH/);
  const otherView = view(ordinaryHand, 1); otherView.players[1].concealedCount = known(13);
  const otherTurn = start(otherView);
  assert.throws(() => reduceObservation(otherTurn, observation('TileDrawn', { actor: 1, tile: known('7p'), tilesRemaining: known(69) }, 'hand-1:1')), /OPPONENT_HIDDEN_TILE/);
  const malformed = view(); malformed.ownConcealed = []; malformed.players[2].concealedCount = known(0);
  assert.throws(() => start(malformed), /CONCEALED_COUNT_INVALID/);
  const ambiguous = view(); ambiguous.ownConcealed[1]!.instanceId = ambiguous.ownConcealed[0]!.instanceId;
  assert.throws(() => start(ambiguous), /DUPLICATE_TILE_INSTANCE/);
});

test('unknown state and disconnection remain untrusted until authoritative synchronization', () => {
  const unknownView = view(); unknownView.tilesRemaining = unknown('MISSING_SOURCE_FIELD');
  const p = start(unknownView); assert.equal(p.state!.trust, 'untrusted');
  const after = reduceObservation(p, observation('TileDrawn', { actor: 2, tile: known('5m'), tilesRemaining: known(69) }, 'hand-1:1'));
  assert.equal(after.state!.trust, 'untrusted');
  const disconnected = reduceObservation(start(), observation('Disconnected', { code: 'NETWORK_LOST', recoverable: true }));
  const later = reduceObservation(disconnected, observation('TileDrawn', { actor: 2, tile: known('5m'), tilesRemaining: known(69) }, 'hand-1:1'));
  assert.equal(later.state!.trust, 'syncing');
  const synced = reduceSync(later, parseSync(syncFor(later)));
  assert.equal(synced.state!.trust, 'trusted');
});

test('room readback invalidates old windows; window IDs and deadline provenance cannot be recycled', () => {
  const p = start([...ordinaryHand, '5m']);
  const window = windowFor(p.state!);
  const offered = reduceObservation(p, observation('OperationOffered', { window }));
  const updated = reduceObservation(offered, observation('RoomVerified', { room: { ...room, autoWin: 'verified-off' }, verifiedAt: at, evidenceIds: ['readback'] }));
  assert.equal(updated.state!.stateVersion, offered.state!.stateVersion + 1);
  assert.equal(updated.state!.operationWindow!.status, 'closed');
  assert.throws(() => reduceObservation(updated, observation('OperationOffered', { window })), /WINDOW_ID_REUSED/);
  assert.throws(() => validateWindow({ ...window, deadline: known({ at: '2026-11-05T07:59:59.999Z', sourceEventId: 'invalid', uncertaintyMs: 0 }) }), /INVALID_WINDOW_DEADLINE/);
  validateWindow({ ...window, deadline: unknown('DEADLINE_PROVENANCE_UNVERIFIED') });
  assert.throws(() => parseObservation({ ...observation('OperationOffered', { window }), cookie: 'must-not-enter-domain' }), /INVALID_FIELDS/);
});

test('chi, pon and open kan consume exact own instances and retain the called tile once', () => {
  const cases: { kind: Meld['kind']; source: Seat; called: TileCode; owned: TileCode[]; tiles: TileCode[]; calledIndex: number; remaining: number }[] = [
    { kind: 'chi', source: 1, called: '2m', owned: ['3m', '4m'], tiles: ['2m', '3m', '4m'], calledIndex: 0, remaining: 11 },
    { kind: 'pon', source: 0, called: '5mr', owned: ['5m', '5m'], tiles: ['5m', '5mr', '5m'], calledIndex: 1, remaining: 11 },
    { kind: 'open-kan', source: 0, called: '5mr', owned: ['5m', '5m', '5m'], tiles: ['5m', '5mr', '5m', '5m'], calledIndex: 1, remaining: 10 },
  ];
  const filler: TileCode[] = ['1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '1s', '2s'];
  for (const c of cases) {
    const p = start(view([...c.owned, ...filler.slice(0, 13 - c.owned.length)], c.source));
    const discarded = reduceObservation(p, observation('TileDiscarded', { actor: c.source, tile: c.called, tsumogiri: known(true), riichiDeclaration: false }, 'hand-1:1'));
    const consumed = discarded.state!.ownConcealed.slice(0, c.owned.length).map(t => t.instanceId);
    const m: Meld = { id: `meld-${c.kind}`, actor: 2, kind: c.kind, tiles: c.tiles, fromSeat: c.source, calledTileIndex: c.calledIndex };
    const melded = reduceObservation(discarded, observation('MeldDeclared', { meld: m, consumed }, 'hand-1:2'));
    assert.equal(melded.state!.ownConcealed.length, c.remaining);
    assert.equal(melded.state!.players[c.source].river.at(-1)!.calledBy, 2);
    assert.deepEqual(melded.state!.players[2].melds[0]!.tiles, c.tiles);
    assertView(melded.state!);
    const wrongConsumed = [...consumed]; wrongConsumed[0] = discarded.state!.ownConcealed.at(-1)!.instanceId;
    assert.throws(() => reduceObservation(discarded, observation('MeldDeclared', { meld: m, consumed: wrongConsumed }, 'hand-1:2')), /MELD_CONSUMED_MISMATCH/);
    const stale = structuredClone(discarded); stale.state!.currentActor = known(3);
    assert.throws(() => reduceObservation(stale, observation('MeldDeclared', { meld: m, consumed }, 'hand-1:2')), /MELD_NOT_LATEST_DISCARD/);
  }
});

test('closed and added kan preserve tile conservation and require replacement draws', () => {
  const fourFives: TileCode[] = ['5m', '5mr', '5m', '5m'];
  const filler: TileCode[] = ['1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '1s'];
  const p = start([...fourFives, ...filler]);
  const closed = reduceObservation(p, observation('MeldDeclared', { meld: { id: 'closed', actor: 2, kind: 'closed-kan', tiles: fourFives }, consumed: p.state!.ownConcealed.slice(0, 4).map(t => t.instanceId) }, 'hand-1:1'));
  assert.equal(closed.state!.ownConcealed.length, 10);
  assert.throws(() => assertWindow(closed.state!, windowFor(closed.state!)), /INVALID_DISCARD_COUNT/);
  const replaced = reduceObservation(closed, observation('TileDrawn', { actor: 2, tile: known('3s'), tilesRemaining: known(69) }, 'hand-1:2'));
  assert.equal(replaced.state!.ownConcealed.length, 11); assertWindow(replaced.state!, windowFor(replaced.state!));

  const midHand = view(['5m', ...filler]);
  midHand.players[0].river = [{ tile: '5mr', tsumogiri: true, riichiDeclaration: false, calledBy: 2, eventId: 'called-source-fact' }];
  midHand.players[2].melds = [{ id: 'old-pon', actor: 2, kind: 'pon', tiles: ['5m', '5mr', '5m'], fromSeat: 0, calledTileIndex: 1 }];
  midHand.drawnTileRef = known('input-tile-0');
  const synced = reduceSync(initialProjection('synthetic-reducer-session'), parseSync({ syncId: 'seed', connectionEpoch: 1, receivedAt: at,
    coverage: 'complete-current-state', room, gameMatchKey: 'synthetic-match', gameHandKey: 'synthetic-hand-1', handOrdinal: 1,
    currentView: midHand, missingFields: [], historyCoverage: 'none', handHistory: [], observedActions: [], sourceCursor: 'hand-1:0' }));
  const added = reduceObservation(synced, observation('MeldDeclared', { meld: { id: 'added', actor: 2, kind: 'added-kan', tiles: fourFives, fromSeat: 0, calledTileIndex: 1, upgradedFrom: 'old-pon' }, consumed: [synced.state!.ownConcealed[0]!.instanceId] }, 'hand-1:1', 1));
  assert.equal(added.state!.players[2].melds.length, 1);
  assert.equal(added.state!.players[2].melds[0]!.kind, 'added-kan');
  assert.equal(added.state!.ownConcealed.length, 10);
  assert.deepEqual(added.state!.drawnTileRef, known(null));
});

test('same-hand sync preserves mode and hand identity but rebuilds all epoch-scoped tile references', () => {
  const p = start([...ordinaryHand, '5m']); p.pendingMode = 'llm';
  const oldRefs = new Set(p.state!.ownConcealed.map(t => t.instanceId));
  const sync = syncFor(p); sync.currentView!.operationWindow = windowFor(p.state!, 'synced-window', 1);
  const result = reduceSync(p, parseSync(sync));
  assert.equal(result.state!.handId, p.state!.handId); assert.equal(result.activeMode, 'engine');
  assert.equal(result.pendingMode, 'llm'); assert.equal(result.state!.connectionEpoch, 1);
  assert.ok(result.state!.ownConcealed.every(t => !oldRefs.has(t.instanceId)));
  assertWindow(result.state!, result.state!.operationWindow!);
  assert.throws(() => reduceSync(p, { ...sync, coverage: 'partial' }), /SYNC_INCOMPLETE/);
  assert.throws(() => reduceSync(p, { ...sync, missingFields: ['rules'] }), /SYNC_INCOMPLETE/);
  const afterDraw = reduceObservation(start(), observation('TileDrawn', { actor: 2, tile: known('5m'), tilesRemaining: known(69) }, 'hand-1:1'));
  assert.throws(() => reduceSync(afterDraw, { ...syncFor(afterDraw), sourceCursor: 'hand-1:0' }), /SYNC_CURSOR_MISMATCH/);
  const missing = syncFor(p); missing.currentView!.unknownFields = ['unverified-rule'];
  assert.throws(() => reduceSync(p, missing), /SYNC_UNKNOWN_STATE/);
});

test('dealer repeat opens a new hand and locks the pending mode without old context', () => {
  const p = start(); p.pendingMode = 'llm';
  const ended = reduceObservation(p, observation('HandEnded', { scores, reason: 'draw', winners: [], resultLabel: 'synthetic draw' }, 'hand-1:1'));
  const repeated = view(); repeated.honba = 1;
  const next = reduceObservation(ended, observation('HandStarted', { ordinal: 2, initialView: repeated, gameHandKey: 'synthetic-hand-2' }, 'hand-2:0'));
  assert.notEqual(next.state!.handId, ended.state!.handId); assert.equal(next.state!.handNumber, ended.state!.handNumber);
  assert.equal(next.activeMode, 'llm'); assert.equal(next.handOrdinal, 2);
  assert.equal(next.contextEventIds.length, 1); assert.equal(next.state!.operationWindow, undefined); assert.equal(next.state!.latestAction, undefined);
  assert.throws(() => reduceObservation(ended, observation('HandStarted', { ordinal: 2, initialView: repeated, gameHandKey: 'synthetic-hand-1' }, 'hand-2:0')), /HAND_BOUNDARY_INVALID/);
  assert.throws(() => reduceSync(ended, syncFor(ended)), /SYNC_HAND_ALREADY_FINISHED/);
});

test('sync evidence must agree with both source cursors and visible rivers before it can reconcile an action', () => {
  const p = start([...ordinaryHand, '5m']);
  const action = observation('TileDiscarded', { actor: 2, tile: '5m', tsumogiri: known(true), riichiDeclaration: false }, 'hand-1:1');
  const after = reduceObservation(p, action), sync = syncFor(after);
  const evidence = { ...action, source: 'majsoul-sync' as const, connectionEpoch: sync.connectionEpoch };
  sync.observedActions = [evidence];
  assert.throws(() => reduceSync(after, parseSync(sync)), /SYNC_ACTION_NOT_IN_VIEW/);
  sync.currentView!.players[2].river[0]!.eventId = evidence.sourceDedupKey;
  assert.equal(reduceSync(after, parseSync(sync)).state!.trust, 'trusted');
  const future = structuredClone(sync); future.observedActions[0]!.sourceCursor = 'hand-1:2';
  assert.throws(() => reduceSync(after, parseSync(future)), /SYNC_EVIDENCE_CURSOR_MISMATCH/);
  const disagreement = structuredClone(sync); disagreement.currentView!.players[2].river[0]!.tile = '4m';
  assert.throws(() => reduceSync(after, parseSync(disagreement)), /SYNC_ACTION_NOT_IN_VIEW/);
  const hidden = structuredClone(sync); hidden.handHistory = [{ ...observation('TileDrawn', { actor: 0, tile: known('2s'), tilesRemaining: known(69) }, 'hand-1:0'), source: 'majsoul-sync', connectionEpoch: 1 }]; hidden.historyCoverage = 'partial';
  assert.throws(() => parseSync(hidden), /OPPONENT_HIDDEN_TILE/);
  const falseComplete = { ...sync, historyCoverage: 'complete-hand' as const };
  assert.throws(() => reduceSync(after, parseSync(falseComplete)), /SYNC_HISTORY_INCOMPLETE/);
});

test('complete-hand history proves river order; dora indicators cannot be rewritten', () => {
  const initial = view([...ordinaryHand, '5m']), p = start(initial);
  const first = observation('HandStarted', { ordinal: 1, initialView: initial, gameHandKey: 'synthetic-hand-1' }, 'hand-1:0', 1);
  const discard = observation('TileDiscarded', { actor: 2, tile: '5m', tsumogiri: known(true), riichiDeclaration: false }, 'hand-1:1');
  const after = reduceObservation(p, discard), sync = syncFor(after);
  sync.historyCoverage = 'complete-hand'; sync.handHistory = [first, { ...discard, connectionEpoch: 1 }].map(o => ({ ...o, source: 'majsoul-sync' }));
  sync.observedActions = [sync.handHistory[1]!];
  assert.equal(reduceSync(after, parseSync(sync)).state!.trust, 'trusted');
  const inconsistent = structuredClone(sync); inconsistent.currentView!.players[2].river = [];
  assert.throws(() => reduceSync(after, parseSync(inconsistent)), /SYNC_HISTORY_RIVER_MISMATCH/);
  assert.deepEqual(['9m', '4z', '7z', '5mr'].map(t => doraFromIndicator(t as TileCode)), ['1m', '1z', '5z', '6m']);
  assert.throws(() => reduceObservation(p, observation('DoraRevealed', { indicators: ['8s'], doraTiles: ['9s'] })), /DORA_HISTORY_CHANGED/);
  assert.throws(() => reduceObservation(p, observation('DoraRevealed', { indicators: ['9s', '8s'], doraTiles: ['1s', '1m'] })), /DORA_MISMATCH/);
});
